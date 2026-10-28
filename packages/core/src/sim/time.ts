import type { Ms } from '../types.ts';

export const MIN = 60_000;
const ICT_OFFSET = 7 * 60 * MIN;
const DAY = 24 * 60 * MIN;

/** Epoch ms of 00:00 ICT on a YYYY-MM-DD date. */
export function ictMidnight(date: string): Ms {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) - ICT_OFFSET;
}

export function ictDate(ts: Ms): string {
  return new Date(ts + ICT_OFFSET).toISOString().slice(0, 10);
}

/** Minutes since local (ICT) midnight. */
export function ictMinuteOfDay(ts: Ms): number {
  return Math.floor((((ts + ICT_OFFSET) % DAY) + DAY) % DAY / MIN);
}

export function addDays(date: string, n: number): string {
  return ictDate(ictMidnight(date) + n * DAY + 12 * 60 * MIN);
}

/** Whole days since 1970-01-01 (stable per-date seed component). */
export function dayNumber(date: string): number {
  return Math.round((ictMidnight(date) + ICT_OFFSET) / DAY);
}

/** 0 = Sunday … 6 = Saturday, for the ICT calendar date. */
export function weekday(date: string): number {
  return new Date(ictMidnight(date) + ICT_OFFSET).getUTCDay();
}
