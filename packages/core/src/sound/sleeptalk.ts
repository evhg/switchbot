// Sleep talk (migration 0029): was someone asleep when the Mac heard talking?
//
// While "Save sleep talk" is on (household_settings.sound_sleeptalk), speech events get a clip and the Mac's local
// transcript. The next morning (nightly-report, after the sleep sync) each speech event is judged against both
// people's sleep stages:
//   at least one person in a non-awake stage at the moment → sleep talk (kept); talkerHint = that person when exactly
//   one was asleep and the other's data is known;
//   both awake or outside their sleep sessions → a conversation: the clip and transcript are removed.
// The judge waits until every person's sleep for the night has synced; from SLEEPTALK_FINAL_HHMM (13:00 ICT) on it
// judges with whatever exists, and a person with no sleep data then counts as awake (privacy first: an event that
// cannot be shown to be sleep talk is treated as a conversation).
import type { Ms, SleepStage } from '../types.ts';

const MIN = 60_000;
const ICT = 7 * 60 * MIN;

/** From this time (ICT) on the night's date, judge with whatever sleep data exists. */
export const SLEEPTALK_FINAL_HHMM = '13:00';
/** A non-awake stage this close to the moment (either side) counts: Fitbit epochs are 30 s and sleep talk often comes with a brief arousal. */
export const SLEEPTALK_TOLERANCE_MS = 60_000;
/** Snippet length in the morning push. */
export const SLEEPTALK_SNIPPET_MAX = 80;

export interface SleepSessionLite {
  start: Ms;
  end: Ms;
  stages: readonly { start: Ms; end: Ms; stage: SleepStage }[];
}

export interface SleepTalkPerson {
  id: string;
  /** This person's sleep sessions for the night; null = not synced yet (no data). */
  sessions: readonly SleepSessionLite[] | null;
}

export type PersonState = 'asleep' | 'awake' | 'unknown';

export type SleepTalkVerdict =
  | { status: 'pending'; reason: string }
  | { status: 'sleep_talk'; talkerHint: string | null; asleep: string[]; reason: string }
  | { status: 'conversation'; reason: string };

/**
 * One person's state around `ts` (± tolerance, over the event's duration): 'asleep' when a non-awake stage overlaps
 * it, or it falls inside a session with no stage data there; 'awake' when outside every session or only 'awake'
 * stages cover it; 'unknown' when there is no data (sessions null).
 */
export function personStateAt(sessions: readonly SleepSessionLite[] | null, ts: Ms, durationS: number | null = null, toleranceMs = SLEEPTALK_TOLERANCE_MS): PersonState {
  if (sessions === null) return 'unknown';
  const from = ts - toleranceMs;
  const to = ts + Math.max(0, durationS ?? 0) * 1000 + toleranceMs;
  for (const s of sessions) {
    if (s.end <= from || s.start >= to) continue;
    const overlapping = s.stages.filter((g) => g.end > from && g.start < to);
    if (overlapping.some((g) => g.stage !== 'awake')) return 'asleep';
    // Inside a session at the moment itself, with no stage there: the session says asleep.
    if (!overlapping.length && ts >= s.start && ts < s.end) return 'asleep';
  }
  return 'awake';
}

/**
 * The pure verdict for one speech event. `final` = past SLEEPTALK_FINAL_HHMM on the night's date: unknown people then
 * count as awake. Before that, any person without data keeps the event pending.
 */
export function judgeSleepTalk(i: { ts: Ms; durationS?: number | null; people: readonly SleepTalkPerson[]; final: boolean }): SleepTalkVerdict {
  const states = i.people.map((p) => ({ id: p.id, state: personStateAt(p.sessions, i.ts, i.durationS ?? null) }));
  const missing = states.filter((s) => s.state === 'unknown').map((s) => s.id);
  if (missing.length && !i.final) return { status: 'pending', reason: `waiting for sleep data (${missing.join(', ')})` };
  const asleep = states.filter((s) => s.state === 'asleep').map((s) => s.id);
  if (asleep.length) {
    const hint = asleep.length === 1 && !missing.length ? asleep[0]! : null;
    return {
      status: 'sleep_talk',
      talkerHint: hint,
      asleep,
      reason: asleep.length > 1 ? 'both asleep' : missing.length ? `${asleep[0]} asleep, no data for ${missing.join(', ')}` : `only ${asleep[0]} asleep`,
    };
  }
  return { status: 'conversation', reason: missing.length ? `nobody asleep (no data for ${missing.join(', ')})` : 'both awake' };
}

/** Is it past the judge's final time for this night (date = the wake date, YYYY-MM-DD)? */
export function sleepTalkFinal(nightDate: string, now: Ms): boolean {
  const [h, m] = SLEEPTALK_FINAL_HHMM.split(':').map(Number) as [number, number];
  return now >= Date.parse(`${nightDate}T00:00:00Z`) - ICT + (h * 60 + m) * MIN;
}

export interface SleepTalkItem {
  ts: Ms;
  talkerHint: string | null;
  transcript: string | null;
}

const hhmm = (ms: Ms) => new Date(ms + ICT).toISOString().slice(11, 16);

/** "“I told you the cat…”": the first SLEEPTALK_SNIPPET_MAX characters, cut at a word when possible, quoted. */
export function transcriptSnippet(t: string, max = SLEEPTALK_SNIPPET_MAX): string {
  const s = t.replace(/\s+/g, ' ').trim();
  const chars = [...s];
  if (chars.length <= max) return `“${s}”`;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `“${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…”`;
}

/**
 * The morning push line: `Sleep talk: 2 clips (01:12 Cath?, 03:40) — tap to listen. “first snippet”`. Times in ICT,
 * oldest first, at most 4 listed (then "…"); a name with "?" when talkerHint names one person. Null when there is none.
 */
export function sleepTalkLine(items: readonly SleepTalkItem[], names: Readonly<Record<string, string>>): string | null {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a.ts - b.ts);
  const times = sorted.slice(0, 4).map((it) => {
    const who = it.talkerHint ? names[it.talkerHint] : undefined;
    return who ? `${hhmm(it.ts)} ${who}?` : hhmm(it.ts);
  });
  const list = `${times.join(', ')}${sorted.length > 4 ? ', …' : ''}`;
  const n = sorted.length;
  const first = sorted.find((it) => it.transcript)?.transcript;
  return `Sleep talk: ${n} clip${n === 1 ? '' : 's'} (${list}) — tap to listen.${first ? ` ${transcriptSnippet(first)}` : ''}`;
}
