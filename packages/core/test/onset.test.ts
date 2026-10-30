import { describe, expect, it } from 'vitest';
import { mergeSplitSessions, personSleepOnset, sessionOnset, typicalSleepOnset, type SleepSession } from '../src/index.ts';

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

  it('merges a night Fitbit split in two (< 2 h apart) before taking the first non-awake start', () => {
    // Each night: 23:00 → 02:40 (10 min awake first), awake 30 min, 03:10 → 08:30. The second piece alone is longer
    // and would put the onset at 03:10.
    const nights = [10, 11, 12].flatMap((d) => {
      const first = sess('a', d, '23:00', 3 + 40 / 60, 10);
      const second = sess('a', d, '03:10', 5 + 20 / 60);
      return [second, first]; // order doesn't matter
    });
    const p = personSleepOnset(nights)!;
    expect(p.nights).toBe(3);
    expect(p.minuteOfDay).toBe(23 * 60 + 10);
    const merged = mergeSplitSessions(nights.filter((s) => s.end <= ict(10, '09:00')));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.start).toBe(ict(10, '23:00'));
    expect(merged[0]!.end).toBe(ict(10, '08:30'));
    expect(merged[0]!.stages.map((x) => x.stage)).toEqual(['awake', 'light', 'light']);
  });

  it('two pieces that are each shorter than a main sleep still make one night', () => {
    const nights = [10, 11, 12].flatMap((d) => [sess('a', d, '22:50', 2.5), sess('a', d, '02:00', 2.5)]);
    const p = personSleepOnset(nights)!;
    expect(p.nights).toBe(3);
    expect(p.minuteOfDay).toBe(22 * 60 + 50);
  });

  it('does not merge sessions 2 h or more apart, nor a short doze an hour before bed', () => {
    const far = [sess('a', 10, '22:00', 2), sess('a', 10, '02:00', 6)]; // 22:00–00:00, then 02:00: gap 2 h
    expect(mergeSplitSessions(far)).toHaveLength(2);
    const doze = [sess('a', 10, '20:30', 1), sess('a', 10, '23:00', 8)]; // 20:30–21:30 on the sofa, bed 23:00
    expect(mergeSplitSessions(doze)).toHaveLength(2);
    const people = [sess('a', 10, '23:00', 3), sess('b', 10, '02:30', 5)];
    expect(mergeSplitSessions(people)).toHaveLength(2);
  });
});
