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
  TemperatureCurve,
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
  /** Curves stored in the backend (Supabase source); a night's curveId resolves against these, then the built-ins. */
  curves?: TemperatureCurve[];
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

/**
 * A stretch of the night without trustworthy room data:
 *   'before-meter' the meter wasn't connected yet (before the first reading ever stored)
 *   'missing'      no readings (hub unplugged, Wi-Fi or cloud outage)
 *   'frozen'       the cloud kept repeating the same temperature and humidity (stale values, left out)
 */
export interface NightGap {
  start: Ms;
  end: Ms;
  kind: 'before-meter' | 'missing' | 'frozen';
  /** Frozen only: the repeated value, e.g. "25.1°, 64%". */
  value?: string;
}

export interface NightQuality {
  /** Gaps inside the night's window (lights-out − 2 h → wake + 1 h, clipped to now), oldest first. */
  gaps: NightGap[];
  /** Share of lights-out → wake with trustworthy readings, 0..1. */
  coverage: number;
  /** Readings left out because they repeated stale cloud values. */
  frozenDropped: number;
  /** CO₂ readings below 300 ppm (the meter's warm-up artifact), shown as no CO₂. */
  co2Glitches: number;
  /** Core's flags (cleanRoomReadings): frozen_temp_rh, frozen_all, gap_overnight, low_coverage, … */
  flags: string[];
}

/** Real-data facts about one night that the core Night type doesn't carry (Supabase source only). */
export interface RealNightInfo {
  date: string;
  quality: NightQuality;
  /**
   * Who ran the aircon: 'live' (commands sent by the controller), 'dry-run' (logged only), 'manual' (no controller
   * commands that night: run by hand or not at all).
   */
  control: 'live' | 'dry-run' | 'manual';
  /** Commands the controller logged for this night (after dropping failed sends). */
  acCount: number;
  precool: { status: string | null; reason: string | null; at: Ms | null };
  /** Expected sleep onset stored on the nights row (null = lights-out + 60 min). */
  sleepOnset: Ms | null;
  /** The morning report (reports table), when the backend has written one. */
  report: { headline: string; insights: string[]; generatedBy: string; createdAt: Ms | null; final: boolean } | null;
  /** Rows from the events table (the backend's detectors), when present. Empty = detected in the browser. */
  storedEvents: number;
}

export interface DataSource {
  kind: SourceKind;
  label: string;
  /** Real-data facts for a night (gaps, who ran the aircon, the morning report). Undefined for the simulator. */
  nightInfo?(date: string): Promise<RealNightInfo | null>;
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
  | { type: 'compute'; nights: Night[]; source: SourceKind; clipTs: Ms; curves?: TemperatureCurve[] }
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
