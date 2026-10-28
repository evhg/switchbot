import { describe, expect, it } from 'vitest';
import type { RoomEvent, RoomReading } from '../src/types.ts';
import { detectEvents } from '../src/metrics/index.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 27, 11); // 18:00 ICT
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const local = h! < 18 ? h! + 24 : h!;
  return T0 + ((local - 18) * 60 + m!) * MIN;
};

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (sd = 1) => sd * Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}

interface NightSpec {
  seed?: number;
  ach?: number;
  genPerPersonLps?: number;
  /** [enter, leave] per person, HH:MM ICT. */
  people?: [string, string][];
  showerAt?: string;
  doorAt?: string;
  missing?: number;
}

/** 18:00 → 12:00 ICT synthetic room: mass-balance CO₂, RH with an optional shower, integer quantisation. */
function night(spec: NightSpec = {}): RoomReading[] {
  const r = rng(spec.seed ?? 1);
  const ach = spec.ach ?? 0.2;
  const g = spec.genPerPersonLps ?? 0.0031;
  const people = (spec.people ?? []).map(([a, b]) => [at(a), at(b)] as const);
  const shower = spec.showerAt ? at(spec.showerAt) : null;
  const door = spec.doorAt ? at(spec.doorAt) : null;
  let c = 470;
  const out: RoomReading[] = [];
  for (let i = 0; i < 18 * 60; i++) {
    const ts = T0 + i * MIN;
    const n = people.filter(([a, b]) => ts >= a && ts < b).length;
    c += ((n * g * 3.6e6) / 120 - ach * (c - 425)) / 60;
    if (door !== null && ts >= door && ts < door + 5 * MIN) c -= 0.1 * (c - 425);
    let rh = 55;
    let temp = 21;
    if (shower !== null && ts >= shower) {
      const m = (ts - shower) / MIN;
      rh += m < 8 ? (m / 8) * 22 : 22 * Math.exp(-(m - 8) / 15);
      temp += m < 8 ? (m / 8) * 0.6 : 0.6 * Math.exp(-(m - 8) / 20);
    }
    if (r.next() < (spec.missing ?? 0.02)) continue;
    out.push({ ts, co2: Math.round(c + r.normal(5)), rh: Math.round(rh + r.normal(0.6)), tempC: Math.round((temp + r.normal(0.05)) * 10) / 10, source: 'sim' });
  }
  return out;
}

const kinds = (es: RoomEvent[]) => es.map((e) => e.kind);
const near = (e: RoomEvent | undefined, hhmm: string, tolMin: number) => {
  expect(e).toBeDefined();
  expect(Math.abs(e!.start - at(hhmm)) / MIN).toBeLessThanOrEqual(tolMin);
};

describe('detectEvents: true positives', () => {
  const rs = night({ people: [['22:00', '06:15'], ['22:45', '06:40']], showerAt: '21:30', doorAt: '02:00', seed: 4 });
  const es = detectEvents(rs, { lightsOut: at('22:30'), wake: at('06:30') });
  const one = (k: RoomEvent['kind']) => es.filter((e) => e.kind === k);

  it('finds exactly one of each night event', () => {
    for (const k of ['shower', 'door_open', 'in_bed', 'both_in_bed', 'out_of_bed'] as const) expect(one(k)).toHaveLength(1);
    expect(one('room_empty').length).toBeGreaterThanOrEqual(1);
  });

  it('times the shower and its end', () => {
    const s = one('shower')[0]!;
    near(s, '21:30', 3);
    expect(s.end).toBeDefined();
    expect((s.end! - s.start) / MIN).toBeGreaterThan(20);
    expect((s.end! - s.start) / MIN).toBeLessThan(90);
    expect(s.detail!.riseRh).toBeGreaterThanOrEqual(18);
    expect(s.confidence).toBeGreaterThan(0.7);
  });

  it('times the door opening', () => {
    near(one('door_open')[0], '02:00', 3);
    expect(Number(one('door_open')[0]!.detail!.dropPpm)).toBeGreaterThan(120);
  });

  it('times in-bed, both-in-bed and out-of-bed from CO₂ regimes', () => {
    near(one('in_bed')[0], '22:00', 20);
    near(one('both_in_bed')[0], '22:45', 25);
    near(one('out_of_bed')[0], '06:40', 30);
    const ib = one('in_bed')[0]!;
    expect(ib.confidence).toBeGreaterThan(0.6);
  });

  it('flags the empty room after departure', () => {
    const e = one('room_empty').find((x) => x.start > at('06:00'))!;
    expect(e).toBeDefined();
    expect(e.start).toBeLessThan(at('07:30'));
    expect(e.end!).toBeGreaterThan(at('10:00'));
  });

  it('returns events sorted by start with confidences in 0..1', () => {
    for (let i = 1; i < es.length; i++) expect(es[i]!.start).toBeGreaterThanOrEqual(es[i - 1]!.start);
    for (const e of es) {
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('detects a single sleeper without a both_in_bed event', () => {
    const solo = detectEvents(night({ people: [['23:00', '07:00']], seed: 9 }), { lightsOut: at('23:00'), wake: at('07:00') });
    expect(kinds(solo)).toContain('in_bed');
    expect(kinds(solo)).not.toContain('both_in_bed');
    near(solo.find((e) => e.kind === 'in_bed'), '23:00', 20);
  });

  it('copes with a leakier room (ACH 0.5) and heavier breathers', () => {
    const es2 = detectEvents(night({ people: [['22:00', '06:00'], ['22:00', '06:00']], ach: 0.5, genPerPersonLps: 0.0038, seed: 12 }));
    near(es2.find((e) => e.kind === 'in_bed'), '22:00', 20);
    expect(kinds(es2)).toContain('both_in_bed');
    expect(kinds(es2)).not.toContain('door_open');
  });
});

describe('detectEvents: robustness across seeds and gaps', () => {
  it.each([11, 12, 13, 14, 15, 16])('seed %i with 8%% missing minutes', (seed) => {
    const rs = night({ people: [['22:15', '06:20'], ['23:00', '06:45']], showerAt: '21:40', doorAt: '01:30', seed, missing: 0.08 });
    const es = detectEvents(rs, { lightsOut: at('22:15'), wake: at('06:30') });
    const count = (k: RoomEvent['kind']) => es.filter((e) => e.kind === k).length;
    expect(count('shower')).toBe(1);
    expect(count('door_open')).toBe(1);
    expect(count('in_bed')).toBe(1);
    expect(count('both_in_bed')).toBe(1);
    expect(count('out_of_bed')).toBe(1);
    near(es.find((e) => e.kind === 'in_bed'), '22:15', 20);
    near(es.find((e) => e.kind === 'both_in_bed'), '23:00', 30);
    near(es.find((e) => e.kind === 'door_open'), '01:30', 5);
  });
});

describe('detectEvents: context', () => {
  it('humid air through an opened door is not a shower', () => {
    const rs = night({ people: [['22:00', '06:30'], ['22:00', '06:30']], doorAt: '02:00', seed: 21 }).map((r) =>
      r.ts >= at('02:00') && r.ts < at('02:30') ? { ...r, rh: r.rh + Math.min(12, ((r.ts - at('02:00')) / MIN) * 3) } : r,
    );
    const ks = kinds(detectEvents(rs));
    expect(ks).toContain('door_open');
    expect(ks).not.toContain('shower');
  });

  it('anchors in-bed near lights-out when the room was occupied all evening', () => {
    const rs = night({ people: [['20:00', '06:30'], ['22:30', '06:30']], seed: 22 });
    const ib = detectEvents(rs, { lightsOut: at('22:30'), wake: at('06:30') }).find((e) => e.kind === 'in_bed')!;
    near(ib, '22:30', 30);
    expect(Math.abs(Number(ib.detail!.roomOccupiedFrom) - at('20:00')) / MIN).toBeLessThanOrEqual(20);
    expect(ib.confidence).toBeLessThan(0.7);
  });
});

describe('detectEvents: no false positives', () => {
  it('flat room at baseline', () => {
    for (const seed of [1, 2, 3]) expect(detectEvents(night({ seed, missing: 0.05 }))).toEqual([]);
  });

  it('flat elevated CO₂ with noise and gaps', () => {
    const r = rng(77);
    const rs: RoomReading[] = [];
    for (let i = 0; i < 18 * 60; i++) {
      if (r.next() < 0.05) continue;
      rs.push({ ts: T0 + i * MIN, co2: Math.round(700 + r.normal(12)), rh: Math.round(52 + r.normal(1)), tempC: 22, source: 'sim' });
    }
    expect(detectEvents(rs)).toEqual([]);
  });

  it('slow AC-driven RH swings and gradual decay are not showers or doors', () => {
    const r = rng(5);
    const rs: RoomReading[] = [];
    for (let i = 0; i < 12 * 60; i++) {
      rs.push({
        ts: T0 + i * MIN,
        co2: Math.round(425 + 1300 * Math.exp((-0.4 * i) / 60) + r.normal(5)),
        rh: Math.round(55 + 6 * Math.sin((2 * Math.PI * i) / 120) + r.normal(0.7)),
        tempC: 22,
        source: 'sim',
      });
    }
    const ks = kinds(detectEvents(rs));
    expect(ks).not.toContain('shower');
    expect(ks).not.toContain('door_open');
    expect(ks).not.toContain('in_bed');
  });

  it('single-sample glitches are ignored', () => {
    const rs = night({ seed: 8 });
    rs[300] = { ...rs[300]!, co2: rs[300]!.co2 - 300, rh: rs[300]!.rh + 20 };
    expect(detectEvents(rs)).toEqual([]);
  });

  it('handles empty input', () => {
    expect(detectEvents([])).toEqual([]);
  });
});
