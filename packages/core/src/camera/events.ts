// Camera sightings from the Mac relay (camera-event Edge Function → public.camera_events, migration 0022): request
// validation and normalisation, the label → person mapping, and the "unknown person while nobody is home" alert rule.
//
// Erik's Mac runs face recognition locally, for enrolled and consenting people only, and posts LABELS: a household
// person id ('a', 'b'), a named guest label (only someone who agreed to be enrolled), 'unknown' (a face that matched
// nobody) or 'person' (a body, no face). No image, face embedding or other biometric data is ever accepted here.
import type { Ms } from '../types.ts';

const MIN = 60_000;
const DAY = 86_400_000;

/** At most this many events per request. */
export const CAMERA_MAX_EVENTS = 100;
/** An event's ts must be within this of the server clock (either side). */
export const CAMERA_MAX_SKEW_MS = DAY;
export const CAMERA_LABEL_MAX = 40;
export const CAMERA_DEFAULT = 'living';
/** At most one "unknown person" push per this many minutes (public.claim_camera_alert uses the same window). */
export const UNKNOWN_ALERT_WINDOW_MIN = 30;
/** Only an 'unknown' sighting this recent can raise the push (a backlog the Mac uploads later never does). */
export const UNKNOWN_ALERT_MAX_AGE_MIN = 30;

/** Labels with a fixed meaning; anything else is a named guest label. */
export const UNKNOWN_LABEL = 'unknown';
export const PERSON_LABEL = 'person';

/** One validated event, ready to insert into public.camera_events. */
export interface CameraEvent {
  ts: Ms;
  camera: string;
  label: string;
  /** Set when the label is a household person id. */
  personId: string | null;
  confidence: number | null;
  activity: string | null;
  durationS: number | null;
}

export interface CameraEventReject {
  index: number;
  reason: string;
}

export type CameraRequest =
  | { kind: 'ping' }
  | { kind: 'events'; events: CameraEvent[]; rejected: CameraEventReject[] }
  | { kind: 'error'; error: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;

// Letters (any script), digits, space, dot, underscore, apostrophe, hyphen. No control characters or markup.
const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;
// Zone / camera names from the Mac: lower-case slugs.
const SLUG_RE = /^[a-z0-9][a-z0-9 _-]*$/;

/** ISO 8601 with an offset or Z, or epoch milliseconds. Anything else (a date without a zone included) → null. */
export function parseCameraTs(v: unknown): Ms | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * A label as stored: trimmed, inner whitespace collapsed; 'unknown', 'person' and household person ids lower-cased.
 * Null when empty, longer than CAMERA_LABEL_MAX or containing anything but letters, digits and ` ._'-`.
 */
export function normalizeCameraLabel(v: unknown, personIds: readonly string[] = ['a', 'b']): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s || s.length > CAMERA_LABEL_MAX || !LABEL_RE.test(s)) return null;
  const lower = s.toLowerCase();
  if (lower === UNKNOWN_LABEL || lower === PERSON_LABEL || personIds.includes(lower)) return lower;
  return s;
}

/** Camera / zone name: lower-case slug, ≤ 40 chars. Null when absent or not a slug. */
export function normalizeCameraSlug(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/\s+/g, ' ');
  return s && s.length <= CAMERA_LABEL_MAX && SLUG_RE.test(s) ? s : null;
}

/** One event of the request body, or the reason it was refused. */
export function parseCameraEvent(
  raw: unknown,
  o: { now: Ms; camera: string; personIds?: readonly string[] },
): CameraEvent | string {
  if (!isObj(raw)) return 'not an object';
  const personIds = o.personIds ?? ['a', 'b'];
  const ts = parseCameraTs(raw.ts);
  if (ts === null) return 'ts must be ISO 8601 with a zone (or epoch ms)';
  if (Math.abs(ts - o.now) > CAMERA_MAX_SKEW_MS) return 'ts more than 1 day from now';
  const label = normalizeCameraLabel(raw.label, personIds);
  if (label === null) return `label must be 1–${CAMERA_LABEL_MAX} letters, digits or " ._'-"`;
  let confidence: number | null = null;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    confidence = num(raw.confidence);
    if (confidence === null || confidence < 0 || confidence > 1) return 'confidence must be 0..1';
    confidence = Math.round(confidence * 1000) / 1000;
  }
  let activity: string | null = null;
  if (raw.activity !== undefined && raw.activity !== null && raw.activity !== '') {
    activity = normalizeCameraSlug(raw.activity);
    if (activity === null) return `activity must be a lower-case zone name (≤ ${CAMERA_LABEL_MAX} chars)`;
  }
  let durationS: number | null = null;
  const d = raw.durationS ?? raw.duration_s;
  if (d !== undefined && d !== null) {
    const x = num(d);
    if (x === null || x < 0 || x > DAY / 1000) return 'durationS must be 0..86400 seconds';
    durationS = Math.round(x);
  }
  return { ts, camera: o.camera, label, personId: personIds.includes(label) ? label : null, confidence, activity, durationS };
}

/**
 * The camera-event request body: {ping: true} → ping; {events: [...], camera?} → the valid events (oldest first) and
 * the refused ones with a reason. Errors that refuse the whole request: no events array, more than CAMERA_MAX_EVENTS,
 * a bad camera name.
 */
export function parseCameraRequest(body: unknown, now: Ms, personIds: readonly string[] = ['a', 'b']): CameraRequest {
  if (!isObj(body)) return { kind: 'error', error: 'body must be a JSON object' };
  if (body.ping === true && body.events === undefined) return { kind: 'ping' };
  let camera = CAMERA_DEFAULT;
  if (body.camera !== undefined && body.camera !== null) {
    const c = normalizeCameraSlug(body.camera);
    if (c === null) return { kind: 'error', error: `camera must be a lower-case name (≤ ${CAMERA_LABEL_MAX} chars)` };
    camera = c;
  }
  if (!Array.isArray(body.events)) return { kind: 'error', error: 'events must be an array' };
  if (body.events.length > CAMERA_MAX_EVENTS) return { kind: 'error', error: `at most ${CAMERA_MAX_EVENTS} events per request` };
  const events: CameraEvent[] = [];
  const rejected: CameraEventReject[] = [];
  body.events.forEach((raw, index) => {
    const e = parseCameraEvent(raw, { now, camera, personIds });
    if (typeof e === 'string') rejected.push({ index, reason: e });
    else events.push(e);
  });
  events.sort((a, b) => a.ts - b.ts);
  return { kind: 'events', events, rejected };
}

/** public.camera_events row (snake_case) for an event. */
export function cameraEventRow(e: CameraEvent, source = 'mac-relay'): Record<string, unknown> {
  return {
    ts: new Date(e.ts).toISOString(),
    camera: e.camera,
    label: e.label,
    person_id: e.personId,
    confidence: e.confidence,
    activity: e.activity,
    duration_s: e.durationS,
    source,
  };
}

/** Is the de-dup window over? `lastSentAt` null = never sent. Same rule as public.claim_camera_alert. */
export function alertDue(lastSentAt: Ms | null, now: Ms, windowMin = UNKNOWN_ALERT_WINDOW_MIN): boolean {
  return lastSentAt === null || now - lastSentAt >= windowMin * MIN;
}

/** The newest 'unknown' sighting recent enough to alert on (not in the future by more than a minute), or null. */
export function unknownToAlert<T extends { ts: Ms; label: string }>(events: readonly T[], now: Ms, maxAgeMin = UNKNOWN_ALERT_MAX_AGE_MIN): T | null {
  let best: T | null = null;
  for (const e of events) {
    if (e.label !== UNKNOWN_LABEL) continue;
    if (now - e.ts > maxAgeMin * MIN || e.ts - now > MIN) continue;
    if (!best || e.ts > best.ts) best = e;
  }
  return best;
}

/** "living" → "living room"; other camera names as they are. */
export function cameraPlace(camera: string): string {
  return camera === 'living' ? 'living room' : camera;
}

/** Push body: "Unknown person seen at home (living room, 14:05)", time in ICT (utcOffsetMin 420). */
export function unknownAlertText(e: { ts: Ms; camera: string }, utcOffsetMin = 420): string {
  const t = new Date(e.ts + utcOffsetMin * MIN).toISOString().slice(11, 16);
  return `Unknown person seen at home (${cameraPlace(e.camera)}, ${t})`;
}
