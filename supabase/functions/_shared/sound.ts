// Night sounds (night-sound Edge Function, migration 0024): should the Mac listen right now?
//
// Listening needs all of: household_settings.sound_mode = 'auto'; sound_paused_until null or past; the household not
// away tonight (ac-curve's helpers: "Away tonight" / travel tag / an away period covering tonight, unless "Home
// tonight"; or every person's latest phone signal a fresh 'away', _shared/presence.ts everyoneAway); and now inside
// tonight's listen window: lights-out − 15 min → the aircon's scheduled OFF at wake + 30 min (core listenWindow, the
// same "off (wake + 30 min)" the controller schedules). Nights are keyed by their wake date (nightDateFor). Between
// that OFF and 12:00 the reported window is the coming night's (its nights row, else the default schedule).
import { clipAllowance, inWindow, listenWindow, type ListenWindow, SOUND_CLIPS_PER_NIGHT, SOUND_SPEECH_CLIPS_PER_NIGHT } from '../../../packages/core/src/sound/payload.ts';
import {
  CALIBRATION_MAX_LABELS,
  type CalibrationLabel,
  calibrationLabelFromRow,
  type CalibrationSummary,
  calibrationSummary,
  SOUND_UNCERTAIN_CLIPS_DEFAULT,
  SOUND_UNCERTAIN_CLIPS_MAX,
} from '../../../packages/core/src/sound/labels.ts';
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
  /** "Save sleep talk" (sound_sleeptalk, migration 0029): speech clips and transcripts allowed. */
  sleepTalk: boolean;
  /** Borderline clips per night (sound_uncertain_clips, migration 0030); 0 = off, and 0 before the migration. */
  uncertainClips?: number;
  /** Migration 0030 is applied (sound_events.uncertain and sound_labels exist). */
  labels?: boolean;
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
  // select('*'): before migration 0029 there is no sound_sleeptalk column, and that must not break listening.
  const { data, error } = await db.from('household_settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(`household_settings: ${error.message}`);
  const r = data as { sound_mode?: string; sound_paused_until?: string | null; sound_clips?: boolean; sound_sleeptalk?: boolean; sound_uncertain_clips?: number } | null;
  const labels = !!r && 'sound_uncertain_clips' in r;
  const n = Number(r?.sound_uncertain_clips ?? SOUND_UNCERTAIN_CLIPS_DEFAULT);
  return {
    // No row = the column defaults: auto, clips on.
    mode: r?.sound_mode === 'off' ? 'off' : 'auto',
    pausedUntil: r?.sound_paused_until ? Date.parse(r.sound_paused_until) : null,
    clips: r?.sound_clips !== false,
    // Missing column (before 0029) = off: speech stays unclipped until the migration is applied.
    sleepTalk: r?.sound_sleeptalk === true,
    // Missing column (before 0030) = no borderline clips, and the uncertain flag is not stored.
    uncertainClips: labels && Number.isFinite(n) ? Math.min(SOUND_UNCERTAIN_CLIPS_MAX, Math.max(0, Math.round(n))) : 0,
    labels,
  };
}

/** Is the household currently paused or switched off (rows posted now are not stored)? */
export const notListening = (s: SoundSettings, now: Ms): boolean => s.mode === 'off' || (s.pausedUntil !== null && s.pausedUntil > now);

export interface CurrentListen extends ListenDecision {
  night: string;
  clips: boolean;
  clipsLeft: number;
  /** Speech clips may be requested (clips and sleep talk on). */
  sleepTalk: boolean;
  speechClipsLeft: number;
  /** Borderline clips left tonight (0 with clips off, sound_uncertain_clips 0, or before migration 0030). */
  uncertainClipsLeft: number;
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
    clipCounts(db, night.date),
  ]);
  const awayWhy = nightAway(night.presenceOverride, night.tags, awayPeriodFor(periods, night.date));
  const d = listenDecision({ now, settings, night, awayWhy, latest: presence.latest, people: presence.people });
  return {
    ...d,
    night: night.date,
    clips: settings.clips,
    clipsLeft: Math.max(0, SOUND_CLIPS_PER_NIGHT - clipsUsed.other),
    sleepTalk: settings.clips && settings.sleepTalk,
    speechClipsLeft: settings.clips && settings.sleepTalk ? Math.max(0, SOUND_SPEECH_CLIPS_PER_NIGHT - clipsUsed.speech) : 0,
    uncertainClipsLeft: settings.clips ? Math.max(0, (settings.uncertainClips ?? 0) - clipsUsed.uncertain) : 0,
    settings,
  };
}

/**
 * Clips reserved for a night (sound_events with clip_path set), split by allowance (core clipAllowance): speech (kind
 * 'speech' or a speech-class label: the sleep-talk allowance), uncertain (borderline sounds, migration 0030) and the
 * rest.
 */
export async function clipCounts(db: Db, nightDate: string): Promise<{ other: number; speech: number; uncertain: number }> {
  // '*': sound_events.uncertain exists only from migration 0030 on (rows with a clip are few: ≤ 40 + 20 + 40 a night).
  const { data, error } = await db.from('sound_events').select('*').eq('night_date', nightDate).not('clip_path', 'is', null).limit(1000);
  if (error) throw new Error(`sound_events clips: ${error.message}`);
  const out = { other: 0, speech: 0, uncertain: 0 };
  for (const r of (data ?? []) as { kind: string; label: string | null; uncertain?: boolean | null }[]) out[clipAllowance(r)]++;
  return out;
}

/** Clips reserved for a night (all allowances together). */
export async function clipsStored(db: Db, nightDate: string): Promise<number> {
  const c = await clipCounts(db, nightDate);
  return c.other + c.speech + c.uncertain;
}

// ---------------------------------------------------------------- labels → the Mac's calibration (migration 0030)

export interface Calibration {
  /** The latest labelled events (≤ 200, newest label first). */
  labels: CalibrationLabel[];
  summary: CalibrationSummary;
}

/**
 * The labelled events the Mac tunes its snore rule from: the newest CALIBRATION_MAX_LABELS sound_labels rows with
 * their sound_events row and the quiet floor of the event's minute (sound_minutes.db_floor). Throws on a read error
 * (e.g. before migration 0030); the caller answers calibration: null then.
 */
export async function loadCalibration(db: Db, limit = CALIBRATION_MAX_LABELS): Promise<Calibration> {
  const { data, error } = await db.from('sound_labels').select('event_id,label,who,labelled_at')
    .order('labelled_at', { ascending: false }).limit(Math.max(1, Math.min(CALIBRATION_MAX_LABELS, limit)));
  if (error) throw new Error(`sound_labels: ${error.message}`);
  const rows = (data ?? []) as { event_id: number; label: string; who: string | null; labelled_at: string }[];
  if (!rows.length) return { labels: [], summary: calibrationSummary([]) };
  type Ev = { id: number; ts: string; camera: string; kind: string; label: string | null; peak_db: number | null; duration_s: number | null; score: number | null; uncertain?: boolean | null };
  const ev = await db.from('sound_events').select('id,ts,camera,kind,label,peak_db,duration_s,score,uncertain').in('id', rows.map((r) => r.event_id));
  if (ev.error) throw new Error(`sound_events labelled: ${ev.error.message}`);
  const events = new Map(((ev.data ?? []) as Ev[]).map((e) => [Number(e.id), e]));
  // The quiet floor of each event's minute.
  const minuteIso = (ts: string) => new Date(Math.floor(Date.parse(ts) / 60_000) * 60_000).toISOString();
  const starts = [...new Set([...events.values()].map((e) => minuteIso(e.ts)))];
  const floors = new Map<string, number>();
  for (let i = 0; i < starts.length; i += 100) {
    const m = await db.from('sound_minutes').select('camera,ts,db_floor').in('ts', starts.slice(i, i + 100));
    if (m.error) throw new Error(`sound_minutes floors: ${m.error.message}`);
    for (const r of (m.data ?? []) as { camera: string; ts: string; db_floor: number | null }[]) {
      if (typeof r.db_floor === 'number') floors.set(`${r.camera}|${new Date(Date.parse(r.ts)).toISOString()}`, r.db_floor);
    }
  }
  const labels: CalibrationLabel[] = [];
  for (const r of rows) {
    const e = events.get(Number(r.event_id)) ?? null;
    const l = calibrationLabelFromRow(r, e, e ? floors.get(`${e.camera}|${minuteIso(e.ts)}`) ?? null : null);
    if (l) labels.push(l);
  }
  return { labels, summary: calibrationSummary(labels) };
}

export const isoOrNull = (ms: Ms | null | undefined) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : iso(ms));
