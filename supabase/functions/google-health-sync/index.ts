// Pulls Google Health API v4 data for each connected person: the last 36 h of heart rate, HRV and SpO2
// (dataSourceFamily google-wearables), steps from local midnight at the start of that window (whole ICT days),
// and the last 7 days of sleep and daily types (Google reprocesses nights).
// Everything returned is appended to raw_health; derived tables are upserted from the core parsers. Steps,
// daily resting HR and daily HRV also land in health_vitals_daily for the Today dashboard.
// Body: {mode?: 'full' | 'queue', personId?, hours?, sleepDays?}. Called by pg_cron, by the webhook, or by a
// household member ("Sync now" in the PWA: full mode, at most once per 2 min per person, 429 otherwise).
// After each person it writes public.band_sync (migration 0015): last run, pairedDevices lastSyncTime and the newest
// wearable data point, which the Presence page shows and a presence gate may later read as a hint.
import { GoogleHealthClient, GoogleHealthError, type ListDataPointsOptions, intervalFilter, sampleTimeFilter } from '../../../packages/core/src/health/client.ts';
import { GoogleOAuthError, refreshAccessToken } from '../../../packages/core/src/health/oauth.ts';
import { parseHeartRate, parseHrv, parseSleep, parseSpo2 } from '../../../packages/core/src/health/parse.ts';
import { requireCronOrMember } from '../_shared/auth.ts';
import { env } from '../_shared/env.ts';
import { DAILY_TYPES, dailyRows, dailyVitalsRows, newestDeviceSync, newestPointTime, rawRows, SAMPLE_TYPES, sessionEndTime, stepsVitalsRows } from '../_shared/health.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { hrMinuteRows, hrvToRows, sleepToRow, spo2ToRows } from '../_shared/rows.ts';
import { type Db, must, serviceClient, upsertChunks } from '../_shared/supabase.ts';
import { DAY, HOUR, ictAt, ictDate, iso, utcDay } from '../_shared/time.ts';

/** Manual "Sync now" from the PWA: once per person per this interval. */
const MANUAL_SYNC_MIN_MS = 2 * 60_000;

interface PersonResult {
  personId: string;
  ok: boolean;
  calls: number;
  counts: Record<string, number>;
  errors: string[];
  deviceLastSyncAt?: string | null;
  newestPointAt?: string | null;
}

serve(async (req) => {
  const db = serviceClient();
  const caller = await requireCronOrMember(req, db);
  const manual = caller !== 'cron';
  const body = await readJson(req);
  const mode = body.mode === 'queue' && !manual ? 'queue' : 'full';
  const hours = typeof body.hours === 'number' ? Math.min(24 * 14, Math.max(1, body.hours)) : 36;
  const sleepDays = typeof body.sleepDays === 'number' ? Math.min(30, Math.max(1, body.sleepDays)) : 7;

  let personIds: string[];
  let jobIds: number[] = [];
  const backfill = new Set<string>();
  if (mode === 'queue') {
    const jobs = must(await db.rpc('claim_health_sync_jobs', { p_limit: 50 }), 'claim jobs') as { id: number; person_id: string | null; reason: string }[];
    if (!jobs.length) return json({ ok: true, mode, jobs: 0 });
    jobIds = jobs.map((j) => j.id);
    const all = jobs.some((j) => !j.person_id);
    personIds = all ? await connectedPeople(db) : [...new Set(jobs.map((j) => j.person_id!))];
    // A fresh OAuth connection backfills two weeks.
    for (const j of jobs) if (j.reason === 'oauth' && j.person_id) backfill.add(j.person_id);
  } else {
    personIds = typeof body.personId === 'string' ? [body.personId] : await connectedPeople(db);
  }
  let limited: string[] = [];
  if (manual) {
    if (!personIds.length) return json({ ok: false, error: 'no band connected yet', results: [] }, 409);
    const claimed = await claimManualSync(db, personIds);
    limited = personIds.filter((p) => !claimed.includes(p));
    personIds = claimed;
    if (!personIds.length) {
      throw new HttpError(429, 'synced less than 2 minutes ago; try again shortly');
    }
  }

  const results: PersonResult[] = [];
  for (const personId of personIds) {
    const bf = backfill.has(personId);
    results.push(await syncPerson(db, personId, bf ? 14 * 24 : hours, bf ? 14 : sleepDays));
  }

  if (jobIds.length) {
    const errors = results.filter((r) => !r.ok).map((r) => `${r.personId}: ${r.errors.join('; ')}`).join(' | ');
    const done = await db.from('health_sync_jobs').update({ done_at: new Date().toISOString(), error: errors || null }).in('id', jobIds);
    if (done.error) console.error('health_sync_jobs', done.error.message);
  }
  return json({ ok: results.every((r) => r.ok), mode, jobs: jobIds.length, results, ...(limited.length ? { rateLimited: limited } : {}) });
});

/**
 * Atomically stamps band_sync.last_manual_sync_at for each person whose last manual sync is older than 2 min and
 * returns those people; the others are rate-limited.
 */
async function claimManualSync(db: Db, personIds: string[]): Promise<string[]> {
  const now = Date.now();
  await db.from('band_sync').upsert(personIds.map((person_id) => ({ person_id })), { onConflict: 'person_id', ignoreDuplicates: true });
  const r = await db
    .from('band_sync')
    .update({ last_manual_sync_at: iso(now) })
    .in('person_id', personIds)
    .or(`last_manual_sync_at.is.null,last_manual_sync_at.lt.${iso(now - MANUAL_SYNC_MIN_MS)}`)
    .select('person_id');
  return (must(r, 'band_sync claim') as { person_id: string }[]).map((x) => x.person_id);
}

async function connectedPeople(db: Db): Promise<string[]> {
  const rows = must(await db.from('oauth_tokens').select('person_id').eq('needs_reconsent', false), 'oauth_tokens') as { person_id: string }[];
  return rows.map((r) => r.person_id);
}

async function syncPerson(db: Db, personId: string, hours: number, sleepDays: number): Promise<PersonResult> {
  const res: PersonResult = { personId, ok: true, calls: 0, counts: {}, errors: [] };
  const refresh = must(await db.rpc('get_google_refresh_token', { p_person_id: personId }), 'get token') as string | null;
  if (!refresh) {
    const out = { ...res, ok: false, errors: ['no refresh token; connect Google Health in the app'] };
    await writeBandSync(db, out);
    return out;
  }

  let accessToken: string;
  try {
    const t = await refreshAccessToken({ clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET'), refreshToken: refresh });
    accessToken = t.accessToken;
    if (t.refreshToken && t.refreshToken !== refresh) {
      await db.rpc('store_google_refresh_token', { p_person_id: personId, p_refresh_token: t.refreshToken, ...(t.scope.length ? { p_scopes: t.scope } : {}) });
    }
  } catch (e) {
    const reconsent = e instanceof GoogleOAuthError && e.error === 'invalid_grant';
    await db.from('oauth_tokens').update({ needs_reconsent: reconsent, last_error: String(e instanceof Error ? e.message : e) }).eq('person_id', personId);
    const out = { ...res, ok: false, errors: [`token refresh: ${e instanceof Error ? e.message : e}`] };
    await writeBandSync(db, out);
    return out;
  }

  const countingFetch = (i: string, init?: RequestInit) => {
    res.calls++;
    return fetch(i, init);
  };
  const client = new GoogleHealthClient(accessToken, countingFetch, { maxRetries: 1, maxRetryWaitMs: 5_000 });
  const now = Date.now();
  const from = now - hours * HOUR;
  const sleepFrom = now - sleepDays * DAY;

  await ensureIdentity(db, client, personId).catch((e) => res.errors.push(`identity: ${e}`));

  const pull = async (dataType: string, primary: ListDataPointsOptions, fallback?: ListDataPointsOptions, maxPages = 20) => {
    try {
      return await client.listAll(dataType, primary, { maxPages });
    } catch (e) {
      // Filter paths for daily/summary types aren't confirmed; retry with the newest page only.
      if (fallback && e instanceof GoogleHealthError && e.status === 400) return await client.listAll(dataType, fallback, { maxPages: 1 });
      throw e;
    }
  };
  const step = async (dataType: string, work: () => Promise<number>) => {
    try {
      res.counts[dataType] = await work();
    } catch (e) {
      // 412 = no Google Health profile yet / 403 = scope not granted: per-type, not fatal.
      res.ok = false;
      res.errors.push(`${dataType}: ${e instanceof Error ? e.message : e}`);
    }
  };
  let newest: number | null = null;
  const seen = (points: unknown[]) => {
    const t = newestPointTime(points);
    if (t !== null && t <= now + HOUR && (newest === null || t > newest)) newest = t;
  };
  const archive = async (dataType: string, points: unknown[]) => {
    const rows = await rawRows(personId, dataType, points);
    await upsertChunks(db, 'raw_health', rows as unknown as Record<string, unknown>[], 'person_id,data_type,point_key,update_time', { ignoreDuplicates: true });
  };

  for (const dataType of SAMPLE_TYPES) {
    await step(dataType, async () => {
      const points = await pull(dataType, { filter: sampleTimeFilter(dataType, from, now), dataSourceFamily: 'google-wearables', pageSize: 10_000 });
      seen(points);
      await archive(dataType, points);
      if (dataType === 'heart-rate') {
        return upsertChunks(db, 'health_hr', hrMinuteRows(personId, parseHeartRate(points)), 'person_id,ts');
      }
      if (dataType === 'heart-rate-variability') return upsertChunks(db, 'health_hrv', hrvToRows(personId, parseHrv(points)), 'person_id,ts');
      return upsertChunks(db, 'health_spo2', spo2ToRows(personId, parseSpo2(points)), 'person_id,ts');
    });
  }

  await step('steps', async () => {
    // 1-min intervals; whole local days so each daily total is complete (today's grows with every sync).
    const stepsFrom = ictAt(ictDate(from), '00:00');
    const points = await pull('steps', { filter: intervalFilter('steps', stepsFrom, now), dataSourceFamily: 'google-wearables', pageSize: 10_000 });
    seen(points);
    await archive('steps', points);
    return upsertChunks(db, 'health_vitals_daily', stepsVitalsRows(personId, points), 'person_id,date');
  });

  await step('sleep', async () => {
    // dataSourceFamily isn't supported for sleep.
    const points = await pull('sleep', { filter: intervalFilter('sleep', sleepFrom, now, 'end_time'), pageSize: 25 });
    await archive('sleep', points);
    const rows = parseSleep(points, personId).map((s) => sleepToRow(s, 'google'));
    return upsertChunks(db, 'sleep_sessions', rows as unknown as Record<string, unknown>[], 'person_id,start_ts');
  });

  await step('respiratory-rate-sleep-summary', async () => {
    const t = 'respiratory-rate-sleep-summary';
    const points = await pull(t, { filter: sampleTimeFilter(t, sleepFrom, now), pageSize: 25 }, { pageSize: 10 });
    await archive(t, points);
    // Keyed by the ICT date the sleep ended (the wake date); the payload shape is unconfirmed, see health-data.md.
    const rows = dailyRows(personId, t, points, (p) => {
      const ts = sessionEndTime(p);
      return ts === null ? null : ictDate(ts);
    });
    return upsertChunks(db, 'health_daily', rows, 'person_id,data_type,date');
  });

  for (const dataType of DAILY_TYPES) {
    let points: unknown[] = [];
    await step(dataType, async () => {
      const since = utcDay(sleepFrom);
      points = await pull(dataType, { filter: `${dataType.replace(/-/g, '_')}.date >= "${since}"`, pageSize: 25 }, { pageSize: 14 });
      await archive(dataType, points);
      return upsertChunks(db, 'health_daily', dailyRows(personId, dataType, points), 'person_id,data_type,date');
    });
    // Own step so a vitals failure (e.g. migration 0003 not applied yet) doesn't mark health_daily as failed.
    if (points.length) await step(`${dataType}:vitals`, () => upsertChunks(db, 'health_vitals_daily', dailyVitalsRows(personId, dataType, points), 'person_id,date'));
  }

  // Band → phone sync time. Not fatal: pairedDevices may need a scope this app doesn't request (then 403).
  let devices: unknown[] | null = null;
  try {
    devices = (await client.pairedDevices()).pairedDevices ?? [];
    res.counts.pairedDevices = devices.length;
  } catch (e) {
    res.errors.push(`pairedDevices (not fatal): ${e instanceof Error ? e.message : e}`);
  }
  const devSync = devices ? newestDeviceSync(devices) : null;
  if (devSync !== null) res.deviceLastSyncAt = iso(devSync);
  if (newest !== null) res.newestPointAt = iso(newest);
  await writeBandSync(db, res, devices);

  await db.from('oauth_tokens').update({ last_sync_at: new Date().toISOString(), last_error: res.ok ? null : res.errors.join('; ').slice(0, 1000) })
    .eq('person_id', personId);
  const q = await db.rpc('bump_api_quota', { p_api: 'google_health', p_day: utcDay(now), p_calls: res.calls });
  await db.from('api_quota_log').insert({
    api: 'google_health',
    fn: 'google-health-sync',
    calls: res.calls,
    used_today: q.data ?? null,
    status: res.ok ? 'ok' : 'partial',
    note: res.errors.join('; ').slice(0, 1000) || null,
  });
  return res;
}

/** public.band_sync row of one run (migration 0015). Times only move forward; absent values keep the stored ones. */
async function writeBandSync(db: Db, r: PersonResult, devices: unknown[] | null = null) {
  const { data } = await db.from('band_sync').select('device_last_sync_at,newest_point_at').eq('person_id', r.personId).maybeSingle();
  const prev = (data ?? {}) as { device_last_sync_at?: string | null; newest_point_at?: string | null };
  const later = (a: string | null | undefined, b: string | null | undefined) => (!a ? b ?? null : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);
  const row: Record<string, unknown> = {
    person_id: r.personId,
    last_sync_at: iso(Date.now()),
    last_sync_ok: r.ok,
    last_error: r.errors.join('; ').slice(0, 1000) || null,
    device_last_sync_at: later(prev.device_last_sync_at, r.deviceLastSyncAt),
    newest_point_at: later(prev.newest_point_at, r.newestPointAt),
    updated_at: iso(Date.now()),
  };
  if (devices) row.devices = devices;
  const up = await db.from('band_sync').upsert(row, { onConflict: 'person_id' });
  if (up.error) console.error('band_sync', up.error.message);
}

/** Stores healthUserId so webhook notifications can be mapped to a person. */
async function ensureIdentity(db: Db, client: GoogleHealthClient, personId: string) {
  const { data } = await db.from('people').select('google_health_user_id').eq('id', personId).maybeSingle();
  if ((data as { google_health_user_id?: string | null } | null)?.google_health_user_id) return;
  const id = await client.identity();
  if (!id.healthUserId) return;
  await db.from('people').update({ google_health_user_id: id.healthUserId }).eq('id', personId);
  await db.from('oauth_tokens').update({ health_user_id: id.healthUserId }).eq('person_id', personId);
}
