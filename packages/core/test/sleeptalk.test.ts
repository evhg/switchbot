import { describe, expect, it } from 'vitest';
import {
  applyTranscriptPolicy,
  clipAllowed,
  judgeSleepTalk,
  normalizeTranscript,
  normalizeTranscriptLang,
  parseSoundPayload,
  personStateAt,
  sleepTalkFinal,
  sleepTalkLine,
  soundEventFromRow,
  soundEventRow,
  transcriptSnippet,
  TRANSCRIPT_MAX,
  type SleepSessionLite,
} from '../src/index.ts';

const MIN = 60_000;
const t = (s: string) => Date.parse(`${s}+07:00`);
const NOW = t('2026-11-05T01:30:00');

/** A session 23:00 → 07:00 with light sleep, an awake stretch 01:00–01:20 and light again. */
const session = (o: Partial<SleepSessionLite> = {}): SleepSessionLite => ({
  start: t('2026-11-04T23:00:00'),
  end: t('2026-11-05T07:00:00'),
  stages: [
    { start: t('2026-11-04T23:00:00'), end: t('2026-11-05T01:00:00'), stage: 'light' },
    { start: t('2026-11-05T01:00:00'), end: t('2026-11-05T01:20:00'), stage: 'awake' },
    { start: t('2026-11-05T01:20:00'), end: t('2026-11-05T07:00:00'), stage: 'deep' },
  ],
  ...o,
});

describe('personStateAt', () => {
  it('asleep in a non-awake stage, awake in an awake stage or outside sessions, unknown without data', () => {
    expect(personStateAt([session()], t('2026-11-05T00:30:00'))).toBe('asleep');
    expect(personStateAt([session()], t('2026-11-05T01:10:00'))).toBe('awake');
    expect(personStateAt([session()], t('2026-11-04T22:30:00'))).toBe('awake');
    expect(personStateAt([], t('2026-11-05T00:30:00'))).toBe('awake');
    expect(personStateAt(null, t('2026-11-05T00:30:00'))).toBe('unknown');
  });
  it('counts a sleep stage within a minute of the moment; a session without stages counts as asleep', () => {
    expect(personStateAt([session()], t('2026-11-05T01:00:40'))).toBe('asleep');
    expect(personStateAt([session()], t('2026-11-05T01:18:30'), 40)).toBe('asleep');
    expect(personStateAt([session({ stages: [] })], t('2026-11-05T03:00:00'))).toBe('asleep');
  });
});

describe('judgeSleepTalk', () => {
  const awakeAll: SleepSessionLite = session({ stages: [{ start: t('2026-11-04T23:00:00'), end: t('2026-11-05T07:00:00'), stage: 'awake' }] });
  it('both asleep → sleep talk, no hint', () => {
    const v = judgeSleepTalk({ ts: t('2026-11-05T03:00:00'), people: [{ id: 'a', sessions: [session()] }, { id: 'b', sessions: [session()] }], final: false });
    expect(v).toMatchObject({ status: 'sleep_talk', talkerHint: null, asleep: ['a', 'b'] });
  });
  it('one asleep → sleep talk with that person as the hint', () => {
    const v = judgeSleepTalk({ ts: t('2026-11-05T03:00:00'), people: [{ id: 'a', sessions: [awakeAll] }, { id: 'b', sessions: [session()] }], final: false });
    expect(v).toMatchObject({ status: 'sleep_talk', talkerHint: 'b' });
  });
  it('both awake (or outside their sessions) → conversation', () => {
    expect(judgeSleepTalk({ ts: t('2026-11-05T01:10:00'), people: [{ id: 'a', sessions: [session()] }, { id: 'b', sessions: [session()] }], final: false }).status).toBe('conversation');
    expect(judgeSleepTalk({ ts: t('2026-11-04T22:20:00'), people: [{ id: 'a', sessions: [session()] }, { id: 'b', sessions: [] }], final: false }).status).toBe('conversation');
  });
  it('missing data: pending before 13:00, then judged with what exists (no data = awake, no hint)', () => {
    const people = [{ id: 'a', sessions: [session()] }, { id: 'b', sessions: null }];
    expect(judgeSleepTalk({ ts: t('2026-11-05T03:00:00'), people, final: false }).status).toBe('pending');
    expect(judgeSleepTalk({ ts: t('2026-11-05T03:00:00'), people, final: true })).toMatchObject({ status: 'sleep_talk', talkerHint: null });
    expect(judgeSleepTalk({ ts: t('2026-11-05T01:10:00'), people, final: true }).status).toBe('conversation');
    expect(judgeSleepTalk({ ts: t('2026-11-05T03:00:00'), people: [{ id: 'a', sessions: null }, { id: 'b', sessions: null }], final: true }).status).toBe('conversation');
  });
  it('final from 13:00 ICT on the night date', () => {
    expect(sleepTalkFinal('2026-11-05', t('2026-11-05T12:59:00'))).toBe(false);
    expect(sleepTalkFinal('2026-11-05', t('2026-11-05T13:00:00'))).toBe(true);
  });
});

describe('sleep talk push line', () => {
  it('lists times (ICT), a probable talker and the first snippet', () => {
    const line = sleepTalkLine(
      [
        { ts: t('2026-11-05T03:40:00'), talkerHint: null, transcript: null },
        { ts: t('2026-11-05T01:12:00'), talkerHint: 'a', transcript: 'no the blue one, the blue one' },
      ],
      { a: 'Cath', b: 'Erik' },
    );
    expect(line).toBe('Sleep talk: 2 clips (01:12 Cath?, 03:40) — tap to listen. “no the blue one, the blue one”');
    expect(sleepTalkLine([], {})).toBeNull();
  });
  it('snippet ≤ 80 chars, cut at a word', () => {
    const s = transcriptSnippet('word '.repeat(40));
    expect([...s].length).toBeLessThanOrEqual(82);
    expect(s.endsWith('…”')).toBe(true);
  });
});

describe('speech clips and transcripts', () => {
  const ev = (o: Partial<{ kind: 'speech' | 'loud'; label: string | null }> = {}) => ({ ts: NOW - MIN, kind: 'speech' as 'speech' | 'loud', label: 'Speech' as string | null, wantClip: true, ...o });
  it('speech is clipped only with sleep talk on', () => {
    expect(clipAllowed(ev(), NOW)).toBe(false);
    expect(clipAllowed(ev(), NOW, { speech: false })).toBe(false);
    expect(clipAllowed(ev(), NOW, { speech: true })).toBe(true);
    expect(clipAllowed(ev({ kind: 'loud', label: 'Shout' }), NOW, { speech: true })).toBe(true);
    expect(clipAllowed({ ...ev(), ts: NOW - 11 * MIN }, NOW, { speech: true })).toBe(false);
    expect(clipAllowed(ev({ kind: 'loud', label: 'Door' }), NOW)).toBe(true);
  });
  it('parses, normalises and drops transcripts', () => {
    const p = parseSoundPayload({ events: [{ ts: NOW - MIN, kind: 'speech', label: 'Speech', wantClip: true, transcript: '  hallo\n daar ', transcriptLang: 'NL' }] }, NOW);
    const e = p.events[0]!;
    expect(e.transcript).toBe('hallo daar');
    expect(e.transcriptLang).toBe('nl');
    expect(applyTranscriptPolicy(e, true).transcript).toBe('hallo daar');
    expect(applyTranscriptPolicy(e, false)).toMatchObject({ transcript: null, transcriptLang: null });
    expect(applyTranscriptPolicy({ ...e, kind: 'snore', label: 'Snoring' }, true).transcript).toBeNull();
    expect([...normalizeTranscript('x'.repeat(3000))!].length).toBe(TRANSCRIPT_MAX);
    expect(normalizeTranscript('   ')).toBeNull();
    expect(normalizeTranscriptLang('english language')).toBeNull();
    const row = soundEventRow(e, 'bedroom', '2026-11-05');
    expect(row).toMatchObject({ transcript: 'hallo daar', transcript_lang: 'nl' });
    expect(soundEventRow({ ...e, transcript: null })).not.toHaveProperty('transcript');
    expect(soundEventFromRow({ ...(row as { ts: string; kind: string }), transcript: 'hallo daar', transcript_lang: 'nl' })).toMatchObject({ transcript: 'hallo daar', transcriptLang: 'nl' });
  });
});
