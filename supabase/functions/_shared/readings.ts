// Meter readings helpers shared by poll-meter and switchbot-webhook.
import { plausibleCo2 } from '../../../packages/core/src/switchbot/parse.ts';
import type { Db } from './supabase.ts';
import { iso } from './time.ts';

/** How far back a previous CO2 value may stand in for a warm-up artifact. */
export const CO2_FALLBACK_MAX_AGE_MS = 30 * 60_000;

/**
 * CO2 of the device's newest plausible reading in the last 30 min, or null. Used when the meter reports the 0 ppm
 * warm-up artifact (after a restart or hub reconnect): the row keeps its temperature and humidity with this CO2
 * instead of being dropped (readings.co2 is NOT NULL). Older than 30 min → null, and the sample is skipped.
 */
export async function recentCo2(db: Db, deviceId: string, at: number): Promise<number | null> {
  const { data, error } = await db
    .from('readings')
    .select('co2')
    .eq('device_id', deviceId)
    .gte('ts', iso(at - CO2_FALLBACK_MAX_AGE_MS))
    .gte('co2', 300)
    .order('ts', { ascending: false })
    .limit(1);
  if (error) {
    console.error('recentCo2', error.message);
    return null;
  }
  const v = (data as { co2: number }[] | null)?.[0]?.co2;
  return typeof v === 'number' && plausibleCo2(v) ? v : null;
}

/** Identical poll rows in a row (minutes) after which the cloud value counts as frozen. */
export const FROZEN_POLL_ROWS = 15;
/** A webhook row this recent proves the meter is still reporting: never frozen. */
export const FROZEN_WEBHOOK_MS = 30 * 60_000;

/**
 * Is a new poll value the SwitchBot cloud's cached value of a meter that stopped reporting (hub unplugged, meter out of
 * Bluetooth range)? GET /status keeps answering with the last value, so the poll would store it every minute as a fresh
 * reading and the controller would act on frozen data. Frozen = the device's newest FROZEN_POLL_ROWS rows (whatever
 * their age, so it stays frozen while nothing new is stored) are all polls with exactly this temperature, RH and CO2,
 * and no webhook row arrived in the last 30 min. A real room is never this flat for 15 min (CO2 alone moves by a few ppm
 * a minute), and the webhook reports every change. The first changed value is stored again.
 */
export function isFrozen(
  newest: readonly { temp_c: number; rh: number; co2: number; source: string }[],
  reading: { tempC: number; rh: number; co2: number },
  lastWebhookAt: number | null,
  now: number,
): boolean {
  if (newest.length < FROZEN_POLL_ROWS) return false;
  if (lastWebhookAt !== null && lastWebhookAt >= now - FROZEN_WEBHOOK_MS) return false;
  return newest.slice(0, FROZEN_POLL_ROWS).every((r) => r.source === 'poll' && r.temp_c === reading.tempC && r.rh === reading.rh && r.co2 === Math.round(reading.co2));
}

/** isFrozen against the database (service-role client). A read error = not frozen (keep writing). */
export async function frozenPoll(db: Db, deviceId: string, reading: { tempC: number; rh: number; co2: number }, now: number): Promise<boolean> {
  const [last, hook] = await Promise.all([
    db.from('readings').select('temp_c,rh,co2,source').eq('device_id', deviceId).order('ts', { ascending: false }).limit(FROZEN_POLL_ROWS),
    db.from('readings').select('ts').eq('device_id', deviceId).eq('source', 'webhook').order('ts', { ascending: false }).limit(1),
  ]);
  if (last.error || hook.error) {
    console.error('frozenPoll', last.error?.message ?? hook.error?.message);
    return false;
  }
  const at = (hook.data as { ts: string }[] | null)?.[0]?.ts;
  return isFrozen((last.data ?? []) as { temp_c: number; rh: number; co2: number; source: string }[], reading, at ? Date.parse(at) : null, now);
}
