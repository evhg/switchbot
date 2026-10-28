import type {
  Ms,
  Night,
  NightReport,
  Person,
  PersonNightMetrics,
  PersonScoreParts,
  RoomEvent,
  RoomNightMetrics,
  RoomReading,
  RoomScoreParts,
} from '@sleep-lab/core';

export type SourceKind = 'sim' | 'supabase';

/** Everything the multi-night views need, computed once per load (in a worker when available). */
export interface Dataset {
  source: SourceKind;
  people: Person[];
  /** Oldest → newest. */
  nights: Night[];
  /** Aligned with `nights`. */
  room: RoomNightMetrics[];
  /** Per person, aligned with `nights`; null when that person has no data that night. Recovery is neutral here (no history). */
  person: Record<string, (PersonNightMetrics | null)[]>;
  generatedAt: Ms;
  computeMs: number;
  /** Served from the browser's IndexedDB cache (computeMs is from the original run). */
  cached?: boolean;
  /** Data newer than this is hidden (simulated "future"). */
  clipTs: Ms;
}

/** Heavier per-night analysis, computed on demand for the night being viewed. */
export interface NightDetail {
  date: string;
  events: RoomEvent[];
  report: NightReport;
  roomParts: RoomScoreParts;
  personParts: Record<string, PersonScoreParts>;
  /** With history, so recovery scores are real. */
  people: PersonNightMetrics[];
}

export interface DataSource {
  kind: SourceKind;
  label: string;
  loadDataset(onProgress?: (msg: string) => void): Promise<Dataset>;
  loadNightDetail(date: string): Promise<NightDetail>;
  /** Latest room reading at `now`, or null when unavailable. */
  liveReading(now: Ms): Promise<RoomReading | null>;
  /** Room readings in [from, to], ascending, ≈1-min resolution. */
  liveWindow(from: Ms, to: Ms): Promise<RoomReading[]>;
}

// ---------- worker protocol ----------
export interface SimParams {
  seed: number;
  nights: number;
  endDate: string;
  clipTs: Ms;
}

export type EngineRequest =
  | { type: 'simulate'; params: SimParams }
  | { type: 'compute'; nights: Night[]; source: SourceKind; clipTs: Ms }
  | { type: 'detail'; date: string };

export type EngineResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
