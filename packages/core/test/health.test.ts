import { describe, expect, it } from 'vitest';
import {
  GoogleHealthClient,
  GoogleHealthError,
  GoogleOAuthError,
  SCOPE_HEALTH_METRICS,
  SCOPE_SLEEP,
  dataPointsOf,
  exchangeCode,
  googleAuthUrl,
  intervalFilter,
  mapSleepStage,
  parseHeartRate,
  parseHrv,
  parseSleep,
  parseSpo2,
  refreshAccessToken,
  sampleTimeFilter,
} from '../src/index.ts';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('no more fake responses');
    return r;
  };
  return { fn, calls };
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers });

// ---------- fixtures ----------
// Built from the documented DataPoint JSON (developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints).
// Documented: heartRate.sampleTime.physicalTime, heartRate.beatsPerMinute (int64 → string), metadata.*;
// heartRateVariability.rootMeanSquareOfSuccessiveDifferencesMilliseconds / standardDeviationMilliseconds;
// oxygenSaturation.percentage; sleep.interval.{startTime,endTime}, sleep.stages[{startTime,endTime,type}],
// sleep.metadata.nap, sleep.updateTime. Assumed: `name` values, the dataSource sub-fields, and that list pages are
// newest-first as documented (the parsers sort anyway).

const HR_PAGE = {
  dataPoints: [
    {
      name: 'users/me/dataTypes/heart-rate/dataPoints/b',
      dataSource: { recordingMethod: 'PASSIVELY_MEASURED', platform: 'FITBIT' },
      heartRate: { sampleTime: { physicalTime: '2026-10-27T17:00:05Z', utcOffset: '25200s' }, beatsPerMinute: '54', metadata: { motionContext: 'SEDENTARY', sensorLocation: 'WRIST' } },
    },
    { heartRate: { sampleTime: { physicalTime: '2026-10-27T17:00:00Z' }, beatsPerMinute: '55' } },
    { heartRate: { sampleTime: { physicalTime: '2026-10-27T17:00:00Z' }, beatsPerMinute: '55' } }, // duplicate
    { heartRate: { sampleTime: { physicalTime: '2026-10-27T17:00:10Z' }, beatsPerMinute: '0' } }, // out of range
    { steps: { count: '3' } }, // other type: ignored
  ],
  nextPageToken: 'p2',
};

const HRV_PAGE = {
  dataPoints: [
    { heartRateVariability: { sampleTime: { physicalTime: '2026-10-27T17:05:00Z' }, rootMeanSquareOfSuccessiveDifferencesMilliseconds: 41.2, standardDeviationMilliseconds: 50 } },
    { heartRateVariability: { sampleTime: { physicalTime: '2026-10-27T17:10:00Z' }, standardDeviationMilliseconds: 48 } }, // rmssd optional
    // snake_case tolerated (not documented for JSON output; defensive)
    { heart_rate_variability: { sample_time: { physical_time: '2026-10-27T17:00:00Z' }, root_mean_square_of_successive_differences_milliseconds: 38 } },
  ],
};

const SPO2_PAGE = {
  dataPoints: [
    { oxygenSaturation: { sampleTime: { physicalTime: '2026-10-27T17:01:00Z' }, percentage: 96.5 } },
    { oxygenSaturation: { sampleTime: { physicalTime: '2026-10-27T17:00:00Z' }, percentage: 97 } },
    { oxygenSaturation: { sampleTime: { physicalTime: '2026-10-27T17:02:00Z' }, percentage: 0 } },
  ],
};

const SLEEP_PAGE = {
  dataPoints: [
    {
      sleep: {
        interval: { startTime: '2026-10-27T16:10:00Z', startUtcOffset: '25200s', endTime: '2026-10-27T23:40:00Z', endUtcOffset: '25200s' },
        type: 'STAGES',
        stages: [
          { startTime: '2026-10-27T16:30:00Z', endTime: '2026-10-27T17:15:00Z', type: 'DEEP' },
          { startTime: '2026-10-27T16:10:00Z', endTime: '2026-10-27T16:30:00Z', type: 'LIGHT' },
          { startTime: '2026-10-27T17:15:00Z', endTime: '2026-10-27T17:40:00Z', type: 'REM' },
          { startTime: '2026-10-27T17:40:00Z', endTime: '2026-10-27T17:45:00Z', type: 'AWAKE' },
          { startTime: '2026-10-27T17:45:00Z', endTime: '2026-10-27T17:45:00Z', type: 'LIGHT' }, // zero length
        ],
        metadata: { stagesStatus: 'SUCCEEDED', processed: true, nap: false, mainSleep: true },
        summary: { minutesAsleep: 420 },
        createTime: '2026-10-28T00:00:00Z',
        updateTime: '2026-10-28T01:00:00Z',
      },
    },
    {
      // Older version of the same night (reprocessed later): dropped.
      sleep: { interval: { startTime: '2026-10-27T16:10:00Z', endTime: '2026-10-27T23:40:00Z' }, stages: [], updateTime: '2026-10-28T00:00:00Z' },
    },
    {
      sleep: {
        interval: { startTime: '2026-10-28T07:00:00Z', endTime: '2026-10-28T07:30:00Z' },
        type: 'CLASSIC',
        stages: [
          { startTime: '2026-10-28T07:00:00Z', endTime: '2026-10-28T07:25:00Z', type: 'ASLEEP' },
          { startTime: '2026-10-28T07:25:00Z', endTime: '2026-10-28T07:30:00Z', type: 'RESTLESS' },
        ],
        metadata: { nap: true },
      },
    },
  ],
};

describe('parsers', () => {
  it('parseHeartRate: int64 strings, ascending, deduped, range-checked', () => {
    expect(parseHeartRate(HR_PAGE)).toEqual([
      { ts: Date.parse('2026-10-27T17:00:00Z'), bpm: 55 },
      { ts: Date.parse('2026-10-27T17:00:05Z'), bpm: 54 },
    ]);
  });

  it('accepts arrays of pages and arrays of points', () => {
    expect(parseHeartRate([HR_PAGE, { dataPoints: [] }])).toHaveLength(2);
    expect(parseHeartRate(HR_PAGE.dataPoints)).toHaveLength(2);
    expect(dataPointsOf(null)).toEqual([]);
  });

  it('parseHrv', () => {
    expect(parseHrv(HRV_PAGE)).toEqual([
      { ts: Date.parse('2026-10-27T17:00:00Z'), rmssdMs: 38 },
      { ts: Date.parse('2026-10-27T17:05:00Z'), rmssdMs: 41.2 },
    ]);
  });

  it('parseSpo2', () => {
    expect(parseSpo2(SPO2_PAGE)).toEqual([
      { ts: Date.parse('2026-10-27T17:00:00Z'), pct: 97 },
      { ts: Date.parse('2026-10-27T17:01:00Z'), pct: 96.5 },
    ]);
  });

  it('parseSleep: sorted stages, newest version, classic mapping, naps optional', () => {
    const s = parseSleep(SLEEP_PAGE, 'a');
    expect(s).toHaveLength(2);
    const main = s[0]!;
    expect(main).toMatchObject({ personId: 'a', start: Date.parse('2026-10-27T16:10:00Z'), end: Date.parse('2026-10-27T23:40:00Z'), updateTime: Date.parse('2026-10-28T01:00:00Z') });
    expect(main.stages.map((x) => x.stage)).toEqual(['light', 'deep', 'rem', 'awake']);
    expect(s[1]!.stages.map((x) => x.stage)).toEqual(['light', 'awake']);
    expect(parseSleep(SLEEP_PAGE, 'a', { includeNaps: false })).toHaveLength(1);
  });

  it('mapSleepStage tolerates prefixes', () => {
    expect(mapSleepStage('SLEEP_STAGE_TYPE_DEEP')).toBe('deep');
    expect(mapSleepStage('rem')).toBe('rem');
    expect(mapSleepStage('UNSPECIFIED')).toBeNull();
    expect(mapSleepStage(3)).toBeNull();
  });
});

describe('GoogleHealthClient', () => {
  it('lists data points with camelCase query params and bearer auth', async () => {
    const f = fakeFetch([json(HR_PAGE)]);
    const c = new GoogleHealthClient('tok', f.fn);
    const filter = sampleTimeFilter('heart-rate', Date.parse('2026-10-27T11:00:00Z'), Date.parse('2026-10-28T05:00:00Z'));
    expect(filter).toBe('heart_rate.sample_time.physical_time >= "2026-10-27T11:00:00.000Z" AND heart_rate.sample_time.physical_time < "2026-10-28T05:00:00.000Z"');
    await c.listDataPoints('heart-rate', { filter, pageSize: 10000, dataSourceFamily: 'google-wearables' });
    const u = new URL(f.calls[0]!.url);
    expect(u.origin + u.pathname).toBe('https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints');
    expect(u.searchParams.get('filter')).toBe(filter);
    expect(u.searchParams.get('pageSize')).toBe('10000');
    expect(u.searchParams.get('dataSourceFamily')).toBe('users/me/dataSourceFamilies/google-wearables');
    expect((f.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('paginates until nextPageToken is empty; reconcile path', async () => {
    const f = fakeFetch([json({ dataPoints: [1, 2], nextPageToken: 'n1' }), json({ dataPoints: [3], nextPageToken: '' })]);
    const c = new GoogleHealthClient('tok', f.fn);
    const all = await c.listAll('sleep', { filter: intervalFilter('sleep', 0, 86_400_000, 'end_time'), pageSize: 25 }, { reconcile: true });
    expect(all).toEqual([1, 2, 3]);
    expect(f.calls[0]!.url).toContain('/dataPoints:reconcile?');
    expect(f.calls[0]!.url).toContain('sleep.interval.end_time');
    expect(new URL(f.calls[1]!.url).searchParams.get('pageToken')).toBe('n1');
  });

  it('identity and pairedDevices', async () => {
    const f = fakeFetch([json({ healthUserId: 'h1', legacyUserId: 'L' }), json({ pairedDevices: [] })]);
    const c = new GoogleHealthClient('tok', f.fn);
    expect((await c.identity()).healthUserId).toBe('h1');
    await c.pairedDevices();
    expect(f.calls.map((x) => x.url)).toEqual(['https://health.googleapis.com/v4/users/me/identity', 'https://health.googleapis.com/v4/users/me/pairedDevices']);
  });

  it('retries 429 then surfaces Google errors', async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([
      json({}, 429, { 'Retry-After': '1' }),
      json({ error: { code: 412, message: 'no profile', status: 'FAILED_PRECONDITION' } }, 412),
    ]);
    const c = new GoogleHealthClient('tok', f.fn, { sleep: async (ms) => void sleeps.push(ms) });
    const err = await c.identity().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleHealthError);
    expect(err).toMatchObject({ status: 412, code: 'FAILED_PRECONDITION' });
    expect(sleeps).toEqual([1000]);
  });
});

describe('OAuth helpers', () => {
  it('googleAuthUrl requests offline access with consent', () => {
    const u = new URL(googleAuthUrl({ clientId: 'cid', redirectUri: 'https://app.test/cb', state: 's1', scopes: [SCOPE_HEALTH_METRICS, SCOPE_SLEEP] }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'https://app.test/cb',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly https://www.googleapis.com/auth/googlehealth.sleep.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state: 's1',
    });
    expect(new URL(googleAuthUrl({ clientId: 'c', redirectUri: 'r', state: 's' })).searchParams.get('scope')).toContain('activity_and_fitness.readonly');
    expect(new URL(googleAuthUrl({ clientId: 'c', redirectUri: 'r', state: 's' })).searchParams.get('scope')).toContain('settings.readonly');
  });

  it('exchangeCode posts a form and maps tokens', async () => {
    const f = fakeFetch([json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'a b', token_type: 'Bearer' })]);
    const t = await exchangeCode({ clientId: 'cid', clientSecret: 'sec', code: 'c0de', redirectUri: 'https://app.test/cb', fetch: f.fn, now: () => 1000 });
    expect(t).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 3_599_000, scope: ['a', 'b'], tokenType: 'Bearer' });
    expect(f.calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(f.calls[0]!.init!.body as string);
    expect(Object.fromEntries(form)).toEqual({ client_id: 'cid', client_secret: 'sec', grant_type: 'authorization_code', code: 'c0de', redirect_uri: 'https://app.test/cb' });
  });

  it('refreshAccessToken surfaces invalid_grant', async () => {
    const f = fakeFetch([json({ access_token: 'at2', expires_in: 100 }), json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)]);
    const t = await refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'rt', fetch: f.fn, now: () => 0 });
    expect(t.refreshToken).toBeUndefined();
    expect(t.expiresAt).toBe(100_000);
    expect(new URLSearchParams(f.calls[0]!.init!.body as string).get('grant_type')).toBe('refresh_token');
    const err = await refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'rt', fetch: f.fn }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect(err).toMatchObject({ status: 400, error: 'invalid_grant' });
  });
});
