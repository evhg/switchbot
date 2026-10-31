// Outdoor temperature and RH for the bedroom's location → public.outdoor_readings (migration 0018 schedules it every
// 15 min). With the GOOGLE_WEATHER_API_KEY secret: Google Weather API currentConditions:lookup (metric); without it, or
// when Google fails (e.g. billing not enabled yet), Open-Meteo's free forecast API (current=temperature_2m,
// relative_humidity_2m). Location: WEATHER_LAT / WEATHER_LON, default Phuket (7.88, 98.39). One row per observation
// time (upsert on ts), source 'google_weather' or 'open_meteo'; loadNight() reads them into Night.outdoor.
import { googleWeatherUrl, openMeteoUrl, parseGoogleCurrentConditions, parseOpenMeteoCurrent, PHUKET_LAT, PHUKET_LON } from '../../../packages/core/src/weather/parse.ts';
import type { OutdoorReading } from '../../../packages/core/src/types.ts';
import { requireCron } from '../_shared/auth.ts';
import { envNumber, optEnv } from '../_shared/env.ts';
import { json, serve } from '../_shared/http.ts';
import { outdoorToRow } from '../_shared/rows.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { iso } from '../_shared/time.ts';

type Source = 'google_weather' | 'open_meteo';

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch { /* not JSON: keep the text for the error */ }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } | boolean; reason?: string } | null);
    const detail = typeof msg === 'object' && msg ? (typeof msg.error === 'object' ? msg.error?.message : msg.reason) : null;
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return body;
}

serve(async (req) => {
  const db = serviceClient();
  await requireCron(req, db);
  const lat = envNumber('WEATHER_LAT', PHUKET_LAT);
  const lon = envNumber('WEATHER_LON', PHUKET_LON);
  const key = optEnv('GOOGLE_WEATHER_API_KEY');

  const errors: string[] = [];
  const calls: Record<Source, number> = { google_weather: 0, open_meteo: 0 };
  let reading: OutdoorReading | null = null;
  let source: Source = 'open_meteo';
  if (key) {
    calls.google_weather++;
    try {
      reading = parseGoogleCurrentConditions(await getJson(googleWeatherUrl(key, lat, lon)));
      if (reading) source = 'google_weather';
      else errors.push('google_weather: no temperature / humidity in the response');
    } catch (e) {
      // The key is never in the message (only the status and Google's error text).
      errors.push(`google_weather: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!reading) {
    calls.open_meteo++;
    try {
      reading = parseOpenMeteoCurrent(await getJson(openMeteoUrl(lat, lon)));
      if (!reading) errors.push('open_meteo: no temperature / humidity in the response');
    } catch (e) {
      errors.push(`open_meteo: ${e instanceof Error ? e.message : e}`);
    }
  }

  let stored = false;
  if (reading) {
    const up = await db.from('outdoor_readings').upsert(outdoorToRow(reading, source), { onConflict: 'ts' });
    if (up.error) errors.push(`outdoor_readings: ${up.error.message}`);
    else stored = true;
  }
  for (const api of Object.keys(calls) as Source[]) {
    if (!calls[api]) continue;
    const log = await db.from('api_quota_log').insert({
      api,
      fn: 'weather-poll',
      calls: calls[api],
      status: stored && api === source ? 'ok' : 'error',
      note: errors.filter((e) => e.startsWith(api) || e.startsWith('outdoor_readings')).join('; ').slice(0, 1000) || null,
    });
    if (log.error) console.error('api_quota_log', log.error.message);
  }
  if (errors.length) console.warn('weather-poll', errors.join('; '));
  return json(
    { ok: stored, source: reading ? source : null, ...(reading ? { ts: iso(reading.ts), tempC: reading.tempC, rh: reading.rh } : {}), ...(errors.length ? { errors } : {}) },
    stored ? 200 : 502,
  );
});
