import { nobodyHome } from '../_shared/presence.ts';
import { parseCameraRequest, unknownToAlert } from '../../../packages/core/src/camera/events.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const at = Date.parse('2026-11-02T14:00:00+07:00');
const p = (personId: string, state: 'home' | 'away', hoursAgo = 1) => ({ personId, name: personId, state, at: at - hoursAgo * 3_600_000 });

Deno.test('nobodyHome: every person away (however old), nobody without a signal', () => {
  assert(nobodyHome([p('a', 'away'), p('b', 'away', 72)], ['a', 'b']), 'both away');
  assert(!nobodyHome([p('a', 'away'), p('b', 'home')], ['a', 'b']), 'one home');
  assert(!nobodyHome([p('a', 'away')], ['a', 'b']), 'b has no signal');
  assert(!nobodyHome([], []), 'no data');
});

Deno.test('camera request: a bare ping, and an unknown sighting that alerts', () => {
  assert(parseCameraRequest({ ping: true, token: 'x' }, at).kind === 'ping', 'ping');
  const r = parseCameraRequest({ events: [{ ts: new Date(at - 60_000).toISOString(), label: 'Unknown', confidence: 0.3 }] }, at);
  assert(r.kind === 'events' && r.events.length === 1, JSON.stringify(r));
  assert(unknownToAlert(r.events, at)?.label === 'unknown', 'alerts');
});
