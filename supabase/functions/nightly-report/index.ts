// Morning report: run the night analysis (_shared/analysis.ts: cleaned room readings → events, night_metrics,
// data-quality flags), build the rule report from the cleaned night and up to 14 earlier nights (room-only while no
// health data exists), add a data-quality caveat, let Claude reword it (grounded in the computed numbers; rules on
// any failure), store it in reports and send Web Push (VAPID keys from Vault, created on first use).
// Body: {date?: 'YYYY-MM-DD', push?: boolean, coach?: boolean} for an explicit run, or {auto: true} from pg_cron
// (every 15 min, 06:00-18:45 ICT, migration 0017), where shouldRun() decides whether anything is due.
// Analysis only (backfills / re-runs, no report, no push): {analyzeOnly: true, date?} — default date = the night that
// ended most recently — or {analyzeOnly: true, dates: [...]} (cron / service key only, ≤ 31 dates).
import { buildRuleReport } from '../../../packages/core/src/metrics/report.ts';
import { DEFAULT_PEOPLE } from '../../../packages/core/src/sim/people.ts';
import type { Night, NightReport, Person } from '../../../packages/core/src/types.ts';
import { analyzeNight, dataQualityFacts, lastEndedNightDate, qualityCaveat } from '../_shared/analysis.ts';
import { requireCronOrMember } from '../_shared/auth.ts';
import { applyCoach, coachFacts, COACH_MODEL, requestCoachText } from '../_shared/coach.ts';
import { knownDeviceId } from '../_shared/devices.ts';
import { NotConfiguredError, optEnv } from '../_shared/env.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { ensureNight, loadCurve, loadNight } from '../_shared/load.ts';
import { appUrl, pushToAll } from '../_shared/push.ts';
import type { NightRow } from '../_shared/rows.ts';
import { type Db, must, serviceClient } from '../_shared/supabase.ts';
import { addDays, HOUR, ictAt, ictDate, MIN, nightWindow } from '../_shared/time.ts';

const HISTORY_NIGHTS = 14;

interface ReportState {
  people_count: number;
  pushed_at: string | null;
  final: boolean;
}

serve(async (req) => {
  const db = serviceClient();
  const caller = await requireCronOrMember(req, db);
  const body = await readJson(req);
  const now = Date.now();
  const today = ictDate(now);
  if (body.analyzeOnly === true) return analyzeOnly(db, caller, body, now, today);
  const date = typeof body.date === 'string' ? body.date : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  // Members may regenerate recent nights only (each run can call Claude and creates a nights row).
  if (caller !== 'cron' && (date < addDays(today, -7) || date > today)) throw new HttpError(400, 'date must be within the last 7 days');
  const meterId = await meterDeviceId(db);

  const people = await loadPeople(db);
  const personIds = people.map((p) => p.id);
  const row = await ensureNight(db, date);

  let push = body.push !== false && caller === 'cron';
  if (caller !== 'cron' && body.push === true) push = true;
  let final = false;
  if (caller === 'cron' && body.auto === true) {
    const due = await shouldRun(db, row, now);
    if (!due.run) return json({ ok: true, date, skipped: due.reason });
    push = due.push;
    final = due.final;
  }

  const curve = await loadCurve(db, row.curve_id);
  // Night analysis: cleaned readings, detector events (manual / controller ones stay) and night_metrics.
  const analysis = await analyzeNight(db, row, { deviceId: meterId, personIds, curve });
  const night = analysis.night;
  if (!night.room.length && !night.people.length) return json({ ok: false, date, error: 'no room or body data for this night', flags: analysis.flags }, 404);

  const historyRows = must(
    await db.from('nights').select('*').lt('date', date).gte('date', addDays(date, -HISTORY_NIGHTS)).order('date', { ascending: false }),
    'history nights',
  ) as NightRow[];
  const history: Night[] = await Promise.all(
    historyRows.map((r) => loadNight(db, r, { deviceId: meterId, personIds, roomBucketMin: 5 })),
  );

  const rule = withCaveat(buildRuleReport(night, history, curve), qualityCaveat(analysis));
  const dataQuality = dataQualityFacts(analysis);
  let report: NightReport = rule;
  let model: string | null = null;
  let coachNote: string | null = null;
  const apiKey = optEnv('ANTHROPIC_API_KEY');
  if (apiKey && body.coach !== false) {
    const events = night.events.map((e) => ({
      kind: e.kind,
      at: new Date(e.start + 7 * 3_600_000).toISOString().slice(11, 16),
      ...(e.end ? { minutes: Math.round((e.end - e.start) / 60_000) } : {}),
    }));
    const facts = coachFacts(rule, people, night.tags, events, dataQuality);
    try {
      const out = await requestCoachText(facts, { apiKey, model: optEnv('ANTHROPIC_MODEL') ?? COACH_MODEL });
      const merged = applyCoach(rule, out.text, facts);
      report = merged.report;
      model = out.model;
      if (merged.dropped.length) coachNote = `dropped ungrounded: ${merged.dropped.join(' | ')}`;
    } catch (e) {
      coachNote = `coach failed, using rules: ${e instanceof Error ? e.message : e}`;
      console.warn(coachNote);
    }
  }

  // A failed push never loses the report; pushed_at is set once a push was attempted, so cron doesn't re-push.
  const pushed = push
    ? await pushToAll(db, { title: 'Last night', body: report.headline, navigate: `${appUrl()}/?date=${report.date}`, tag: `report-${report.date}` }, 'report', { urgency: 'normal' })
      .catch((e) => ({ skipped: `push failed: ${e instanceof Error ? e.message : e}` }))
    : null;
  const up = await db.from('reports').upsert(
    {
      date,
      report,
      rule_report: rule,
      generated_by: report.generatedBy,
      model,
      people_count: night.people.length,
      final: final || now >= finalAt(row),
      ...(pushed ? { pushed_at: new Date().toISOString() } : {}),
      created_at: new Date().toISOString(),
    },
    { onConflict: 'date' },
  );
  if (up.error) throw new Error(`reports: ${up.error.message}`);
  return json({ ok: true, date, generatedBy: report.generatedBy, model, coachNote, headline: report.headline, insights: report.insights, dataQuality, push: pushed });
});

/** After this the morning CO2 decay (wake → noon) is in, so a report generated later is final. */
function finalAt(row: NightRow): number {
  return Math.max(ictAt(row.date, '12:00'), Date.parse(row.wake) + 2 * HOUR);
}

/** First report: wake + 45 min (09:15 with an 08:30 wake), i.e. after the aircon's OFF at wake + 30. */
const FIRST_REPORT_MIN = 45;

/**
 * Scheduled mode: the first report (with push) once wake + 45 min has passed and every connected person's sleep
 * has synced (nobody connected = room-only, at once), or at wake + 4 h regardless; silent regenerates when more
 * people's sleep arrives (even after the report is final: hourly health sync + cron until 18:45) and once after
 * finalAt() for the morning ACH. Nothing otherwise.
 */
async function shouldRun(db: Db, row: NightRow, now: number): Promise<{ run: true; push: boolean; final: boolean } | { run: false; reason: string }> {
  const wake = Date.parse(row.wake);
  if (now < wake + FIRST_REPORT_MIN * MIN) return { run: false, reason: `waiting for wake + ${FIRST_REPORT_MIN} min` };
  const state = must(await db.from('reports').select('people_count,pushed_at,final').eq('date', row.date).maybeSingle(), 'reports') as ReportState | null;
  const connected = must(await db.from('oauth_tokens').select('person_id'), 'oauth_tokens') as { person_id: string }[];
  const { from, to } = nightWindow(row.date);
  const sessions = must(
    await db.from('sleep_sessions').select('person_id').gte('end_ts', new Date(from).toISOString()).lt('end_ts', new Date(to + 2 * HOUR).toISOString()),
    'sleep_sessions',
  ) as { person_id: string }[];
  const withSleep = new Set(sessions.map((s) => s.person_id)).size;
  const isFinal = now >= finalAt(row);
  if (!state?.pushed_at) {
    const allSynced = withSleep >= connected.length;
    if (!allSynced && now < wake + 4 * HOUR) return { run: false, reason: `waiting for sleep data (${withSleep}/${connected.length})` };
    return { run: true, push: true, final: isFinal };
  }
  // Late sleep data first: a report that is already final still regenerates (silently) when more people's sleep has
  // synced since it was written, so connecting Google Health later in the day still reaches that morning's report.
  if (withSleep > state.people_count) return { run: true, push: false, final: isFinal };
  if (state.final) return { run: false, reason: 'final report done' };
  if (isFinal) return { run: true, push: false, final: true };
  return { run: false, reason: 'up to date' };
}

async function loadPeople(db: Db): Promise<Person[]> {
  const rows = must(await db.from('people').select('id,name,color_key').order('id'), 'people') as { id: string; name: string; color_key: string }[];
  return rows.length ? rows.map((r) => ({ id: r.id, name: r.name, colorKey: r.color_key })) : DEFAULT_PEOPLE;
}

/** Appends the data-quality caveat as the last insight (replacing the 4th when full). */
function withCaveat(report: NightReport, caveat: string | null): NightReport {
  if (!caveat) return report;
  return { ...report, insights: [...report.insights.slice(0, 3), caveat] };
}

/** METER_DEVICE_ID, else the meter poll-meter discovered (devices table). */
async function meterDeviceId(db: Db): Promise<string> {
  const id = await knownDeviceId(db, 'meter');
  if (!id) throw new NotConfiguredError('METER_DEVICE_ID');
  return id;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** {analyzeOnly: true}: night analysis (events + night_metrics) for one or more nights, no report. */
async function analyzeOnly(db: Db, caller: string, body: Record<string, unknown>, now: number, today: string): Promise<Response> {
  let dates: string[];
  if (Array.isArray(body.dates)) {
    if (caller !== 'cron') throw new HttpError(403, 'dates[] is for scheduled / service callers');
    dates = body.dates.filter((d): d is string => typeof d === 'string' && DATE.test(d)).slice(0, 31);
  } else if (typeof body.date === 'string') {
    if (!DATE.test(body.date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    dates = [body.date];
  } else {
    dates = [await lastEndedNightDate(db, now, today, addDays(today, -1))];
  }
  if (caller !== 'cron' && dates.some((d) => d < addDays(today, -7) || d > today)) throw new HttpError(400, 'date must be within the last 7 days');
  const deviceId = await meterDeviceId(db);
  const personIds = (await loadPeople(db)).map((p) => p.id);
  const fin = (x: number) => (Number.isFinite(x) ? x : null);
  const results = [];
  for (const date of dates) {
    const row = must(await db.from('nights').select('*').eq('date', date).maybeSingle(), 'nights') as NightRow | null;
    if (!row) {
      results.push({ date, error: 'no nights row' });
      continue;
    }
    const a = await analyzeNight(db, row, { deviceId, personIds });
    results.push({
      date,
      sleepAirScore: fin(a.metrics.sleepAirScore),
      co2Mean: fin(a.metrics.co2Mean),
      co2Max: fin(a.metrics.co2Max),
      tempMean: fin(a.metrics.tempMean),
      rhMean: fin(a.metrics.rhMean),
      events: a.night.events.map((e) => ({ kind: e.kind, start: new Date(e.start).toISOString(), end: e.end ? new Date(e.end).toISOString() : null, confidence: e.confidence, detail: e.detail ?? {} })),
      dataQuality: dataQualityFacts(a),
    });
  }
  return json({ ok: true, analyzed: results });
}
