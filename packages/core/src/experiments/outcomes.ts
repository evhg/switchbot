// Per-night outcomes of an experiment night, from data the backend already stores (pure).
import type { Ms, RoomReading, StageSegment } from '../types.ts';
import { SNORE_MIN_S } from '../sound/payload.ts';
import { plausibleCo2 } from '../switchbot/parse.ts';
import type { NightOutcomes, PersonOutcomes } from './types.ts';

const MIN = 60_000;
/** An awake run counts as an awakening from this length on (2 min). */
export const AWAKENING_MIN = 2;
/** Fewer room readings than this between lights-out and wake = no room outcome (≈ 30 min of 1-min data). */
export const MIN_ROOM_READINGS = 30;
/** A reading stands for at most this long when the next one is late (gaps are not counted as minutes over 1000). */
const MAX_READING_SPAN_MS = 5 * MIN;

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Person outcomes from the main sleep's stages; null without a single sleep stage. */
export function personOutcomes(stages: readonly StageSegment[], lightsOut: Ms): PersonOutcomes | null {
  const segs = [...stages].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const sleep = segs.filter((s) => s.stage !== 'awake');
  if (!sleep.length) return null;
  const first = sleep[0]!.start;
  const last = Math.max(...sleep.map((s) => s.end));
  const mins = { deep: 0, rem: 0, light: 0, awake: 0 };
  let awakenings = 0;
  let runStart: Ms | null = null;
  let runEnd: Ms = 0;
  const closeRun = () => {
    if (runStart !== null && runEnd - runStart >= AWAKENING_MIN * MIN) awakenings++;
    runStart = null;
  };
  for (const s of segs) {
    const a = Math.max(s.start, first);
    const b = Math.min(s.end, last);
    if (b <= a) continue;
    mins[s.stage] += (b - a) / MIN;
    if (s.stage === 'awake') {
      // Back-to-back awake segments (≤ 1 min apart) are one run.
      if (runStart !== null && a - runEnd <= MIN) runEnd = Math.max(runEnd, b);
      else {
        closeRun();
        runStart = a;
        runEnd = b;
      }
    } else closeRun();
  }
  closeRun();
  return {
    onsetMin: r1(Math.max(0, (first - lightsOut) / MIN)),
    deepMin: r1(mins.deep),
    remMin: r1(mins.rem),
    lightMin: r1(mins.light),
    awakeMin: r1(mins.awake),
    awakenings,
  };
}

export interface NightOutcomesInput {
  lightsOut: Ms;
  wake: Ms;
  /** Main sleep stages per person id (null / [] = no data). */
  sleep: Record<string, readonly StageSegment[] | null | undefined>;
  room: readonly Pick<RoomReading, 'ts' | 'co2' | 'tempC'>[];
  /** sound_minutes of the night (any order); null / [] = the listener heard nothing. */
  sound?: readonly { ts: Ms; snoreS: number }[] | null;
}

/**
 * The outcomes of one night: per person (sleep onset latency from lights-out, deep / REM / light minutes, awake
 * minutes after onset, awakenings = awake runs ≥ 2 min after onset), and the room between lights-out and wake
 * (CO₂ mean and minutes > 1000 ppm, mean temperature, snoring minutes with snore_s ≥ 10).
 */
export function nightOutcomes(i: NightOutcomesInput): NightOutcomes {
  const missing: string[] = [];
  const people: Record<string, PersonOutcomes> = {};
  for (const [id, stages] of Object.entries(i.sleep)) {
    const p = stages && stages.length ? personOutcomes(stages, i.lightsOut) : null;
    if (p) people[id] = p;
    else missing.push(`sleep:${id}`);
  }

  const room = i.room.filter((r) => r.ts >= i.lightsOut && r.ts <= i.wake).sort((a, b) => a.ts - b.ts);
  const co2 = room.filter((r) => plausibleCo2(r.co2));
  let co2Mean: number | null = null;
  let co2Over1000Min: number | null = null;
  if (co2.length >= MIN_ROOM_READINGS) {
    co2Mean = Math.round(co2.reduce((s, r) => s + r.co2, 0) / co2.length);
    let over = 0;
    for (let k = 0; k < co2.length; k++) {
      const next = co2[k + 1];
      const span = next ? Math.min(next.ts - co2[k]!.ts, MAX_READING_SPAN_MS) : MIN;
      if (co2[k]!.co2 > 1000) over += span;
    }
    co2Over1000Min = Math.round(over / MIN);
  }
  const temps = room.filter((r) => Number.isFinite(r.tempC));
  const tempMean = temps.length >= MIN_ROOM_READINGS ? Math.round((temps.reduce((s, r) => s + r.tempC, 0) / temps.length) * 100) / 100 : null;
  if (co2Mean === null && tempMean === null) missing.push('room');

  const sound = (i.sound ?? []).filter((m) => m.ts >= i.lightsOut && m.ts <= i.wake);
  const snoreMin = sound.length ? sound.filter((m) => m.snoreS >= SNORE_MIN_S).length : null;
  if (snoreMin === null) missing.push('sound');

  return { people, co2Mean, co2Over1000Min, tempMean, snoreMin, missing };
}
