// Meter Pro CO2 status + webhook parsing. See docs/research/openapi.md §3, §5 and meter-pro-co2.md.
import type { Ms, RoomReading } from '../types.ts';

export const METER_PRO_CO2_TYPE = 'MeterPro(CO2)';
export const CO2_MIN = 0;
export const CO2_MAX = 9999;

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

function toReading(o: Obj, ts: Ms, source: RoomReading['source'], fahrenheit = false): RoomReading | null {
  let tempC = num(o.temperature);
  const rh = num(o.humidity);
  const co2 = num(o.CO2 ?? o.co2);
  if (tempC === null || rh === null || co2 === null) return null;
  if (fahrenheit) tempC = Math.round(((tempC - 32) * 5 / 9) * 10) / 10;
  // CO2 outside the sensor range is a glitch, not a reading.
  if (co2 < CO2_MIN || co2 > CO2_MAX) return null;
  if (rh < 0 || rh > 100 || tempC < -40 || tempC > 80) return null;
  return { ts, tempC, rh, co2, source };
}

/**
 * Accepts either the full `{statusCode, body}` envelope or just `body` from GET /devices/{id}/status.
 * Returns null for non-CO2 devices or implausible values.
 */
export function parseMeterStatus(body: unknown, receivedAt: Ms): RoomReading | null {
  if (!isObj(body)) return null;
  const b = 'statusCode' in body && isObj(body.body) ? body.body : body;
  return toReading(b, receivedAt, 'poll');
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
export function parseWebhookEvent(body: unknown, receivedAt: Ms): SwitchBotWebhookEvent | null {
  if (!isObj(body) || body.eventType !== 'changeReport' || !isObj(body.context)) return null;
  const c = body.context;
  const deviceMac = typeof c.deviceMac === 'string' ? c.deviceMac : '';
  if (!deviceMac || deviceMac === 'TESTMAC') return null;
  const deviceType = typeof c.deviceType === 'string' ? c.deviceType : '';
  const scale = typeof c.scale === 'string' ? c.scale.toUpperCase() : 'CELSIUS';
  const ev: SwitchBotWebhookEvent = {
    deviceMac,
    deviceType,
    reading: toReading(c, receivedAt, 'webhook', scale === 'FAHRENHEIT'),
  };
  const tos = num(c.timeOfSample);
  if (tos !== null) ev.timeOfSample = tos;
  const battery = num(c.battery);
  if (battery !== null) ev.battery = battery;
  return ev;
}
