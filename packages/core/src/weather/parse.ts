// Outdoor weather → OutdoorReading (public.outdoor_readings), from Google's Weather API (currentConditions:lookup)
// or Open-Meteo (`current=temperature_2m,relative_humidity_2m`, the free fallback without a key).
import type { Ms, OutdoorReading } from '../types.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Phuket (the bedroom), the default for WEATHER_LAT / WEATHER_LON. */
export const PHUKET_LAT = 7.88;
export const PHUKET_LON = 98.39;

export const GOOGLE_WEATHER_URL = 'https://weather.googleapis.com/v1/currentConditions:lookup';
export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

export function googleWeatherUrl(key: string, lat = PHUKET_LAT, lon = PHUKET_LON): string {
  const qs = new URLSearchParams({ key, 'location.latitude': String(lat), 'location.longitude': String(lon) });
  return `${GOOGLE_WEATHER_URL}?${qs}`;
}

export function openMeteoUrl(lat = PHUKET_LAT, lon = PHUKET_LON, timezone = 'Asia/Bangkok'): string {
  const qs = new URLSearchParams({ latitude: String(lat), longitude: String(lon), current: 'temperature_2m,relative_humidity_2m', timezone });
  return `${OPEN_METEO_URL}?${qs}`;
}

const MIN = 60_000;
const fToC = (f: number) => ((f - 32) * 5) / 9;
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Plausible outdoor values only (a 0 / null placeholder must not land in the table). */
function reading(ts: Ms, tempC: number | null, rh: number | null): OutdoorReading | null {
  if (!Number.isFinite(ts) || tempC === null || rh === null) return null;
  if (tempC < -40 || tempC > 60 || rh < 0 || rh > 100) return null;
  return { ts: Math.floor(ts / MIN) * MIN, tempC: round1(tempC), rh: round1(rh) };
}

/**
 * Google Weather API `currentConditions:lookup`: {currentTime, temperature: {degrees, unit}, relativeHumidity, …}.
 * Metric is the default; FAHRENHEIT is converted. Time floored to the minute.
 */
export function parseGoogleCurrentConditions(json: unknown): OutdoorReading | null {
  if (!isObj(json)) return null;
  const ts = typeof json.currentTime === 'string' ? Date.parse(json.currentTime) : NaN;
  const t = isObj(json.temperature) ? json.temperature : null;
  let tempC = num(t?.degrees);
  if (tempC !== null && t?.unit === 'FAHRENHEIT') tempC = fToC(tempC);
  return reading(ts, tempC, num(json.relativeHumidity));
}

/**
 * Open-Meteo forecast `current` block. `current.time` is local wall time ("2026-10-31T14:15") in the requested
 * timezone; `utc_offset_seconds` turns it into an instant. A unit of °F is converted.
 */
export function parseOpenMeteoCurrent(json: unknown): OutdoorReading | null {
  if (!isObj(json) || !isObj(json.current)) return null;
  const c = json.current;
  const time = typeof c.time === 'string' ? c.time : '';
  const off = num(json.utc_offset_seconds) ?? 0;
  const ts = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time) ? Date.parse(`${time.slice(0, 16)}:00Z`) - off * 1000 : NaN;
  let tempC = num(c.temperature_2m);
  const unit = isObj(json.current_units) ? json.current_units.temperature_2m : undefined;
  if (tempC !== null && typeof unit === 'string' && unit.includes('F')) tempC = fToC(tempC);
  return reading(ts, tempC, num(c.relative_humidity_2m));
}
