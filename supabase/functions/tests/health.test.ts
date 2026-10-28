import { civilDate, dailyRows, rawRows, sessionEndTime } from '../_shared/health.ts';
import { ictDate } from '../_shared/time.ts';
import { defaultSchedule, nightDateFor, nightWindow } from '../_shared/time.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const hr = (iso: string, bpm: number) => ({ heartRate: { sampleTime: { physicalTime: iso }, beatsPerMinute: String(bpm) }, dataSource: { platform: 'FITBIT' } });

Deno.test('rawRows chunks heart rate per hour with a content-hash key', async () => {
  const page = { dataPoints: [hr('2026-10-28T01:59:00Z', 55), hr('2026-10-28T01:00:05Z', 54), hr('2026-10-28T02:00:00Z', 53)] };
  const rows = await rawRows('a', 'heart-rate', page);
  assert(rows.length === 2, 'two hours');
  assert(rows[0]!.point_key.startsWith('2026-10-28T01:00:00.000Z#') && rows[0]!.update_time === null, 'key');
  const more = await rawRows('a', 'heart-rate', { dataPoints: [...page.dataPoints, hr('2026-10-28T01:30:00Z', 52)] });
  assert(more[0]!.point_key !== rows[0]!.point_key && more[1]!.point_key === rows[1]!.point_key, 'new version only when content changes');
});

Deno.test('rawRows keeps one row per ordinary point with updateTime as version', async () => {
  const rows = await rawRows('b', 'sleep', {
    dataPoints: [{ name: 'users/me/dataTypes/sleep/dataPoints/1', sleep: { interval: { startTime: '2026-10-27T15:30:00Z', endTime: '2026-10-27T23:00:00Z' }, updateTime: '2026-10-28T00:10:00Z' } }],
  });
  assert(rows.length === 1 && rows[0]!.point_key === 'users/me/dataTypes/sleep/dataPoints/1' && rows[0]!.update_time === '2026-10-28T00:10:00.000Z', 'row');
});

Deno.test('civilDate and dailyRows handle object and string dates, newest version wins', () => {
  assert(civilDate({ dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 8 } } }) === '2026-10-08', 'object date');
  const rows = dailyRows('a', 'daily-resting-heart-rate', {
    dataPoints: [
      { dailyRestingHeartRate: { date: '2026-10-28', beatsPerMinute: 55 }, updateTime: '2026-10-28T01:00:00Z', dataSource: {} },
      { dailyRestingHeartRate: { date: '2026-10-28', beatsPerMinute: 54 }, updateTime: '2026-10-28T03:00:00Z', dataSource: {} },
    ],
  });
  assert(rows.length === 1 && JSON.stringify(rows[0]!.value).includes('54') && !('dataSource' in (rows[0]!.value as object)), 'latest');
});

Deno.test('ICT night helpers', () => {
  const { lightsOut, wake } = defaultSchedule('2026-10-28', '22:30', '06:30');
  assert(new Date(lightsOut).toISOString() === '2026-10-27T15:30:00.000Z' && new Date(wake).toISOString() === '2026-10-27T23:30:00.000Z', 'schedule');
  assert(new Date(defaultSchedule('2026-10-28', '00:30', '08:00').lightsOut).toISOString() === '2026-10-27T17:30:00.000Z', 'after-midnight lights-out');
  assert(nightDateFor(Date.parse('2026-10-27T14:00:00Z')) === '2026-10-28', '21:00 ICT belongs to the next wake date');
  assert(nightDateFor(Date.parse('2026-10-28T02:00:00Z')) === '2026-10-28', '09:00 ICT belongs to today');
  const w = nightWindow('2026-10-28');
  assert(w.to - w.from === 18 * 3_600_000, 'window 18:00 → 12:00');
});

Deno.test('per-session summaries are keyed by the wake date (interval end), not the evening start', () => {
  const p = { respiratoryRateSleepSummary: { interval: { startTime: '2026-10-27T15:30:00Z', endTime: '2026-10-27T23:40:00Z' }, fullSleepBreathsPerMinute: 14.2 } };
  const rows = dailyRows('a', 'respiratory-rate-sleep-summary', { dataPoints: [p] }, (x) => {
    const t = sessionEndTime(x);
    return t === null ? null : ictDate(t);
  });
  assert(rows[0]?.date === '2026-10-28', `wake date, got ${rows[0]?.date}`);
});
