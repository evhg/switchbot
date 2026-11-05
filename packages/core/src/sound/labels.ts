// Sound labels (migration 0030): the household's "Snoring" / "Not snoring" verdicts on sound events, and what the Mac
// listener learns from them (night-sound GET "calibration"). Pure.
//
// The bedroom camera's microphone is very quiet and YAMNet often names real snoring "Whale vocalization", "Animal",
// "Music" or quiet "Speech". From the labelled events the Mac derives
//   - per YAMNet top class: the share of its labelled events that were snoring (snore precision); a class with at
//     least CALIBRATION_MIN_LABELS labels and precision ≥ CALIBRATION_MIN_PRECISION is "trusted": the rhythm rule may
//     count a second as snoring when that class is the frame's top class;
//   - a peak threshold above the quiet floor: the median of (peak − floor) over snore-labelled events, minus a 2 dB
//     margin, kept within 4..10 dB; 10 dB (night-sound-fix-2) with fewer than 3 such events.
import type { Ms } from '../types.ts';

export const SOUND_LABELS = ['snore', 'not_snore', 'speech', 'other'] as const;
export type SoundLabel = (typeof SOUND_LABELS)[number];
export const SOUND_LABEL_WHO = ['a', 'b', 'both', 'unknown'] as const;
export type SoundLabelWho = (typeof SOUND_LABEL_WHO)[number];

/** The Mac gets at most this many labelled events (newest labels first). */
export const CALIBRATION_MAX_LABELS = 200;
/** A YAMNet class needs this many labels … */
export const CALIBRATION_MIN_LABELS = 3;
/** … and this share of them snoring before the Mac trusts it as a snore class. */
export const CALIBRATION_MIN_PRECISION = 0.6;
/** The default peak threshold above the floor (night-sound-fix-2), used until there are enough snore labels. */
export const DEFAULT_PEAK_ABOVE_FLOOR_DB = 10;
/** The derived threshold stays within this range … */
export const MIN_PEAK_ABOVE_FLOOR_DB = 4;
export const MAX_PEAK_ABOVE_FLOOR_DB = 10;
/** … and sits this far below the median of the snore-labelled events. */
export const PEAK_MARGIN_DB = 2;
/** Borderline clips per night (household_settings.sound_uncertain_clips) by default, and its range. */
export const SOUND_UNCERTAIN_CLIPS_DEFAULT = 8;
export const SOUND_UNCERTAIN_CLIPS_MAX = 40;

export const isSoundLabel = (v: unknown): v is SoundLabel => typeof v === 'string' && (SOUND_LABELS as readonly string[]).includes(v);
export const isSoundLabelWho = (v: unknown): v is SoundLabelWho => typeof v === 'string' && (SOUND_LABEL_WHO as readonly string[]).includes(v);

/** One labelled event as the Mac receives it (night-sound GET calibration.labels[]). */
export interface CalibrationLabel {
  eventId: number;
  /** Event time, ISO. */
  ts: string;
  label: SoundLabel;
  who: SoundLabelWho | null;
  /** The event's kind as the Mac sent it. */
  kind: string;
  /** YAMNet class the Mac reported for the event (sound_events.label), or null. */
  yamnet: string | null;
  peakDb: number | null;
  /** The quiet floor (dbFloor) of the event's minute, or null when that minute has no summary. */
  floorDb: number | null;
  durationS: number | null;
  score: number | null;
  uncertain: boolean;
  labelledAt: string;
}

export interface YamnetCalibration {
  yamnet: string;
  /** Labelled events with this top class. */
  n: number;
  snore: number;
  notSnore: number;
  /** snore / n (0..1, 2 decimals). */
  precision: number;
  /** n ≥ CALIBRATION_MIN_LABELS and precision ≥ CALIBRATION_MIN_PRECISION. */
  trusted: boolean;
}

export interface CalibrationSummary {
  total: number;
  counts: Record<SoundLabel, number>;
  /** Per YAMNet class, most labels first. Events without a YAMNet label are left out. */
  byYamnet: YamnetCalibration[];
  /** The trusted classes (byYamnet[].trusted), for the Mac's snore rule. */
  snoreClasses: string[];
  /** Snore-labelled events with both peakDb and floorDb: how many, and the median of peak − floor (dB, 1 decimal). */
  peakAboveFloor: { n: number; median: number | null };
  /** The Mac's rhythm-rule peak threshold above the 10-minute floor, dB (see the header). */
  suggestedPeakAboveFloorDb: number;
  /** Newest labelledAt, or null without labels. */
  updatedAt: string | null;
}

const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The calibration the Mac derives its snore rule from (see the header). */
export function calibrationSummary(labels: readonly Pick<CalibrationLabel, 'label' | 'yamnet' | 'peakDb' | 'floorDb' | 'labelledAt'>[]): CalibrationSummary {
  const counts: Record<SoundLabel, number> = { snore: 0, not_snore: 0, speech: 0, other: 0 };
  const per = new Map<string, { n: number; snore: number; notSnore: number }>();
  const gaps: number[] = [];
  let updatedAt: string | null = null;
  for (const l of labels) {
    if (!isSoundLabel(l.label)) continue;
    counts[l.label]++;
    if (l.labelledAt && (!updatedAt || Date.parse(l.labelledAt) > Date.parse(updatedAt))) updatedAt = l.labelledAt;
    if (l.yamnet) {
      const p = per.get(l.yamnet) ?? { n: 0, snore: 0, notSnore: 0 };
      p.n++;
      if (l.label === 'snore') p.snore++;
      if (l.label === 'not_snore') p.notSnore++;
      per.set(l.yamnet, p);
    }
    if (l.label === 'snore' && fin(l.peakDb) && fin(l.floorDb)) gaps.push(l.peakDb - l.floorDb);
  }
  const byYamnet = [...per]
    .map(([yamnet, p]): YamnetCalibration => {
      const precision = Math.round((p.snore / p.n) * 100) / 100;
      return { yamnet, n: p.n, snore: p.snore, notSnore: p.notSnore, precision, trusted: p.n >= CALIBRATION_MIN_LABELS && precision >= CALIBRATION_MIN_PRECISION };
    })
    .sort((a, b) => b.n - a.n || a.yamnet.localeCompare(b.yamnet));
  const med = median(gaps);
  return {
    total: counts.snore + counts.not_snore + counts.speech + counts.other,
    counts,
    byYamnet,
    snoreClasses: byYamnet.filter((y) => y.trusted).map((y) => y.yamnet),
    peakAboveFloor: { n: gaps.length, median: med === null ? null : Math.round(med * 10) / 10 },
    suggestedPeakAboveFloorDb: suggestedPeakAboveFloor(gaps),
    updatedAt,
  };
}

/** median(gaps) − 2 dB, rounded to 0.5 dB, within 4..10; 10 with fewer than 3 gaps. */
export function suggestedPeakAboveFloor(gaps: readonly number[]): number {
  const m = gaps.length >= CALIBRATION_MIN_LABELS ? median(gaps) : null;
  if (m === null) return DEFAULT_PEAK_ABOVE_FLOOR_DB;
  const x = Math.round((m - PEAK_MARGIN_DB) * 2) / 2;
  return Math.min(MAX_PEAK_ABOVE_FLOOR_DB, Math.max(MIN_PEAK_ABOVE_FLOOR_DB, x));
}

/** "Labelled: 6 snore, 3 not" counts for the app. */
export function labelCounts(labels: Iterable<SoundLabel | null | undefined>): { snore: number; notSnore: number; total: number } {
  let snore = 0;
  let notSnore = 0;
  let total = 0;
  for (const l of labels) {
    if (!isSoundLabel(l)) continue;
    total++;
    if (l === 'snore') snore++;
    else if (l === 'not_snore') notSnore++;
  }
  return { snore, notSnore, total };
}

/**
 * A sound_labels row joined with its sound_events row (and the minute's floor) → CalibrationLabel; null when the label
 * or the event is unusable.
 */
export function calibrationLabelFromRow(
  r: { event_id: number | string; label: string; who?: string | null; labelled_at: string },
  e: { ts: string; kind: string; label?: string | null; peak_db?: number | null; duration_s?: number | null; score?: number | null; uncertain?: boolean | null } | null,
  floorDb: number | null = null,
): CalibrationLabel | null {
  if (!e || !isSoundLabel(r.label)) return null;
  const id = Number(r.event_id);
  if (!Number.isFinite(id)) return null;
  return {
    eventId: id,
    ts: new Date(Date.parse(e.ts)).toISOString(),
    label: r.label,
    who: isSoundLabelWho(r.who) ? r.who : null,
    kind: e.kind,
    yamnet: e.label ?? null,
    peakDb: fin(e.peak_db) ? e.peak_db : null,
    floorDb: fin(floorDb) ? floorDb : null,
    durationS: fin(e.duration_s) ? e.duration_s : null,
    score: fin(e.score) ? e.score : null,
    uncertain: e.uncertain === true,
    labelledAt: new Date(Date.parse(r.labelled_at)).toISOString(),
  };
}

/** Minute starts (epoch ms) an event covers: [ts, ts + duration], at least its own minute, at most 60 minutes. */
export function eventMinutes(e: { ts: Ms; durationS: number | null }): Ms[] {
  const MIN = 60_000;
  const first = Math.floor(e.ts / MIN) * MIN;
  const end = e.ts + Math.max(0, Math.min(3600, e.durationS ?? 0)) * 1000;
  const out: Ms[] = [];
  for (let t = first; (t === first || t < end) && out.length < 60; t += MIN) out.push(t);
  return out;
}
