'use client';
/**
 * Night sounds (Live, Today › Snoring & noise, System › Camera): reads public.sound_minutes and public.sound_events
 * (migration 0024, written by the night-sound Edge Function from the Mac's night listener) and the household's sound
 * settings in household_settings.
 *
 *   useSoundSettings(enabled, nonce)    sound_mode ('auto' | 'off'), sound_paused_until, sound_clips, live_video,
 *                                       sound_sleeptalk (migration 0029)
 *   setSoundSettings / pauseSoundUntil / setLiveVideo / setSoundSleepTalk   the writers' RPCs; each returns an error
 *                                       message or null
 *   useRecentSounds(enabled, nonce)     the last 60 minutes + the newest events, refreshed every 60 s (Live tab)
 *   useNewestSoundMinute(enabled)       ts of the newest sound_minutes row (the Mac listener's status)
 *   useNightSounds(night)               one night's minutes and events (night_date = the morning's date); sample
 *                                       data from the night's own hypnograms in the simulator
 *   signClipUrls(paths)                 1-hour signed URLs for clips in the private 'night-sounds' bucket
 *   cathWakeStarts(stages)              starts of Cath's awakenings after sleep onset (the final wake-up excluded)
 *
 * The audio itself never leaves the Mac except for short clips of notable moments; talking only while "Save sleep talk"
 * is on (then with the Mac's transcript; clips where both were awake are removed the next morning, migration 0029).
 * Summaries and the "does snoring wake Cath?" math live in @sleep-lab/core (src/sound): nightSoundSummary, wakeTriggers.
 *   sleepTalkEvents(events)             the night's sleep talk: speech events not judged a conversation, with a clip or
 *                                       a transcript
 */
import { useEffect, useState } from 'react';
import {
  awakeningStarts,
  isSpeechEvent,
  SNORE_MIN_S,
  SOUND_CLIPS_PER_NIGHT,
  SOUND_KINDS,
  type SleepStage,
  type SoundEvent as CoreSoundEvent,
  type SoundKind,
  type SoundMinute as CoreSoundMinute,
} from '@sleep-lab/core';
import { useAuth } from './auth.tsx';
import { useData } from './data/context.tsx';
import { supabaseClient } from './data/supabase.ts';
import { DAY, HOUR, MIN, ictDate, ictMidnight } from './format.ts';

type Row = Record<string, unknown>;

export { SNORE_MIN_S, SOUND_KINDS };
export type { SoundKind };
export type SoundMode = 'auto' | 'off';

/** One minute of the night listener's summary (sound_minutes): @sleep-lab/core's SoundMinute (null = not measured). */
export type SoundMinute = CoreSoundMinute;

/** One discrete moment (sound_events): @sleep-lab/core's SoundEvent plus the row's id and clip. */
export interface SoundEvent extends CoreSoundEvent {
  id: string;
  /** Object name in the 'night-sounds' bucket; null when no clip was kept (or it aged out after 14 days). */
  clipPath: string | null;
  /** Speech only: null = not judged yet, true = someone was asleep (sleep talk), false = both awake (conversation). */
  sleepTalk?: boolean | null;
  /** 'a' | 'b' when only that person was asleep: probably the one talking. */
  talkerHint?: string | null;
  sample?: boolean;
}

export interface SoundSettings {
  mode: SoundMode;
  pausedUntil: number | null;
  clips: boolean;
  liveVideo: boolean;
  /** "Save sleep talk" (sound_sleeptalk, migration 0029); null before the migration. */
  sleepTalk: boolean | null;
}

/** The listener counts as "listening" when its newest minute is this recent. */
export const LISTENING_MS = 3 * MIN;
/** The window opens this long before lights-out and closes when the aircon goes off (wake + 30 min). */
export const LISTEN_EARLY_MIN = 15;
export const CLIP_BUCKET = 'night-sounds';
export const CLIPS_PER_NIGHT = SOUND_CLIPS_PER_NIGHT;

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN);
const numOr = (v: unknown, d: number) => (Number.isFinite(num(v)) ? num(v) : d);
const numOrNull = (v: unknown) => (Number.isFinite(num(v)) ? num(v) : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** A server message that means "migration 0024 isn't applied yet". */
export const missingSound = (m: string) => /does not exist|schema cache|could not find|sound_|live_video/i.test(m);
export const NOT_YET = 'Night sounds aren’t on the server yet (migration 0024).';
const errText = (m: string) => (missingSound(m) ? NOT_YET : m);

function toClasses(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (Number.isFinite(num(x))) out[k] = num(x);
  return out;
}

export function toSoundMinute(r: Row): SoundMinute {
  return {
    ts: Date.parse(String(r.ts)),
    dbAvg: numOrNull(r.db_avg),
    dbMax: numOrNull(r.db_max),
    dbFloor: numOrNull(r.db_floor),
    snoreS: numOr(r.snore_s, 0),
    snoreProb: numOrNull(r.snore_prob),
    speechS: numOr(r.speech_s, 0),
    coughS: numOr(r.cough_s, 0),
    classes: toClasses(r.classes),
    n: numOr(r.n, 0),
  };
}

export function toSoundEvent(r: Row): SoundEvent {
  const k = str(r.kind);
  return {
    id: String(r.id),
    ts: Date.parse(String(r.ts)),
    durationS: numOrNull(r.duration_s),
    kind: k && (SOUND_KINDS as readonly string[]).includes(k) ? (k as SoundKind) : 'other',
    label: str(r.label),
    peakDb: numOrNull(r.peak_db),
    score: numOrNull(r.score),
    wantClip: false,
    // A conversation (sleep_talk false) keeps clip_path until the morning judge removes its object: never played.
    clipPath: r.sleep_talk === false ? null : str(r.clip_path),
    transcript: str(r.transcript),
    transcriptLang: str(r.transcript_lang),
    sleepTalk: typeof r.sleep_talk === 'boolean' ? r.sleep_talk : null,
    talkerHint: str(r.talker_hint),
  };
}

const MINUTE_COLS = 'ts,db_avg,db_max,db_floor,snore_s,snore_prob,speech_s,cough_s,classes,n';
// '*': the sleep-talk columns (migration 0029) are read when they exist, without breaking before it.
const EVENT_COLS = '*';

/**
 * The night's sleep talk, oldest first: speech events (by kind or label) not judged a conversation (sleep_talk false),
 * that kept a clip or a transcript.
 */
export function sleepTalkEvents(events: readonly SoundEvent[]): SoundEvent[] {
  return events.filter((e) => isSpeechEvent(e) && e.sleepTalk !== false && (!!e.clipPath || !!e.transcript)).sort((a, b) => a.ts - b.ts);
}

/** "probably Cath" from talker_hint (null when unknown). */
export function talkerWords(hint: string | null | undefined, names: Readonly<Record<string, string>>): string | null {
  const n = hint ? names[hint] : undefined;
  return n ? `probably ${n}` : null;
}

/** Plain words for an event: "Snoring", "Loud: Door", "Cough", "Talking", or the class name. */
export function eventWords(e: Pick<SoundEvent, 'kind' | 'label'> & { sleepTalk?: boolean | null }): string {
  if (e.sleepTalk === true) return 'Sleep talk';
  if (e.kind === 'snore') return 'Snoring';
  if (e.kind === 'cough') return 'Cough';
  if (e.kind === 'speech') return 'Talking';
  if (e.kind === 'loud') return e.label && !/^(loud|silence)$/i.test(e.label) ? `Loud: ${e.label}` : 'Loud noise';
  return e.label || 'Noise';
}

/** "−42 dB" style loudness (dBFS: 0 is the microphone's maximum, quieter is more negative). */
export const dbText = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? `${v < 0 ? '−' : ''}${Math.abs(Math.round(v))} dB` : '–');

// ───────────────────────────── settings ─────────────────────────────

/** household_settings' sound columns; undefined while loading, null when unreadable (before migration 0024). */
export function useSoundSettings(enabled: boolean, nonce = 0): { settings: SoundSettings | null | undefined; error: string | null } {
  const [res, setRes] = useState<{ settings: SoundSettings | null | undefined; error: string | null }>({ settings: undefined, error: null });
  useEffect(() => {
    if (!enabled) return setRes({ settings: null, error: null });
    let alive = true;
    supabaseClient()
      .from('household_settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) return setRes({ settings: null, error: errText(error.message) });
        const d = (data ?? {}) as Row;
        const until = str(d.sound_paused_until);
        setRes({
          settings: {
            mode: d.sound_mode === 'off' ? 'off' : 'auto',
            pausedUntil: until ? Date.parse(until) : null,
            clips: d.sound_clips !== false,
            liveVideo: d.live_video === true,
            sleepTalk: typeof d.sound_sleeptalk === 'boolean' ? d.sound_sleeptalk : null,
          },
          error: null,
        });
      });
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);
  return res;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<string | null> {
  const { error } = await supabaseClient().rpc(name, args);
  return error ? errText(error.message) : null;
}

/** Listening mode and/or clips (null keeps the current value). */
export const setSoundSettings = (mode: SoundMode | null, clips: boolean | null) => rpc('set_sound_settings', { p_mode: mode, p_clips: clips });
/** Pause until an instant; null resumes. */
export const pauseSoundUntil = (until: number | null) => rpc('pause_sound_until', { p_until: until === null ? null : new Date(until).toISOString() });
export const setLiveVideo = (on: boolean) => rpc('set_live_video', { p_on: on });
/** "Save sleep talk" (migration 0029). */
export async function setSoundSleepTalk(on: boolean): Promise<string | null> {
  const { error } = await supabaseClient().rpc('set_sound_sleeptalk', { p_on: on });
  if (!error) return null;
  return /set_sound_sleeptalk|sound_sleeptalk/i.test(error.message) ? 'Sleep talk isn’t on the server yet (migration 0029).' : errText(error.message);
}

/**
 * When "Pause tonight" ends: the 12:00 ICT after the coming (or ongoing) night's listening window. `offMin` is the
 * window's end as a minute of day (wake + 30 min). During the night or after noon that is the next 12:00; between the
 * morning's window end and noon, last night is over, so it is tomorrow's 12:00 (today's noon would leave tonight on).
 */
export function nextNoon(now = Date.now(), offMin?: number): number {
  const midnight = ictMidnight(ictDate(now));
  const noon = midnight + 12 * HOUR;
  if (noon <= now) return noon + DAY;
  const minOfDay = (now - midnight) / MIN;
  return offMin !== undefined && offMin % 1440 < 720 && minOfDay >= offMin % 1440 ? noon + DAY : noon;
}

/** Whether a pause is still running. */
export const isPaused = (s: Pick<SoundSettings, 'pausedUntil'> | null | undefined, now = Date.now()) => !!s?.pausedUntil && s.pausedUntil > now;

// ───────────────────────────── reads ─────────────────────────────

/** ts of the newest sound_minutes row (null = none yet); undefined while loading. Refreshed every 60 s. */
export function useNewestSoundMinute(enabled: boolean, nonce = 0): { ts: number | null | undefined; error: string | null } {
  const [res, setRes] = useState<{ ts: number | null | undefined; error: string | null }>({ ts: undefined, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setTick((x) => x + 1), 60_000);
    return () => window.clearInterval(id);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return setRes({ ts: null, error: null });
    let alive = true;
    supabaseClient()
      .from('sound_minutes')
      .select('ts')
      .order('ts', { ascending: false })
      .limit(1)
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) return setRes({ ts: null, error: errText(error.message) });
        const r = (data ?? [])[0] as Row | undefined;
        setRes({ ts: r ? Date.parse(String(r.ts)) : null, error: null });
      });
    return () => {
      alive = false;
    };
  }, [enabled, nonce, tick]);
  return res;
}

export interface RecentSounds {
  /** The last 60 minutes, oldest first. */
  minutes: SoundMinute[];
  /** The newest events (any night), newest first. */
  events: SoundEvent[];
  /** Newest minute ts (null = none ever). */
  newest: number | null;
}

/** The Live tab's panel: the last hour and the newest 20 events, refreshed every 60 s; undefined while loading. */
export function useRecentSounds(enabled: boolean, nonce = 0): { data: RecentSounds | undefined; error: string | null } {
  const [res, setRes] = useState<{ data: RecentSounds | undefined; error: string | null }>({ data: undefined, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setTick((x) => x + 1), 60_000);
    return () => window.clearInterval(id);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return setRes({ data: { minutes: [], events: [], newest: null }, error: null });
    let alive = true;
    const db = supabaseClient();
    const since = new Date(Date.now() - 60 * MIN).toISOString();
    Promise.all([
      db.from('sound_minutes').select(MINUTE_COLS).gte('ts', since).order('ts', { ascending: true }).limit(120),
      db.from('sound_events').select(EVENT_COLS).eq('hidden', false).order('ts', { ascending: false }).limit(20),
      db.from('sound_minutes').select('ts').order('ts', { ascending: false }).limit(1),
    ]).then(([m, e, n]) => {
      if (!alive) return;
      const err = m.error ?? e.error ?? n.error;
      if (err) return setRes({ data: { minutes: [], events: [], newest: null }, error: errText(err.message) });
      const top = ((n.data ?? []) as Row[])[0];
      setRes({
        data: {
          minutes: ((m.data ?? []) as Row[]).map(toSoundMinute),
          events: ((e.data ?? []) as Row[]).map(toSoundEvent),
          newest: top ? Date.parse(String(top.ts)) : null,
        },
        error: null,
      });
    });
    return () => {
      alive = false;
    };
  }, [enabled, nonce, tick]);
  return res;
}

/** All of one night's rows (night_date = the morning's date), oldest first; paged past PostgREST's 1000-row limit. */
export async function fetchNightSounds(date: string): Promise<{ minutes: SoundMinute[]; events: SoundEvent[] }> {
  const db = supabaseClient();
  const minutes: SoundMinute[] = [];
  for (let from = 0; from < 3000; from += 1000) {
    const { data, error } = await db.from('sound_minutes').select(MINUTE_COLS).eq('night_date', date).order('ts', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(errText(error.message));
    minutes.push(...((data ?? []) as Row[]).map(toSoundMinute));
    if ((data ?? []).length < 1000) break;
  }
  const { data, error } = await db.from('sound_events').select(EVENT_COLS).eq('night_date', date).eq('hidden', false).order('ts', { ascending: true }).limit(1000);
  if (error) throw new Error(errText(error.message));
  return { minutes, events: ((data ?? []) as Row[]).map(toSoundEvent) };
}

export interface NightSoundsInput {
  date: string;
  lightsOut: number;
  wake: number;
  /** Stage runs of the snorer (Erik, 'b'), for sample data only. */
  snorerStages?: readonly { start: number; end: number; stage: SleepStage }[];
}

/** One night's sounds: real for a signed-in member on real data, sample (from the night itself) in the simulator. */
export function useNightSounds(night: NightSoundsInput | null): {
  real: boolean;
  data: { minutes: SoundMinute[]; events: SoundEvent[] } | null;
  error: string | null;
} {
  const auth = useAuth();
  const { sourceKind } = useData();
  const real = sourceKind === 'supabase' && auth.status === 'signed-in' && !!auth.probe?.member;
  const [res, setRes] = useState<{ key: string; data: { minutes: SoundMinute[]; events: SoundEvent[] } | null; error: string | null } | null>(null);
  const key = night ? `${real ? 'r' : 's'}:${night.date}` : '';
  useEffect(() => {
    if (!night) return;
    let alive = true;
    if (!real) {
      setRes({ key, data: sampleNightSounds(night), error: null });
      return;
    }
    fetchNightSounds(night.date).then(
      (d) => alive && setRes({ key, data: d, error: null }),
      (e: unknown) => alive && setRes({ key, data: { minutes: [], events: [] }, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // Never show another night's sounds while this one loads.
  if (!res || res.key !== key) return { real, data: null, error: null };
  return { real, data: res.data, error: res.error };
}

/** 1-hour signed URLs for clip objects (path → url); paths that fail are left out. */
export async function signClipUrls(paths: readonly string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(paths.filter(Boolean))].map((p) => p.replace(new RegExp(`^${CLIP_BUCKET}/`), ''));
  if (!uniq.length) return {};
  const { data, error } = await supabaseClient().storage.from(CLIP_BUCKET).createSignedUrls(uniq, 3600);
  if (error || !data) return {};
  const out: Record<string, string> = {};
  data.forEach((d, i) => {
    if (d.signedUrl && !d.error) {
      const p = uniq[i]!;
      out[p] = d.signedUrl;
      out[`${CLIP_BUCKET}/${p}`] = d.signedUrl;
    }
  });
  return out;
}

/** Signed URLs for the clips among `events`, re-signed when the set changes and every 50 min. */
export function useClipUrls(events: readonly Pick<SoundEvent, 'clipPath'>[] | null | undefined, enabled: boolean): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = (events ?? []).map((e) => e.clipPath ?? '').filter(Boolean).join('|');
  // The URLs last 1 h: re-sign every 50 min even when the set of clips stays the same (a Live tab left open overnight).
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!enabled || !key) return;
    const id = window.setInterval(() => setEpoch((x) => x + 1), 50 * MIN);
    return () => window.clearInterval(id);
  }, [enabled, key]);
  useEffect(() => {
    if (!enabled || !key) return setUrls({});
    let alive = true;
    signClipUrls(key.split('|')).then((u) => alive && setUrls(u), () => alive && setUrls({}));
    return () => {
      alive = false;
    };
  }, [enabled, key, epoch]);
  return urls;
}

// ───────────────────────────── math for the app ─────────────────────────────

/**
 * Starts of Cath's awakenings after sleep onset (awakeningStarts in @sleep-lab/core), without the final one: an awake
 * run that starts after her last sleep segment is getting up, not a wake-up.
 */
export function cathWakeStarts(stages: readonly { start: number; end: number; stage: SleepStage }[]): number[] {
  const lastSleep = Math.max(-Infinity, ...stages.filter((s) => s.stage !== 'awake').map((s) => s.end));
  return awakeningStarts(stages).filter((t) => t < lastSleep);
}

/** Listening status from the newest minute: "Listening · last minute 23:41" vs "Not listening". */
export const isListening = (newest: number | null | undefined, now = Date.now()) => !!newest && now - newest < LISTENING_MS;

// ───────────────────────────── sample data (simulator) ─────────────────────────────

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/**
 * Plausible sounds for a simulated night: a quiet floor around −62 dB, snoring in runs during the snorer's light and
 * deep sleep (more in the second half), a few loud moments and coughs. Deterministic per date.
 */
export function sampleNightSounds(n: NightSoundsInput): { minutes: SoundMinute[]; events: SoundEvent[] } {
  const r = rng(n.date);
  const from = Math.ceil((n.lightsOut - LISTEN_EARLY_MIN * MIN) / MIN) * MIN;
  const to = Math.min(n.wake + 30 * MIN, from + 14 * HOUR);
  const stageAt = (t: number) => n.snorerStages?.find((s) => s.start <= t && s.end > t)?.stage ?? null;
  const minutes: SoundMinute[] = [];
  const events: SoundEvent[] = [];
  let run = 0;
  let id = 0;
  for (let t = from; t < to; t += MIN) {
    const st = stageAt(t);
    const floor = -62 + (r() - 0.5) * 3;
    const asleep = st === 'light' || st === 'deep';
    const late = (t - n.lightsOut) / Math.max(1, n.wake - n.lightsOut);
    if (run > 0) run--;
    else if (asleep && r() < 0.04 + 0.05 * late) run = 4 + Math.floor(r() * 18);
    const snoreS = run > 0 && asleep ? Math.round(18 + r() * 40) : r() < 0.03 ? Math.round(r() * 8) : 0;
    const dbAvg = floor + 4 + (snoreS / 60) * 14 + r() * 2;
    let dbMax = dbAvg + 4 + r() * 6;
    const coughS = r() < 0.006 ? 1 + Math.round(r() * 2) : 0;
    const loud = r() < 0.005;
    if (loud) dbMax = floor + 22 + r() * 8;
    if (snoreS >= SNORE_MIN_S && (minutes.at(-1)?.snoreS ?? 0) < SNORE_MIN_S)
      events.push({ id: `s${id++}`, ts: t + 5_000, durationS: 30 + Math.round(r() * 200), kind: 'snore', label: 'Snoring', peakDb: dbMax, score: 0.5 + r() * 0.4, wantClip: false, clipPath: null, sample: true });
    if (coughS) events.push({ id: `s${id++}`, ts: t + 20_000, durationS: coughS, kind: 'cough', label: 'Cough', peakDb: dbMax, score: 0.6, wantClip: false, clipPath: null, sample: true });
    if (loud) events.push({ id: `s${id++}`, ts: t + 31_000, durationS: 1 + Math.round(r() * 3), kind: 'loud', label: r() < 0.5 ? 'Door' : 'Vehicle', peakDb: dbMax, score: 0.5, wantClip: false, clipPath: null, sample: true });
    const classes: Record<string, number> = snoreS ? { Snoring: snoreS, Breathing: Math.round(r() * 10) } : { Silence: 50, 'White noise': 8 };
    minutes.push({ ts: t, dbAvg, dbMax, dbFloor: floor, snoreS, snoreProb: Math.min(1, snoreS / 60 + r() * 0.1), speechS: 0, coughS, classes, n: 61 });
  }
  // Sleep talk: two short mumbles in the snorer's sleep (one with a guess at who), no audio in the simulator.
  const asleepAt = minutes.filter((m) => {
    const st = stageAt(m.ts);
    return st === 'light' || st === 'rem';
  });
  const lines = ['No, the blue one… put it with the others.', 'Wacht even, ik kom zo.', 'Mm. Tomorrow.', 'Did you lock the door?'];
  for (const [i, frac] of [0.3, 0.75].entries()) {
    const m = asleepAt[Math.floor(frac * asleepAt.length)];
    if (!m) continue;
    m.speechS = 6 + Math.round(r() * 8);
    events.push({
      id: `s${id++}`,
      ts: m.ts + 12_000,
      durationS: m.speechS,
      kind: 'speech',
      label: 'Speech',
      peakDb: (m.dbMax ?? -50) + 2,
      score: 0.7,
      wantClip: false,
      clipPath: null,
      transcript: lines[Math.floor(r() * lines.length)]!,
      transcriptLang: null,
      sleepTalk: true,
      talkerHint: i === 0 ? 'b' : null,
      sample: true,
    });
  }
  events.sort((a, b) => a.ts - b.ts);
  return { minutes, events };
}
