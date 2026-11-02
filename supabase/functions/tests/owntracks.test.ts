import { parseOwnTracks } from '../../../packages/core/src/location/owntracks.ts';
import { friendName, friendsResponse, friendTid, homeFromSettings, owntracksToken, presenceDecision, PRESENCE_MAX_AGE_MS, readBodyLimited } from '../_shared/owntracks.ts';
import { PRESENCE_TOKEN } from '../_shared/presence.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const TOKEN = 'slp_' + 'ab'.repeat(32);
const NOW = Date.parse('2026-11-02T18:00:00+07:00');
const MIN = 60_000;
const HOME = { lat: 7.8804, lon: 98.3923, radiusM: 150 };
const north = (m: number) => HOME.lat + m / 111_195;
const loc = (minAgo: number, m: number, acc = 10) => ({ _type: 'location', lat: north(m), lon: HOME.lon, acc, tst: Math.floor((NOW - minAgo * MIN) / 1000) });
const h = (o: Record<string, string>) => new Headers(o);

Deno.test('owntracks auth: Basic password, X-Presence-Token, Bearer', () => {
  assert(owntracksToken(h({ authorization: `Basic ${btoa(`cath:${TOKEN}`)}` })) === TOKEN, 'basic');
  assert(owntracksToken(h({ authorization: `Basic ${btoa(`cath:${TOKEN.toUpperCase().replace('SLP_', 'slp_')}`)}` })) === TOKEN, 'lower-cased');
  assert(owntracksToken(h({ authorization: `basic ${btoa(`:${TOKEN}`)}` })) === TOKEN, 'empty user');
  assert(owntracksToken(h({ authorization: `Basic ${btoa('cath')}` })) === null, 'no colon');
  assert(owntracksToken(h({ authorization: 'Basic !!!' })) === null, 'not base64');
  assert(owntracksToken(h({ 'x-presence-token': ` ${TOKEN} ` })) === TOKEN, 'header');
  assert(owntracksToken(h({ authorization: `Bearer ${TOKEN}` })) === TOKEN, 'bearer');
  assert(owntracksToken(h({ authorization: 'Bearer eyJhbGciOi.x.y' })) === null, 'a JWT is not a presence token');
  assert(owntracksToken(h({})) === null, 'none');
  const pw = owntracksToken(h({ authorization: `Basic ${btoa('erik:hunter2')}` }));
  assert(pw === 'hunter2' && !PRESENCE_TOKEN.test(pw), 'malformed passwords fail the regex');
});

Deno.test('owntracks presence: newest fresh signal wins, hysteresis, stale and replayed messages ignored', () => {
  const d = (body: unknown, prev: { state: 'home' | 'away'; at: number } | null, home = HOME) => presenceDecision(parseOwnTracks(body, NOW), home, prev, NOW);
  assert(d(loc(1, 20), { state: 'away', at: NOW - 3 * 60 * MIN })?.state === 'home', 'arrived');
  assert(d(loc(1, 220), { state: 'home', at: NOW - 3 * 60 * MIN }) === null, 'in the band');
  assert(d(loc(1, 900), { state: 'home', at: NOW - 3 * 60 * MIN })?.state === 'away', 'left');
  assert(d(loc(1, 20), null, null as unknown as typeof HOME) === null, 'no home set → fixes say nothing');
  assert(d(loc(PRESENCE_MAX_AGE_MS / MIN + 5, 900), null) === null, 'too old');
  assert(d(loc(10, 900), { state: 'home', at: NOW - 5 * MIN }) === null, 'older than the latest presence event');
  // Batch: an old 'away' fix, then a newer fix at home → home.
  assert(d([loc(30, 900), loc(2, 10)], null)?.state === 'home', 'newest wins');
  // Transitions of a home region work without a home point.
  const tr = { _type: 'transition', event: 'leave', desc: 'Thuis', lat: north(100), lon: HOME.lon, acc: 30, tst: Math.floor((NOW - MIN) / 1000) };
  const r = d(tr, { state: 'home', at: NOW - 60 * MIN }, null as unknown as typeof HOME);
  assert(r?.state === 'away' && r.from === 'transition', JSON.stringify(r));
  assert(d({ ...tr, desc: 'Office' }, null, null as unknown as typeof HOME) === null, 'other regions ignored');
  assert(homeFromSettings({ home_lat: 1, home_lon: 2, home_radius_m: null })?.radiusM === 150, 'default radius');
  assert(homeFromSettings({ home_lat: null, home_lon: 2 }) === null, 'no home');
});

Deno.test('owntracks response: other people as friends, latest fix within 7 days', () => {
  const people = [{ id: 'a', name: 'You' }, { id: 'b', name: 'Erik' }, { id: 'c', name: null }];
  assert(friendName(people[0]!) === 'Cath' && friendTid(people[0]!) === 'C', 'placeholder name');
  assert(friendTid(people[1]!) === 'E' && friendTid(people[2]!) === 'C', 'tid');
  const rows = [
    { person_id: 'a', ts: new Date(NOW - MIN).toISOString(), lat: 1, lon: 2, acc_m: 5, batt: 80, conn: 'w' },
    { person_id: 'b', ts: new Date(NOW - 2 * MIN).toISOString(), lat: 3, lon: 4, acc_m: 12, batt: null, conn: null },
    { person_id: 'c', ts: new Date(NOW - 8 * 86_400_000).toISOString(), lat: 5, lon: 6, acc_m: null, batt: null, conn: null },
  ];
  const out = friendsResponse(people, rows, 'a', NOW);
  assert(out.length === 2, JSON.stringify(out));
  assert(JSON.stringify(out[0]) === JSON.stringify({ _type: 'card', tid: 'E', topic: 'owntracks/erik/E', name: 'Erik' }), JSON.stringify(out[0]));
  assert(
    JSON.stringify(out[1]) === JSON.stringify({ _type: 'location', tid: 'E', topic: 'owntracks/erik/E', lat: 3, lon: 4, tst: Math.floor((NOW - 2 * MIN) / 1000), acc: 12 }),
    JSON.stringify(out[1]),
  );
  const forB = friendsResponse(people, rows, 'b', NOW);
  assert(forB.length === 2 && (forB[0] as { name: string }).name === 'Cath' && (forB[1] as { batt: number }).batt === 80, JSON.stringify(forB));
});

Deno.test('owntracks body: read with a byte cap, also without Content-Length', async () => {
  const post = (body: BodyInit | null) => new Request('http://x/', { method: 'POST', body });
  assert((await readBodyLimited(post('{"a":1}'), 100)) === '{"a":1}', 'small');
  assert((await readBodyLimited(post(null), 100)) === '', 'no body');
  assert((await readBodyLimited(post('x'.repeat(101)), 100)) === null, 'over the cap');
  // A streamed (chunked) body that never ends: abandoned once past the cap.
  let sent = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      sent += 64;
      c.enqueue(new Uint8Array(64));
    },
  });
  assert((await readBodyLimited(post(endless), 1000)) === null, 'endless stream');
  assert(sent < 2000, `read ${sent} bytes`);
  // Multi-byte text split across chunks decodes intact.
  const enc = new TextEncoder().encode('"ทดสอบ"');
  const split = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.slice(0, 3));
      c.enqueue(enc.slice(3));
      c.close();
    },
  });
  assert((await readBodyLimited(post(split), 100)) === '"ทดสอบ"', 'utf-8');
});
