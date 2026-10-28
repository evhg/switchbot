// App-side derived analyses that the core metrics module doesn't cover (all pure).
import { dewPointC, type Night, type RoomEvent, type SleepStage, type StageSegment } from '@sleep-lab/core';
import { MIN } from './format.ts';
import { mean, median } from './stats.ts';

/** ACH needed to hold two sleepers (0.0062 L/s total) under 1000 ppm in 120 m³ (mirrors core's report). */
export const ACH_FOR_1000 = (0.0062 * 3.6e6) / 120 / (1000 - 425);

/** Steady-state CO₂ for a given ACH with two sleepers in 120 m³. */
export const steadyCo2 = (ach: number) => 425 + (0.0062 * 3.6e6) / 120 / Math.max(0.01, ach);

export interface ShowerImpact {
  start: number;
  end: number;
  rhBefore: number;
  rhPeak: number;
  tempBefore: number;
  tempPeak: number;
  /** Mean temperature 20–40 min after the shower ended. */
  tempAfter: number;
  recoverMin: number | null;
  /** Minutes the room stayed > 0.3 °C above its pre-shower temperature (extra cooling load). */
  extraCoolMin: number;
  dewBefore: number;
  dewPeak: number;
}

export function showerImpact(night: Night, ev: Pick<RoomEvent, 'start' | 'end'>): ShowerImpact | null {
  const rs = night.room;
  const end = ev.end ?? ev.start + 12 * MIN;
  const before = rs.filter((r) => r.ts >= ev.start - 15 * MIN && r.ts < ev.start);
  const during = rs.filter((r) => r.ts >= ev.start && r.ts <= end + 20 * MIN);
  if (!before.length || !during.length) return null;
  const rhBefore = mean(before.map((r) => r.rh));
  const tempBefore = mean(before.map((r) => r.tempC));
  const peakR = during.reduce((a, b) => (b.rh > a.rh ? b : a));
  const peakT = during.reduce((a, b) => (b.tempC > a.tempC ? b : a));
  const after = rs.filter((r) => r.ts > peakR.ts);
  const back = after.find((r) => r.rh <= rhBefore + 3);
  const afterWin = rs.filter((r) => r.ts >= end + 20 * MIN && r.ts <= end + 40 * MIN);
  const warm = rs.filter((r) => r.ts >= ev.start && r.ts <= ev.start + 180 * MIN && r.tempC > tempBefore + 0.3).length;
  return {
    start: ev.start,
    end,
    rhBefore,
    rhPeak: peakR.rh,
    tempBefore,
    tempPeak: peakT.tempC,
    tempAfter: afterWin.length ? mean(afterWin.map((r) => r.tempC)) : NaN,
    recoverMin: back ? (back.ts - peakR.ts) / MIN : null,
    extraCoolMin: warm,
    dewBefore: dewPointC(tempBefore, rhBefore),
    dewPeak: dewPointC(peakT.tempC, peakR.rh),
  };
}

/** First pre-cool pull-down (first power-on command → +75 min): RH swings there can mimic a shower. */
export function pulldownWindow(night: Night): { start: number; end: number } | null {
  const first = [...night.ac].sort((a, b) => a.ts - b.ts).find((c) => c.state.power);
  return first ? { start: first.ts, end: first.ts + 75 * MIN } : null;
}

/** Minutes the aircon was commanded on, from the first power-on to the last power-off (or end of data). */
export function acRuntimeMin(night: Night): number {
  const cmds = [...night.ac].sort((a, b) => a.ts - b.ts);
  let on: number | null = null;
  let total = 0;
  for (const c of cmds) {
    if (c.state.power && on === null) on = c.ts;
    if (!c.state.power && on !== null) {
      total += c.ts - on;
      on = null;
    }
  }
  if (on !== null) total += Math.max(0, (night.room.at(-1)?.ts ?? on) - on);
  return total / MIN;
}

/** Minutes to cool 1 °C after the first power-on command (the precool), with the outdoor temperature then. */
export function coolingResponse(night: Night): { minutes: number; outdoor: number } | null {
  const first = [...night.ac].sort((a, b) => a.ts - b.ts).find((c) => c.state.power);
  if (!first) return null;
  const start = night.room.find((r) => r.ts >= first.ts);
  if (!start) return null;
  const hit = night.room.find((r) => r.ts > start.ts && r.tempC <= start.tempC - 1);
  if (!hit) return null;
  const o = night.outdoor.reduce<{ ts: number; tempC: number } | null>((best, x) => (!best || Math.abs(x.ts - first.ts) < Math.abs(best.ts - first.ts) ? x : best), null);
  return { minutes: (hit.ts - start.ts) / MIN, outdoor: o?.tempC ?? NaN };
}

const stageAt = (segs: readonly StageSegment[], ts: number): SleepStage | null => segs.find((s) => ts >= s.start && ts < s.end)?.stage ?? null;

export interface Synchrony {
  /** Wake bouts (after sleep onset) per person. */
  bouts: Record<string, { start: number; end: number }[]>;
  /** Bouts that began while (or ≤2 min after) the partner's bout began: who woke first. */
  shared: { first: string; second: string; at: number; lagMin: number; roomCause: string | null }[];
  /** Fraction of minutes (both asleep window) where both are in the same asleep/awake state. */
  agreement: number;
}

export function synchrony(night: Night, idA: string, idB: string, roomEvents: RoomEvent[]): Synchrony | null {
  const a = night.people.find((p) => p.personId === idA);
  const b = night.people.find((p) => p.personId === idB);
  if (!a || !b) return null;
  const bouts = (segs: StageSegment[]) => {
    const firstSleep = segs.find((s) => s.stage !== 'awake')?.start ?? Infinity;
    const lastSleep = [...segs].reverse().find((s) => s.stage !== 'awake')?.end ?? -Infinity;
    return segs.filter((s) => s.stage === 'awake' && s.start > firstSleep && s.end < lastSleep).map((s) => ({ start: s.start, end: s.end }));
  };
  const ba = bouts(a.sleep.stages);
  const bb = bouts(b.sleep.stages);
  const shared: Synchrony['shared'] = [];
  const cause = (t: number) => {
    const e = roomEvents.find((ev) => ['shower', 'door_open', 'out_of_bed'].includes(ev.kind) && Math.abs(ev.start - t) <= 6 * MIN);
    if (e) return e.kind.replace('_', ' ');
    const c = night.ac.find((x) => Math.abs(x.ts - t) <= 4 * MIN);
    return c ? 'AC command' : null;
  };
  for (const x of ba) {
    for (const y of bb) {
      const lag = (y.start - x.start) / MIN;
      if (Math.abs(lag) <= 5 && y.start <= x.end + 2 * MIN && x.start <= y.end + 2 * MIN) {
        const firstIsA = lag >= 0;
        shared.push({ first: firstIsA ? idA : idB, second: firstIsA ? idB : idA, at: Math.min(x.start, y.start), lagMin: Math.abs(lag), roomCause: cause(Math.min(x.start, y.start)) });
      }
    }
  }
  const from = Math.max(a.sleep.start, b.sleep.start);
  const to = Math.min(a.sleep.end, b.sleep.end);
  let same = 0;
  let n = 0;
  for (let t = from; t < to; t += MIN) {
    const sa = stageAt(a.sleep.stages, t);
    const sb = stageAt(b.sleep.stages, t);
    if (!sa || !sb) continue;
    n++;
    if ((sa === 'awake') === (sb === 'awake')) same++;
  }
  return { bouts: { [idA]: ba, [idB]: bb }, shared, agreement: n ? same / n : NaN };
}

/** Our own minute-level sleep/wake estimate from HR alone: awake when the 9-min median HR is well above the night's baseline. */
export function hrSleepWake(hr: { ts: number; bpm: number }[]): { start: number; end: number; awake: boolean }[] {
  if (hr.length < 20) return [];
  const sorted = [...hr].sort((a, b) => a.ts - b.ts);
  const base = median(sorted.map((h) => h.bpm));
  const sm = sorted.map((h, i) => median(sorted.slice(Math.max(0, i - 4), i + 5).map((x) => x.bpm)));
  const out: { start: number; end: number; awake: boolean }[] = [];
  sorted.forEach((h, i) => {
    const awake = sm[i]! > base * 1.12;
    const last = out.at(-1);
    const end = sorted[i + 1]?.ts ?? h.ts + MIN;
    if (last && last.awake === awake) last.end = end;
    else out.push({ start: h.ts, end, awake });
  });
  return out;
}
