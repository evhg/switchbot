// Pulls Google Health API v4 data for each connected person: the last 36 h of heart rate, HRV and SpO2
// (dataSourceFamily google-wearables), the last 7 days of sleep and daily types (Google reprocesses nights).
// Everything returned is appended to raw_health; derived tables are upserted from the core parsers.
// Body: {mode?: 'full' | 'queue', personId?, hours?, sleepDays?}. Called by pg_cron, by the webhook, or by a
// household member ("sync now").
import {
  GoogleHealthClient,
  GoogleHealthError,
  GoogleOAuthError,
  type ListDataPointsOptions,
  parseHeartRate,
  parseHrv,
  parseSleep,
  parseSpo2,
  refreshAccessToken,
  intervalFilter,
  sampleTimeFilter,
} from '../../../packages/core/src/index.ts';
import { requireCronOrMember } from '../_shared/auth.ts';
import { env } from '../_shared/env.ts';
import { DAILY_TYPES, dailyRows, rawRows, SAMPLE_TYPES, sessionEndTime } from '../_shared/health.ts';
import { json, readJson, serve } from '../_shared/http.ts';
import { hrMinuteRows, hrvToRows, sleepToRow, spo2ToRows } from '../_shared/rows.ts';
import { type Db, must, serviceClient, upsertChunks } from '../_shared/supabase.ts';
import { DAY, HOUR, ictDate, utcDay } from '../_shared/time.ts';

interface PersonResult {
  personId: string;
  ok: boolean;
  calls: number;
  counts: Record<string, number>;
  errors: string[];
}

serve(async (req) => {
  const db = serviceClient();
  await requireCronOrMember(req, db);
  const body = await readJson(req);
  const mode = body.mode === 'queue' ? 'queue' : 'full';
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
  return json({ ok: results.every((r) => r.ok), mode, jobs: jobIds.length, results });
});

async function connectedPeople(db: Db): Promise<string[]> {
  const rows = must(await db.from('oauth_tokens').select('person_id').eq('needs_reconsent', false), 'oauth_tokens') as { person_id: string }[];
  return rows.map((r) => r.person_id);
}

async function syncPerson(db: Db, personId: string, hours: number, sleepDays: number): Promise<PersonResult> {
  const res: PersonResult = { personId, ok: true, calls: 0, counts: {}, errors: [] };
  const refresh = must(await db.rpc('get_google_refresh_token', { p_person_id: personId }), 'get token') as string | null;
  if (!refresh) return { ...res, ok: false, errors: ['no refresh token; run google-oauth/start'] };

  let accessToken: string;
  try {
    const t = await refreshAccessToken({ clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET'), refreshToken: refresh });
    accessToken = t.accessToken;
    if (t.refreshToken && t.refreshToken !== refresh) {
      await db.rpc('store_google_refresh_token', { p_person_id: personId, p_refresh_token: t.refreshToken, p_scopes: t.scope });
    }
  } catch (e) {
    const reconsent = e instanceof GoogleOAuthError && e.error === 'invalid_grant';
    await db.from('oauth_tokens').update({ needs_reconsent: reconsent, last_error: String(e instanceof Error ? e.message : e) }).eq('person_id', personId);
    return { ...res, ok: false, errors: [`token refresh: ${e instanceof Error ? e.message : e}`] };
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
  const archive = async (dataType: string, points: unknown[]) => {
    const rows = await rawRows(personId, dataType, points);
    await upsertChunks(db, 'raw_health', rows as unknown as Record<string, unknown>[], 'person_id,data_type,point_key,update_time', { ignoreDuplicates: true });
  };

  for (const dataType of SAMPLE_TYPES) {
    await step(dataType, async () => {
      const points = await pull(dataType, { filter: sampleTimeFilter(dataType, from, now), dataSourceFamily: 'google-wearables', pageSize: 10_000 });
      await archive(dataType, points);
      if (dataType === 'heart-rate') {
        return upsertChunks(db, 'health_hr', hrMinuteRows(personId, parseHeartRate(points)), 'person_id,ts');
      }
      if (dataType === 'heart-rate-variability') return upsertChunks(db, 'health_hrv', hrvToRows(personId, parseHrv(points)), 'person_id,ts');
      return upsertChunks(db, 'health_spo2', spo2ToRows(personId, parseSpo2(points)), 'person_id,ts');
    });
  }

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
    await step(dataType, async () => {
      const since = utcDay(sleepFrom);
      const points = await pull(dataType, { filter: `${dataType.replace(/-/g, '_')}.date >= "${since}"`, pageSize: 25 }, { pageSize: 14 });
      await archive(dataType, points);
      return upsertChunks(db, 'health_daily', dailyRows(personId, dataType, points), 'person_id,data_type,date');
    });
  }

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

/** Stores healthUserId so webhook notifications can be mapped to a person. */
async function ensureIdentity(db: Db, client: GoogleHealthClient, personId: string) {
  const { data } = await db.from('people').select('google_health_user_id').eq('id', personId).maybeSingle();
  if ((data as { google_health_user_id?: string | null } | null)?.google_health_user_id) return;
  const id = await client.identity();
  if (!id.healthUserId) return;
  await db.from('people').update({ google_health_user_id: id.healthUserId }).eq('id', personId);
  await db.from('oauth_tokens').update({ health_user_id: id.healthUserId }).eq('person_id', personId);
}
