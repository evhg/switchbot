// Device tokens (migration 0028) use the presence-token format, so every endpoint's PRESENCE_TOKEN check and token
// parsing accept them unchanged: presence (record_presence), camera-event / night-sound / owntracks
// (presence_token_person). The SQL side is checked in packages/core/test/device-tokens.test.ts.
import { owntracksToken } from '../_shared/owntracks.ts';
import { PRESENCE_TOKEN, presenceToken } from '../_shared/presence.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** What create_device_token / rotate_presence_token generate: 'slp_' || encode(gen_random_bytes(32), 'hex'). */
function sqlLikeToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return 'slp_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

Deno.test('device tokens: same format as presence tokens, accepted by every endpoint', () => {
  for (let i = 0; i < 50; i++) {
    const tok = sqlLikeToken();
    assert(PRESENCE_TOKEN.test(tok), `format ${i}`);
    const req = (h: Record<string, string>) => new Request('https://x/functions/v1/night-sound', { method: 'GET', headers: h });
    // night-sound and camera-event: presenceToken(), lower-cased, then the regex.
    assert(presenceToken(req({ 'x-presence-token': tok }), {})?.toLowerCase() === tok, 'night-sound header');
    assert(presenceToken(req({ authorization: `Bearer ${tok}` }), {})?.toLowerCase() === tok, 'bearer');
    assert(presenceToken(req({}), { token: ` ${tok} ` }) === tok, 'body (trimmed)');
    // presence (phone Shortcut with a phone/device token): lower-cased before the regex.
    const upper = presenceToken(req({ 'x-presence-token': tok.replace(/[a-f]/g, (c) => c.toUpperCase()) }), {})!;
    assert(PRESENCE_TOKEN.test(upper.toLowerCase()) && upper.toLowerCase() === tok, 'presence lower-cases');
    // owntracks: HTTP Basic password.
    assert(owntracksToken(new Headers({ authorization: `Basic ${btoa(`erik:${tok}`)}` })) === tok, 'owntracks basic');
  }
});

Deno.test('device tokens: near misses still fail the regex', () => {
  const tok = sqlLikeToken();
  assert(!PRESENCE_TOKEN.test(tok.slice(0, -1)), 'too short');
  assert(!PRESENCE_TOKEN.test(`${tok}0`), 'too long');
  assert(!PRESENCE_TOKEN.test(tok.replace('slp_', 'dev_')), 'other prefix');
  assert(!PRESENCE_TOKEN.test(`${tok.slice(0, -1)}g`), 'not hex');
});

Deno.test('owntracks: asks for phone/device kinds only, falls back before migration 0028', async () => {
  const { owntracksPerson, OWNTRACKS_DEVICE_KINDS, isMissingRpc } = await import('../_shared/owntracks.ts');
  assert(JSON.stringify(OWNTRACKS_DEVICE_KINDS) === '["phone","device"]', 'no listener kind');
  const tok = sqlLikeToken();
  const calls: [string, Record<string, unknown>][] = [];
  const db = (answers: Record<string, { data: unknown; error: { message: string; code?: string } | null }>) => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      return Promise.resolve(answers[fn] ?? { data: null, error: { message: `unexpected ${fn}` } });
    },
  });
  // After 0028: one call with the kinds.
  let r = await owntracksPerson(db({ presence_token_person_kinds: { data: 'b', error: null } }), tok);
  assert(r.person === 'b' && !r.error && calls.length === 1, 'resolved');
  assert(calls[0]?.[0] === 'presence_token_person_kinds' && JSON.stringify(calls[0]?.[1].p_kinds) === '["phone","device"]', 'kinds sent');
  // A listener token: the database answers null → refused.
  calls.length = 0;
  r = await owntracksPerson(db({ presence_token_person_kinds: { data: null, error: null } }), tok);
  assert(r.person === null && !r.error && calls.length === 1, 'listener refused, no fallback');
  // Before 0028: the RPC is missing → presence_token_person.
  calls.length = 0;
  const missing = { message: 'Could not find the function public.presence_token_person_kinds(p_kinds, p_token)', code: 'PGRST202' };
  r = await owntracksPerson(db({ presence_token_person_kinds: { data: null, error: missing }, presence_token_person: { data: 'a', error: null } }), tok);
  assert(r.person === 'a' && calls.length === 2 && calls[1]?.[0] === 'presence_token_person', 'fallback');
  // Other database errors are reported, not retried.
  calls.length = 0;
  r = await owntracksPerson(db({ presence_token_person_kinds: { data: null, error: { message: 'timeout', code: '57014' } } }), tok);
  assert(r.error === 'timeout' && calls.length === 1, 'error');
  assert(!isMissingRpc(null) && isMissingRpc({ message: 'x', code: '42883' }), 'isMissingRpc');
});
