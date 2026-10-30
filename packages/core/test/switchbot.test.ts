import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SwitchBotClient,
  SwitchBotError,
  acStateToSetAllParam,
  normalizeMac,
  parseMeterStatus,
  plausibleCo2,
  parseRetryAfter,
  parseSetAllParam,
  parseWebhookEvent,
  switchBotSignHeaders,
  toSwitchBotCommand,
  type AcState,
} from '../src/index.ts';

const TOKEN = 'test-token-abc';
const SECRET = 'test-secret-xyz';

describe('switchBotSignHeaders', () => {
  it('matches an independent node:crypto HMAC, uppercased', async () => {
    const t = 1761600000000;
    const nonce = '0b5f9c4e-1111-4222-8333-944455556666';
    const h = await switchBotSignHeaders(TOKEN, SECRET, { t, nonce });
    const expected = createHmac('sha256', SECRET).update(TOKEN + t + nonce).digest('base64');
    expect(h.sign).toBe(expected.toUpperCase());
    expect(h.Authorization).toBe(TOKEN);
    expect(h.t).toBe(String(t));
    expect(h.nonce).toBe(nonce);
    expect(h['Content-Type']).toBe('application/json; charset=utf8');
    const plain = await switchBotSignHeaders(TOKEN, SECRET, { t, nonce, uppercase: false });
    expect(plain.sign).toBe(expected);
  });

  it('generates a 13-digit t and a uuid nonce by default', async () => {
    const h = await switchBotSignHeaders(TOKEN, SECRET);
    expect(h.t).toMatch(/^\d{13}$/);
    expect(h.nonce).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('setAll mapping', () => {
  const s: AcState = { power: true, setpointC: 19, mode: 'cool', fan: 'auto' };
  it('formats "temp,mode,fan,power"', () => {
    expect(acStateToSetAllParam(s)).toBe('19,2,1,on');
    expect(acStateToSetAllParam({ ...s, mode: 'heat', fan: 'high', power: false })).toBe('19,5,4,off');
    expect(acStateToSetAllParam({ ...s, mode: 'dry', fan: 'medium' })).toBe('19,3,3,on');
    expect(acStateToSetAllParam({ ...s, mode: 'fan', fan: 'low' })).toBe('19,4,2,on');
    expect(acStateToSetAllParam({ ...s, mode: 'auto' })).toBe('19,1,1,on');
  });
  it('rounds to an integer and clamps to 16..30', () => {
    expect(acStateToSetAllParam({ ...s, setpointC: 19.6 })).toBe('20,2,1,on');
    expect(acStateToSetAllParam({ ...s, setpointC: 12 })).toBe('16,2,1,on');
    expect(acStateToSetAllParam({ ...s, setpointC: 35 })).toBe('30,2,1,on');
    expect(() => acStateToSetAllParam({ ...s, setpointC: NaN })).toThrow();
  });
  it('round-trips via parseSetAllParam', () => {
    expect(parseSetAllParam('19,2,1,on')).toEqual(s);
    expect(parseSetAllParam('26,0,3,off')).toEqual({ setpointC: 26, mode: 'auto', fan: 'medium', power: false });
    expect(parseSetAllParam('bad')).toBeNull();
  });
  it('toSwitchBotCommand handles setAll and customize', () => {
    expect(toSwitchBotCommand({ ts: 0, state: s, via: 'setAll', reason: 'x' })).toEqual({ commandType: 'command', command: 'setAll', parameter: '19,2,1,on' });
    expect(toSwitchBotCommand({ ts: 0, state: s, via: 'customize', button: 'C19', reason: 'x' })).toEqual({
      commandType: 'customize',
      command: 'C19',
      parameter: 'default',
    });
    expect(toSwitchBotCommand({ ts: 0, state: { ...s, power: false }, via: 'customize', reason: 'x' }).command).toBe('turnOff');
    expect(() => toSwitchBotCommand({ ts: 0, state: s, via: 'customize', reason: 'x' })).toThrow();
  });
});

describe('parseMeterStatus', () => {
  // Shape from devices/sensors/meter-pro-co2.md; values illustrative.
  const body = { deviceId: 'C271111EC0AB', deviceType: 'MeterPro(CO2)', hubDeviceId: 'FA7310762361', battery: 100, version: 'V1.2', temperature: 24.1, humidity: 52, CO2: 812 };
  it('parses body or full envelope', () => {
    const r = { ts: 1000, tempC: 24.1, rh: 52, co2: 812, source: 'poll' };
    expect(parseMeterStatus(body, 1000)).toEqual(r);
    expect(parseMeterStatus({ statusCode: 100, body, message: 'success' }, 1000)).toEqual(r);
  });
  it('rejects artifacts and non-CO2 devices', () => {
    expect(parseMeterStatus({ ...body, CO2: 10000 }, 0)).toBeNull();
    expect(parseMeterStatus({ ...body, CO2: -1 }, 0)).toBeNull();
    expect(parseMeterStatus({ ...body, CO2: 9999 }, 0)?.co2).toBe(9999);
    expect(parseMeterStatus({ deviceType: 'Meter', temperature: 24, humidity: 50 }, 0)).toBeNull();
    expect(parseMeterStatus(null, 0)).toBeNull();
  });
  it('drops the 0 ppm warm-up artifact unless a fallback CO2 is given (temp/RH kept)', () => {
    expect(parseMeterStatus({ ...body, CO2: 0 }, 0)).toBeNull();
    expect(parseMeterStatus({ ...body, CO2: 299 }, 0)).toBeNull();
    expect(parseMeterStatus({ ...body, CO2: 300 }, 0)?.co2).toBe(300);
    expect(parseMeterStatus({ ...body, CO2: 0 }, 0, { co2Fallback: 930 })).toEqual({ ts: 0, tempC: 24.1, rh: 52, co2: 930, source: 'poll' });
    expect(parseMeterStatus({ ...body, CO2: 0 }, 0, { co2Fallback: 0 })).toBeNull();
    expect(parseMeterStatus({ ...body, CO2: 0 }, 0, { co2Fallback: null })).toBeNull();
    // A valid value ignores the fallback.
    expect(parseMeterStatus(body, 0, { co2Fallback: 930 })?.co2).toBe(812);
    const ev = { eventType: 'changeReport', eventVersion: '1', context: { deviceType: 'MeterPro(CO2)', deviceMac: 'B0:E9:FE:00:00:01', temperature: 19.2, humidity: 54, CO2: 0, scale: 'CELSIUS', timeOfSample: 1 } };
    expect(parseWebhookEvent(ev, 0)!.reading).toBeNull();
    expect(parseWebhookEvent(ev, 0, { co2Fallback: 925 })!.reading).toEqual({ ts: 0, tempC: 19.2, rh: 54, co2: 925, source: 'webhook' });
    expect(plausibleCo2(0)).toBe(false);
    expect(plausibleCo2(420)).toBe(true);
  });
});

describe('parseWebhookEvent', () => {
  // Shape from devices/sensors/meter-pro-co2.md.
  const ev = {
    eventType: 'changeReport',
    eventVersion: '1',
    context: { deviceType: 'MeterPro(CO2)', deviceMac: 'C2:71:11:1E:C0:AB', temperature: 22.5, scale: 'CELSIUS', humidity: 31, CO2: 1203, battery: 100, timeOfSample: 123456789 },
  };
  it('parses a Meter Pro CO2 changeReport', () => {
    const p = parseWebhookEvent(ev, 5000);
    expect(p).toEqual({
      deviceMac: 'C2:71:11:1E:C0:AB',
      deviceType: 'MeterPro(CO2)',
      reading: { ts: 5000, tempC: 22.5, rh: 31, co2: 1203, source: 'webhook' },
      timeOfSample: 123456789,
      battery: 100,
    });
    expect(normalizeMac(p!.deviceMac)).toBe('C271111EC0AB');
  });
  it('converts Fahrenheit', () => {
    const p = parseWebhookEvent({ ...ev, context: { ...ev.context, temperature: 68, scale: 'FAHRENHEIT' } }, 0);
    expect(p?.reading?.tempC).toBe(20);
  });
  it('ignores TESTMAC and other event types', () => {
    expect(parseWebhookEvent({ ...ev, context: { ...ev.context, deviceMac: 'TESTMAC' } }, 0)).toBeNull();
    expect(parseWebhookEvent({ eventType: 'other', context: {} }, 0)).toBeNull();
    expect(parseWebhookEvent('x', 0)).toBeNull();
  });
  it('returns reading null for devices without CO2', () => {
    const p = parseWebhookEvent({ eventType: 'changeReport', eventVersion: '1', context: { deviceType: 'WoHand', deviceMac: 'AA:BB', power: 'on' } }, 0);
    expect(p).toMatchObject({ deviceType: 'WoHand', reading: null });
  });
});

// ---------- client with fake fetch ----------

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error('no more fake responses');
    return typeof r === 'function' ? r() : r;
  };
  return { fn, calls };
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ statusCode: 100, body, message: 'success' }), { status: 200, headers });

function client(responses: (Response | (() => Response))[], extra: Partial<ConstructorParameters<typeof SwitchBotClient>[0]> = {}) {
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const c = new SwitchBotClient({
    token: TOKEN,
    secret: SECRET,
    fetch: f.fn,
    now: () => Date.UTC(2026, 9, 28, 12),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { c, calls: f.calls, sleeps };
}

describe('SwitchBotClient', () => {
  it('lists devices with signed headers', async () => {
    const list = { deviceList: [{ deviceId: 'C271111EC0AB', deviceName: 'CO2', deviceType: 'MeterPro(CO2)', hubDeviceId: 'X' }], infraredRemoteList: [] };
    const { c, calls } = client([ok(list)]);
    expect(await c.listDevices()).toEqual(list);
    expect(calls[0]!.url).toBe('https://api.switch-bot.com/v1.1/devices');
    expect(calls[0]!.method).toBe('GET');
    const h = calls[0]!.headers;
    const expected = createHmac('sha256', SECRET).update(TOKEN + h.t + h.nonce).digest('base64').toUpperCase();
    expect(h.sign).toBe(expected);
    expect(h.Authorization).toBe(TOKEN);
  });

  it('sends setAll, customize, turnOn/Off and AcCommand bodies', async () => {
    const { c, calls } = client([ok({}), ok({}), ok({}), ok({}), ok({})]);
    await c.setAll('02-202007201626-70', { power: true, setpointC: 19, mode: 'cool', fan: 'low' });
    await c.customize('02-202007201626-70', 'ECO SLEEP');
    await c.turnOn('ir1');
    await c.turnOff('ir1');
    await c.sendAcCommand('ir1', { ts: 0, via: 'customize', button: 'C20', state: { power: true, setpointC: 20, mode: 'cool', fan: 'auto' }, reason: '' });
    expect(calls[0]!.url).toBe('https://api.switch-bot.com/v1.1/devices/02-202007201626-70/commands');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ command: 'setAll', parameter: '19,2,2,on', commandType: 'command' });
    expect(calls[1]!.body).toEqual({ command: 'ECO SLEEP', parameter: 'default', commandType: 'customize' });
    expect(calls[2]!.body).toEqual({ command: 'turnOn', parameter: 'default', commandType: 'command' });
    expect(calls[3]!.body).toEqual({ command: 'turnOff', parameter: 'default', commandType: 'command' });
    expect(calls[4]!.body).toEqual({ command: 'C20', parameter: 'default', commandType: 'customize' });
  });

  it('builds webhook and scene requests', async () => {
    const { c, calls } = client(Array.from({ length: 7 }, () => ok({})));
    await c.setupWebhook('https://x.test/hook/secret');
    await c.queryWebhook();
    await c.queryWebhook(['https://x.test/hook/secret']);
    await c.updateWebhook('https://x.test/hook/secret', false);
    await c.deleteWebhook('https://x.test/hook/secret');
    await c.listScenes();
    await c.executeScene('T02-abc');
    expect(calls.map((x) => x.url.replace('https://api.switch-bot.com/v1.1', ''))).toEqual([
      '/webhook/setupWebhook',
      '/webhook/queryWebhook',
      '/webhook/queryWebhook',
      '/webhook/updateWebhook',
      '/webhook/deleteWebhook',
      '/scenes',
      '/scenes/T02-abc/execute',
    ]);
    expect(calls[0]!.body).toEqual({ action: 'setupWebhook', url: 'https://x.test/hook/secret', deviceList: 'ALL' });
    expect(calls[1]!.body).toEqual({ action: 'queryUrl' });
    expect(calls[2]!.body).toEqual({ action: 'queryDetails', urls: ['https://x.test/hook/secret'] });
    expect(calls[3]!.body).toEqual({ action: 'updateWebhook', config: { url: 'https://x.test/hook/secret', enable: false } });
    expect(calls[4]!.body).toEqual({ action: 'deleteWebhook', url: 'https://x.test/hook/secret' });
    expect(calls[6]!.method).toBe('POST');
  });

  it.each([
    [151, 'device_type'],
    [152, 'not_found'],
    [160, 'unsupported'],
    [161, 'offline'],
    [171, 'offline'],
    [190, 'internal'],
  ])('maps statusCode %i to %s', async (code, kind) => {
    const { c } = client([new Response(JSON.stringify({ statusCode: code, body: {}, message: 'nope' }), { status: 200 })]);
    const err = await c.getStatus('X').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwitchBotError);
    expect(err).toMatchObject({ statusCode: code, kind, status: 200 });
  });

  it('throws auth on HTTP 401', async () => {
    const { c } = client([new Response('{"message":"Unauthorized"}', { status: 401 })]);
    await expect(c.listDevices()).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const { c, calls, sleeps } = client([new Response('', { status: 429, headers: { 'Retry-After': '2' } }), ok({ temperature: 1 })]);
    expect(await c.getStatus('X')).toEqual({ temperature: 1 });
    expect(sleeps).toEqual([2000]);
    expect(calls).toHaveLength(2);
    expect(c.quota().used).toBe(2);
  });

  it('gives up on 429 with X-RateLimit-Remaining: 0 (daily quota) without retrying', async () => {
    const { c, calls } = client([new Response('', { status: 429, headers: { 'X-RateLimit-Remaining': '0', 'Retry-After': '3600' } })]);
    const err = await c.listDevices().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate_limit', status: 429, retryAfterMs: 3_600_000 });
    expect(calls).toHaveLength(1);
    expect(c.quota().serverRemaining).toBe(0);
  });

  it('backs off exponentially on 5xx and gives up after maxRetries', async () => {
    const { c, sleeps } = client([new Response('', { status: 503 }), new Response('', { status: 503 }), new Response('', { status: 503 })]);
    await expect(c.listDevices()).rejects.toMatchObject({ kind: 'http', status: 503 });
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('does not retry a command POST on 5xx (it may have reached the hub)', async () => {
    const { c, calls } = client([new Response('', { status: 502 }), ok({})]);
    await expect(c.setAll('AC', { power: true, setpointC: 19, mode: 'cool', fan: 'low' })).rejects.toMatchObject({ kind: 'http', status: 502 });
    expect(calls).toHaveLength(1);
  });

  it('tracks X-RateLimit-Remaining and enforces the local budget', async () => {
    const seen: number[] = [];
    const { c, calls } = client([ok({}, { 'X-RateLimit-Remaining': '9876' }), ok({})], { dailyBudget: 2, onQuota: (q) => seen.push(q.used) });
    await c.listScenes();
    expect(c.quota()).toMatchObject({ used: 1, remaining: 1, budget: 2, serverRemaining: 9876 });
    await c.listScenes();
    await expect(c.listScenes()).rejects.toMatchObject({ kind: 'budget' });
    expect(calls).toHaveLength(2);
    expect(seen).toEqual([1, 2]);
  });

  it('resets the local counter on a new UTC day', async () => {
    let now = Date.UTC(2026, 9, 28, 23, 59);
    const f = fakeFetch([ok({}), ok({})]);
    const c = new SwitchBotClient({ token: TOKEN, secret: SECRET, fetch: f.fn, dailyBudget: 1, now: () => now, quota: { day: '2026-10-28', used: 0 } });
    await c.listScenes();
    await expect(c.listScenes()).rejects.toMatchObject({ kind: 'budget' });
    now += 2 * 60_000;
    await c.listScenes();
    expect(c.quota()).toMatchObject({ day: '2026-10-29', used: 1 });
  });

  it('parseRetryAfter handles seconds and HTTP dates', () => {
    expect(parseRetryAfter('5', 0)).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
