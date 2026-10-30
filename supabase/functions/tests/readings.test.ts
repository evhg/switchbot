import { FROZEN_POLL_ROWS, isFrozen } from '../_shared/readings.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const MIN = 60_000;
const NOW = Date.parse('2026-10-30T10:48:00+07:00');
const row = (o: Partial<{ temp_c: number; rh: number; co2: number; source: string }> = {}) => ({ temp_c: 21.8, rh: 69, co2: 881, source: 'poll', ...o });
const same = { tempC: 21.8, rh: 69, co2: 881 };

Deno.test('frozen cloud value: 15 identical polls and no webhook for 30 min', () => {
  const rows = Array.from({ length: FROZEN_POLL_ROWS }, () => row());
  assert(isFrozen(rows, same, null, NOW), 'hub unplugged');
  assert(isFrozen(rows, same, NOW - 31 * MIN, NOW), 'old webhook');
  assert(!isFrozen(rows, same, NOW - 10 * MIN, NOW), 'recent webhook: meter alive');
  assert(!isFrozen(rows, { ...same, co2: 884 }, null, NOW), 'value changed');
  assert(!isFrozen(rows.slice(1), same, null, NOW), 'too few rows');
  assert(!isFrozen([row({ co2: 879 }), ...rows.slice(1)], same, null, NOW), 'room still moving');
  assert(!isFrozen([row({ source: 'webhook' }), ...rows.slice(1)], same, null, NOW), 'webhook row among them');
});
