// Night sounds from the Mac listener (night-sound Edge Function → public.sound_minutes / public.sound_events, migration
// 0024): request validation and clamping, the listen window, and the snake_case rows.
//
// The Mac classifies the bedroom camera's audio locally (YAMNet AudioSet classes) and posts per-minute summaries and
// discrete events only: no raw audio arrives here. Short clips of notable moments are uploaded separately through
// signed Storage URLs the function hands out. Speech is clipped only while "Save sleep talk" is on
// (household_settings.sound_sleeptalk, migration 0029): then speech events may carry a clip (≤ 30 s, ≤ 20 a night,
// on top of the 40) and the Mac's local transcript; the morning judge (sleeptalk.ts) removes the ones where both were awake.
import type { Ms } from '../types.ts';
import { OFF_AFTER_WAKE_MIN } from '../control/quiet.ts';
import { addDays, ictDate } from '../sim/time.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** At most this many minute summaries and events per request. */
export const SOUND_MAX_MINUTES = 120;
export const SOUND_MAX_EVENTS = 100;
/** A ts may be at most this far in the future (clock skew) … */
export const SOUND_MAX_FUTURE_MS = 2 * MIN;
/** … and at most this old (an unsent batch the Mac kept on disk). */
export const SOUND_MAX_AGE_MS = 36 * HOUR;
/** dBFS range kept (values outside are clamped). */
export const SOUND_DB_MIN = -120;
export const SOUND_DB_MAX = 20;
/** The listen window opens this long before tonight's lights-out … */
export const LISTEN_BEFORE_LIGHTS_OUT_MIN = 15;
/** … and closes at the aircon's scheduled OFF (wake + OFF_AFTER_WAKE_MIN). Rows this close outside it are still kept. */
export const LISTEN_GRACE_MS = 5 * MIN;
/** At most this many stored clips per night. */
export const SOUND_CLIPS_PER_NIGHT = 40;
/** At most this many speech clips per night (sleep talk, only with sound_sleeptalk on), on top of SOUND_CLIPS_PER_NIGHT. */
export const SOUND_SPEECH_CLIPS_PER_NIGHT = 20;
/** Clip length the Mac may cut: ~10 s for ordinary moments, the whole speech run (pre-roll 2 s) up to 30 s for speech. */
export const SOUND_CLIP_MAX_S = 10;
export const SPEECH_CLIP_MAX_S = 30;
/** Transcript of a speech clip (made on the Mac): at most this many characters; its language code at most 10. */
export const TRANSCRIPT_MAX = 2000;
export const TRANSCRIPT_LANG_MAX = 10;
/** A minute counts as snoring when the Mac classified at least this many of its seconds as snoring. */
export const SNORE_MIN_S = 10;
/** A loud moment: this many dB above the room's quiet floor. */
export const LOUD_ABOVE_FLOOR_DB = 15;
export const SOUND_CAMERA_DEFAULT = 'bedroom';
export const SOUND_KINDS = ['snore', 'loud', 'cough', 'speech', 'other'] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

/** One minute summary, as validated (ts = start of the minute, epoch ms). */
export interface SoundMinute {
  ts: Ms;
  dbAvg: number | null;
  dbMax: number | null;
  /** 10th percentile of the minute's frame levels: the quiet floor. */
  dbFloor: number | null;
  /** Seconds (0..60) classified as snoring. */
  snoreS: number;
  /** Mean snoring score 0..1, or null. */
  snoreProb: number | null;
  speechS: number;
  coughS: number;
  /** Top classes (≤ 5): YAMNet class name → seconds. */
  classes: Record<string, number>;
  /** Classifier frames in the minute. */
  n: number;
}

/** One discrete event, as validated. */
export interface SoundEvent {
  ts: Ms;
  durationS: number | null;
  kind: SoundKind;
  /** YAMNet class name, or null. */
  label: string | null;
  peakDb: number | null;
  score: number | null;
  wantClip: boolean;
  /** Local transcript of a speech clip (≤ 2000 chars), or null. Kept only for speech events with sleep talk on. */
  transcript?: string | null;
  /** Language the transcriber detected ("en", "nl", "th"; ≤ 10 chars), or null. */
  transcriptLang?: string | null;
}

export interface SoundPayloadError {
  /** 'request' for the whole body (then nothing is stored). */
  kind: 'request' | 'minute' | 'event';
  index: number;
  reason: string;
}

export interface SoundPayload {
  camera: string;
  ping: boolean;
  minutes: SoundMinute[];
  /** Same order as the request (the response's upload `index` refers to the request's events array). */
  events: (SoundEvent & { index: number })[];
  errors: SoundPayloadError[];
  /** A request-level problem (400): not an object, too many rows, bad camera. Nothing is stored. */
  fatal: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const db = (v: unknown): number | null => {
  const x = num(v);
  return x === null ? null : round(clamp(x, SOUND_DB_MIN, SOUND_DB_MAX), 1);
};
const secs = (v: unknown): number => {
  const x = num(v);
  return x === null ? 0 : Math.round(clamp(x, 0, 60));
};
const unit = (v: unknown): number | null => {
  const x = num(v);
  return x === null ? null : round(clamp(x, 0, 1), 3);
};
const SLUG_RE = /^[a-z0-9][a-z0-9 _-]*$/;
// YAMNet class names: letters, digits, space and a little punctuation ("Snoring", "Vehicle horn, car horn, honking").
const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} ,.()'&/_-]*$/u;
const LABEL_MAX = 80;

/** A YAMNet class name as stored: trimmed, whitespace collapsed; null when empty, too long or odd characters. */
export function normalizeSoundLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  return s && s.length <= LABEL_MAX && LABEL_RE.test(s) ? s : null;
}

/**
 * YAMNet classes that are people talking (or close to it). Audio of these is never clipped: an event with one of these
 * labels gets no clip whatever its kind, so a raised voice reported as kind 'loud' still is not recorded.
 */
export const SPEECH_LABELS: readonly string[] = [
  'Speech',
  'Child speech, kid speaking',
  'Conversation',
  'Narration, monologue',
  'Babbling',
  'Speech synthesizer',
  'Shout',
  'Bellow',
  'Whoop',
  'Yell',
  'Children shouting',
  'Screaming',
  'Whispering',
  'Laughter',
  'Baby laughter',
  'Giggle',
  'Snicker',
  'Belly laugh',
  'Chuckle, chortle',
  'Crying, sobbing',
  'Baby cry, infant cry',
  'Whimper',
  'Wail, moan',
  'Sigh',
  'Singing',
  'Humming',
];
const SPEECH_SET = new Set(SPEECH_LABELS.map((l) => l.toLowerCase()));

/** True when a YAMNet label is a speech/voice class (case-insensitive). */
export function isSpeechLabel(label: string | null | undefined): boolean {
  return !!label && SPEECH_SET.has(label.trim().replace(/\s+/g, ' ').toLowerCase());
}

/** A clip is only made for a fresh event (a re-sent outbox batch no longer has its audio). */
export const CLIP_MAX_AGE_MS = 10 * MIN;

/** A speech event: kind 'speech' or a speech/voice class label (a raised voice reported as 'loud' included). */
export function isSpeechEvent(e: { kind: SoundKind | string; label: string | null | undefined }): boolean {
  return e.kind === 'speech' || isSpeechLabel(e.label);
}

/**
 * May the server reserve a clip for this event? Only when the Mac asked and it is at most CLIP_MAX_AGE_MS old; a
 * speech event (by kind or by label) only when `opts.speech` is true ("Save sleep talk" on; it then counts against
 * SOUND_SPEECH_CLIPS_PER_NIGHT). Without opts speech is never clipped.
 */
export function clipAllowed(e: { ts: Ms; kind: SoundKind; label: string | null; wantClip: boolean }, now: Ms, opts: { speech?: boolean } = {}): boolean {
  if (!e.wantClip || now - e.ts > CLIP_MAX_AGE_MS) return false;
  return isSpeechEvent(e) ? opts.speech === true : true;
}

/** A transcript as stored: trimmed, whitespace collapsed, control characters removed, ≤ TRANSCRIPT_MAX; null when empty or not a string. */
export function normalizeTranscript(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return [...s].slice(0, TRANSCRIPT_MAX).join('').trim();
}

/** A language code as stored: lower-case letters, digits and '-' (e.g. 'en', 'nl', 'th', 'zh-hant'), ≤ 10; else null. */
export function normalizeTranscriptLang(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s && s.length <= TRANSCRIPT_LANG_MAX && /^[a-z]{2,3}(-[a-z0-9]{1,6})?$/.test(s) ? s : null;
}

/**
 * The transcript rule: kept only when "Save sleep talk" is on and the event is speech; otherwise both fields are
 * dropped (null).
 */
export function applyTranscriptPolicy<E extends { kind: SoundKind; label: string | null; transcript?: string | null; transcriptLang?: string | null }>(
  e: E,
  sleepTalk: boolean,
): E {
  if (sleepTalk && isSpeechEvent(e) && e.transcript) return e;
  return { ...e, transcript: null, transcriptLang: null };
}

/** ISO 8601 with Z or an offset, or epoch ms. */
export function parseSoundTs(v: unknown): Ms | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function tsProblem(ts: Ms | null, now: Ms): string | null {
  if (ts === null) return 'ts: expected ISO 8601 with Z or an offset, or epoch ms';
  if (ts > now + SOUND_MAX_FUTURE_MS) return 'ts: in the future';
  if (ts < now - SOUND_MAX_AGE_MS) return 'ts: older than 36 h';
  return null;
}

/** Top 5 classes by seconds (labels normalised, seconds 0..60, zero-second entries skipped). */
function parseClasses(v: unknown): Record<string, number> {
  if (!isObj(v)) return {};
  const out = new Map<string, number>();
  for (const [k, raw] of Object.entries(v)) {
    const label = normalizeSoundLabel(k);
    const x = num(raw);
    if (!label || x === null) continue;
    const s = round(clamp(x, 0, 60), 1);
    if (s > 0) out.set(label, Math.max(out.get(label) ?? 0, s));
  }
  return Object.fromEntries([...out].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5));
}

export function parseSoundMinute(raw: unknown, now: Ms): SoundMinute | string {
  if (!isObj(raw)) return 'not an object';
  const t = parseSoundTs(raw.ts);
  const bad = tsProblem(t, now);
  if (bad) return bad;
  const n = num(raw.n);
  return {
    ts: Math.floor(t! / MIN) * MIN,
    dbAvg: db(raw.dbAvg),
    dbMax: db(raw.dbMax),
    dbFloor: db(raw.dbFloor),
    snoreS: secs(raw.snoreS),
    snoreProb: unit(raw.snoreProb),
    speechS: secs(raw.speechS),
    coughS: secs(raw.coughS),
    classes: parseClasses(raw.classes),
    n: n === null ? 0 : Math.round(clamp(n, 0, 600)),
  };
}

export function parseSoundEvent(raw: unknown, now: Ms): SoundEvent | string {
  if (!isObj(raw)) return 'not an object';
  const t = parseSoundTs(raw.ts);
  const bad = tsProblem(t, now);
  if (bad) return bad;
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
  if (!(SOUND_KINDS as readonly string[]).includes(kind)) return `kind: expected ${SOUND_KINDS.join(' | ')}`;
  const d = num(raw.durationS ?? raw.duration_s);
  return {
    ts: t!,
    durationS: d === null ? null : round(clamp(d, 0, 3600), 1),
    kind: kind as SoundKind,
    label: normalizeSoundLabel(raw.label),
    peakDb: db(raw.peakDb ?? raw.peak_db),
    score: unit(raw.score),
    wantClip: raw.wantClip === true,
    transcript: normalizeTranscript(raw.transcript),
    transcriptLang: normalizeTranscriptLang(raw.transcriptLang ?? raw.transcript_lang),
  };
}

/**
 * The night-sound POST body → validated minutes and events. Invalid rows are skipped and listed in `errors`; a
 * request-level problem (not an object, > 120 minutes or > 100 events, a bad camera name) sets `fatal`.
 * Duplicate minutes (same minute start) keep the first.
 */
export function parseSoundPayload(body: unknown, now: Ms): SoundPayload {
  const out: SoundPayload = { camera: SOUND_CAMERA_DEFAULT, ping: false, minutes: [], events: [], errors: [], fatal: null };
  const fail = (reason: string): SoundPayload => {
    out.fatal = reason;
    out.errors.push({ kind: 'request', index: -1, reason });
    return out;
  };
  if (!isObj(body)) return fail('body must be a JSON object');
  if (body.camera !== undefined && body.camera !== null) {
    const c = typeof body.camera === 'string' ? body.camera.trim().toLowerCase() : '';
    if (!c || c.length > 40 || !SLUG_RE.test(c)) return fail('camera: lower-case [a-z0-9 _-], at most 40 chars');
    out.camera = c;
  }
  const minutes = body.minutes ?? [];
  const events = body.events ?? [];
  if (!Array.isArray(minutes)) return fail('minutes: expected an array');
  if (!Array.isArray(events)) return fail('events: expected an array');
  if (minutes.length > SOUND_MAX_MINUTES) return fail(`minutes: at most ${SOUND_MAX_MINUTES} per request`);
  if (events.length > SOUND_MAX_EVENTS) return fail(`events: at most ${SOUND_MAX_EVENTS} per request`);
  if (body.ping === true && minutes.length === 0 && events.length === 0) {
    out.ping = true;
    return out;
  }
  const seen = new Set<number>();
  minutes.forEach((raw, index) => {
    const m = parseSoundMinute(raw, now);
    if (typeof m === 'string') out.errors.push({ kind: 'minute', index, reason: m });
    else if (seen.has(m.ts)) out.errors.push({ kind: 'minute', index, reason: 'duplicate minute' });
    else {
      seen.add(m.ts);
      out.minutes.push(m);
    }
  });
  events.forEach((raw, index) => {
    const e = parseSoundEvent(raw, now);
    if (typeof e === 'string') out.errors.push({ kind: 'event', index, reason: e });
    else out.events.push({ ...e, index });
  });
  return out;
}

// ---------------------------------------------------------------- the night and its listen window

/** The night a moment belongs to, keyed by its wake (morning) date, ICT: from 12:00 ICT on it is tomorrow's night. */
export function soundNightDate(ts: Ms): string {
  const ictHour = new Date(ts + 7 * HOUR).getUTCHours();
  return ictHour >= 12 ? addDays(ictDate(ts), 1) : ictDate(ts);
}

export interface ListenWindow {
  from: Ms;
  until: Ms;
}

/**
 * The listen window of a night: lights-out − 15 min → the aircon's scheduled OFF. Pass `offAt`, or `wake` (OFF = wake +
 * OFF_AFTER_WAKE_MIN, the schedule's "off (wake + 30 min)").
 */
export function listenWindow(o: { lightsOut: Ms; offAt?: Ms; wake?: Ms }): ListenWindow {
  const until = o.offAt ?? (o.wake !== undefined ? o.wake + OFF_AFTER_WAKE_MIN * MIN : NaN);
  if (!Number.isFinite(until)) throw new Error('listenWindow: offAt or wake required');
  return { from: o.lightsOut - LISTEN_BEFORE_LIGHTS_OUT_MIN * MIN, until };
}

/** ts inside [from − grace, until + grace]. */
export function inWindow(ts: Ms, w: ListenWindow, graceMs = 0): boolean {
  return ts >= w.from - graceMs && ts <= w.until + graceMs;
}

// ---------------------------------------------------------------- rows

// 20261103T171502Z, or 20261103T171502.345Z when the ts has milliseconds (two events a fraction apart stay distinct).
const compact = (ts: Ms) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.000Z$/, 'Z');

/**
 * Object name of an event's clip inside the private Storage bucket 'night-sounds' (no bucket prefix):
 * `<night>/<YYYYMMDDTHHMMSS[.mmm]Z>_<kind>.m4a`, e.g. `2026-11-04/20261103T171502Z_snore.m4a`.
 */
export function soundClipPath(nightDate: string, e: { ts: Ms; kind: SoundKind }): string {
  return `${nightDate}/${compact(e.ts)}_${e.kind}.m4a`;
}

/** snake_case insert row for public.sound_minutes. */
export function soundMinuteRow(m: SoundMinute, camera = SOUND_CAMERA_DEFAULT, nightDate = soundNightDate(m.ts)): Record<string, unknown> {
  return {
    camera,
    ts: new Date(m.ts).toISOString(),
    night_date: nightDate,
    db_avg: m.dbAvg,
    db_max: m.dbMax,
    db_floor: m.dbFloor,
    snore_s: m.snoreS,
    snore_prob: m.snoreProb,
    speech_s: m.speechS,
    cough_s: m.coughS,
    classes: m.classes,
    n: m.n,
  };
}

/** snake_case insert row for public.sound_events (clip_path is reserved later, by the function). */
export function soundEventRow(e: SoundEvent, camera = SOUND_CAMERA_DEFAULT, nightDate = soundNightDate(e.ts)): Record<string, unknown> {
  return {
    camera,
    ts: new Date(e.ts).toISOString(),
    night_date: nightDate,
    duration_s: e.durationS,
    kind: e.kind,
    label: e.label,
    peak_db: e.peakDb,
    score: e.score,
    // Only when present, so a row without one stays insertable before migration 0029.
    ...(e.transcript ? { transcript: e.transcript, transcript_lang: e.transcriptLang ?? null } : {}),
  };
}

/** A public.sound_minutes row (as the app reads it) → SoundMinute. */
export function soundMinuteFromRow(r: {
  ts: string;
  db_avg?: number | null;
  db_max?: number | null;
  db_floor?: number | null;
  snore_s?: number | null;
  snore_prob?: number | null;
  speech_s?: number | null;
  cough_s?: number | null;
  classes?: Record<string, number> | null;
  n?: number | null;
}): SoundMinute {
  return {
    ts: Date.parse(r.ts),
    dbAvg: r.db_avg ?? null,
    dbMax: r.db_max ?? null,
    dbFloor: r.db_floor ?? null,
    snoreS: r.snore_s ?? 0,
    snoreProb: r.snore_prob ?? null,
    speechS: r.speech_s ?? 0,
    coughS: r.cough_s ?? 0,
    classes: r.classes ?? {},
    n: r.n ?? 0,
  };
}

/** A public.sound_events row → SoundEvent (wantClip false; clipPath / id / hidden carried along). */
export function soundEventFromRow(r: {
  id?: number;
  ts: string;
  duration_s?: number | null;
  kind: string;
  label?: string | null;
  peak_db?: number | null;
  score?: number | null;
  clip_path?: string | null;
  hidden?: boolean | null;
  transcript?: string | null;
  transcript_lang?: string | null;
}): SoundEvent & { id?: number; clipPath: string | null; hidden: boolean } {
  return {
    ...(r.id !== undefined ? { id: r.id } : {}),
    ts: Date.parse(r.ts),
    durationS: r.duration_s ?? null,
    kind: ((SOUND_KINDS as readonly string[]).includes(r.kind) ? r.kind : 'other') as SoundKind,
    label: r.label ?? null,
    peakDb: r.peak_db ?? null,
    score: r.score ?? null,
    wantClip: false,
    transcript: r.transcript ?? null,
    transcriptLang: r.transcript_lang ?? null,
    clipPath: r.clip_path ?? null,
    hidden: r.hidden === true,
  };
}
