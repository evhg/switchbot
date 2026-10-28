import { describe, expect, it } from 'vitest';
import * as core from '../src/index.ts';
import type { Night } from '../src/types.ts';

// Integration check against the simulator's ground truth (skipped if the simulator isn't present).
const simulate = (core as Record<string, unknown>).simulateNights as ((o: object) => Night[]) | undefined;

describe.skipIf(!simulate)('metrics on simulated nights', () => {
  const nights = simulate ? simulate({ nights: 20, seed: 3, endDate: '2026-10-28' }) : [];

  it('recovers morning ACH close to the simulated truth', () => {
    const errs = nights
      .map((n) => ({ fit: core.roomNightMetrics(n, core.DEFAULT_CURVE).achMorning, truth: n.truth?.ach }))
      .filter((x): x is { fit: number; truth: number } => x.fit !== null && x.truth !== undefined)
      .map((x) => Math.abs(x.fit - x.truth));
    expect(errs.length).toBeGreaterThanOrEqual(nights.length * 0.6);
    expect(errs.reduce((a, b) => a + b, 0) / errs.length).toBeLessThan(0.1);
  });

  it('finds in-bed near the true time on most nights', () => {
    let hits = 0;
    for (const n of nights) {
      const truth = n.truth?.events.find((e) => e.kind === 'in_bed');
      const found = core.detectEvents(n.room, { lightsOut: n.lightsOut, wake: n.wake }).find((e) => e.kind === 'in_bed');
      if (truth && found && Math.abs(found.start - truth.start) <= 45 * 60_000) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(nights.length * 0.85);
  }, 30_000);

  it('builds a report for the latest night', () => {
    const last = nights[nights.length - 1]!;
    const r = core.buildRuleReport(last, nights.slice(0, -1), core.DEFAULT_CURVE);
    expect(r.people.length).toBe(last.people.length);
    expect(r.insights.length).toBeGreaterThanOrEqual(2);
    for (const p of r.people) {
      expect(p.recoveryScore).toBeGreaterThanOrEqual(0);
      expect(p.recoveryScore).toBeLessThanOrEqual(100);
    }
  }, 30_000);
});
