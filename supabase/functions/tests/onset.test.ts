import { planAcSchedule } from '../../../packages/core/src/control/quiet.ts';
import { DEFAULT_REMOTE } from '../../../packages/core/src/control/remote.ts';
import { DEFAULT_CURVE, expectedSleepOnset } from '../../../packages/core/src/curve.ts';
import { learnedSleepOnset, onsetOnNight } from '../_shared/load.ts';
import { rowSleepOnset, type SleepRow } from '../_shared/rows.ts';
import type { Db } from '../_shared/supabase.ts';
import { defaultSchedule, ictAt, MIN } from '../_shared/time.ts';

function eq<T>(a: T, b: T, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const hm = (ms: number) => new Date(ms + 7 * 60 * MIN).toISOString().slice(11, 16);

/** A query builder that ignores filters and returns `rows` (enough for learnedSleepOnset). */
function fakeDb(rows: SleepRow[]): Db {
  const q: Record<string, unknown> = {};
  for (const k of ['select', 'neq', 'gte', 'lt', 'order', 'limit']) q[k] = () => q;
  (q as { then: unknown }).then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
  return { from: () => q } as unknown as Db;
}

Deno.test('tonight (22:00 → 08:30, no stored onset): sleep onset 23:00, warming step 03:30, OFF 09:00', () => {
  const { lightsOut, wake } = defaultSchedule('2026-10-30', '22:00', '08:30');
  const onset = expectedSleepOnset(lightsOut, rowSleepOnset({ sleep_onset: null }));
  eq(hm(onset), '23:00');
  const plan = planAcSchedule({ curve: DEFAULT_CURVE, lightsOut, wake, remote: DEFAULT_REMOTE, sleepOnset: onset });
  eq(plan.commands.map((c) => [hm(c.ts), c.state.power ? c.state.setpointC : 'off', c.asleep]), [
    ['21:30', 18, false],
    ['03:30', 20, true],
    ['09:00', 'off', false],
  ]);
});

Deno.test('onsetOnNight puts a minute of day on the right side of midnight', () => {
  const lo = ictAt('2026-10-29', '22:00');
  eq(hm(onsetOnNight(lo, 23 * 60)), '23:00');
  eq(onsetOnNight(lo, 23 * 60) - lo, 60 * MIN);
  eq(onsetOnNight(lo, 30) - lo, 150 * MIN);
  eq(rowSleepOnset({ sleep_onset: '2026-10-29T16:15:00Z' }), Date.parse('2026-10-29T16:15:00Z'));
});

Deno.test('learnedSleepOnset: later of the two medians, clamped to the night; null without data', async () => {
  const lo = ictAt('2026-10-29', '22:00');
  eq(await learnedSleepOnset(fakeDb([]), lo), null);
  const rows: SleepRow[] = [];
  for (let d = 1; d <= 5; d++) {
    for (const [p, start] of [['a', '22:40'], ['b', '23:20']] as const) {
      const s = ictAt(`2026-10-${String(20 + d).padStart(2, '0')}`, start);
      rows.push({ person_id: p, start_ts: new Date(s).toISOString(), end_ts: new Date(s + 8 * 60 * MIN).toISOString(), stages: [], update_time: null, source: 'google' });
    }
  }
  const t = await learnedSleepOnset(fakeDb(rows), lo);
  eq(t === null ? null : hm(t), '23:20');
});
