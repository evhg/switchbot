// Read-only Supabase source. Columns follow supabase/migrations/0001_init.sql (+ 0003 health_vitals_daily); RLS only lets signed-in
// household members read, so the anon key alone returns nothing (see supabaseSignIn). The row → type
// mapping is isolated in the to* functions below so a migration rename is a one-line fix here. Sign-in state lives in
// lib/auth.tsx; this file only exposes the client and the auth calls.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { BUILTIN_CURVES, DEFAULT_CURVE, cleanRoomReadings, plausibleCo2, type AcCommand, type AcMode, type CurvePhase, type FanSpeed, type Ms, type Night, type Person, type PersonNight, type RoomEvent, type RoomEventKind, type RoomReading, type SleepSession, type StageSegment, type TagKey, type TemperatureCurve } from '@sleep-lab/core';
import { addDays, DAY, HOUR, ictDate, ictMidnight, MIN } from '../format.ts';
import { runEngine } from './engine-client.ts';
import type { Dataset, DataSource, NightDetail, NightGap, NightQuality, RealNightInfo } from './types.ts';

type Row = Record<string, unknown>;

const num = (v: unknown, d = NaN) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : d);
const ms = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

export function supabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export const toReading = (r: Row): RoomReading => ({
  ts: ms(r.ts),
  tempC: num(r.temp_c),
  rh: num(r.rh),
  co2: num(r.co2),
  source: (str(r.source, 'poll') as RoomReading['source']),
});

export const toAcCommand = (r: Row): AcCommand => {
  const state = (r.state ?? {}) as Row;
  return {
    ts: ms(r.ts),
    state: {
      power: Boolean(state.power ?? r.power ?? true),
      setpointC: num(state.setpointC ?? r.setpoint_c, 20),
      mode: str(state.mode ?? r.mode, 'cool') as AcMode,
      fan: str(state.fan ?? r.fan, 'auto') as FanSpeed,
    },
    via: str(r.via, 'setAll') === 'customize' ? 'customize' : 'setAll',
    button: typeof r.button === 'string' ? r.button : undefined,
    reason: str(r.reason),
    landed: typeof r.landed === 'boolean' ? r.landed : null,
  };
};

export const toEvent = (r: Row): RoomEvent => ({
  kind: str(r.kind) as RoomEventKind,
  start: ms(r.start_ts ?? r.start),
  end: r.end_ts ?? r.end ? ms(r.end_ts ?? r.end) : undefined,
  confidence: num(r.confidence, 1),
  detail: (r.detail ?? undefined) as RoomEvent['detail'],
});

async function pageAll(q: () => { range(a: number, b: number): PromiseLike<{ data: Row[] | null; error: { message: string } | null }> }, max = 200_000): Promise<Row[]> {
  const out: Row[] = [];
  const size = 1000;
  for (let from = 0; from < max; from += size) {
    const { data, error } = await q().range(from, from + size - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

// ───────────────────────── real-data hygiene (pure, unit-testable) ─────────────────────────

/** Gaps and frozen stretches shorter than this are not drawn (a missed poll or two). */
const SHOW_GAP_MIN = 10;

/**
 * One night's room data, cleaned with core's cleanRoomReadings (the backend uses the same rules, so numbers agree):
 * stale repeated cloud values are dropped, CO₂ below 300 ppm (the meter's warm-up 0) becomes NaN so no chart draws it.
 * Gaps before the first reading ever stored are 'before-meter'. Everything is clipped to `now`.
 */
export function cleanNight(raw: readonly RoomReading[], o: { from: Ms; to: Ms; lightsOut: Ms; wake: Ms; now: Ms; firstEver: Ms | null }): { readings: RoomReading[]; quality: NightQuality } {
  const to = Math.max(o.from + MIN, Math.min(o.to, o.now));
  const { readings, quality: q } = cleanRoomReadings(raw, { from: o.from, to, lightsOut: o.lightsOut, wake: o.wake });
  const gaps: NightGap[] = [
    ...q.gaps.map((g): NightGap => ({ start: g.start, end: g.end, kind: o.firstEver === null || g.end <= o.firstEver + MIN ? 'before-meter' : 'missing' })),
    ...q.frozen.map((f): NightGap => ({ start: f.start, end: f.end, kind: 'frozen', value: `${f.tempC.toFixed(1)}°, ${Math.round(f.rh)}%` })),
  ]
    .filter((g) => g.end - g.start >= SHOW_GAP_MIN * MIN)
    .sort((a, b) => a.start - b.start);
  return {
    readings: readings.map((r) => (plausibleCo2(r.co2) ? r : { ...r, co2: NaN })),
    quality: { gaps, coverage: q.coverage, frozenDropped: q.rawCount - q.keptCount, co2Glitches: q.invalidCo2Count, flags: q.flags },
  };
}

/** Default schedule of a night without a nights row: lights out 22:00, wake 08:30 (ICT), as the backend creates it. */
export const defaultLightsOut = (date: string) => ictMidnight(date) - 2 * HOUR;
export const defaultWake = (date: string) => ictMidnight(date) + 8.5 * HOUR;
/** The room-data window of the night ending on `date`: 18:00 the evening before → 12:00 on the wake date. */
export const nightWindow = (date: string) => ({ from: ictMidnight(date) - 6 * HOUR, to: ictMidnight(date) + 12 * HOUR });

/**
 * Wake dates to show: every night whose wake time has passed and that has room readings in its sleep window (lights
 * out → wake) or a sleep session. Planned future nights (rows created for away periods etc.) are not nights yet.
 */
export function realNightDates(o: { now: Ms; fromDate: string; readings: readonly RoomReading[]; rows: ReadonlyMap<string, { lightsOut: Ms; wake: Ms }>; sleepEnds: readonly Ms[] }): string[] {
  const out: string[] = [];
  const last = ictDate(o.now);
  for (let d = o.fromDate; d <= last; d = addDays(d, 1)) {
    const row = o.rows.get(d);
    const lo = row?.lightsOut ?? defaultLightsOut(d);
    const wake = row?.wake ?? defaultWake(d);
    if (wake > o.now) continue;
    const win = nightWindow(d);
    const room = o.readings.some((r) => r.ts >= lo - HOUR && r.ts < wake);
    const sleep = o.sleepEnds.some((t) => t >= win.from && t < win.to);
    if (room || sleep) out.push(d);
  }
  return out;
}

export const rowToCurve = (r: Row): TemperatureCurve | null =>
  Array.isArray(r.phases) && typeof r.id === 'string'
    ? { id: r.id, name: str(r.name, r.id), phases: r.phases as CurvePhase[], minC: num(r.min_c, 16), maxC: num(r.max_c, 24) }
    : null;

/** A night's curve: the stored row, else the built-in with that id, else the default. */
export function curveById(id: string | null | undefined, curves: readonly TemperatureCurve[] = []): TemperatureCurve {
  return curves.find((c) => c.id === id) ?? BUILTIN_CURVES.find((c) => c.id === id) ?? DEFAULT_CURVE;
}

let client: SupabaseClient | null = null;
/**
 * The one browser client. The session (Supabase Auth, email one-time code or magic link) persists in this browser
 * and refreshes itself; RLS then lets household members read. detectSessionInUrl picks up a magic-link redirect.
 */
export function supabaseClient(): SupabaseClient {
  return (client ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', {
    auth: {
      // Stay signed in on the home-screen app: the session lives in localStorage and refreshes itself.
      persistSession: true,
      autoRefreshToken: true,
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
      storageKey: 'sleeplab.auth',
      // Implicit flow: email links and admin-generated links (auth-admin) return #access_token, which works on any
      // device (PKCE would need the verifier from the browser that asked). ?token_hash links go through supabaseVerifyLink.
      flowType: 'implicit',
      detectSessionInUrl: true,
    },
  }));
}
const db = supabaseClient;

/**
 * Step 1 of sign-in: email a one-time code (and a magic link, depending on the project's email template).
 * shouldCreateUser is false: only invited addresses can sign in, so a stranger can't create an account here.
 */
export async function supabaseSignIn(email: string, redirectPath = '/signin'): Promise<string | null> {
  if (!supabaseConfigured()) return 'Supabase is not configured.';
  // The link in the email returns to this origin's /signin. It must match an entry in the project's Auth → URL
  // Configuration → Redirect URLs: otherwise Supabase silently sends the link to the Site URL instead (2026-10-30:
  // http://localhost:3000, a dead page that used up the link).
  const emailRedirectTo = typeof window !== 'undefined' ? `${window.location.origin}${redirectPath}` : undefined;
  const { error } = await db().auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo } });
  return error ? friendlyAuthError(error.message) : null;
}

/** Step 2: the 6-digit code from the email. */
export async function supabaseVerifyCode(email: string, code: string): Promise<string | null> {
  if (!supabaseConfigured()) return 'Supabase is not configured.';
  const { error } = await db().auth.verifyOtp({ email: email.trim(), token: code.replace(/\s+/g, ''), type: 'email' });
  return error ? friendlyAuthError(error.message) : null;
}

/** Email + password (set once from System › General › Account, or on the signed-in /signin page). */
export async function supabaseSignInWithPassword(email: string, password: string): Promise<string | null> {
  if (!supabaseConfigured()) return 'Supabase is not configured.';
  const { error } = await db().auth.signInWithPassword({ email: email.trim(), password });
  if (!error) return null;
  if (/invalid login credentials/i.test(error.message)) return 'That email and password don’t match. If you haven’t set a password yet, sign in with an email code first.';
  if (/email not confirmed/i.test(error.message)) return 'This address isn’t confirmed yet. Sign in once with an email code or link, then set a password.';
  return friendlyAuthError(error.message);
}

export const MIN_PASSWORD = 8;

/** Sets (or changes) the signed-in user's password. */
export async function supabaseSetPassword(password: string): Promise<string | null> {
  if (!supabaseConfigured()) return 'Supabase is not configured.';
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  const { error } = await db().auth.updateUser({ password });
  if (!error) return null;
  if (/same.*password|different from the old/i.test(error.message)) return 'That’s already your password.';
  if (/weak|pwned|leaked/i.test(error.message)) return 'Supabase rejected that password as too weak. Try a longer one.';
  if (/reauthentication|recent/i.test(error.message)) return 'For safety, sign in again (email code or link), then set the password.';
  return friendlyAuthError(error.message);
}

/** Links of the form /signin?token_hash=…&type=magiclink (custom email templates / admin links). */
export async function supabaseVerifyLink(tokenHash: string, type: string): Promise<string | null> {
  if (!supabaseConfigured()) return 'Supabase is not configured.';
  // Sign-in links only: a recovery/invite/email_change hash in someone else's link must not change this session.
  if (type !== 'magiclink' && type !== 'email') return 'This link is not a sign-in link.';
  const t = type as 'magiclink' | 'email';
  const { error } = await db().auth.verifyOtp({ token_hash: tokenHash, type: t });
  return error ? friendlyAuthError(error.message) : null;
}

export async function supabaseSignOut(): Promise<void> {
  if (!supabaseConfigured()) return;
  await db().auth.signOut({ scope: 'local' });
}

function friendlyAuthError(msg: string): string {
  if (/signups? not allowed|user not found|otp_disabled/i.test(msg)) return 'This email isn’t on the household list. Ask the owner to invite it.';
  if (/expired|invalid/i.test(msg)) return 'That code has expired or doesn’t match. Request a new one.';
  if (/email rate limit|over_email_send_rate_limit/i.test(msg)) return 'The email limit for this hour is used up. Sign in with your password instead, or try a code again later.';
  if (/rate|security purposes|too many/i.test(msg)) return 'Too many tries. Wait a minute, then try again.';
  return msg;
}

/** What a signed-in user can see: membership (RLS hides other rows) and whether any real data has arrived. */
export interface BackendProbe {
  member: boolean;
  personId: string | null;
  role: string | null;
  /** Readings from a real sensor (source other than 'sim'). */
  realReadings: number;
  /** Google Health payloads archived (the seed never writes these). */
  healthRows: number;
  /** Any nights at all (simulated seed included). */
  nights: number;
  devices: { id: string; kind: string; name: string }[];
}

export async function probeBackend(userId: string): Promise<BackendProbe> {
  const c = db();
  const head = { count: 'exact' as const, head: true };
  const [m, rr, hr, ni, dv] = await Promise.all([
    c.from('household_members').select('person_id,role').eq('user_id', userId).maybeSingle(),
    c.from('readings').select('ts', head).neq('source', 'sim'),
    c.from('raw_health').select('id', head),
    c.from('nights').select('date', head),
    c.from('devices').select('device_id,kind,name'),
  ]);
  if (m.error) throw new Error(m.error.message);
  const row = m.data as Row | null;
  return {
    member: Boolean(row),
    personId: row ? (typeof row.person_id === 'string' ? row.person_id : null) : null,
    role: row ? str(row.role) : null,
    realReadings: rr.count ?? 0,
    healthRows: hr.count ?? 0,
    nights: ni.count ?? 0,
    devices: ((dv.data ?? []) as Row[]).map((d) => ({ id: str(d.device_id), kind: str(d.kind), name: str(d.name) })),
  };
}

/**
 * Binds the signed-in account to its person with a one-time household code (migration 0005: the owner creates it
 * with private.create_household_claim in the SQL editor). Returns an error message, or null on success.
 */
export async function claimHousehold(code: string): Promise<string | null> {
  if (!supabaseConfigured()) return 'Supabase is not configured.';
  const clean = code.replace(/[^0-9a-z]/gi, '');
  if (clean.length < 24) return 'The code has 24 characters (letters A–F and digits), e.g. 1A2B-3C4D-….';
  const { error } = await db().rpc('claim_household', { p_code: clean });
  if (!error) return null;
  if (/invalid or expired/i.test(error.message)) return 'That code doesn’t match, was already used, or has expired. Ask the owner for a new one.';
  if (/already linked/i.test(error.message)) return 'This person is already linked to another account.';
  return error.message;
}

/** Stores this browser's push subscription for the signed-in member (RPC checks household membership). */
export async function pushSubscribe(sub: PushSubscriptionJSON, userAgent: string): Promise<string | null> {
  if (!supabaseConfigured()) return 'Supabase is not configured.';
  const { endpoint, keys } = sub;
  if (!endpoint || !keys?.p256dh || !keys.auth) return 'The browser returned an incomplete subscription.';
  const { error } = await db().rpc('register_push_subscription', { p_endpoint: endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth, p_user_agent: userAgent.slice(0, 200) });
  return error ? error.message : null;
}

export async function supabaseUserEmail(): Promise<string | null> {
  if (!supabaseConfigured()) return null;
  const { data } = await db().auth.getSession();
  return data.session?.user.email ?? null;
}

/** Edge Functions base URL (NEXT_PUBLIC_FUNCTIONS_URL overrides, e.g. behind a custom domain). */
export function functionsUrl(): string {
  const o = process.env.NEXT_PUBLIC_FUNCTIONS_URL;
  if (o) return o.replace(/\/$/, '');
  return `${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '')}/functions/v1`;
}

/** First finite number under any of `keys`, depth-first (Google daily payloads are nested; mirrors the backend's findNumber). */
export function findNumber(v: unknown, keys: string[]): number | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  for (const k of keys) {
    const x = (v as Row)[k];
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  }
  for (const x of Object.values(v as Row)) {
    const n = findNumber(x, keys);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** respRate / tempDeviationC from health_daily rows, as supabase/functions/_shared/load.ts dailyExtras does. */
export function dailyExtras(rows: Row[]): Pick<PersonNight, 'respRate' | 'tempDeviationC'> {
  const out: Pick<PersonNight, 'respRate' | 'tempDeviationC'> = {};
  for (const r of rows) {
    const t = str(r.data_type);
    if (t === 'daily-sleep-temperature-derivations') {
      const n = findNumber(r.value, ['nightlyTemperatureCelsius']);
      const b = findNumber(r.value, ['baselineTemperatureCelsius']);
      if (n !== undefined && b !== undefined) out.tempDeviationC = Math.round((n - b) * 100) / 100;
    } else if ((t === 'daily-respiratory-rate' || t === 'respiratory-rate-sleep-summary') && out.respRate === undefined) {
      const v = findNumber(r.value, ['breathsPerMinute', 'fullSleepBreathsPerMinute', 'averageBreathsPerMinute']);
      if (v !== undefined) out.respRate = v;
    }
  }
  return out;
}

type Vitals = Pick<PersonNight, 'steps' | 'restingHr' | 'hrvDailyMs' | 'deepRmssdMs'>;

/**
 * Daily vitals for one night from health_vitals_daily (migration 0003), as the backend's vitalsFromRows does:
 * steps from the day before the wake date (the day leading into the night), resting HR / daily HRV from the wake date.
 */
export function vitalsFor(rows: Row[], date: string): Vitals {
  const prev = rows.find((r) => str(r.date) === addDays(date, -1));
  const same = rows.find((r) => str(r.date) === date);
  const out: Vitals = {};
  const set = (k: keyof Vitals, v: unknown) => {
    const n = num(v);
    if (Number.isFinite(n)) out[k] = n;
  };
  set('steps', prev?.steps);
  set('restingHr', same?.resting_hr);
  set('hrvDailyMs', same?.hrv_daily_ms);
  set('deepRmssdMs', same?.deep_rmssd_ms);
  return out;
}

/** Same rule as the backend's effectiveCommands: drop failed sends, and dry runs once a night has live commands. */
export function effectiveCommandRows(rows: Row[]): Row[] {
  const ok = rows.filter((r) => r.sent_ok !== false);
  return ok.some((r) => r.dry_run !== true) ? ok.filter((r) => r.dry_run !== true) : ok;
}

/** The room meter: NEXT_PUBLIC_METER_DEVICE_ID, else the devices row of kind 'meter', else the simulated meter. */
async function meterDeviceId(): Promise<string | null> {
  const env = process.env.NEXT_PUBLIC_METER_DEVICE_ID;
  if (env) return env;
  const { data } = await db().from('devices').select('device_id,kind,name');
  const rows = (data ?? []) as Row[];
  const pick = rows.find((r) => r.kind === 'meter') ?? rows.find((r) => r.kind === 'sim' && /meter/i.test(`${str(r.device_id)} ${str(r.name)}`));
  return pick ? str(pick.device_id) : null;
}

const toStages = (v: unknown): StageSegment[] =>
  Array.isArray(v) ? (v as Row[]).map((x) => ({ start: ms(x.start), end: ms(x.end), stage: str(x.stage, 'light') as StageSegment['stage'] })).filter((x) => Number.isFinite(x.start)) : [];

export function createSupabaseSource(days = 90): DataSource {
  let dataset: Promise<Dataset> | null = null;
  let meter: string | null | undefined;
  const readingsQ = () => {
    const q = db().from('readings').select('ts,temp_c,rh,co2,source');
    return meter ? q.eq('device_id', meter) : q;
  };
  const details = new Map<string, Promise<NightDetail>>();
  /** Per night: facts the Night type doesn't carry (filled by load, the report is fetched on demand). */
  const infos = new Map<string, Omit<RealNightInfo, 'report'>>();
  const reports = new Map<string, Promise<RealNightInfo['report']>>();

  async function load(onProgress?: (m: string) => void): Promise<Dataset> {
    const now = Date.now();
    const fromDate = addDays(ictDate(now), -days);
    const from = ictMidnight(fromDate) - 6 * HOUR;
    const iso = new Date(from).toISOString();
    onProgress?.('Loading nights…');
    meter ??= await meterDeviceId();
    const [nightsRes, curveRows, firstRes] = await Promise.all([
      db().from('nights').select('*').gte('date', fromDate).order('date'),
      pageAll(() => db().from('curves').select('id,name,phases,min_c,max_c')).catch(() => [] as Row[]),
      readingsQ().order('ts').limit(1),
    ]);
    if (nightsRes.error) throw new Error(nightsRes.error.message);
    const nightRows = new Map(((nightsRes.data ?? []) as Row[]).map((r) => [str(r.date), r]));
    const curves = curveRows.flatMap((r) => rowToCurve(r) ?? []);
    const firstEver = firstRes.data?.[0] ? ms((firstRes.data[0] as Row).ts) : null;
    onProgress?.('Loading room readings…');
    const raw = (await pageAll(() => readingsQ().gte('ts', iso).order('ts'))).map(toReading);
    onProgress?.('Loading aircon log…');
    const [acRows, eventRows, outdoorRows] = await Promise.all([
      pageAll(() => db().from('ac_commands').select('*').gte('ts', iso).order('ts')),
      pageAll(() => db().from('events').select('night_date,kind,start_ts,end_ts,confidence,detail,source').gte('start_ts', iso).order('start_ts')).catch(() => [] as Row[]),
      // Outdoor weather every 15 min (weather-poll, migration 0018); none → the outdoor charts stay empty.
      pageAll(() => db().from('outdoor_readings').select('ts,temp_c,rh,source').neq('source', 'sim').gte('ts', iso).order('ts')).catch(() => [] as Row[]),
    ]);
    const outdoorAll = outdoorRows.map((r) => ({ ts: ms(r.ts), tempC: num(r.temp_c), rh: num(r.rh) })).filter((o) => Number.isFinite(o.tempC) && Number.isFinite(o.rh));
    onProgress?.('Loading body data…');
    const [peopleRows, sessions, hr, hrv, spo2, daily, vitals] = await Promise.all([
      pageAll(() => db().from('people').select('id,name,color_key').order('id')),
      pageAll(() => db().from('sleep_sessions').select('person_id,start_ts,end_ts,stages,update_time').gte('end_ts', iso).order('end_ts')),
      pageAll(() => db().from('health_hr').select('person_id,ts,bpm').gte('ts', iso).order('ts')),
      pageAll(() => db().from('health_hrv').select('person_id,ts,rmssd_ms').gte('ts', iso).order('ts')),
      pageAll(() => db().from('health_spo2').select('person_id,ts,pct').gte('ts', iso).order('ts')),
      pageAll(() => db().from('health_daily').select('person_id,data_type,date,value').gte('date', fromDate)),
      // A project without migration 0003 has no vitals table: degrade to no vitals instead of failing the load.
      pageAll(() => db().from('health_vitals_daily').select('person_id,date,steps,resting_hr,hrv_daily_ms,deep_rmssd_ms').gte('date', addDays(fromDate, -1))).catch(() => [] as Row[]),
    ]);
    const people: Person[] = peopleRows.map((r) => ({ id: str(r.id), name: str(r.name, str(r.id)), colorKey: str(r.color_key, 'personA') }));
    const dailyFor = (pid: string, date: string) => ({
      ...dailyExtras(daily.filter((d) => d.person_id === pid && d.date === date)),
      ...vitalsFor(vitals.filter((v) => v.person_id === pid), date),
    });
    const schedule = new Map(
      [...nightRows].map(([d, r]) => [d, { lightsOut: ms(r.lights_out) || defaultLightsOut(d), wake: ms(r.wake) || defaultWake(d) }]),
    );
    const dates = realNightDates({ now, fromDate, readings: raw, rows: schedule, sleepEnds: sessions.map((x) => ms(x.end_ts)) });
    infos.clear();

    const nights: Night[] = dates.map((date) => {
      const r = nightRows.get(date) ?? ({} as Row);
      const lightsOut = schedule.get(date)?.lightsOut ?? defaultLightsOut(date);
      const wake = schedule.get(date)?.wake ?? defaultWake(date);
      const sleepOnset = r.sleep_onset ? ms(r.sleep_onset) : undefined;
      const { from: winFrom, to: winTo } = nightWindow(date);
      const tags = (Array.isArray(r.tags) ? r.tags : []) as TagKey[];
      // The sleep session that ends closest to this night's wake time, per person.
      const nightPeople: PersonNight[] = people.flatMap((p) => {
        const s = sessions
          .filter((x) => x.person_id === p.id && Math.abs(ms(x.end_ts) - wake) < 6 * HOUR)
          .sort((a, b) => Math.abs(ms(a.end_ts) - wake) - Math.abs(ms(b.end_ts) - wake))[0];
        if (!s) return [];
        const sleep: SleepSession = { personId: p.id, start: ms(s.start_ts), end: ms(s.end_ts), stages: toStages(s.stages), updateTime: s.update_time ? ms(s.update_time) : undefined };
        const inS = (x: Row) => x.person_id === p.id && ms(x.ts) >= sleep.start - HOUR && ms(x.ts) <= sleep.end + HOUR;
        return [{
          personId: p.id,
          sleep,
          hr: hr.filter(inS).map((x) => ({ ts: ms(x.ts), bpm: num(x.bpm) })),
          hrv: hrv.filter(inS).map((x) => ({ ts: ms(x.ts), rmssdMs: num(x.rmssd_ms) })),
          spo2: spo2.filter(inS).map((x) => ({ ts: ms(x.ts), pct: num(x.pct) })),
          ...dailyFor(p.id, date),
        }];
      });
      const mine = acRows.filter((x) => str(x.night_date) === date || (!x.night_date && ms(x.ts) >= winFrom && ms(x.ts) < winTo));
      const ac = effectiveCommandRows(mine);
      const { readings: room, quality } = cleanNight(raw, { from: winFrom, to: winTo, lightsOut, wake, now, firstEver });
      infos.set(date, {
        date,
        quality,
        control: !ac.length ? 'manual' : ac.some((x) => x.dry_run !== true) ? 'live' : 'dry-run',
        acCount: ac.length,
        precool: { status: typeof r.precool_status === 'string' ? r.precool_status : null, reason: typeof r.precool_reason === 'string' ? r.precool_reason : null, at: r.precool_at ? ms(r.precool_at) : null },
        sleepOnset: sleepOnset ?? null,
        storedEvents: eventRows.filter((e) => str(e.night_date) === date).length,
      });
      return {
        date,
        lightsOut,
        wake,
        ...(sleepOnset ? { sleepOnset } : {}),
        room,
        outdoor: outdoorAll.filter((o) => o.ts >= winFrom && o.ts < winTo),
        ac: ac.map(toAcCommand),
        curveId: str(r.curve_id, DEFAULT_CURVE.id),
        // Same rule as the backend (night_metrics flag manual_night): no live command = run by hand, so core scores the
        // room against the steady comfort target instead of the stored plan.
        manual: !ac.some((x) => x.dry_run !== true),
        // The backend's detector rows when it wrote any; otherwise the engine detects events in the browser.
        events: eventRows.filter((e) => str(e.night_date) === date || (!e.night_date && ms(e.start_ts) >= lightsOut && ms(e.start_ts) < wake)).map(toEvent),
        people: nightPeople,
        tags,
      };
    });
    if (!nights.length) {
      return { source: 'supabase', people, nights: [], room: [], person: {}, generatedAt: now, computeMs: 0, clipTs: now + DAY, curves };
    }
    onProgress?.('Computing metrics…');
    const ds = await runEngine<Dataset>({ type: 'compute', nights, source: 'supabase', clipTs: now + DAY, curves });
    return { ...ds, curves };
  }

  async function loadReport(date: string): Promise<RealNightInfo['report']> {
    const { data, error } = await db().from('reports').select('report,generated_by,created_at,final').eq('date', date).maybeSingle();
    if (error || !data) return null;
    const row = data as Row;
    const rep = (row.report ?? {}) as Row;
    const headline = str(rep.headline);
    if (!headline) return null;
    return {
      headline,
      insights: Array.isArray(rep.insights) ? (rep.insights as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      generatedBy: str(row.generated_by, str(rep.generatedBy, 'rules')),
      createdAt: row.created_at ? ms(row.created_at) : null,
      final: row.final === true,
    };
  }

  return {
    kind: 'supabase',
    label: 'Supabase',
    loadDataset(onProgress) {
      dataset ??= load(onProgress).catch((e) => {
        dataset = null;
        throw e;
      });
      return dataset;
    },
    loadNightDetail(date) {
      let d = details.get(date);
      if (!d) {
        d = runEngine<NightDetail>({ type: 'detail', date });
        details.set(date, d);
        d.catch(() => details.delete(date));
      }
      return d;
    },
    async nightInfo(date) {
      if (dataset) await dataset.catch(() => null);
      const base = infos.get(date);
      if (!base) return null;
      let r = reports.get(date);
      if (!r) {
        r = loadReport(date).catch(() => null);
        reports.set(date, r);
      }
      return { ...base, report: await r };
    },
    async liveReading() {
      meter ??= await meterDeviceId();
      const { data, error } = await readingsQ().order('ts', { ascending: false }).limit(1);
      if (error || !data?.[0]) return null;
      return toReading(data[0] as Row);
    },
    async liveWindow(from, to) {
      meter ??= await meterDeviceId();
      const rows = await pageAll(() => readingsQ().gte('ts', new Date(from).toISOString()).lte('ts', new Date(to).toISOString()).order('ts'), 5000);
      return cleanNight(rows.map(toReading), { from, to: to + MIN, lightsOut: from, wake: to, now: to + MIN, firstEver: null }).readings;
    },
  };
}

/** Tonight's curve id from its nights row (null = no row yet: the backend will create it with the default curve). */
export async function fetchNightCurveId(date: string): Promise<string | null> {
  if (!supabaseConfigured()) return null;
  const { data } = await db().from('nights').select('curve_id').eq('date', date).maybeSingle();
  const id = (data as Row | null)?.curve_id;
  return typeof id === 'string' ? id : null;
}
