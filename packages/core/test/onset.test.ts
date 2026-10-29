import { describe, expect, it } from 'vitest';
import { personSleepOnset, sessionOnset, typicalSleepOnset, type SleepSession } from '../src/index.ts';

const MIN = 60_000;
/** Epoch ms of HH:MM ICT on the evening before wake date 2026-10-(day). */
const ict = (wakeDay: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const evening = Date.UTC(2026, 9, wakeDay - 1, 0, 0) - 7 * 60 * MIN;
  return evening + (h < 12 ? 24 * 60 + h * 60 + m : h * 60 + m) * MIN;
};
const sess = (personId: string, wakeDay: number, start: string, hours = 8, awakeMin = 0): SleepSession => {
  const s = ict(wakeDay, start);
  const stages: SleepSession['stages'] = [];
  if (awakeMin) stages.push({ start: s, end: s + awakeMin * MIN, stage: 'awake' });
  stages.push({ start: s + awakeMin * MIN, end: s + hours * 60 * MIN, stage: 'light' });
  return { personId, start: s, end: s + hours * 60 * MIN, stages };
};

describe('typicalSleepOnset', () => {
  it('median of the main sleeps, onset = first non-awake stage', () => {
    const xs = ['22:50', '23:00', '23:10', '22:40', '23:20'].map((t, i) => sess('a', 10 + i, t, 8, 10));
    expect(sessionOnset(xs[0]!)).toBe(ict(10, '23:00'));
    const p = personSleepOnset(xs)!;
    expect(p.minuteOfDay).toBe(23 * 60 + 10); // starts + 10 min awake: median of 23:00, 23:10, 23:20, 22:50, 23:30
    expect(p.nights).toBe(5);
  });

  it('wraps around midnight (23:40 and 00:20 are 40 min apart)', () => {
    const xs = ['23:40', '00:20', '00:00'].map((t, i) => sess('a', 10 + i, t));
    expect(personSleepOnset(xs)!.minuteOfDay).toBe(0);
  });

  it('ignores naps and daytime sleep, keeps one main sleep per night, uses the last 14 nights', () => {
    const xs: SleepSession[] = [];
    for (let d = 1; d <= 20; d++) xs.push(sess('a', d, d <= 6 ? '21:00' : '23:00')); // 6 old early nights fall out of the window
    xs.push(sess('a', 18, '14:00', 1.5)); // afternoon nap
    xs.push(sess('a', 19, '20:30', 1)); // short evening doze before the main sleep
    xs.push(sess('a', 20, '13:00', 4)); // long daytime sleep: not bedtime
    const p = personSleepOnset(xs)!;
    expect(p.nights).toBe(14);
    expect(p.minuteOfDay).toBe(23 * 60);
  });

  it('needs at least 3 nights per person; household = the later of the two medians, rounded to 5 min', () => {
    expect(typicalSleepOnset([sess('a', 10, '23:00'), sess('a', 11, '23:00')])).toBeNull();
    const a = ['22:30', '22:40', '22:35'].map((t, i) => sess('a', 10 + i, t));
    const b = ['23:12', '23:18', '23:20', '23:05'].map((t, i) => sess('b', 10 + i, t));
    const r = typicalSleepOnset({ a, b })!;
    expect(r.perPerson.map((p) => [p.personId, p.minuteOfDay])).toEqual([
      ['a', 22 * 60 + 35],
      ['b', 23 * 60 + 15],
    ]);
    expect(r.personId).toBe('b');
    expect(r.minuteOfDay).toBe(23 * 60 + 15);
    expect(r.hhmm).toBe('23:15');
    // A flat array is grouped by personId; a person after midnight is "later" than one at 23:50.
    const c = ['00:10', '00:20', '00:05'].map((t, i) => sess('c', 10 + i, t));
    const d = ['23:50', '23:55', '23:45'].map((t, i) => sess('d', 10 + i, t));
    expect(typicalSleepOnset([...c, ...d])!.hhmm).toBe('00:10');
  });

  it('`before` drops sessions that had not ended yet', () => {
    const xs = ['23:00', '23:00', '01:00', '01:00'].map((t, i) => sess('a', 10 + i, t, i === 3 ? 7.5 : 8));
    expect(personSleepOnset(xs)!.minuteOfDay).toBe(0);
    expect(personSleepOnset(xs, { before: ict(13, '08:00') })!.minuteOfDay).toBe(23 * 60);
  });
});
