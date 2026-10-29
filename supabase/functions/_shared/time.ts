// ICT (UTC+7, no DST) date helpers. A night is keyed by its wake-up date.
import type { Ms } from '../../../packages/core/src/types.ts';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
const ICT = 7 * HOUR;

export const iso = (ms: Ms) => new Date(ms).toISOString();
export const floorMinute = (ms: Ms) => Math.floor(ms / MIN) * MIN;
export const utcDay = (ms: Ms) => iso(ms).slice(0, 10);
export const ictDate = (ms: Ms) => new Date(ms + ICT).toISOString().slice(0, 10);
export const ictHour = (ms: Ms) => new Date(ms + ICT).getUTCHours();

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Epoch ms of `hh:mm` ICT on `date`. */
export function ictAt(date: string, hhmm: string): Ms {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Date.parse(`${date}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00+07:00`);
}

/**
 * Default schedule for the night ending on `wakeDate`. A lights-out time at or after 12:00 belongs to the
 * previous evening; earlier times (e.g. 00:30) to the wake date itself.
 */
export function defaultSchedule(wakeDate: string, lightsOutHHMM: string, wakeHHMM: string): { lightsOut: Ms; wake: Ms } {
  const loHour = Number(lightsOutHHMM.split(':')[0]);
  const lightsOut = ictAt(loHour >= 12 ? addDays(wakeDate, -1) : wakeDate, lightsOutHHMM);
  return { lightsOut, wake: ictAt(wakeDate, wakeHHMM) };
}

/** Wake date of the night that `now` belongs to: after 12:00 ICT that's tomorrow, before it today. */
export function nightDateFor(now: Ms): string {
  return ictHour(now) >= 12 ? addDays(ictDate(now), 1) : ictDate(now);
}

/** The room-data window of a night: 18:00 ICT the evening before → 12:00 ICT on the wake date. */
export function nightWindow(date: string): { from: Ms; to: Ms } {
  return { from: ictAt(addDays(date, -1), '18:00'), to: ictAt(date, '12:00') };
}
