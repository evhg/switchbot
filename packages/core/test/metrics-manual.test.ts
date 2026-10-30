import { describe, expect, it } from 'vitest';
import { ONE_BEEP_V2, buildRuleReport, detectEvents, plateauAch, roomNightBreakdown } from '../src/index.ts';
import type { Night, RoomReading } from '../src/types.ts';

const MIN = 60_000;
const LO = Date.parse('2026-10-29T22:00:00+07:00');
const WAKE = Date.parse('2026-10-30T08:30:00+07:00');

/**
 * Shaped like the real night of 2026-10-30: aircon at 17 by hand (bed air 18.5–19.7 °C, never warming), two sleepers,
 * CO₂ rising ~100 ppm/h early and ~10 ppm/h late (approaching equilibrium near 940 ppm, never flat).
 */
function realLike(): RoomReading[] {
  const out: RoomReading[] = [];
  for (let m = -30; m < 840; m++) {
    const ts = LO + m * MIN;
    const h = Math.max(0, m) / 60;
    const co2 = Math.round(560 + 340 * (1 - Math.exp(-h / 2.4)) + 9 * h);
    let tempC = 19.6 - 0.9 * (1 - Math.exp(-h / 1.5));
    let rh = 53;
    if (m >= 634) rh = Math.min(65, 53 + (m - 634) * 1.7); // Erik's shower at 08:34
    if (m >= 638) tempC += Math.min(0.6, (m - 638) * 0.1);
    if (m >= 650) { tempC = 19.5 + (m - 650) * 0.06; rh = Math.min(69, 64 + (m - 650) * 0.2); } // aircon OFF 09:00ish → warm drift
    out.push({ ts, tempC: Math.round(tempC * 10) / 10, rh: Math.round(rh), co2, source: 'poll' });
  }
  return out;
}

const night = (manual: boolean): Night => ({
  date: '2026-10-30', lightsOut: LO, wake: WAKE, room: realLike(), outdoor: [], ac: [], curveId: ONE_BEEP_V2.id, events: [], people: [], tags: [], manual,
});

describe('a night run by hand', () => {
  it('is scored against the steady comfort target, not the stored plan that never ran', () => {
    const planned = roomNightBreakdown(night(false), ONE_BEEP_V2);
    const manual = roomNightBreakdown(night(true), ONE_BEEP_V2);
    expect(manual.parts.manual).toBe(true);
    // The v2 plan wanted 21 °C after 03:30; a steady ~18.8 °C room is far from it but on the comfort target.
    expect(manual.metrics.minutesTempInTarget).toBeGreaterThan(planned.metrics.minutesTempInTarget);
    expect(manual.metrics.sleepAirScore).toBeGreaterThan(planned.metrics.sleepAirScore);
  });

  it('report says so and never talks about the curve', () => {
    const r = buildRuleReport(night(true), [], ONE_BEEP_V2);
    expect(r.insights.some((t) => /run by hand/.test(t))).toBe(true);
    expect(r.drivers.map((d) => d.label).join(' ')).not.toMatch(/curve/);
    expect(r.headline).not.toMatch(/curve/);
    expect(r.insights.join(' ')).not.toMatch(/tracked/);
  });
});

describe('plateauAch', () => {
  it('treats CO₂ still rising at wake as an upper bound from the end-of-night level', () => {
    const p = plateauAch(realLike(), WAKE)!;
    expect(p.kind).toBe('upper_bound');
    expect(p.ppm).toBeGreaterThan(900);
    expect(p.ach).toBeGreaterThan(0.3);
    expect(p.ach).toBeLessThan(0.4);
  });

  it('calls a flat end of night a plateau', () => {
    const flat = realLike().map((r) => (r.ts > WAKE - 120 * MIN ? { ...r, co2: 900 + ((r.ts / MIN) % 3) } : r));
    expect(plateauAch(flat, WAKE)!.kind).toBe('plateau');
  });
});

describe('events on a real-like night', () => {
  const ev = detectEvents(realLike(), { lightsOut: LO, wake: WAKE });
  it('counts two people all night once ventilation is in the balance', () => {
    const inBed = ev.find((e) => e.kind === 'in_bed')!;
    expect(inBed.detail!.achFrom).toBe('plateau');
    expect(Number(inBed.detail!.persons)).toBeGreaterThan(1.5);
    const both = ev.find((e) => e.kind === 'both_in_bed')!;
    expect(both.end! - both.start).toBeGreaterThan(6 * 60 * MIN);
  });
  it('measures the shower itself, not the warm-up after the aircon goes off', () => {
    const sh = ev.find((e) => e.kind === 'shower')!;
    expect(sh).toBeTruthy();
    expect(Number(sh.detail!.peakRh)).toBeLessThanOrEqual(66);
    expect(Number(sh.detail!.tempBumpC)).toBeLessThanOrEqual(0.8);
  });
});
