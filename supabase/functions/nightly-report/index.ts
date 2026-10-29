// Morning report: detect room events, build the rule report from the night and up to 14 earlier nights, let
// Claude reword it (grounded in the computed numbers; rules on any failure), store it in reports and send Web Push.
// Body: {date?: 'YYYY-MM-DD', push?: boolean, coach?: boolean} for an explicit run, or {auto: true} from pg_cron
// (every 15 min, 06:00-14:45 ICT), where shouldRun() decides whether anything is due.
import { detectEvents } from '../../../packages/core/src/metrics/events.ts';
import { buildRuleReport } from '../../../packages/core/src/metrics/report.ts';
import { DEFAULT_PEOPLE } from '../../../packages/core/src/sim/people.ts';
import type { Night, NightReport, Person } from '../../../packages/core/src/types.ts';
import { requireCronOrMember } from '../_shared/auth.ts';
import { applyCoach, coachFacts, COACH_MODEL, requestCoachText } from '../_shared/coach.ts';
import { env, optEnv } from '../_shared/env.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { ensureNight, loadCurve, loadNight } from '../_shared/load.ts';
import { eventToRow, type NightRow } from '../_shared/rows.ts';
import { type Db, must, serviceClient } from '../_shared/supabase.ts';
import { addDays, HOUR, ictAt, ictDate, MIN, nightWindow } from '../_shared/time.ts';
import { declarativePayload, sendWebPush, type VapidKeys } from '../_shared/webpush.ts';

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
  const date = typeof body.date === 'string' ? body.date : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  // Members may regenerate recent nights only (each run can call Claude and creates a nights row).
  if (caller !== 'cron' && (date < addDays(today, -7) || date > today)) throw new HttpError(400, 'date must be within the last 7 days');
  const meterId = env('METER_DEVICE_ID');

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
  const night = await loadNight(db, row, { deviceId: meterId, personIds });
  if (!night.room.length && !night.people.length) return json({ ok: false, date, error: 'no room or body data for this night' }, 404);

  // Events: recompute detector events for this night (manual / controller ones stay).
  night.events = detectEvents(night.room, { lightsOut: night.lightsOut, wake: night.wake });
  await replaceDetectorEvents(db, date, night);

  const historyRows = must(
    await db.from('nights').select('*').lt('date', date).gte('date', addDays(date, -HISTORY_NIGHTS)).order('date', { ascending: false }),
    'history nights',
  ) as NightRow[];
  const history: Night[] = await Promise.all(
    historyRows.map((r) => loadNight(db, r, { deviceId: meterId, personIds, roomBucketMin: 5 })),
  );

  const rule = buildRuleReport(night, history, curve);
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
    const facts = coachFacts(rule, people, night.tags, events);
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

  const pushed = push ? await pushAll(db, report) : null;
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
  return json({ ok: true, date, generatedBy: report.generatedBy, model, coachNote, headline: report.headline, push: pushed });
});

/** After this the morning CO2 decay (wake → noon) is in, so a report generated later is final. */
function finalAt(row: NightRow): number {
  return Math.max(ictAt(row.date, '12:00'), Date.parse(row.wake) + 2 * HOUR);
}

/**
 * Scheduled mode: the first report (with push) once wake + 60 min has passed and every connected person's sleep
 * has synced, or at wake + 4 h regardless; silent regenerates when more people's sleep arrives and once after
 * finalAt() for the morning ACH. Nothing otherwise.
 */
async function shouldRun(db: Db, row: NightRow, now: number): Promise<{ run: true; push: boolean; final: boolean } | { run: false; reason: string }> {
  const wake = Date.parse(row.wake);
  if (now < wake + 60 * MIN) return { run: false, reason: 'waiting for wake + 60 min' };
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
  if (state.final) return { run: false, reason: 'final report done' };
  if (isFinal) return { run: true, push: false, final: true };
  if (withSleep > state.people_count) return { run: true, push: false, final: false };
  return { run: false, reason: 'up to date' };
}

async function loadPeople(db: Db): Promise<Person[]> {
  const rows = must(await db.from('people').select('id,name,color_key').order('id'), 'people') as { id: string; name: string; color_key: string }[];
  return rows.length ? rows.map((r) => ({ id: r.id, name: r.name, colorKey: r.color_key })) : DEFAULT_PEOPLE;
}

async function replaceDetectorEvents(db: Db, date: string, night: Night) {
  const del = await db.from('events').delete().eq('night_date', date).eq('source', 'detector');
  if (del.error) throw new Error(`events delete: ${del.error.message}`);
  if (!night.events.length) return;
  const ins = await db.from('events').insert(night.events.map((e) => eventToRow(date, e, 'detector')));
  if (ins.error) throw new Error(`events insert: ${ins.error.message}`);
}

async function pushAll(db: Db, report: NightReport) {
  const pub = optEnv('VAPID_PUBLIC_KEY');
  const priv = optEnv('VAPID_PRIVATE_KEY');
  if (!pub || !priv) return { skipped: 'no VAPID keys' };
  const keys: VapidKeys = { publicKey: pub, privateKey: priv, subject: optEnv('VAPID_SUBJECT') ?? 'mailto:admin@example.com' };
  const subs = must(await db.from('push_subscriptions').select('id,endpoint,p256dh,auth,failures'), 'push_subscriptions') as {
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
    failures: number;
  }[];
  const appUrl = (optEnv('APP_URL') ?? '/').replace(/\/$/, '');
  const message = declarativePayload({
    title: 'Last night',
    body: report.headline,
    navigate: `${appUrl}/?date=${report.date}`,
    tag: `report-${report.date}`,
  });
  let sent = 0;
  let removed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await sendWebPush(s, message, keys, { urgency: 'normal', topic: 'report' });
      if (r.ok) {
        sent++;
        await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), failures: 0 }).eq('id', s.id);
      } else if (r.gone) {
        removed++;
        await db.from('push_subscriptions').delete().eq('id', s.id);
      } else {
        await db.from('push_subscriptions').update({ failures: s.failures + 1 }).eq('id', s.id);
      }
    } catch (e) {
      console.warn('push failed', s.endpoint.slice(0, 40), e);
      await db.from('push_subscriptions').update({ failures: s.failures + 1 }).eq('id', s.id);
    }
  }));
  return { subscriptions: subs.length, sent, removed };
}
