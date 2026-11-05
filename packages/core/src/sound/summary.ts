// Night sounds: the night's summary and "does the snoring wake Cath?" (her Fitbit awakenings against the Mac's minutes
// and events). Pure: pass the rows (soundMinuteFromRow / soundEventFromRow) and the awakening times.
import type { Ms, StageSegment } from '../types.ts';
import { eventMinutes } from './labels.ts';
import { LOUD_ABOVE_FLOOR_DB, SNORE_MIN_S, type SoundEvent, type SoundMinute } from './payload.ts';

const MIN = 60_000;

export interface NightSoundSummary {
  /** Minutes with a summary (= minutes the Mac listened). */
  listenedMin: number;
  /** Minutes with snoreS ≥ 10, with the household's labels applied (labelledSnore). */
  snoreMin: number;
  /** Of snoreMin: minutes counted only because an event in them was labelled snoring. */
  labelAddedMin: number;
  /** Minutes the detector called snoring that a "Not snoring" label took out. */
  labelRemovedMin: number;
  /** snoreMin / listenedMin, percent 0..100 (rounded), 0 without data. */
  snorePct: number;
  /** Events of kind 'loud'. */
  loudEvents: number;
  /** Longest run of consecutive snoring minutes. */
  longestSnoreRunMin: number;
  /** Highest minute dbMax (or event peakDb), dBFS; null without data. */
  loudestDb: number | null;
  /** The night's quiet floor: median of the minutes' dbFloor, dBFS; null without data. */
  floorDb: number | null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const isSnoreMinute = (m: SoundMinute) => m.snoreS >= SNORE_MIN_S;

/**
 * The household's labels per minute (a human label wins over the detector): minute start → true (an event covering it
 * was labelled 'snore') or false (only 'not_snore' labels cover it). An event covers [ts, ts + durationS] (its own
 * minute at least, 60 minutes at most). 'speech' / 'other' labels and unlabelled events leave the detector alone.
 */
export function labelledSnore(events: readonly Pick<SoundEvent, 'ts' | 'durationS' | 'humanLabel'>[]): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const e of events) {
    if (e.humanLabel !== 'snore' && e.humanLabel !== 'not_snore') continue;
    for (const t of eventMinutes(e)) {
      if (e.humanLabel === 'snore') out.set(t, true);
      else if (!out.has(t)) out.set(t, false);
    }
  }
  return out;
}

/** Snoring per minute after the labels: the detector (snoreS ≥ 10) unless a label covers the minute. */
const snoreAt = (labels: Map<number, boolean>, ts: number, m: SoundMinute | undefined) => labels.get(ts) ?? (!!m && isSnoreMinute(m));

export function nightSoundSummary(minutes: readonly SoundMinute[], events: readonly SoundEvent[]): NightSoundSummary {
  const byTs = new Map<number, SoundMinute>();
  for (const m of minutes) if (!byTs.has(Math.floor(m.ts / MIN) * MIN)) byTs.set(Math.floor(m.ts / MIN) * MIN, m);
  const labels = labelledSnore(events);
  // A labelled-snoring minute counts even without a summary row (the Mac heard it: there is an event).
  const keys = new Set<number>(byTs.keys());
  for (const [t, v] of labels) if (v) keys.add(t);
  const sorted = [...keys].sort((a, b) => a - b).map((ts) => [ts, byTs.get(ts)] as const);
  let snoreMin = 0;
  let labelAddedMin = 0;
  let labelRemovedMin = 0;
  let run = 0;
  let longest = 0;
  let prevTs = -Infinity;
  for (const [ts, m] of sorted) {
    const detector = !!m && isSnoreMinute(m);
    const snoring = snoreAt(labels, ts, m);
    if (snoring && !detector) labelAddedMin++;
    if (!snoring && detector) labelRemovedMin++;
    if (snoring) {
      snoreMin++;
      run = ts - prevTs === MIN && run > 0 ? run + 1 : 1;
      longest = Math.max(longest, run);
    } else run = 0;
    prevTs = ts;
  }
  const peaks = [
    ...sorted.map(([, m]) => m?.dbMax),
    ...events.map((e) => e.peakDb),
  ].filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const floors = sorted.map(([, m]) => m?.dbFloor).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const floor = median(floors);
  const listenedMin = sorted.length;
  return {
    listenedMin,
    snoreMin,
    labelAddedMin,
    labelRemovedMin,
    snorePct: listenedMin ? Math.round((snoreMin / listenedMin) * 100) : 0,
    loudEvents: events.filter((e) => e.kind === 'loud').length,
    longestSnoreRunMin: longest,
    loudestDb: peaks.length ? Math.max(...peaks) : null,
    floorDb: floor === null ? null : Math.round(floor * 10) / 10,
  };
}

/**
 * Starts of the awake runs after sleep onset, from one person's stages: the start of every 'awake' segment that
 * follows a sleep segment (light / deep / rem). Lying awake before falling asleep is not an awakening; touching
 * awake segments count once.
 */
export function awakeningStarts(stages: readonly StageSegment[]): Ms[] {
  const s = [...stages].sort((a, b) => a.start - b.start);
  const out: Ms[] = [];
  let asleep = false;
  let prev: StageSegment | null = null;
  for (const seg of s) {
    if (seg.stage === 'awake') {
      if (asleep && !(prev?.stage === 'awake' && prev.end >= seg.start)) out.push(seg.start);
    } else asleep = true;
    prev = seg;
  }
  return out;
}

export interface WakeTriggerRow {
  wakeAt: Ms;
  /** The Mac listened around it (a minute summary inside the lookback). Without it the other fields are false. */
  heard: boolean;
  /** Snoring: a minute with snoreS ≥ 10 overlapping [wakeAt − lookback, wakeAt], or a snore event in it. */
  snore: boolean;
  /** A loud moment: an event with peakDb ≥ floor + 15 dB in [wakeAt − lookback, wakeAt + slack]. */
  loud: boolean;
  /** snore || loud. */
  triggered: boolean;
  /** The loudest qualifying event, if any. */
  event: { ts: Ms; kind: SoundEvent['kind']; label: string | null; peakDb: number | null } | null;
}

export interface WakeTriggers {
  rows: WakeTriggerRow[];
  /** Awakenings in the input. */
  wakeUps: number;
  /** … the Mac listened around. */
  heard: number;
  withSnore: number;
  withLoud: number;
  /** withSnore or withLoud. */
  triggered: number;
}

/**
 * For each of Cath's awakenings (awakeningStarts of her stages): did snoring or a loud noise come just before it?
 * lookbackMs (default 2 min) before the awakening; slackMs (default 30 s, one Fitbit epoch) after it for events, as
 * the awake epoch may start slightly before the sound that caused it. The loud threshold is the minute's dbFloor
 * (the minute containing the event), else the night's floor (median dbFloor), + 15 dB.
 */
export function wakeTriggers(
  cathWakeStarts: readonly Ms[],
  minutes: readonly SoundMinute[],
  events: readonly SoundEvent[],
  opts: { lookbackMs?: number; slackMs?: number } = {},
): WakeTriggers {
  const lookback = opts.lookbackMs ?? 2 * MIN;
  const slack = opts.slackMs ?? 30_000;
  const byMinute = new Map<number, SoundMinute>();
  for (const m of minutes) byMinute.set(Math.floor(m.ts / MIN) * MIN, m);
  const nightFloor = nightSoundSummary(minutes, []).floorDb;
  const labels = labelledSnore(events);
  const floorAt = (ts: Ms) => byMinute.get(Math.floor(ts / MIN) * MIN)?.dbFloor ?? nightFloor;
  const isLoud = (e: SoundEvent) => {
    if (e.peakDb === null) return e.kind === 'loud';
    const f = floorAt(e.ts);
    return f === null ? e.kind === 'loud' : e.peakDb >= f + LOUD_ABOVE_FLOOR_DB;
  };

  const rows = [...cathWakeStarts].sort((a, b) => a - b).map((wakeAt): WakeTriggerRow => {
    const from = wakeAt - lookback;
    // Minutes overlapping [from, wakeAt]: ts ≤ wakeAt and ts + 60 s > from.
    const near = minutes.filter((m) => m.ts <= wakeAt && m.ts + MIN > from);
    const heard = near.length > 0;
    if (!heard) return { wakeAt, heard, snore: false, loud: false, triggered: false, event: null };
    const evs = events.filter((e) => e.ts >= from && e.ts <= wakeAt + slack);
    // Labels win: a minute labelled snoring counts, one labelled "Not snoring" doesn't; likewise the events.
    const nearTs = new Set(near.map((m) => Math.floor(m.ts / MIN) * MIN));
    for (const [t, v] of labels) if (v && t <= wakeAt && t + MIN > from) nearTs.add(t);
    const snoreEv = (e: SoundEvent) => (e.humanLabel === 'snore' ? true : e.humanLabel === 'not_snore' ? false : e.kind === 'snore');
    const snore = [...nearTs].some((t) => snoreAt(labels, t, byMinute.get(t))) || evs.some((e) => snoreEv(e) && e.ts <= wakeAt);
    const loudEvs = evs.filter(isLoud);
    const top = [...loudEvs, ...evs.filter(snoreEv)]
      .sort((a, b) => (b.peakDb ?? -Infinity) - (a.peakDb ?? -Infinity))[0];
    const loud = loudEvs.length > 0;
    return {
      wakeAt,
      heard,
      snore,
      loud,
      triggered: snore || loud,
      event: top ? { ts: top.ts, kind: top.kind, label: top.label, peakDb: top.peakDb } : null,
    };
  });
  return {
    rows,
    wakeUps: rows.length,
    heard: rows.filter((r) => r.heard).length,
    withSnore: rows.filter((r) => r.snore).length,
    withLoud: rows.filter((r) => r.loud).length,
    triggered: rows.filter((r) => r.triggered).length,
  };
}
