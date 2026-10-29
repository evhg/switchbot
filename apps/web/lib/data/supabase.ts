// Read-only Supabase source. Columns follow supabase/migrations/0001_init.sql (+ 0003 health_vitals_daily); RLS only lets signed-in
// household members read, so the anon key alone returns nothing (see supabaseSignIn). The row → type
// mapping is isolated in the to* functions below so a migration rename is a one-line fix here. Sign-in state lives in
// lib/auth.tsx; this file only exposes the client and the auth calls.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AcCommand, AcMode, FanSpeed, Night, Person, PersonNight, RoomEvent, RoomEventKind, RoomReading, SleepSession, StageSegment, TagKey } from '@sleep-lab/core';
import { addDays, DAY, HOUR, ictDate, ictMidnight } from '../format.ts';
import { runEngine } from './engine-client.ts';
import type { Dataset, DataSource, NightDetail } from './types.ts';

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

let client: SupabaseClient | null = null;
/**
 * The one browser client. The session (Supabase Auth, email one-time code or magic link) persists in this browser
 * and refreshes itself; RLS then lets household members read. detectSessionInUrl picks up a magic-link redirect.
 */
export function supabaseClient(): SupabaseClient {
  return (client ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'sleeplab.auth' },
  }));
}
const db = supabaseClient;

/**
 * Step 1 of sign-in: email a one-time code (and a magic link, depending on the project's email template).
 * shouldCreateUser is false: only invited addresses can sign in, so a stranger can't create an account here.
 */
export async function supabaseSignIn(email: string, redirectPath = '/signin'): Promise<string | null> {
  if (!supabaseConfigured()) return 'Supabase is not configured.';
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

export async function supabaseSignOut(): Promise<void> {
  if (!supabaseConfigured()) return;
  await db().auth.signOut({ scope: 'local' });
}

function friendlyAuthError(msg: string): string {
  if (/signups? not allowed|user not found|otp_disabled/i.test(msg)) return 'This email isn’t on the household list. Ask the owner to invite it.';
  if (/expired|invalid/i.test(msg)) return 'That code has expired or doesn’t match. Request a new one.';
  if (/rate|security purposes|too many/i.test(msg)) return 'Too many tries. Wait a minute, then request a new code.';
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

  async function load(onProgress?: (m: string) => void): Promise<Dataset> {
    const now = Date.now();
    const fromDate = addDays(ictDate(now), -days);
    onProgress?.('Loading nights…');
    const nightsRes = await db().from('nights').select('*').gte('date', fromDate).order('date');
    if (nightsRes.error) throw new Error(nightsRes.error.message);
    const nightRows = (nightsRes.data ?? []) as Row[];
    // Signed in, but nothing has arrived yet: an empty dataset (the shell shows the onboarding state instead of charts).
    if (!nightRows.length) {
      const { data: ppl } = await db().from('people').select('id,name,color_key').order('id');
      const people: Person[] = ((ppl ?? []) as Row[]).map((r) => ({ id: str(r.id), name: str(r.name, str(r.id)), colorKey: str(r.color_key, 'personA') }));
      return { source: 'supabase', people, nights: [], room: [], person: {}, generatedAt: now, computeMs: 0, clipTs: now + DAY };
    }
    const from = ictMidnight(fromDate) - 6 * HOUR;
    onProgress?.('Loading room readings…');
    meter ??= await meterDeviceId();
    const readings = (await pageAll(() => readingsQ().gte('ts', new Date(from).toISOString()).order('ts'))).map(toReading);
    onProgress?.('Loading aircon log…');
    const acRows = await pageAll(() => db().from('ac_commands').select('*').gte('ts', new Date(from).toISOString()).order('ts'));
    const iso = new Date(from).toISOString();
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

    const nights: Night[] = nightRows.map((r) => {
      const date = str(r.date);
      const lightsOut = ms(r.lights_out) || ictMidnight(date) - 1.5 * HOUR;
      const wake = ms(r.wake) || ictMidnight(date) + 6.5 * HOUR;
      const winFrom = ictMidnight(date) - 6 * HOUR;
      const winTo = ictMidnight(date) + 12 * HOUR;
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
      return {
        date,
        lightsOut,
        wake,
        room: readings.filter((x) => x.ts >= winFrom && x.ts < winTo),
        outdoor: [],
        ac: effectiveCommandRows(acRows.filter((x) => str(x.night_date) === date || (!x.night_date && ms(x.ts) >= winFrom && ms(x.ts) < winTo))).map(toAcCommand),
        curveId: str(r.curve_id, 'default-v1'),
        events: [],
        people: nightPeople,
        tags,
      };
    });
    onProgress?.('Computing metrics…');
    return runEngine<Dataset>({ type: 'compute', nights, source: 'supabase', clipTs: now + DAY });
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
    async liveReading() {
      meter ??= await meterDeviceId();
      const { data, error } = await readingsQ().order('ts', { ascending: false }).limit(1);
      if (error || !data?.[0]) return null;
      return toReading(data[0] as Row);
    },
    async liveWindow(from, to) {
      meter ??= await meterDeviceId();
      const rows = await pageAll(() => readingsQ().gte('ts', new Date(from).toISOString()).lte('ts', new Date(to).toISOString()).order('ts'), 5000);
      return rows.map(toReading);
    },
  };
}
