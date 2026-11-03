import { listenDecision, type ListenInput, notListening, pausedText, soundWindow } from '../_shared/sound.ts';
import { defaultSchedule, nightDateFor } from '../_shared/time.ts';
import { clipAllowed, inWindow, LISTEN_GRACE_MS, parseSoundPayload, soundNightDate } from '../../../packages/core/src/sound/payload.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg: string) {
  if (a !== b) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const t = (s: string) => Date.parse(`${s}+07:00`);
const { lightsOut, wake } = defaultSchedule('2026-11-04', '22:00', '08:30');
const base = (now: number, o: Partial<ListenInput> = {}): ListenInput => ({
  now,
  settings: { mode: 'auto', pausedUntil: null, clips: true },
  night: { date: '2026-11-04', lightsOut, wake, presenceOverride: null, tags: [] },
  awayWhy: null,
  latest: [],
  people: ['a', 'b'],
  ...o,
});

Deno.test('listen window: lights-out − 15 min → wake + 30 min', () => {
  eq(listenDecision(base(t('2026-11-03T21:40:00'))).reason, 'Off — starts 21:45', 'before');
  const on = listenDecision(base(t('2026-11-03T21:45:00')));
  assert(on.listen, 'at start');
  eq(on.reason, 'Listening until 09:00', 'reason');
  eq(new Date(on.until).toISOString(), '2026-11-04T02:00:00.000Z', 'until 09:00 ICT');
  assert(listenDecision(base(t('2026-11-04T09:00:00'))).listen, 'at OFF');
  assert(!listenDecision(base(t('2026-11-04T09:01:00'))).listen, 'after OFF');
});

Deno.test('listen: off, paused, away, nobody home', () => {
  const now = t('2026-11-04T01:00:00');
  eq(listenDecision(base(now, { settings: { mode: 'off', pausedUntil: null, clips: true } })).reason, 'Turned off in settings', 'off');
  const paused = listenDecision(base(now, { settings: { mode: 'auto', pausedUntil: t('2026-11-04T12:00:00'), clips: true } }));
  assert(!paused.listen, 'paused');
  eq(paused.reason, 'Paused until 12:00', 'paused reason');
  assert(listenDecision(base(now, { settings: { mode: 'auto', pausedUntil: now - 1, clips: true } })).listen, 'pause over');
  eq(listenDecision(base(now, { awayWhy: 'away tonight (marked in the app)' })).reason, 'Away tonight', 'away');
  const latest = [
    { personId: 'a', name: 'Cath', state: 'away' as const, at: now - 3_600_000 },
    { personId: 'b', name: 'Erik', state: 'away' as const, at: now - 3_600_000 },
  ];
  eq(listenDecision(base(now, { latest })).reason, 'Nobody home', 'everyone away');
  assert(listenDecision(base(now, { latest, night: { ...base(now).night, presenceOverride: 'home' } })).listen, 'home tonight wins');
  assert(listenDecision(base(now, { latest: [latest[0]!] })).listen, 'Erik has no signal → home');
});

Deno.test('pausedText and notListening', () => {
  const now = t('2026-11-03T23:00:00');
  eq(pausedText(t('2026-11-04T12:00:00'), now), 'Paused until tomorrow 12:00', 'tomorrow');
  assert(notListening({ mode: 'auto', pausedUntil: now + 1, clips: true }, now), 'paused');
  assert(!notListening({ mode: 'auto', pausedUntil: now - 1, clips: true }, now), 'not paused');
});

Deno.test('server-side window filter and night keying match the backend', () => {
  for (const s of ['2026-11-03T21:00:00', '2026-11-04T08:59:00', '2026-11-04T12:00:00']) {
    eq(soundNightDate(t(s)), nightDateFor(t(s)), s);
  }
  const w = soundWindow({ lightsOut, wake });
  assert(inWindow(t('2026-11-03T21:41:00'), w, LISTEN_GRACE_MS), 'grace before');
  assert(!inWindow(t('2026-11-03T21:30:00'), w, LISTEN_GRACE_MS), 'too early');
  const p = parseSoundPayload({ minutes: [{ ts: '2026-11-04T01:00:00+07:00', snoreS: 20 }], events: [{ ts: '2026-11-04T01:00:10+07:00', kind: 'snore', wantClip: true }] }, t('2026-11-04T01:01:00'));
  eq(p.minutes.length + p.events.length, 2, 'parsed');
});

Deno.test('clips: never for speech labels or re-sent (stale) events', () => {
  const now = Date.parse('2026-11-04T01:30:00+07:00');
  const parsed = parseSoundPayload(
    {
      events: [
        { ts: new Date(now - 60_000).toISOString(), kind: 'loud', label: 'Door', wantClip: true },
        { ts: new Date(now - 60_000).toISOString(), kind: 'loud', label: 'Shout', wantClip: true },
        { ts: new Date(now - 60_000).toISOString(), kind: 'speech', label: 'Speech', wantClip: true },
        { ts: new Date(now - 30 * 60_000).toISOString(), kind: 'cough', label: 'Cough', wantClip: true },
      ],
    },
    now,
  );
  const allowed = parsed.events.filter((e) => clipAllowed(e, now)).map((e) => e.index);
  if (JSON.stringify(allowed) !== '[0]') throw new Error(`clip guard: ${JSON.stringify(allowed)}`);
});
