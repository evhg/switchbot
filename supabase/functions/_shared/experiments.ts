// Lab › Experiments backend helpers (migration 0025): row mapping, timing rules, the 20:30 notice, outcome loading.
// The decisions themselves are pure core code (packages/core/src/experiments): assignArm, nightOutcomes,
// analyzeExperiment, autopilotStep.
import { experimentLine, type ExperimentAnalysis } from '../../../packages/core/src/experiments/analysis.ts';
import { nightOutcomes } from '../../../packages/core/src/experiments/outcomes.ts';
import type { Experiment, ExperimentArm, ExperimentNight, NightOutcomes } from '../../../packages/core/src/experiments/types.ts';
import type { Ms, StageSegment } from '../../../packages/core/src/types.ts';
import { loadRoom } from './load.ts';
import { appUrl } from './push.ts';
import type { Db } from './supabase.ts';
import { addDays, ictAt, ictDate, iso, MIN } from './time.ts';
import type { NotificationContent } from './webpush.ts';

/** Household people for outcomes: a = Cath, b = Erik. */
export const EXPERIMENT_PERSON_IDS = ['a', 'b'] as const;
/** The engine sets an aircon arm's curve only until lights-out − 45 min (pre-cool starts at −30). */
export const APPLY_BEFORE_LIGHTS_OUT_MIN = 45;
/** Manual assignment push time (ICT) on the evening before the night. */
export const PUSH_HHMM = '20:30';
/** Outcomes are computed from 10:00 ICT (after the morning sleep syncs). */
export const OUTCOMES_FROM_HOUR = 10;
/** A computed night is recomputed (late syncs) at most every 2 h for 2 days. */
export const RECOMPUTE_EVERY_MS = 2 * 60 * MIN;
export const RECOMPUTE_DAYS = 2;

export interface ExperimentRow {
  id: number;
  slug: string;
  title: string;
  kind: 'auto' | 'manual';
  arms: ExperimentArm[];
  primary_outcome: string;
  status: 'running' | 'finished' | 'stopped';
  started_on: string;
  ended_on: string | null;
  winner_arm: string | null;
  seed: number;
  autopilot: boolean;
  min_per_arm: number | null;
  max_nights: number | null;
  analysis: StoredAnalysis | null;
  notes: string | null;
}

export interface ExperimentNightRow {
  experiment_id: number;
  night_date: string;
  arm_key: string;
  source: 'random' | 'pinned';
  followed: boolean;
  outcomes: NightOutcomes | null;
  computed_at: string | null;
  applied_at: string | null;
  apply_note: string | null;
  applied_tag?: string | null;
  notified_at: string | null;
}

export function rowToExperiment(r: ExperimentRow): Experiment & { id: number } {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    kind: r.kind,
    arms: Array.isArray(r.arms) ? r.arms : [],
    primaryOutcome: r.primary_outcome,
    status: r.status,
    startedOn: r.started_on,
    endedOn: r.ended_on,
    winnerArm: r.winner_arm,
    seed: r.seed,
    autopilot: r.autopilot,
    notes: r.notes,
    ...(r.min_per_arm ? { minPerArm: r.min_per_arm } : {}),
    ...(r.max_nights ? { maxNights: r.max_nights } : {}),
  };
}

export function rowToExperimentNight(r: ExperimentNightRow): ExperimentNight {
  return { nightDate: r.night_date, armKey: r.arm_key, source: r.source, followed: r.followed, outcomes: r.outcomes ?? null };
}

/** What experiments.analysis holds (the web reads it for lists; it recomputes the full analysis itself). */
export interface StoredAnalysis {
  status: ExperimentAnalysis['status'];
  verdict: string;
  leader: string;
  winner: string | null;
  counts: Record<string, number>;
  counted: number;
  excluded: number;
  done: boolean;
  primary: { key: string; diff: number | null; lo: number | null; hi: number | null; pBetter: number | null } | null;
  /** "Autopilot is testing … (night 3 of ≥12)" / "Experiment: door OPEN a crack (night 1 of ≥8)" for the next night. */
  line: string | null;
}

export function storedAnalysis(exp: Experiment, nights: readonly ExperimentNight[], a: ExperimentAnalysis, nextNight: string): StoredAnalysis {
  const p = a.primary;
  return {
    status: a.status,
    verdict: a.verdict,
    leader: a.leader,
    winner: a.winner,
    counts: a.counts,
    counted: a.counted,
    excluded: a.excluded,
    done: a.done,
    primary: p ? { key: p.key, diff: round(p.diff), lo: round(p.lo), hi: round(p.hi), pBetter: round(p.pBetter) } : null,
    line: experimentLine(exp, nights, nextNight),
  };
}

const round = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

/** The evening (ICT date) before night `nightDate`. */
export const eveningOf = (nightDate: string) => addDays(nightDate, -1);

/**
 * May the engine create a random assignment for this night now? Only on its evening (from 12:00 ICT) and before
 * lights-out; for an aircon experiment before lights-out − 45 min (the pre-cool starts at −30).
 */
export function assignmentOpen(now: Ms, kind: Experiment['kind'], nightDate: string, lightsOut: Ms): boolean {
  if (now < ictAt(eveningOf(nightDate), '12:00')) return false;
  return now < lightsOut - (kind === 'auto' ? APPLY_BEFORE_LIGHTS_OUT_MIN * MIN : 0);
}

/** The manual push is due at 20:30 ICT (or 30 min before an earlier lights-out) until lights-out + 1 h. */
export function pushDue(now: Ms, nightDate: string, lightsOut: Ms, notifiedAt: string | null): boolean {
  if (notifiedAt) return false;
  const at = Math.min(ictAt(eveningOf(nightDate), PUSH_HHMM), lightsOut - 30 * MIN);
  return now >= at && now < lightsOut + 60 * MIN;
}

/**
 * The curve an aircon night ran instead of its arm's (null = it ran the arm's curve, it is already not counted, or it
 * is a household experiment). Such a night must not count: the curve was changed after the engine applied it.
 */
export function ranOtherCurve(exp: Pick<Experiment, 'kind' | 'arms'>, n: Pick<ExperimentNightRow, 'arm_key' | 'followed'>, curveId: string | null): string | null {
  if (exp.kind !== 'auto' || !n.followed) return null;
  const want = exp.arms.find((a) => a.key === n.arm_key)?.curve_id;
  if (!want || curveId === want) return null;
  return curveId ?? 'no curve';
}

/** Should the outcomes of a night be (re)computed now? From 10:00 ICT on its wake date, once wake + 1 h has passed. */
export function outcomesDue(now: Ms, nightDate: string, wake: Ms, computedAt: string | null): boolean {
  const today = ictDate(now);
  if (nightDate > today) return false;
  if (nightDate === today && now < ictAt(today, `${String(OUTCOMES_FROM_HOUR).padStart(2, '0')}:00`)) return false;
  if (now < wake + 60 * MIN) return false;
  if (!computedAt) return true;
  return nightDate >= addDays(today, -RECOMPUTE_DAYS) && now - Date.parse(computedAt) >= RECOMPUTE_EVERY_MS;
}

/** "Tonight's experiment: Door OPEN a crack" (both phones). `line` = experimentLine (its "night n of ≥m" is shown). */
export function experimentNotice(exp: Pick<Experiment, 'title'>, arm: ExperimentArm, nightDate: string, line: string | null, base = appUrl()): NotificationContent {
  const nth = line ? /\((night [^)]*)\)/.exec(line)?.[1] ?? null : null;
  return {
    title: `Tonight's experiment: ${arm.instruction ?? arm.label}`,
    body: `${exp.title}${nth ? `, ${nth}` : ''}. Didn't manage it? Tap "Didn't follow" in the morning.`,
    navigate: `${base}/lab`,
    tag: `experiment-${nightDate}`,
  };
}

/** Main sleep (longest session ending 18:00 the evening before → 14:00 on the wake date) of each person. */
export async function loadMainStages(db: Db, nightDate: string): Promise<Record<string, StageSegment[] | null>> {
  const from = ictAt(addDays(nightDate, -1), '18:00');
  const to = ictAt(nightDate, '14:00');
  const { data, error } = await db.from('sleep_sessions').select('person_id,start_ts,end_ts,stages,source')
    .in('person_id', [...EXPERIMENT_PERSON_IDS]).neq('source', 'sim').gte('end_ts', iso(from)).lt('end_ts', iso(to));
  if (error) throw new Error(`sleep_sessions: ${error.message}`);
  const out: Record<string, StageSegment[] | null> = Object.fromEntries(EXPERIMENT_PERSON_IDS.map((p) => [p, null]));
  const best: Record<string, number> = {};
  for (const r of (data ?? []) as { person_id: string; start_ts: string; end_ts: string; stages: StageSegment[] | null }[]) {
    const len = Date.parse(r.end_ts) - Date.parse(r.start_ts);
    if (len > (best[r.person_id] ?? -1)) {
      best[r.person_id] = len;
      out[r.person_id] = Array.isArray(r.stages) ? r.stages : null;
    }
  }
  return out;
}

/** Outcomes of one night from nights, sleep_sessions, readings (the meter) and sound_minutes. */
export async function computeNightOutcomes(db: Db, night: { date: string; lights_out: string; wake: string }, meterId: string | null): Promise<NightOutcomes> {
  const lightsOut = Date.parse(night.lights_out);
  const wake = Date.parse(night.wake);
  const [sleep, room, sound] = await Promise.all([
    loadMainStages(db, night.date),
    meterId ? loadRoom(db, meterId, lightsOut, wake + MIN) : Promise.resolve([]),
    db.from('sound_minutes').select('ts,snore_s').eq('night_date', night.date).gte('ts', iso(lightsOut)).lte('ts', iso(wake)).limit(2000),
  ]);
  if (sound.error) console.error('sound_minutes', sound.error.message);
  const minutes = ((sound.data ?? []) as { ts: string; snore_s: number }[]).map((m) => ({ ts: Date.parse(m.ts), snoreS: m.snore_s }));
  return nightOutcomes({ lightsOut, wake, sleep, room, sound: minutes });
}

export async function logExperiment(db: Db, experimentId: number | null, kind: string, message: string, data: Record<string, unknown> = {}): Promise<void> {
  const r = await db.from('experiment_log').insert({ experiment_id: experimentId, kind, message: message.slice(0, 1000), data });
  if (r.error) console.error('experiment_log', r.error.message);
}

/** The newest log message of a kind (Autopilot logs "nothing to do" only when the reason changes). */
export async function lastLogMessage(db: Db, kind: string): Promise<string | null> {
  const { data } = await db.from('experiment_log').select('message').eq('kind', kind).order('at', { ascending: false }).limit(1).maybeSingle();
  return (data as { message?: string } | null)?.message ?? null;
}
