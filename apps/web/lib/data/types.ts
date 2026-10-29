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
  /** Progressive first paint: only the newest night is in this dataset (history still computing). */
  partial?: boolean;
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
  /** `onPartial` (optional) receives a newest-night-only dataset (partial: true) before the full one resolves. */
  loadDataset(onProgress?: (msg: string) => void, onPartial?: (ds: Dataset) => void): Promise<Dataset>;
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

export type EngineResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  /** Streamed before the final result: a partial result and/or a progress line. */
  | { id: number; stream: true; partial?: unknown; progress?: string };

/** One slice of a dataset sent over the worker's bulk port (oldest → newest within the slice). */
export interface DatasetChunk {
  nights: Night[];
  room: RoomNightMetrics[];
  person: Record<string, (PersonNightMetrics | null)[]>;
}

/** Messages on the worker's bulk port: chunks (prepended, newest-first order of arrival), then a commit. */
export type BulkMessage =
  | { id: number; chunk: DatasetChunk }
  | { id: number; commit: { meta: Omit<Dataset, 'nights' | 'room' | 'person'>; total: number; final: boolean }; progress?: string }
  | { id: number; progress?: string };

export type WorkerInbound = { id: number; req: EngineRequest } | { bulkPort: MessagePort };

/** Callback the engine uses to stream partial results / progress for the current request. */
export type EngineEmit = (msg: { partial?: unknown; progress?: string }) => void;
