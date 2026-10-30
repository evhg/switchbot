// Meter Pro CO2 status + webhook parsing. See docs/research/openapi.md §3, §5 and meter-pro-co2.md.
import type { Ms, RoomReading } from '../types.ts';

export const METER_PRO_CO2_TYPE = 'MeterPro(CO2)';
export const CO2_MIN = 0;
export const CO2_MAX = 9999;
/**
 * Lowest CO2 a real room can read (outdoor air is ~420 ppm). The meter reports 0 ppm for a minute or so after a
 * restart or a hub reconnect while the NDIR sensor warms up; values below this are artifacts, not readings.
 */
export const CO2_PLAUSIBLE_MIN = 300;

/** True for a CO2 value a room can actually have (CO2_PLAUSIBLE_MIN..CO2_MAX). */
export const plausibleCo2 = (ppm: number): boolean => Number.isFinite(ppm) && ppm >= CO2_PLAUSIBLE_MIN && ppm <= CO2_MAX;

export interface ParseOptions {
  /**
   * CO2 to store when the reported value is implausible (< CO2_PLAUSIBLE_MIN, e.g. the 0 ppm warm-up artifact),
   * typically the previous valid reading's. Without it such a payload gives no reading (temp/RH alone can't be
   * stored: readings.co2 is NOT NULL).
   */
  co2Fallback?: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** "AA:BB:cc:dd:ee:ff" → "AABBCCDDEEFF", matching /devices deviceId. */
export function normalizeMac(mac: string): string {
  return mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

function toReading(o: Obj, ts: Ms, source: RoomReading['source'], fahrenheit = false, opts: ParseOptions = {}): RoomReading | null {
  let tempC = num(o.temperature);
  const rh = num(o.humidity);
  let co2 = num(o.CO2 ?? o.co2);
  if (tempC === null || rh === null || co2 === null) return null;
  if (fahrenheit) tempC = Math.round(((tempC - 32) * 5 / 9) * 10) / 10;
  // CO2 outside the sensor range is a glitch, not a reading.
  if (co2 < CO2_MIN || co2 > CO2_MAX) return null;
  // Warm-up artifact (0 ppm after a restart): keep temp/RH with the caller's fallback CO2, or drop the sample.
  if (!plausibleCo2(co2)) {
    const fb = opts.co2Fallback;
    if (typeof fb !== 'number' || !plausibleCo2(fb)) return null;
    co2 = fb;
  }
  if (rh < 0 || rh > 100 || tempC < -40 || tempC > 80) return null;
  return { ts, tempC, rh, co2, source };
}

/**
 * Accepts either the full `{statusCode, body}` envelope or just `body` from GET /devices/{id}/status.
 * Returns null for non-CO2 devices or implausible values (CO2 < CO2_PLAUSIBLE_MIN unless `opts.co2Fallback` is given).
 */
export function parseMeterStatus(body: unknown, receivedAt: Ms, opts: ParseOptions = {}): RoomReading | null {
  if (!isObj(body)) return null;
  const b = 'statusCode' in body && isObj(body.body) ? body.body : body;
  return toReading(b, receivedAt, 'poll', false, opts);
}

export interface SwitchBotWebhookEvent {
  deviceMac: string;
  deviceType: string;
  reading: RoomReading | null;
  /** Raw context.timeOfSample. The docs hint it may be send time, so `reading.ts` uses receivedAt instead. */
  timeOfSample?: number;
  battery?: number;
}

/**
 * Parses a `changeReport` webhook. Returns null for other payloads and for the `TESTMAC` placeholder
 * sent after each (re)registration. `reading` is null for devices without temp/RH/CO2.
 */
export function parseWebhookEvent(body: unknown, receivedAt: Ms, opts: ParseOptions = {}): SwitchBotWebhookEvent | null {
  if (!isObj(body) || body.eventType !== 'changeReport' || !isObj(body.context)) return null;
  const c = body.context;
  const deviceMac = typeof c.deviceMac === 'string' ? c.deviceMac : '';
  if (!deviceMac || deviceMac === 'TESTMAC') return null;
  const deviceType = typeof c.deviceType === 'string' ? c.deviceType : '';
  const scale = typeof c.scale === 'string' ? c.scale.toUpperCase() : 'CELSIUS';
  const ev: SwitchBotWebhookEvent = {
    deviceMac,
    deviceType,
    reading: toReading(c, receivedAt, 'webhook', scale === 'FAHRENHEIT', opts),
  };
  const tos = num(c.timeOfSample);
  if (tos !== null) ev.timeOfSample = tos;
  const battery = num(c.battery);
  if (battery !== null) ev.battery = battery;
  return ev;
}
