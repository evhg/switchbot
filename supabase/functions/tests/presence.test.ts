import { ASLEEP_START_MIN, awayPeriodFor, co2Rising, everyoneAway, isAway, needsPresenceGate, nightAway, PRESENCE_TOKEN, presenceGate, presenceState, presenceToken, since, START_UNTIL_MIN } from '../_shared/presence.ts';
import { precoolNotice } from '../_shared/push.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const MIN = 60_000;
const LO = Date.parse('2026-10-29T22:00:00+07:00');
const PRE = LO - 30 * MIN;
const base = { now: PRE, precoolStart: PRE, lightsOut: LO, override: null, tags: [] as string[], latest: [] };
const you = (state: 'home' | 'away', hhmm: string) => ({ personId: 'a', name: 'You', state, at: Date.parse(`2026-10-29T${hhmm}:00+07:00`) });
const erik = (state: 'home' | 'away', hhmm: string) => ({ personId: 'b', name: 'Erik', state, at: Date.parse(`2026-10-29T${hhmm}:00+07:00`) });

Deno.test('no presence data at all: no pre-cool, with a clear reason', () => {
  const g = presenceGate(base);
  assert(!g.allow && g.status === 'waiting', JSON.stringify(g));
  assert(g.reason === 'nobody home (no presence signal)', g.reason);
});

Deno.test('anyone home: pre-cool starts; everyone away: waits', () => {
  const g = presenceGate({ ...base, latest: [you('away', '08:10'), erik('home', '18:42')] });
  assert(g.allow && g.status === 'started' && g.reason === 'Erik home since 18:42', JSON.stringify(g));
  const w = presenceGate({ ...base, latest: [you('away', '08:10'), erik('away', '09:00')] });
  assert(!w.allow && w.status === 'waiting' && w.reason === 'nobody home (You away since 08:10, Erik away since 09:00)', JSON.stringify(w));
});

Deno.test('a late arrival starts the AC until lights-out + 3 h, never later', () => {
  const late = [you('home', '23:40')];
  assert(presenceGate({ ...base, now: LO + 100 * MIN, latest: late }).allow, 'within 3 h');
  const g = presenceGate({ ...base, now: LO + (START_UNTIL_MIN + 5) * MIN, latest: late });
  assert(!g.allow && g.status === 'skipped', JSON.stringify(g));
  const n = presenceGate({ ...base, now: LO + (START_UNTIL_MIN + 5) * MIN });
  assert(!n.allow && n.status === 'skipped' && n.reason.startsWith('nobody home (no presence signal)'), JSON.stringify(n));
});

Deno.test('overrides: "Home tonight" starts without a signal, "Away tonight" / travel wins over everything', () => {
  const h = presenceGate({ ...base, override: 'home' });
  assert(h.allow && h.status === 'override', JSON.stringify(h));
  const a = presenceGate({ ...base, override: 'away', latest: [you('home', '18:00')] });
  assert(!a.allow && a.status === 'away', JSON.stringify(a));
  assert(!presenceGate({ ...base, tags: ['travel'], latest: [you('home', '18:00')] }).allow, 'travel tag');
  assert(isAway('away', []) && isAway(null, ['travel']) && !isAway('home', ['alcohol']) && !isAway(undefined, null), 'isAway');
});

Deno.test('request parsing: token from header, bearer or body; state home/away only', () => {
  const tok = `slp_${'ab'.repeat(32)}`;
  assert(PRESENCE_TOKEN.test(tok) && !PRESENCE_TOKEN.test('slp_123') && !PRESENCE_TOKEN.test(`x${tok}`), 'format');
  const r = (h: Record<string, string>) => new Request('https://x/functions/v1/presence', { method: 'POST', headers: h });
  assert(presenceToken(r({ 'x-presence-token': tok }), {}) === tok, 'header');
  assert(presenceToken(r({ authorization: `Bearer ${tok}` }), {}) === tok, 'bearer');
  assert(presenceToken(r({ authorization: 'Bearer eyJhbGciOi.jwt' }), {}) === null, 'a JWT is not a presence token');
  assert(presenceToken(r({}), { token: tok }) === tok, 'body');
  assert(presenceState({ state: 'Home' }) === 'home' && presenceState({ state: 'away' }) === 'away', 'states');
  assert(presenceState({ state: 'maybe' }) === null && presenceState({}) === null, 'bad state');
});

Deno.test('the gate is closed before the pre-cool start, whatever the presence says', () => {
  for (const now of [PRE - MIN, Date.parse('2026-10-29T14:00:00+07:00')]) {
    const g = presenceGate({ ...base, now, latest: [you('home', '13:00')] });
    assert(!g.allow && g.status === 'waiting' && g.reason === 'before pre-cool start', JSON.stringify(g));
    assert(!presenceGate({ ...base, now, override: 'home' }).allow, 'override does not open it early either');
  }
  assert(presenceGate({ ...base, latest: [you('home', '13:00')] }).allow, 'open at the start');
});

Deno.test('a home signal older than 48 h is stale: waits, unless bedroom CO2 is rising', () => {
  const old = { personId: 'a', name: 'You', state: 'home' as const, at: Date.parse('2026-10-26T18:42:00+07:00') };
  const g = presenceGate({ ...base, latest: [old] });
  assert(!g.allow && g.status === 'waiting' && g.reason.startsWith('home signal stale (You home since Mon 18:42)'), JSON.stringify(g));
  const c = presenceGate({ ...base, latest: [old], co2Rising: true });
  assert(c.allow && c.status === 'started' && c.reason.includes('CO₂ rising'), JSON.stringify(c));
  // A fresh signal from someone else wins; a stale one past lights-out + 3 h skips the night.
  assert(presenceGate({ ...base, latest: [old, erik('home', '18:00')] }).reason === 'Erik home since 18:00', 'fresh wins');
  const late = presenceGate({ ...base, now: LO + (START_UNTIL_MIN + 5) * MIN, latest: [old], co2Rising: true });
  assert(!late.allow && late.status === 'skipped', JSON.stringify(late));
});

Deno.test('since(): time only for today / the last 12 h, weekday for older signals', () => {
  assert(since(Date.parse('2026-10-29T18:42:00+07:00'), PRE) === '18:42', 'today');
  assert(since(Date.parse('2026-10-29T23:40:00+07:00'), LO + 100 * MIN) === '23:40', 'last night, after midnight');
  assert(since(Date.parse('2026-10-28T18:42:00+07:00'), PRE) === 'Wed 18:42', 'yesterday');
});

Deno.test('ac-curve wiring: only the first power-on command of the night is gated', () => {
  const on = (targetC = 18) => ({ state: { power: true, mode: 'cool', targetC } });
  const off = { state: { power: false } };
  assert(needsPresenceGate(on(), []), 'pre-cool ON with nothing sent tonight');
  assert(needsPresenceGate(on(), [off]), 'ON after an ensure-off tonight');
  // A stale ON from last night (assumed state) no longer skips the gate: only tonight's log counts.
  assert(needsPresenceGate(on(), []), 'assumed ON from yesterday does not matter');
  assert(!needsPresenceGate(on(20), [on()]), 'warming step after tonight\'s ON');
  assert(!needsPresenceGate(off, [on()]), 'the OFF at wake + 30');
  assert(!needsPresenceGate(off, []), 'an ensure-off');
  assert(!needsPresenceGate(null, []), 'no command');
  // Away: the window is disabled and ac-curve only ensures off.
  assert(isAway('away', []), 'away override');
});

Deno.test('co2Rising: +120 ppm over the last hour and at least 550 ppm', () => {
  const now = PRE;
  const rs = (ppm0: number, ppm1: number) => [
    ...[60, 55, 50, 46].map((m) => ({ ts: now - m * MIN, co2: ppm0 })),
    ...[8, 5, 2, 0].map((m) => ({ ts: now - m * MIN, co2: ppm1 })),
  ];
  assert(co2Rising(rs(480, 650), now), 'rising');
  assert(!co2Rising(rs(480, 560), now), 'too small');
  assert(!co2Rising(rs(380, 520), now), 'still low');
  assert(!co2Rising(rs(480, 650).slice(0, 5), now), 'not enough recent data');
});

Deno.test('pre-cool push opens Tonight\'s plan', () => {
  const n = precoolNotice('2026-10-30', 'Erik home since 18:42', 'https://app.example');
  assert(n.navigate === 'https://app.example/settings/plan' && n.tag === 'precool-2026-10-30' && n.body.includes('Away tonight'), JSON.stringify(n));
});

Deno.test('default presence home: no data pre-cools; only everyone away within 12 h stops it', () => {
  const home = { ...base, defaultPresence: 'home' as const, people: ['a', 'b'] };
  const g = presenceGate(home);
  assert(g.allow && g.status === 'override' && g.reason === 'home by default (household setting)', JSON.stringify(g));
  // One person away, the other without a signal: still home.
  assert(presenceGate({ ...home, latest: [you('away', '20:00')] }).allow, 'one away');
  // Both away within 12 h: nobody home, waits (and starts if someone arrives).
  const w = presenceGate({ ...home, latest: [you('away', '18:00'), erik('away', '19:30')] });
  assert(!w.allow && w.status === 'waiting' && w.reason.startsWith('nobody home (You away since 18:00, Erik away since 19:30'), JSON.stringify(w));
  // Both away, but one signal older than 12 h (a missed "arrive"): home by default.
  const old = { personId: 'a', name: 'You', state: 'away' as const, at: PRE - 13 * 60 * MIN };
  assert(presenceGate({ ...home, latest: [old, erik('away', '19:30')] }).allow, 'stale away');
  assert(everyoneAway([you('away', '18:00'), erik('away', '19:30')], ['a', 'b'], PRE) && !everyoneAway([], ['a', 'b'], PRE), 'everyoneAway');
  // A fresh home signal still reads as started (with the push), the overrides still win.
  assert(presenceGate({ ...home, latest: [erik('home', '18:42')] }).status === 'started', 'fresh home');
  assert(presenceGate({ ...home, override: 'away' }).status === 'away', 'away tonight');
  // Never outside pre-cool start … lights-out + 3 h.
  assert(!presenceGate({ ...home, now: PRE - MIN }).allow, 'before precool');
  assert(presenceGate({ ...home, now: LO + (START_UNTIL_MIN + 5) * MIN }).status === 'skipped', 'too late');
});

Deno.test('away periods: evening dates, inclusive; "Home tonight" wins for one night', () => {
  const bkk = { id: 1, from: '2026-11-05', to: '2026-11-06', note: 'Bangkok' };
  // Night keys are wake dates: the evening of 5 Nov is the night ending 6 Nov.
  assert(awayPeriodFor([bkk], '2026-11-05') === null, 'evening of 4 Nov: home');
  assert(awayPeriodFor([bkk], '2026-11-06') === bkk && awayPeriodFor([bkk], '2026-11-07') === bkk, 'evenings 5 and 6 Nov: away');
  assert(awayPeriodFor([bkk], '2026-11-08') === null, 'evening of 7 Nov: home again');
  const g = presenceGate({ ...base, defaultPresence: 'home', awayPeriod: bkk, latest: [you('home', '18:00')] });
  assert(!g.allow && g.status === 'away' && g.reason === 'away: Bangkok, evenings 5 Nov–6 Nov', JSON.stringify(g));
  assert(presenceGate({ ...base, defaultPresence: 'home', awayPeriod: bkk, override: 'home' }).allow, 'home tonight wins');
  assert(nightAway(null, [], bkk) !== null && nightAway('home', [], bkk) === null && nightAway('away', [], null) !== null && nightAway(null, [], null) === null, 'nightAway');
});

Deno.test('past lights-out + 15 min only a late arrival starts the AC (a failed 21:30 start never beeps while asleep)', () => {
  const home = { ...base, defaultPresence: 'home' as const, people: ['a', 'b'] };
  const at = (m: number) => LO + m * MIN;
  assert(presenceGate({ ...home, now: at(ASLEEP_START_MIN) }).allow, 'default: still at lights-out + 15');
  const d = presenceGate({ ...home, now: at(ASLEEP_START_MIN + 5) });
  assert(!d.allow && d.status === 'skipped' && d.reason.includes('no beep while asleep'), JSON.stringify(d));
  assert(!presenceGate({ ...base, override: 'home', now: at(60) }).allow, 'Home tonight: not after settle');
  // A home signal from before the pre-cool start (they were home all evening) does not start it late either.
  assert(!presenceGate({ ...home, now: at(60), latest: [erik('home', '18:42')] }).allow, 'early signal');
  // Someone arriving at 23:30 does.
  const a = presenceGate({ ...home, now: at(95), latest: [erik('home', '18:42'), you('home', '23:30')] });
  assert(a.allow && a.status === 'started' && a.reason === 'You home since 23:30', JSON.stringify(a));
  assert(presenceGate({ ...base, override: 'home', now: at(95), latest: [you('home', '23:30')] }).allow, 'Home tonight + arrival');
});
