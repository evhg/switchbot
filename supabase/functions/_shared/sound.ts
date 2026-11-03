// Night sounds (night-sound Edge Function, migration 0024): should the Mac listen right now?
//
// Listening needs all of: household_settings.sound_mode = 'auto'; sound_paused_until null or past; the household not
// away tonight (ac-curve's helpers: "Away tonight" / travel tag / an away period covering tonight, unless "Home
// tonight"; or every person's latest phone signal a fresh 'away', _shared/presence.ts everyoneAway); and now inside
// tonight's listen window: lights-out − 15 min → the aircon's scheduled OFF at wake + 30 min (core listenWindow, the
// same "off (wake + 30 min)" the controller schedules). Nights are keyed by their wake date (nightDateFor). Between
// that OFF and 12:00 the reported window is the coming night's (its nights row, else the default schedule).
import { inWindow, listenWindow, type ListenWindow, SOUND_CLIPS_PER_NIGHT } from '../../../packages/core/src/sound/payload.ts';
import type { Ms } from '../../../packages/core/src/types.ts';
import { DEFAULT_WAKE_HHMM } from './load.ts';
import { optEnv } from './env.ts';
import { awayPeriodFor, everyoneAway, type LatestPresence, loadAwayPeriods, loadPresence, nightAway, type PresenceState } from './presence.ts';
import type { Db } from './supabase.ts';
import { addDays, defaultSchedule, ictDate, iso, nightDateFor } from './time.ts';

const MIN = 60_000;

export type SoundMode = 'auto' | 'off';

export interface SoundSettings {
  mode: SoundMode;
  pausedUntil: Ms | null;
  clips: boolean;
}

/** The night fields the decision needs (a nights row, or the default schedule). */
export interface SoundNight {
  date: string;
  lightsOut: Ms;
  wake: Ms;
  presenceOverride: PresenceState | null;
  tags: string[];
}

export interface ListenInput {
  now: Ms;
  settings: SoundSettings;
  night: SoundNight;
  /** nightAway(override, tags, away period) for this night, or null. */
  awayWhy: string | null;
  /** Latest phone signal per person and every person id (for everyoneAway). */
  latest: readonly LatestPresence[];
  people: readonly string[];
}

export interface ListenDecision {
  listen: boolean;
  reason: string;
  from: Ms;
  until: Ms;
}

const ICT = 7 * 60 * MIN;
/** "22:15" (ICT). */
export const hhmm = (ms: Ms) => new Date(ms + ICT).toISOString().slice(11, 16);

/** "Paused until 12:00" today (ICT), "… tomorrow 12:00", else "… Thu 12:00". */
export function pausedText(until: Ms, now: Ms): string {
  const d = ictDate(until);
  const today = ictDate(now);
  if (d === today) return `Paused until ${hhmm(until)}`;
  if (d === addDays(today, 1)) return `Paused until tomorrow ${hhmm(until)}`;
  return `Paused until ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(until + ICT).getUTCDay()]} ${hhmm(until)}`;
}

/** The pure decision (see the header). */
export function listenDecision(i: ListenInput): ListenDecision {
  const w = listenWindow({ lightsOut: i.night.lightsOut, wake: i.night.wake });
  const off = (reason: string): ListenDecision => ({ listen: false, reason, from: w.from, until: w.until });
  if (i.settings.mode === 'off') return off('Turned off in settings');
  if (i.settings.pausedUntil !== null && i.settings.pausedUntil > i.now) return off(pausedText(i.settings.pausedUntil, i.now));
  if (i.awayWhy) return off('Away tonight');
  if (i.night.presenceOverride !== 'home' && everyoneAway(i.latest, i.people, i.now)) return off('Nobody home');
  if (i.now < w.from) return off(`Off — starts ${hhmm(w.from)}`);
  if (i.now > w.until) return off(`Off — night over at ${hhmm(w.until)}`);
  return { listen: true, reason: `Listening until ${hhmm(w.until)}`, from: w.from, until: w.until };
}

/** The listen window of a stored night. */
export const soundWindow = (n: Pick<SoundNight, 'lightsOut' | 'wake'>): ListenWindow => listenWindow({ lightsOut: n.lightsOut, wake: n.wake });
export { inWindow };

// ---------------------------------------------------------------- loading

interface NightRowLite {
  date: string;
  lights_out: string;
  wake: string;
  presence_override?: string | null;
  tags?: string[] | null;
}

const toNight = (r: NightRowLite): SoundNight => ({
  date: r.date,
  lightsOut: Date.parse(r.lights_out),
  wake: Date.parse(r.wake),
  presenceOverride: r.presence_override === 'home' || r.presence_override === 'away' ? r.presence_override : null,
  tags: r.tags ?? [],
});

/** Stored nights by date (missing dates are absent). */
export async function loadSoundNights(db: Db, dates: readonly string[]): Promise<Map<string, SoundNight>> {
  const out = new Map<string, SoundNight>();
  if (!dates.length) return out;
  const { data, error } = await db.from('nights').select('date,lights_out,wake,presence_override,tags').in('date', [...dates]);
  if (error) throw new Error(`nights: ${error.message}`);
  for (const r of (data ?? []) as NightRowLite[]) out.set(r.date, toNight(r));
  return out;
}

/** A night's row, or the default schedule ensureNight would create (DEFAULT_LIGHTS_OUT / DEFAULT_WAKE). */
export async function soundNight(db: Db, date: string): Promise<SoundNight> {
  const got = (await loadSoundNights(db, [date])).get(date);
  if (got) return got;
  const { lightsOut, wake } = defaultSchedule(date, optEnv('DEFAULT_LIGHTS_OUT') ?? '22:00', optEnv('DEFAULT_WAKE') ?? DEFAULT_WAKE_HHMM);
  return { date, lightsOut, wake, presenceOverride: null, tags: [] };
}

/** household_settings' sound columns. A read error throws (the caller answers 500 and the Mac retries). */
export async function loadSoundSettings(db: Db): Promise<SoundSettings> {
  const { data, error } = await db.from('household_settings').select('sound_mode,sound_paused_until,sound_clips').eq('id', 1).maybeSingle();
  if (error) throw new Error(`household_settings: ${error.message}`);
  const r = data as { sound_mode?: string; sound_paused_until?: string | null; sound_clips?: boolean } | null;
  return {
    // No row = the column defaults: auto, clips on.
    mode: r?.sound_mode === 'off' ? 'off' : 'auto',
    pausedUntil: r?.sound_paused_until ? Date.parse(r.sound_paused_until) : null,
    clips: r?.sound_clips !== false,
  };
}

/** Is the household currently paused or switched off (rows posted now are not stored)? */
export const notListening = (s: SoundSettings, now: Ms): boolean => s.mode === 'off' || (s.pausedUntil !== null && s.pausedUntil > now);

export interface CurrentListen extends ListenDecision {
  night: string;
  clips: boolean;
  clipsLeft: number;
  settings: SoundSettings;
}

/** The GET answer: tonight's (or, past its OFF, the coming night's) decision plus the clip allowance. */
export async function currentListen(db: Db, now: Ms): Promise<CurrentListen> {
  const settings = await loadSoundSettings(db);
  let night = await soundNight(db, nightDateFor(now));
  if (now > soundWindow(night).until) night = await soundNight(db, addDays(night.date, 1));
  const [periods, presence, clipsUsed] = await Promise.all([
    loadAwayPeriods(db, addDays(night.date, -1)),
    loadPresence(db).catch((e) => {
      console.error('presence', e instanceof Error ? e.message : String(e));
      return { latest: [] as LatestPresence[], people: [] as string[] };
    }),
    clipsStored(db, night.date),
  ]);
  const awayWhy = nightAway(night.presenceOverride, night.tags, awayPeriodFor(periods, night.date));
  const d = listenDecision({ now, settings, night, awayWhy, latest: presence.latest, people: presence.people });
  return { ...d, night: night.date, clips: settings.clips, clipsLeft: Math.max(0, SOUND_CLIPS_PER_NIGHT - clipsUsed), settings };
}

/** Clips reserved for a night (sound_events with clip_path set). */
export async function clipsStored(db: Db, nightDate: string): Promise<number> {
  const { count, error } = await db.from('sound_events').select('id', { count: 'exact', head: true }).eq('night_date', nightDate).not('clip_path', 'is', null);
  if (error) throw new Error(`sound_events count: ${error.message}`);
  return count ?? 0;
}

export const isoOrNull = (ms: Ms | null | undefined) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : iso(ms));
