import { alertKey, bandSeenAt, batteryState, listenerState, listenerWatch, listenerWatchData, recipients, staleState, stateData } from '../alerts/logic.ts';
import { batteryAlert, estimateDrain, listenerAlert } from '../../../packages/core/src/alerts/alerts.ts';

function eq<T>(a: T, b: T, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const members = [
  { user_id: 'u-cath', person_id: 'a', role: 'member' },
  { user_id: 'u-erik', person_id: 'b', role: 'owner' },
  { user_id: 'u-guest', person_id: null, role: 'viewer' },
];

Deno.test('recipients: own account + owner for band alerts, everyone for the listener', () => {
  eq(recipients('battery', 'a', members).sort(), ['u-cath', 'u-erik'], 'Cath battery');
  eq(recipients('stale', 'b', members), ['u-erik'], 'Erik stale (he is the owner)');
  eq(recipients('listener', null, members).sort(), ['u-cath', 'u-erik', 'u-guest'], 'listener');
});

Deno.test('alert_state keys and data round-trip', () => {
  eq(alertKey('battery', 'a'), 'battery:a', 'key');
  eq(alertKey('listener'), 'listener', 'listener key');
  const cycle = Date.parse('2026-11-04T01:00:00Z');
  const d = stateData('battery', { cycle }, { title: 'T', body: 'B', personId: 'a' });
  eq(d, { title: 'T', body: 'B', person_id: 'a', cycle: '2026-11-04T01:00:00.000Z' }, 'battery data');
  eq(batteryState(d).cycle, cycle, 'battery state back');
  const seenAt = Date.parse('2026-11-04T07:20:00Z');
  eq(staleState(stateData('stale', { seenAt }, {})).seenAt, seenAt, 'stale back');
  eq(listenerState(stateData('listener', { night: '2026-11-05' }, {})).night, '2026-11-05', 'listener back');
  eq(batteryState(null).cycle, null, 'no row');
  eq(staleState({ seen_at: 'junk' }).seenAt, null, 'junk');
});

Deno.test('band last seen: the later of the two times', () => {
  eq(bandSeenAt({ device_last_sync_at: '2026-11-04T01:00:00Z', newest_point_at: '2026-11-04T02:00:00Z' }), Date.parse('2026-11-04T02:00:00Z'), 'later');
  eq(bandSeenAt({ device_last_sync_at: null, newest_point_at: '2026-11-04T02:00:00Z' }), Date.parse('2026-11-04T02:00:00Z'), 'one');
  eq(bandSeenAt({}), null, 'none');
});

Deno.test('a stored battery state stops a second push in the same cycle', () => {
  const t0 = Date.parse('2026-11-04T08:00:00+07:00');
  const readings = Array.from({ length: 7 }, (_, i) => ({ ts: t0 + i * 3_600_000, level: 30 - 2 * i }));
  const now = t0 + 6 * 3_600_000;
  const first = batteryAlert({ name: 'Cath', estimate: estimateDrain(readings, now), state: batteryState(undefined), now });
  eq(first.send, true, 'first');
  const stored = stateData('battery', first.state, { title: first.title, body: first.body });
  const second = batteryAlert({ name: 'Cath', estimate: estimateDrain(readings, now + 900_000), state: batteryState(stored), now: now + 900_000 });
  eq(second.send, false, 'second');
});

Deno.test('listener: one push per night through the stored state', () => {
  const from = Date.parse('2026-11-04T21:45:00+07:00');
  const now = Date.parse('2026-11-05T02:00:00+07:00');
  const i = { listening: true, night: '2026-11-05', from, lastMinute: Date.parse('2026-11-05T01:42:00+07:00'), macLabel: 'Erik’s Mac', now };
  const d = listenerAlert({ ...i, state: listenerState(undefined) });
  eq(d.body, 'Night listener stopped at 01:43 — check Erik’s Mac', 'text');
  eq(listenerAlert({ ...i, state: listenerState(stateData('listener', d.state, {})) }).send, false, 'deduped');
  eq(listenerAlert({ ...i, night: '2026-11-06', state: listenerState(stateData('listener', d.state, {})) }).send, true, 'next night');
});

Deno.test('listener watch round-trips through alert_state', () => {
  const w = { since: Date.parse('2026-11-05T01:00:00+07:00'), night: '2026-11-05' };
  const back = listenerWatch(listenerWatchData(w));
  eq(back?.since, w.since, 'since');
  eq(back?.night, w.night, 'night');
  eq(listenerWatch(listenerWatchData(null)), null, 'cleared');
});
