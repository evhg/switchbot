import { describe, expect, it } from 'vitest';
import type { RoomReading } from '../src/types.ts';
import { cleanRoomReadings } from '../src/metrics/index.ts';

const MIN = 60_000;
const LIGHTS_OUT = Date.parse('2026-10-29T22:00:00+07:00');
const WAKE = Date.parse('2026-10-30T08:30:00+07:00');
const FROM = LIGHTS_OUT - 120 * MIN;
const TO = Date.parse('2026-10-30T12:00:00+07:00');

/** Minute rows from `a` to `b` (minutes relative to lights-out), with a slowly drifting room. */
function rows(a: number, b: number, f: (m: number) => Partial<RoomReading> = () => ({})): RoomReading[] {
  const out: RoomReading[] = [];
  for (let m = a; m < b; m++) {
    out.push({ ts: LIGHTS_OUT + m * MIN, tempC: 19 + ((m >> 3) % 5) / 10, rh: 53 + ((m >> 4) % 3), co2: 600 + m, source: 'poll', ...f(m) });
  }
  return out;
}
const opts = { from: FROM, to: TO, lightsOut: LIGHTS_OUT, wake: WAKE };

describe('cleanRoomReadings', () => {
  it('keeps a clean night untouched', () => {
    const { readings, quality } = cleanRoomReadings(rows(-120, 840), opts);
    expect(readings).toHaveLength(960);
    expect(quality.frozen).toEqual([]);
    expect(quality.gaps).toEqual([]);
    expect(quality.coveragePct).toBe(100);
    expect(quality.flags).toEqual([]);
  });

  it('drops frozen temp/RH while CO2 moves (the 2026-10-29 cloud freeze)', () => {
    const input = [...rows(-58, 22, () => ({ tempC: 25.1, rh: 64 })), ...rows(22, 630)];
    const { readings, quality } = cleanRoomReadings(input, opts);
    expect(quality.frozen).toHaveLength(1);
    expect(quality.frozen[0]).toMatchObject({ kind: 'temp_rh', minutes: 80, tempC: 25.1 });
    expect(quality.frozenNightMinutes).toBe(22);
    expect(readings[0]!.ts).toBe(LIGHTS_OUT + 22 * MIN);
    expect(quality.coverage).toBeCloseTo(608 / 630, 5);
    expect(quality.flags).toContain('frozen_temp_rh');
    expect(quality.flags).toContain('gap_evening');
  });

  it('drops a cached snapshot (all three identical) and reports the outage as a gap', () => {
    // Like 2026-10-30 09:08: the run starts with the meter's last real (webhook) change, then only cached poll rows.
    const input = [...rows(-120, 640), ...rows(640, 760, (m) => ({ tempC: 21.8, rh: 69, co2: 881, ...(m === 640 ? { source: 'webhook' as const } : {}) })), ...rows(820, 840)];
    const { quality } = cleanRoomReadings(input, opts);
    expect(quality.frozen.map((f) => f.kind)).toEqual(['all']);
    expect(quality.frozenMinutes).toBe(120);
    expect(quality.gaps).toHaveLength(1);
    expect(quality.gaps[0]!.minutes).toBe(60);
    expect(quality.gapNightMinutes).toBe(0);
    expect(quality.flags).toEqual(expect.arrayContaining(['frozen_all', 'gap_morning']));
  });

  it('keeps a still, real stretch: identical values under 60 min, or with a webhook row inside', () => {
    const still = rows(-120, 840, (m) => (m >= 120 && m < 165 ? { tempC: 19.1, rh: 53, co2: 940 } : {}));
    expect(cleanRoomReadings(still, opts).quality.frozen).toEqual([]);
    const pushed = rows(-120, 840, (m) => (m >= 120 && m < 220 ? { tempC: 19.1, rh: 53, co2: 940, ...(m === 150 ? { source: 'webhook' as const } : {}) } : {}));
    const { readings, quality } = cleanRoomReadings(pushed, opts);
    expect(quality.frozen).toEqual([]);
    expect(readings).toHaveLength(960);
  });

  it('keeps a stable empty room (identical T/RH, only CO2 noise)', () => {
    const input = rows(-120, 840, (m) => (m > 700 ? { tempC: 26.3, rh: 52, co2: 405 + (m % 7) } : {}));
    const { readings, quality } = cleanRoomReadings(input, opts);
    expect(quality.frozen).toEqual([]);
    expect(readings).toHaveLength(960);
  });

  it('counts 0 ppm CO2 rows without dropping them and flags a thin night', () => {
    const input = rows(0, 300, (m) => (m === 3 ? { co2: 0 } : {}));
    const { readings, quality } = cleanRoomReadings(input, opts);
    expect(readings).toHaveLength(300);
    expect(quality.invalidCo2Count).toBe(1);
    expect(quality.flags).toEqual(expect.arrayContaining(['invalid_co2', 'low_coverage', 'gap_overnight']));
  });
});
