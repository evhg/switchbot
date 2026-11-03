import { describe, expect, it } from 'vitest';
import {
  awakeningStarts,
  clipAllowed,
  isSpeechLabel,
  inWindow,
  listenWindow,
  nightSoundSummary,
  parseSoundPayload,
  soundClipPath,
  soundEventFromRow,
  soundEventRow,
  soundMinuteFromRow,
  soundMinuteRow,
  soundNightDate,
  wakeTriggers,
  SOUND_MAX_EVENTS,
  SOUND_MAX_MINUTES,
  type SoundEvent,
  type SoundMinute,
} from '../src/index.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-11-04T01:30:00+07:00');
const iso = (offsetMin: number) => new Date(NOW + offsetMin * MIN).toISOString();

const minute = (offsetMin: number, o: Partial<SoundMinute> = {}): SoundMinute => ({
  ts: NOW + offsetMin * MIN,
  dbAvg: -60,
  dbMax: -50,
  dbFloor: -70,
  snoreS: 0,
  snoreProb: 0,
  speechS: 0,
  coughS: 0,
  classes: {},
  n: 61,
  ...o,
});
const event = (offsetMin: number, o: Partial<SoundEvent> = {}): SoundEvent => ({
  ts: NOW + offsetMin * MIN,
  durationS: 3,
  kind: 'loud',
  label: 'Door',
  peakDb: -40,
  score: 0.8,
  wantClip: false,
  ...o,
});

describe('parseSoundPayload', () => {
  it('ping', () => {
    const r = parseSoundPayload({ ping: true }, NOW);
    expect(r.ping).toBe(true);
    expect(r.fatal).toBeNull();
  });

  it('validates and clamps minutes', () => {
    const r = parseSoundPayload(
      {
        camera: 'bedroom',
        minutes: [
          {
            ts: '2026-11-04T01:29:30+07:00',
            dbAvg: -55.55,
            dbMax: 40,
            dbFloor: -500,
            snoreS: 75,
            snoreProb: 1.4,
            speechS: -3,
            coughS: '2',
            classes: { Snoring: 40, Breathing: 12, Silence: 5, Speech: 0, Music: 1, Dog: 2, Fan: 3, '<b>': 9 },
            n: 61,
          },
          { ts: '2026-11-04T01:29:00+07:00' }, // same minute → duplicate
          { ts: iso(10) }, // future
          { ts: iso(-37 * 60) }, // too old
          { ts: '2026-11-04T01:29:00' }, // no zone
        ],
      },
      NOW,
    );
    expect(r.fatal).toBeNull();
    expect(r.minutes).toHaveLength(1);
    const m = r.minutes[0]!;
    expect(m.ts).toBe(Date.parse('2026-11-04T01:29:00+07:00'));
    expect(m.dbAvg).toBe(-55.5);
    expect(m.dbMax).toBe(20);
    expect(m.dbFloor).toBe(-120);
    expect(m.snoreS).toBe(60);
    expect(m.snoreProb).toBe(1);
    expect(m.speechS).toBe(0);
    expect(m.coughS).toBe(2);
    expect(Object.keys(m.classes)).toEqual(['Snoring', 'Breathing', 'Silence', 'Fan', 'Dog']);
    expect(r.errors.map((e) => [e.kind, e.index])).toEqual([
      ['minute', 1],
      ['minute', 2],
      ['minute', 3],
      ['minute', 4],
    ]);
  });

  it('validates events and keeps the request index', () => {
    const r = parseSoundPayload(
      {
        events: [
          { ts: iso(-1), kind: 'banana' },
          { ts: iso(-1), durationS: 9.2, kind: 'Snore', label: 'Snoring', peakDb: -30, score: 0.7, wantClip: true },
          { ts: iso(-1), kind: 'speech', wantClip: 'yes' },
        ],
      },
      NOW,
    );
    expect(r.events.map((e) => [e.index, e.kind, e.wantClip])).toEqual([
      [1, 'snore', true],
      [2, 'speech', false],
    ]);
    expect(r.errors).toEqual([{ kind: 'event', index: 0, reason: expect.stringContaining('kind') }]);
  });

  it('never allows a clip of speech (by kind or label) or of a stale event', () => {
    const ev = (o: Partial<{ ts: number; kind: SoundEvent['kind']; label: string | null; wantClip: boolean }> = {}) => ({
      ts: NOW - MIN,
      kind: 'loud' as const,
      label: 'Door',
      wantClip: true,
      ...o,
    });
    expect(clipAllowed(ev(), NOW)).toBe(true);
    expect(clipAllowed(ev({ wantClip: false }), NOW)).toBe(false);
    expect(clipAllowed(ev({ kind: 'speech' }), NOW)).toBe(false);
    expect(clipAllowed(ev({ label: 'Speech' }), NOW)).toBe(false);
    expect(clipAllowed(ev({ label: ' shout ' }), NOW)).toBe(false);
    expect(clipAllowed(ev({ kind: 'cough', label: 'Narration, monologue' }), NOW)).toBe(false);
    expect(clipAllowed(ev({ ts: NOW - 11 * MIN }), NOW)).toBe(false);
    expect(isSpeechLabel('Snoring')).toBe(false);
    expect(isSpeechLabel(null)).toBe(false);
    expect(isSpeechLabel('Whispering')).toBe(true);
  });

  it('refuses too many rows, bad camera and non-objects', () => {
    expect(parseSoundPayload({ minutes: Array.from({ length: SOUND_MAX_MINUTES + 1 }, () => ({})) }, NOW).fatal).toMatch(/minutes/);
    expect(parseSoundPayload({ events: Array.from({ length: SOUND_MAX_EVENTS + 1 }, () => ({})) }, NOW).fatal).toMatch(/events/);
    expect(parseSoundPayload({ camera: 'Bed<room>' }, NOW).fatal).toMatch(/camera/);
    expect(parseSoundPayload([], NOW).fatal).toMatch(/object/);
    expect(parseSoundPayload({ minutes: 'x' }, NOW).fatal).toMatch(/minutes/);
  });
});

describe('night and window', () => {
  it('soundNightDate keys a night by its morning (ICT, switch at 12:00)', () => {
    expect(soundNightDate(Date.parse('2026-11-03T22:00:00+07:00'))).toBe('2026-11-04');
    expect(soundNightDate(Date.parse('2026-11-04T08:59:00+07:00'))).toBe('2026-11-04');
    expect(soundNightDate(Date.parse('2026-11-04T11:59:00+07:00'))).toBe('2026-11-04');
    expect(soundNightDate(Date.parse('2026-11-04T12:00:00+07:00'))).toBe('2026-11-05');
  });

  it('listenWindow = lights-out − 15 min → wake + 30 min', () => {
    const lightsOut = Date.parse('2026-11-03T22:00:00+07:00');
    const wake = Date.parse('2026-11-04T08:30:00+07:00');
    const w = listenWindow({ lightsOut, wake });
    expect(new Date(w.from).toISOString()).toBe('2026-11-03T14:45:00.000Z');
    expect(new Date(w.until).toISOString()).toBe('2026-11-04T02:00:00.000Z');
    expect(listenWindow({ lightsOut, offAt: wake })).toEqual({ from: w.from, until: wake });
    expect(() => listenWindow({ lightsOut })).toThrow();
    expect(inWindow(w.from - 4 * MIN, w)).toBe(false);
    expect(inWindow(w.from - 4 * MIN, w, 5 * MIN)).toBe(true);
    expect(inWindow(w.until + 6 * MIN, w, 5 * MIN)).toBe(false);
  });
});

describe('rows', () => {
  it('round-trips minutes and events; clip path', () => {
    const m = minute(0, { snoreS: 22, classes: { Snoring: 22 } });
    const row = soundMinuteRow(m);
    expect(row).toMatchObject({ camera: 'bedroom', night_date: '2026-11-04', snore_s: 22 });
    expect(soundMinuteFromRow(row as never)).toEqual(m);
    const e = event(0, { kind: 'snore' });
    const er = soundEventRow(e, 'bedroom', '2026-11-04');
    expect(er).toMatchObject({ kind: 'snore', peak_db: -40, night_date: '2026-11-04' });
    expect(soundEventFromRow({ ...(er as { ts: string; kind: string }), id: 5, clip_path: 'x', hidden: false })).toMatchObject({ id: 5, ts: e.ts, kind: 'snore', clipPath: 'x' });
    expect(soundClipPath('2026-11-04', { ts: Date.parse('2026-11-03T17:15:02.345Z'), kind: 'snore' })).toBe('2026-11-04/20261103T171502.345Z_snore.m4a');
    expect(soundClipPath('2026-11-04', { ts: Date.parse('2026-11-03T17:15:02Z'), kind: 'loud' })).toBe('2026-11-04/20261103T171502Z_loud.m4a');
  });
});

describe('nightSoundSummary', () => {
  it('counts snoring minutes, runs, loud events, loudest and floor', () => {
    const ms = [
      minute(0, { snoreS: 12 }),
      minute(1, { snoreS: 30 }),
      minute(2, { snoreS: 5, dbMax: -20 }),
      minute(3, { snoreS: 40, dbFloor: -66 }),
      minute(5, { snoreS: 40 }), // gap at 4: a new run
      minute(6, { snoreS: 40 }),
      minute(7, { snoreS: 40 }),
    ];
    const s = nightSoundSummary(ms, [event(2, { peakDb: -10 }), event(3, { kind: 'cough' })]);
    expect(s).toEqual({
      listenedMin: 7,
      snoreMin: 6,
      snorePct: 86,
      loudEvents: 1,
      longestSnoreRunMin: 3,
      loudestDb: -10,
      floorDb: -70,
    });
    expect(nightSoundSummary([], [])).toEqual({ listenedMin: 0, snoreMin: 0, snorePct: 0, loudEvents: 0, longestSnoreRunMin: 0, loudestDb: null, floorDb: null });
  });
});

describe('awakeningStarts', () => {
  it('awake runs after sleep onset, once per run', () => {
    const t = (m: number) => NOW + m * MIN;
    const stages = [
      { start: t(0), end: t(20), stage: 'awake' as const },
      { start: t(20), end: t(60), stage: 'light' as const },
      { start: t(60), end: t(62), stage: 'awake' as const },
      { start: t(62), end: t(64), stage: 'awake' as const },
      { start: t(64), end: t(120), stage: 'deep' as const },
      { start: t(120), end: t(121), stage: 'awake' as const },
    ];
    expect(awakeningStarts(stages)).toEqual([t(60), t(120)]);
  });
});

describe('wakeTriggers', () => {
  it('snoring, loud noises and unheard awakenings', () => {
    const ms = [minute(0), minute(1, { snoreS: 25 }), minute(2), minute(10), minute(11), minute(12), minute(20), minute(21)];
    const es = [
      event(11.5, { kind: 'loud', peakDb: -50 }), // floor −70 + 15 = −55 → loud
      event(20.2, { kind: 'other', label: 'Dog', peakDb: -60 }), // below threshold
    ];
    const r = wakeTriggers([NOW + 2.5 * MIN, NOW + 12 * MIN, NOW + 21 * MIN, NOW + 60 * MIN], ms, es);
    expect(r.wakeUps).toBe(4);
    expect(r.heard).toBe(3);
    expect(r.withSnore).toBe(1);
    expect(r.withLoud).toBe(1);
    expect(r.triggered).toBe(2);
    expect(r.rows.map((x) => [x.snore, x.loud, x.heard])).toEqual([
      [true, false, true],
      [false, true, true],
      [false, false, true],
      [false, false, false],
    ]);
    expect(r.rows[1]!.event).toMatchObject({ kind: 'loud', peakDb: -50 });
  });

  it('respects the lookback', () => {
    const ms = [minute(0, { snoreS: 30 }), minute(1), minute(2), minute(3), minute(4)];
    expect(wakeTriggers([NOW + 4.5 * MIN], ms, []).withSnore).toBe(0);
    expect(wakeTriggers([NOW + 4.5 * MIN], ms, [], { lookbackMs: 5 * MIN }).withSnore).toBe(1);
  });
});
