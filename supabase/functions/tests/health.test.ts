import { civilDate, dailyRows, dailyVitalsRows, newestDeviceSync, newestPointTime, rawRows, sessionEndTime, stepsVitalsRows } from '../_shared/health.ts';
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

Deno.test('stepsVitalsRows sums 1-min intervals per ICT day', () => {
  const st = (start: string, count: string) => ({
    steps: { interval: { startTime: start, endTime: new Date(Date.parse(start) + 60_000).toISOString() }, count },
  });
  const rows = stepsVitalsRows('a', { dataPoints: [st('2026-10-27T16:59:00Z', '30'), st('2026-10-27T17:00:00Z', '12'), st('2026-10-28T03:00:00Z', '100')] });
  assert(rows.length === 2, 'two local days');
  assert(rows[0]!.date === '2026-10-27' && rows[0]!.steps === 30, 'day before local midnight');
  assert(rows[1]!.date === '2026-10-28' && rows[1]!.steps === 112, 'local day after 17:00Z');
  assert(rows.every((r) => Object.keys(r).sort().join() === 'date,person_id,steps,updated_at'), 'steps rows touch only steps');
});

Deno.test('dailyVitalsRows maps resting HR and daily HRV to their own columns', () => {
  const rhr = dailyVitalsRows('b', 'daily-resting-heart-rate', {
    dataPoints: [{ dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 28 }, beatsPerMinute: '57', dailyRestingHeartRateMetadata: { calculationMethod: 'WITH_SLEEP' } } }],
  });
  assert(rhr.length === 1 && rhr[0]!.date === '2026-10-28' && rhr[0]!.resting_hr === 57 && rhr[0]!.resting_hr_method === 'WITH_SLEEP', 'resting hr');
  assert(!('steps' in rhr[0]!) && !('hrv_daily_ms' in rhr[0]!), 'no foreign columns');
  const hrv = dailyVitalsRows('b', 'daily-heart-rate-variability', {
    dataPoints: [{ dailyHeartRateVariability: { date: { year: 2026, month: 10, day: 28 }, averageHeartRateVariabilityMilliseconds: 41.5 } }],
  });
  assert(hrv[0]!.hrv_daily_ms === 41.5 && hrv[0]!.deep_rmssd_ms === null, 'hrv columns, missing deep value is null');
  assert(dailyVitalsRows('b', 'daily-oxygen-saturation', { dataPoints: [] }).length === 0, 'other types');
});

Deno.test('newestPointTime / newestDeviceSync: latest band activity for band_sync', () => {
  const pts = [hr('2026-10-28T01:59:00Z', 55), hr('2026-10-28T02:10:00Z', 53), hr('2026-10-28T01:00:05Z', 54)];
  assert(newestPointTime(pts) === Date.parse('2026-10-28T02:10:00Z'), 'newest sample of an array');
  assert(newestPointTime({ dataPoints: pts }) === Date.parse('2026-10-28T02:10:00Z'), 'newest sample of a page');
  const steps = [{ steps: { interval: { startTime: '2026-10-28T03:00:00Z', endTime: '2026-10-28T03:01:00Z' }, count: '12' } }];
  assert(newestPointTime(steps) === Date.parse('2026-10-28T03:01:00Z'), 'interval end for steps');
  assert(newestPointTime([]) === null, 'none');
  const devices = [{ deviceType: 'TRACKER', lastSyncTime: '2026-10-28T04:00:00Z', batteryLevel: 80 }, { deviceType: 'PHONE', lastSyncTime: '2026-10-28T05:00:00Z' }, { deviceType: 'X' }];
  assert(newestDeviceSync(devices) === Date.parse('2026-10-28T05:00:00Z'), 'newest lastSyncTime');
  assert(newestDeviceSync([]) === null, 'no devices');
});

Deno.test('OAuth account check: Gmail-normalised, only another household login is rejected', async () => {
  const { idTokenEmail, normEmail, wrongAccount } = await import('../_shared/health.ts');
  assert(normEmail('Cath.Tunti+fit@googlemail.com') === 'cathtunti@gmail.com' && normEmail('a.b@example.com') === 'a.b@example.com' && normEmail('x') === null, 'normEmail');
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const tok = (c: unknown) => `${b64({ alg: 'RS256' })}.${b64(c)}.sig`;
  assert(idTokenEmail(tok({ aud: 'cid', email: 'verspui@gmail.com', email_verified: true }), 'cid') === 'verspui@gmail.com', 'email');
  assert(idTokenEmail(tok({ aud: 'other', email: 'verspui@gmail.com' }), 'cid') === null, 'aud');
  assert(idTokenEmail(tok({ aud: 'cid', email: 'x@y.z', email_verified: false }), 'cid') === null, 'unverified');
  assert(idTokenEmail(undefined, 'cid') === null && idTokenEmail('garbage', 'cid') === null, 'absent');
  const members = [{ personId: 'a', email: 'cath.tunti@gmail.com' }, { personId: 'b', email: 'verspui@gmail.com' }];
  assert(wrongAccount('verspui@gmail.com', 'a', members) === 'b', 'Erik on Cath\'s link');
  assert(wrongAccount('cathtunti@gmail.com', 'a', members) === null, 'own account (dots ignored)');
  assert(wrongAccount('fitbit.only@gmail.com', 'a', members) === null && wrongAccount(null, 'a', members) === null, 'unknown account: accepted');
});
