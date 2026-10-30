// Google Health sync helpers: raw archive rows, daily-type dates, token handling.
import { dailyStepTotals, dataPointsOf, parseDailyHrv, parseDailyRestingHr, parseGoogleTime } from '../../../packages/core/src/health/parse.ts';
import { iso } from './time.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Data types stored at full fidelity in raw_health but as hourly chunks (they arrive at up to 1 Hz). */
export const CHUNKED_TYPES = new Set(['heart-rate', 'steps']);

export const SAMPLE_TYPES = ['heart-rate', 'heart-rate-variability', 'oxygen-saturation'] as const;
export const DAILY_TYPES = [
  'daily-resting-heart-rate',
  'daily-heart-rate-variability',
  'daily-oxygen-saturation',
  'daily-respiratory-rate',
  'daily-sleep-temperature-derivations',
] as const;

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** First value under `key` anywhere in `v` (depth-first). */
export function deepFind(v: unknown, key: string, depth = 0): unknown {
  if (depth > 6 || (typeof v !== 'object' || v === null)) return undefined;
  if (!Array.isArray(v) && key in (v as Obj)) return (v as Obj)[key];
  for (const x of Array.isArray(v) ? v : Object.values(v as Obj)) {
    const r = deepFind(x, key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** Civil date of a daily point: `date` as "YYYY-MM-DD" or {year, month, day}. */
export function civilDate(point: unknown): string | null {
  const d = deepFind(point, 'date');
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  if (isObj(d) && typeof d.year === 'number' && typeof d.month === 'number' && typeof d.day === 'number') {
    return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
  }
  return null;
}

/** Sample or interval time of a point, for keys and bucketing. */
export function pointTime(point: unknown): number | null {
  for (const k of ['physicalTime', 'startTime', 'endTime']) {
    const t = parseGoogleTime(deepFind(point, k));
    if (t !== null) return t;
  }
  return null;
}

/**
 * End of a per-sleep-session point (interval endTime first), so it maps to the wake date. A session starting
 * 22:30 ICT must not be keyed to the evening's calendar date. Falls back to the sample time.
 */
export function sessionEndTime(point: unknown): number | null {
  for (const k of ['endTime', 'physicalTime', 'startTime']) {
    const t = parseGoogleTime(deepFind(point, k));
    if (t !== null) return t;
  }
  return null;
}

export interface RawHealthRow {
  person_id: string;
  data_type: string;
  point_key: string;
  payload: unknown;
  update_time: string | null;
  data_source: unknown;
}

/**
 * Archive rows for one fetch. Ordinary types: one row per point, keyed by its resource name (or time), with
 * updateTime as the version. Chunked types: one row per hour of points, keyed by hour + content hash, so a
 * later fetch with more points becomes a new version instead of being dropped.
 */
export async function rawRows(personId: string, dataType: string, json: unknown): Promise<RawHealthRow[]> {
  const points = dataPointsOf(json);
  if (CHUNKED_TYPES.has(dataType)) {
    const hours = new Map<number, Obj[]>();
    for (const p of points) {
      const t = pointTime(p);
      const h = t === null ? 0 : Math.floor(t / 3_600_000) * 3_600_000;
      const xs = hours.get(h);
      if (xs) xs.push(p);
      else hours.set(h, [p]);
    }
    const out: RawHealthRow[] = [];
    for (const [h, xs] of [...hours.entries()].sort((a, b) => a[0] - b[0])) {
      xs.sort((a, b) => (pointTime(a) ?? 0) - (pointTime(b) ?? 0));
      const body = JSON.stringify(xs);
      out.push({
        person_id: personId,
        data_type: dataType,
        point_key: `${h ? iso(h) : 'unknown'}#${(await sha256Hex(body)).slice(0, 16)}`,
        payload: { points: xs },
        update_time: null,
        data_source: xs[0]?.dataSource ?? null,
      });
    }
    return out;
  }
  const out: RawHealthRow[] = [];
  for (const p of points) {
    const t = pointTime(p);
    const date = civilDate(p);
    const key = typeof p.name === 'string' && p.name
      ? p.name
      : t !== null
      ? iso(t)
      : date ?? (await sha256Hex(JSON.stringify(p))).slice(0, 24);
    const upd = parseGoogleTime(deepFind(p, 'updateTime'));
    out.push({
      person_id: personId,
      data_type: dataType,
      point_key: key,
      payload: p,
      update_time: upd === null ? null : iso(upd),
      data_source: p.dataSource ?? null,
    });
  }
  return out;
}

/** health_daily rows (latest version per date wins). `dateOf` overrides the civil date, e.g. for per-session summaries. */
export function dailyRows(personId: string, dataType: string, json: unknown, dateOf?: (p: Obj) => string | null) {
  const best = new Map<string, { row: Record<string, unknown>; upd: number }>();
  for (const p of dataPointsOf(json)) {
    const date = dateOf ? dateOf(p) : civilDate(p);
    if (!date) continue;
    const upd = parseGoogleTime(deepFind(p, 'updateTime')) ?? 0;
    const prev = best.get(date);
    if (prev && prev.upd > upd) continue;
    const { dataSource: _ds, ...value } = p;
    best.set(date, {
      upd,
      row: { person_id: personId, data_type: dataType, date, value, update_time: upd ? iso(upd) : null, fetched_at: iso(Date.now()) },
    });
  }
  return [...best.values()].map((b) => b.row);
}

/**
 * health_vitals_daily rows (migration 0003), one per local date. Every row in a batch carries the same columns, so
 * an upsert only touches the columns its data type owns: steps never clear resting HR and vice versa.
 */
export type VitalsRow = Record<string, string | number | null>;

const vitalsRow = (personId: string, date: string, cols: Record<string, string | number | null>): VitalsRow => ({
  person_id: personId,
  date,
  ...cols,
  updated_at: iso(Date.now()),
});

/** Daily step totals (ICT days). Fetch from local midnight, or the first day is partial. */
export function stepsVitalsRows(personId: string, json: unknown): VitalsRow[] {
  return dailyStepTotals(json).map((d) => vitalsRow(personId, d.date, { steps: d.steps }));
}

/** daily-resting-heart-rate / daily-heart-rate-variability → their vitals columns; other types give no rows. */
export function dailyVitalsRows(personId: string, dataType: string, json: unknown): VitalsRow[] {
  if (dataType === 'daily-resting-heart-rate') {
    return parseDailyRestingHr(json).map((d) => vitalsRow(personId, d.date, { resting_hr: d.bpm, resting_hr_method: d.method ?? null }));
  }
  if (dataType === 'daily-heart-rate-variability') {
    return parseDailyHrv(json).map((d) => vitalsRow(personId, d.date, { hrv_daily_ms: d.averageMs ?? null, deep_rmssd_ms: d.deepSleepRmssdMs ?? null }));
  }
  return [];
}

/**
 * Newest time among data points (sample time, else interval end), or null. For steps that is the end of the newest
 * 1-min interval: when the band last recorded something that reached Google.
 */
export function newestPointTime(json: unknown): number | null {
  let best: number | null = null;
  for (const p of dataPointsOf(json)) {
    const t = parseGoogleTime(deepFind(p, 'physicalTime')) ?? parseGoogleTime(deepFind(p, 'endTime')) ?? parseGoogleTime(deepFind(p, 'startTime'));
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

/** Newest `lastSyncTime` across pairedDevices entries (band → phone app → Google), or null. */
export function newestDeviceSync(devices: readonly unknown[]): number | null {
  let best: number | null = null;
  for (const d of devices) {
    const t = parseGoogleTime(deepFind(d, 'lastSyncTime'));
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

/** Gmail ignores dots and "+tags" and treats googlemail.com as gmail.com: compare addresses the way Google does. */
export function normEmail(e: string | null | undefined): string | null {
  const s = (e ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  let [user, domain] = [s.slice(0, at), s.slice(at + 1)];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') user = user.split('+')[0]!.replaceAll('.', '');
  return `${user}@${domain}`;
}

/**
 * Email of the Google account that consented, from the id_token of the code exchange ('openid email' scopes). The token
 * came straight from Google's token endpoint over TLS, so its claims are used without a signature check (Google's
 * guidance for server-side flows); `aud` must still be our client. null when absent or unverified.
 */
export function idTokenEmail(idToken: string | undefined, clientId: string): string | null {
  const part = idToken?.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)))) as Obj;
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(clientId) || c.email_verified === false || typeof c.email !== 'string') return null;
    return c.email;
  } catch {
    return null;
  }
}

/**
 * The consenting Google account belongs to a DIFFERENT household person (e.g. Erik finishing Cath's consent on a shared
 * phone): returns that person's id, else null. A Google account that is no household login (a separate Fitbit account)
 * is accepted: the app login and the band's Google account need not be the same.
 */
export function wrongAccount(googleEmail: string | null, personId: string, members: readonly { personId: string | null; email: string | null }[]): string | null {
  const g = normEmail(googleEmail);
  if (!g) return null;
  const owners = members.filter((m) => m.personId && normEmail(m.email) === g).map((m) => m.personId!);
  return owners.length && !owners.includes(personId) ? owners[0]! : null;
}
