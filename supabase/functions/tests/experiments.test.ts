import {
  assignmentOpen,
  experimentNotice,
  type ExperimentNightRow,
  type ExperimentRow,
  outcomesDue,
  pushDue,
  ranOtherCurve,
  rowToExperiment,
  rowToExperimentNight,
  storedAnalysis,
} from '../_shared/experiments.ts';
import { analyzeExperiment, assignArm } from '../../../packages/core/src/experiments/analysis.ts';
import { EXPERIMENT_TEMPLATES } from '../../../packages/core/src/experiments/templates.ts';
import { defaultSchedule, iso } from '../_shared/time.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg: string) {
  if (a !== b) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const t = (s: string) => Date.parse(`${s}+07:00`);
// Tonight: evening 2026-11-04, night 2026-11-05, lights-out 22:00, wake 08:30.
const { lightsOut, wake } = defaultSchedule('2026-11-05', '22:00', '08:30');
const door = EXPERIMENT_TEMPLATES[0]!;
const row: ExperimentRow = {
  id: 1,
  slug: door.slug,
  title: door.title,
  kind: 'manual',
  arms: door.arms,
  primary_outcome: door.primaryOutcome,
  status: 'running',
  started_on: '2026-11-05',
  ended_on: null,
  winner_arm: null,
  seed: 20261105,
  autopilot: false,
  min_per_arm: 4,
  max_nights: 21,
  analysis: null,
  notes: null,
};

Deno.test('assignment window: from 12:00 ICT on the evening; aircon arms only until lights-out − 45 min', () => {
  assert(!assignmentOpen(t('2026-11-04T11:59:00'), 'manual', '2026-11-05', lightsOut), 'before noon');
  assert(assignmentOpen(t('2026-11-04T12:00:00'), 'manual', '2026-11-05', lightsOut), 'noon');
  assert(assignmentOpen(t('2026-11-04T21:59:00'), 'manual', '2026-11-05', lightsOut), 'manual until lights-out');
  assert(!assignmentOpen(t('2026-11-04T22:00:00'), 'manual', '2026-11-05', lightsOut), 'manual at lights-out');
  assert(assignmentOpen(t('2026-11-04T21:14:00'), 'auto', '2026-11-05', lightsOut), 'auto before 21:15');
  assert(!assignmentOpen(t('2026-11-04T21:15:00'), 'auto', '2026-11-05', lightsOut), 'auto from 21:15 (pre-cool at 21:30)');
});

Deno.test('20:30 push once, until lights-out + 1 h', () => {
  assert(!pushDue(t('2026-11-04T20:29:00'), '2026-11-05', lightsOut, null), 'before 20:30');
  assert(pushDue(t('2026-11-04T20:30:00'), '2026-11-05', lightsOut, null), 'at 20:30');
  assert(!pushDue(t('2026-11-04T20:45:00'), '2026-11-05', lightsOut, iso(t('2026-11-04T20:30:00'))), 'already sent');
  assert(!pushDue(t('2026-11-04T23:01:00'), '2026-11-05', lightsOut, null), 'too late');
  const early = defaultSchedule('2026-11-05', '20:30', '07:00').lightsOut;
  assert(pushDue(t('2026-11-04T20:00:00'), '2026-11-05', early, null), '30 min before an early lights-out');
});

Deno.test('outcomes from 10:00 ICT the morning after, recomputed every 2 h for 2 days', () => {
  assert(!outcomesDue(t('2026-11-05T09:59:00'), '2026-11-05', wake, null), 'before 10:00');
  assert(outcomesDue(t('2026-11-05T10:00:00'), '2026-11-05', wake, null), 'at 10:00');
  assert(!outcomesDue(t('2026-11-05T11:00:00'), '2026-11-05', wake, iso(t('2026-11-05T10:00:00'))), 'computed 1 h ago');
  assert(outcomesDue(t('2026-11-05T12:00:00'), '2026-11-05', wake, iso(t('2026-11-05T10:00:00'))), 'recompute after 2 h');
  assert(!outcomesDue(t('2026-11-09T12:00:00'), '2026-11-05', wake, iso(t('2026-11-05T10:00:00'))), 'settled after 2 days');
  assert(outcomesDue(t('2026-11-09T12:00:00'), '2026-11-05', wake, null), 'a missed night is computed late');
  assert(!outcomesDue(t('2026-11-04T23:00:00'), '2026-11-05', wake, null), 'not during the night');
});

Deno.test('rows → core types; tonight pinned open; push text and stored analysis line', () => {
  const exp = rowToExperiment(row);
  eq(exp.primaryOutcome, 'sleep_score', 'primary');
  eq(exp.minPerArm, 4, 'min per arm');
  const nightRow: ExperimentNightRow = {
    experiment_id: 1, night_date: '2026-11-05', arm_key: 'open', source: 'pinned', followed: true,
    outcomes: null, computed_at: null, applied_at: null, apply_note: null, notified_at: null,
  };
  const nights = [rowToExperimentNight(nightRow)];
  const a = analyzeExperiment(exp, nights);
  eq(a.status, 'running', 'running');
  const stored = storedAnalysis(exp, nights, a, '2026-11-05');
  eq(stored.line, 'Experiment: door OPEN a crack (night 1 of ≥8)', 'line');
  const n = experimentNotice(exp, exp.arms[1]!, '2026-11-05', stored.line, 'https://x.test');
  eq(n.title, "Tonight's experiment: Door OPEN a crack", 'title');
  eq(n.body, 'Door: open a crack vs closed, night 1 of ≥8. Didn\'t manage it? Tap "Didn\'t follow" in the morning.', 'body');
  eq(n.tag, 'experiment-2026-11-05', 'tag');
  // The pinned night counts as 'open' in its block: the next night gets 'closed'.
  eq(assignArm(exp, nights, '2026-11-06'), 'closed', 'next night balances the block');
});

Deno.test('aircon night that ran another curve does not count', () => {
  const exp = {
    kind: 'auto' as const,
    arms: [
      { key: 'base', label: 'Steady 18.5', curve_id: 'steady-18-5-quiet-v1' },
      { key: 'cool', label: 'Cool early', curve_id: 'cool-early-warm-late-v1' },
    ],
  };
  eq(ranOtherCurve(exp, { arm_key: 'cool', followed: true }, 'cool-early-warm-late-v1'), null, 'ran the arm');
  eq(ranOtherCurve(exp, { arm_key: 'cool', followed: true }, 'steady-18-5-quiet-v1'), 'steady-18-5-quiet-v1', 'switched back by hand');
  eq(ranOtherCurve(exp, { arm_key: 'cool', followed: false }, 'steady-18-5-quiet-v1'), null, 'already not counted');
  eq(ranOtherCurve({ ...exp, kind: 'manual' }, { arm_key: 'cool', followed: true }, null), null, 'household experiment');
});
