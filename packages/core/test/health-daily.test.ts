import { describe, expect, it } from 'vitest';
import {
  dailyStepTotals,
  localDate,
  parseCivilDate,
  parseDailyHrv,
  parseDailyRestingHr,
  parseStepIntervals,
  personNightMetrics,
  simulateNights,
} from '../src/index.ts';

// Fixtures follow the documented v4 DataPoint shapes (docs/research/health-data.md §2.5):
//   steps: {interval{startTime, endTime, …}, count (int64 → string)}
//   dailyRestingHeartRate: {date{year, month, day}, beatsPerMinute, dailyRestingHeartRateMetadata{calculationMethod}}
//   dailyHeartRateVariability: {date, averageHeartRateVariabilityMilliseconds, deepSleepRoot…Milliseconds, …}
const stepPoint = (start: string, count: string | number, minutes = 1) => ({
  name: `users/me/dataTypes/steps/dataPoints/${start}`,
  dataSource: { platform: 'FITBIT' },
  steps: {
    interval: { startTime: start, endTime: new Date(Date.parse(start) + minutes * 60_000).toISOString(), startUtcOffset: '25200s', endUtcOffset: '25200s' },
    count,
  },
});

describe('steps', () => {
  it('parses intervals (int64 strings, snake_case), drops bad points and duplicate starts', () => {
    const page = {
      dataPoints: [
        stepPoint('2026-10-27T03:00:00Z', '120'),
        stepPoint('2026-10-27T03:01:00Z', 95),
        stepPoint('2026-10-27T03:01:00Z', 95), // repeated across pages
        { steps: { interval: { start_time: '2026-10-27T03:02:00Z', end_time: '2026-10-27T03:03:00Z' }, count: '7' } },
        { steps: { interval: { startTime: '2026-10-27T03:04:00Z', endTime: '2026-10-27T03:05:00Z' }, count: '-3' } },
        { steps: { interval: { startTime: 'garbage', endTime: '2026-10-27T03:05:00Z' }, count: '3' } },
        { heartRate: {} },
      ],
    };
    const xs = parseStepIntervals(page);
    expect(xs.map((x) => x.count)).toEqual([120, 95, 7]);
    expect(xs[0]!.end - xs[0]!.start).toBe(60_000);
  });

  it('sums per ICT calendar day: 16:59Z is still the same local day, 17:00Z is the next', () => {
    const pages = [
      { dataPoints: [stepPoint('2026-10-26T16:59:00Z', 40), stepPoint('2026-10-26T17:00:00Z', 10)] },
      { dataPoints: [stepPoint('2026-10-27T02:00:00Z', '5000'), stepPoint('2026-10-27T16:59:00Z', 1)] },
    ];
    expect(dailyStepTotals(pages)).toEqual([
      { date: '2026-10-26', steps: 40 },
      { date: '2026-10-27', steps: 5011 },
    ]);
    // A different fixed offset moves the boundary.
    expect(dailyStepTotals(pages, 0).map((d) => d.date)).toEqual(['2026-10-26', '2026-10-27']);
    expect(localDate(Date.parse('2026-10-26T17:00:00Z'))).toBe('2026-10-27');
  });
});

describe('daily resting HR and HRV', () => {
  it('parses civil dates in both shapes', () => {
    expect(parseCivilDate({ year: 2026, month: 3, day: 9 })).toBe('2026-03-09');
    expect(parseCivilDate('2026-10-27')).toBe('2026-10-27');
    expect(parseCivilDate({ year: 2026, month: 13, day: 1 })).toBeNull();
    expect(parseCivilDate(undefined)).toBeNull();
  });

  it('daily-resting-heart-rate: latest version per date wins, out-of-range dropped', () => {
    const page = {
      dataPoints: [
        { updateTime: '2026-10-27T08:00:00Z', dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 27 }, beatsPerMinute: '58', dailyRestingHeartRateMetadata: { calculationMethod: 'WITH_SLEEP' } } },
        { updateTime: '2026-10-27T11:00:00Z', dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 27 }, beatsPerMinute: 57 } },
        { dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 26 }, beatsPerMinute: 59, dailyRestingHeartRateMetadata: { calculationMethod: 'ONLY_WITH_AWAKE_DATA' } } },
        { dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 25 }, beatsPerMinute: 0 } },
      ],
    };
    expect(parseDailyRestingHr(page)).toEqual([
      { date: '2026-10-26', bpm: 59, method: 'ONLY_WITH_AWAKE_DATA' },
      { date: '2026-10-27', bpm: 57 },
    ]);
  });

  it('daily-heart-rate-variability: average, deep-sleep RMSSD and non-REM HR', () => {
    const page = {
      dataPoints: [
        {
          dailyHeartRateVariability: {
            date: { year: 2026, month: 10, day: 27 },
            averageHeartRateVariabilityMilliseconds: 44.2,
            deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: '58.9',
            nonRemHeartRateBeatsPerMinute: 54,
            entropy: 2.9,
          },
        },
        { dailyHeartRateVariability: { date: { year: 2026, month: 10, day: 26 } } },
      ],
    };
    expect(parseDailyHrv(page)).toEqual([{ date: '2026-10-27', averageMs: 44.2, deepSleepRmssdMs: 58.9, nonRemHr: 54 }]);
  });
});

describe('simulated daily vitals', () => {
  const nights = simulateNights({ seed: 42, nights: 60, endDate: '2026-10-27' });

  it('steps and resting HR are present, plausible and person-specific', () => {
    for (const id of ['a', 'b']) {
      const pns = nights.flatMap((n) => n.people.filter((p) => p.personId === id));
      expect(pns.length).toBeGreaterThan(40);
      const gaps: number[] = [];
      for (const pn of pns) {
        expect(Number.isInteger(pn.steps)).toBe(true);
        expect(pn.steps!).toBeGreaterThanOrEqual(1500);
        expect(pn.steps!).toBeLessThanOrEqual(24000);
        const m = personNightMetrics({ ...nights[0]!, date: '2026-01-01', people: [pn] }, id);
        gaps.push(pn.restingHr! - m.hrNadir);
        expect(m.steps).toBe(pn.steps);
        expect(m.restingHr).toBe(pn.restingHr);
        expect(m.deepRmssd!).toBeGreaterThan(m.rmssdMean);
      }
      // Resting HR sits a few bpm above the (smoothed) sleeping nadir.
      const gap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      expect(gap).toBeGreaterThan(3);
      expect(gap).toBeLessThan(10);
      expect(Math.min(...gaps)).toBeGreaterThan(0);
    }
  });

  it('exercise days walk more than other days', () => {
    const steps = (tagged: boolean) =>
      nights.filter((n) => n.tags.includes('late_exercise') === tagged).flatMap((n) => n.people.map((p) => p.steps!));
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(steps(true))).toBeGreaterThan(avg(steps(false)) + 2000);
  });

  it('daily HRV from Google stands in when there are no HRV samples', () => {
    const n = nights.at(-1)!;
    const pn = { ...n.people[0]!, hrv: [], hrvDailyMs: 41.3, deepRmssdMs: 55 };
    const m = personNightMetrics({ ...n, people: [pn] }, pn.personId);
    expect(m.rmssdMean).toBe(41.3);
    expect(m.deepRmssd).toBe(55);
  });
});
