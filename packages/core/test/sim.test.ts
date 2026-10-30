import { describe, expect, it } from 'vitest';
import {
  createRng,
  DEFAULT_CURVE,
  DEFAULT_PEOPLE,
  simulateLiveReading,
  simulateNight,
  simulateNights,
  targetAt,
  type Night,
} from '../src/index.ts';

const MIN = 60_000;
const END = '2026-10-28';
const nights: Night[] = simulateNights({ nights: 90, endDate: END, seed: 42 });
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const at = (n: Night, ts: number) => n.room.find((r) => r.ts === ts);
const ictHour = (ts: number) => new Date(ts + 7 * 3_600_000).getUTCHours() + new Date(ts).getUTCMinutes() / 60;

describe('createRng', () => {
  it('is deterministic and well-behaved', () => {
    const a = createRng(1);
    const b = createRng(1);
    const xs = Array.from({ length: 1000 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b.next()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const r = createRng(9);
    const zs = Array.from({ length: 5000 }, () => r.normal(10, 2));
    const m = zs.reduce((s, z) => s + z, 0) / zs.length;
    expect(m).toBeGreaterThan(9.9);
    expect(m).toBeLessThan(10.1);
    for (let i = 0; i < 200; i++) {
      const k = r.int(3, 5);
      expect(k >= 3 && k <= 5 && Number.isInteger(k)).toBe(true);
    }
  });
});

describe('simulateNights: determinism and shape', () => {
  it('same seed → identical output; different seed → different', () => {
    const a = simulateNights({ nights: 4, endDate: END, seed: 7 });
    const b = simulateNights({ nights: 4, endDate: END, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = simulateNights({ nights: 4, endDate: END, seed: 8 });
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it('a night does not depend on the requested range', () => {
    const last3 = nights.slice(-3);
    expect(JSON.stringify(simulateNights({ nights: 3, endDate: END, seed: 42 }))).toBe(JSON.stringify(last3));
    expect(JSON.stringify(simulateNight(END, { seed: 42 }))).toBe(JSON.stringify(nights[nights.length - 1]));
  });

  it('runs 90 nights quickly', () => {
    const t = performance.now();
    simulateNights({ nights: 90, endDate: END, seed: 3 });
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it('has 1-min room data 18:00 → 12:00 ICT, quantised like the Meter', () => {
    expect(nights).toHaveLength(90);
    expect(nights[89]!.date).toBe(END);
    for (const n of nights) {
      expect(n.room).toHaveLength(18 * 60);
      expect(ictHour(n.room[0]!.ts)).toBe(18);
      expect(n.room.every((r, i) => i === 0 || r.ts - n.room[i - 1]!.ts === MIN)).toBe(true);
      expect(n.room.every((r) => r.source === 'sim' && Number.isInteger(r.co2) && Number.isInteger(r.rh))).toBe(true);
      expect(n.room.every((r) => Math.abs(r.tempC * 10 - Math.round(r.tempC * 10)) < 1e-6)).toBe(true);
      expect(n.outdoor).toHaveLength(19);
      expect(n.curveId).toBe(DEFAULT_CURVE.id);
      expect(n.truth).toBeDefined();
      const lo = ictHour(n.lightsOut);
      expect(lo).toBeGreaterThanOrEqual(22.5);
      expect(lo).toBeLessThanOrEqual(24.1);
      const wk = ictHour(n.wake);
      expect(wk).toBeGreaterThanOrEqual(6.5);
      expect(wk).toBeLessThanOrEqual(8.3);
    }
  });
});

describe('room physics', () => {
  it('keeps CO2 in a sane range and builds up overnight with occupants', () => {
    const wakeCo2: number[] = [];
    const rises: number[] = [];
    for (const n of nights) {
      expect(n.room.every((r) => r.co2 > 380 && r.co2 < 3000)).toBe(true);
      if (n.people.length === 2 && !n.tags.includes('door_ajar')) {
        const start = at(n, n.lightsOut)!.co2;
        const end = at(n, n.wake)!.co2;
        expect(end).toBeGreaterThan(start);
        rises.push(end - start);
        wakeCo2.push(end);
      }
    }
    expect(median(rises)).toBeGreaterThan(400);
    const m = median(wakeCo2);
    expect(m).toBeGreaterThan(1000);
    expect(m).toBeLessThan(1800);
  });

  it('decays when the room is empty, at the true ACH', () => {
    let checked = 0;
    const errs: number[] = [];
    for (const n of nights) {
      const e = n.truth!.events.find((x) => x.kind === 'room_empty' && x.start > n.wake && x.end! - x.start >= 120 * MIN);
      if (!e) continue;
      const a = at(n, e.start + 15 * MIN)!;
      const b = at(n, e.end! - MIN)!;
      expect(b.co2).toBeLessThan(a.co2);
      const ach = Math.log((a.co2 - 425) / (b.co2 - 425)) / ((b.ts - a.ts) / 3_600_000);
      errs.push(Math.abs(ach - n.truth!.ach) / n.truth!.ach);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
    expect(median(errs)).toBeLessThan(0.2);
  });

  it('door_ajar nights have higher ACH and lower CO2', () => {
    const ajar = nights.filter((n) => n.tags.includes('door_ajar'));
    const sealed = nights.filter((n) => !n.tags.includes('door_ajar'));
    expect(ajar.length).toBeGreaterThan(0);
    for (const n of ajar) expect(n.truth!.ach).toBeGreaterThanOrEqual(0.5);
    for (const n of sealed) {
      expect(n.truth!.ach).toBeGreaterThanOrEqual(0.08);
      expect(n.truth!.ach).toBeLessThanOrEqual(0.35);
    }
  });

  it('shows an RH spike on shower truth events', () => {
    const jumps: number[] = [];
    for (const n of nights) {
      for (const s of n.truth!.events.filter((e) => e.kind === 'shower')) {
        const before = at(n, s.start - 2 * MIN);
        if (!before) continue;
        const peak = Math.max(...n.room.filter((r) => r.ts >= s.start && r.ts <= s.end! + 15 * MIN).map((r) => r.rh));
        jumps.push(peak - before.rh);
      }
    }
    expect(jumps.length).toBeGreaterThan(50);
    expect(median(jumps)).toBeGreaterThanOrEqual(12);
  });

  it('tracks the curve within ~1 °C for most of the night', () => {
    const fractions = nights.map((n) => {
      const xs = n.room.filter((r) => r.ts >= n.lightsOut + 60 * MIN && r.ts < n.wake);
      return xs.filter((r) => Math.abs(r.tempC - targetAt(DEFAULT_CURVE, n.lightsOut, r.ts)!) <= 1).length / xs.length;
    });
    expect(median(fractions)).toBeGreaterThan(0.8);
  });

  it('is warm and humid before pre-cool, outdoors is Phuket', () => {
    for (const n of nights) {
      expect(n.room[0]!.tempC).toBeGreaterThan(26);
      for (const o of n.outdoor) {
        expect(o.tempC).toBeGreaterThan(24);
        expect(o.tempC).toBeLessThan(35);
        expect(o.rh).toBeGreaterThanOrEqual(60);
      }
    }
  });
});

describe('AC log', () => {
  it('is realistic and respects the remote profile', () => {
    const counts = nights.map((n) => n.ac.length);
    // Quiet mode + the steady default curve: precool and OFF, nothing planned while asleep (plus rare resends).
    expect(median(counts)).toBeGreaterThanOrEqual(2);
    expect(median(counts)).toBeLessThanOrEqual(6);
    let missed = 0;
    let flagged = 0;
    for (const n of nights) {
      expect(n.ac.length).toBeLessThanOrEqual(12);
      for (let i = 1; i < n.ac.length; i++) {
        const a = n.ac[i - 1]!;
        const b = n.ac[i]!;
        expect(b.ts - a.ts).toBeGreaterThanOrEqual(20 * MIN);
        if (JSON.stringify(a.state) === JSON.stringify(b.state)) expect(b.reason).toMatch(/^resend/);
      }
      expect(n.ac[n.ac.length - 1]!.state.power).toBe(false);
      missed += n.truth!.events.filter((e) => e.kind === 'ac_missed').length;
      flagged += n.ac.filter((c) => c.landed === false).length;
    }
    expect(missed).toBeGreaterThan(0);
    expect(flagged).toBeGreaterThan(0);
  });
});

describe('truth', () => {
  it('records ACH, events and per-person CO2 generation', () => {
    for (const n of nights) {
      const t = n.truth!;
      const kinds = new Set(t.events.map((e) => e.kind));
      expect(kinds.has('in_bed')).toBe(true);
      expect(kinds.has('out_of_bed')).toBe(true);
      if (n.people.length === 2) expect(kinds.has('both_in_bed')).toBe(true);
      expect(Object.keys(t.co2GenLps).sort()).toEqual(n.people.map((p) => p.personId).sort());
      for (const g of Object.values(t.co2GenLps)) {
        expect(g).toBeGreaterThan(0.002);
        expect(g).toBeLessThan(0.0045);
      }
      for (const e of t.events) {
        expect(e.start).toBeGreaterThanOrEqual(n.room[0]!.ts);
        expect(e.start).toBeLessThan(n.room[n.room.length - 1]!.ts + MIN);
      }
    }
    expect(nights.some((n) => n.truth!.events.some((e) => e.kind === 'room_empty' && e.start > n.wake))).toBe(true);
    expect(nights.some((n) => n.truth!.events.some((e) => e.kind === 'door_open'))).toBe(true);
  });
});

describe('body', () => {
  it('produces plausible sleep architecture', () => {
    const deep: number[] = [];
    const rem: number[] = [];
    for (const n of nights) {
      for (const p of n.people) {
        expect(DEFAULT_PEOPLE.map((x) => x.id)).toContain(p.personId);
        const st = p.sleep.stages;
        expect(st[0]!.start).toBe(p.sleep.start);
        expect(st[st.length - 1]!.end).toBe(p.sleep.end);
        for (let i = 1; i < st.length; i++) expect(st[i]!.start).toBe(st[i - 1]!.end);
        const tot = { awake: 0, light: 0, deep: 0, rem: 0 };
        for (const s of st) tot[s.stage] += (s.end - s.start) / MIN;
        const tst = tot.light + tot.deep + tot.rem;
        expect(tst).toBeGreaterThan(240);
        expect(tst).toBeLessThan(600);
        deep.push(tot.deep / tst);
        rem.push(tot.rem / tst);
        // Deep is front-loaded, REM back-loaded.
        const mid = (p.sleep.start + p.sleep.end) / 2;
        const half = (stage: string, first: boolean) =>
          st.filter((s) => s.stage === stage && (first ? s.start < mid : s.start >= mid)).reduce((a, s) => a + s.end - s.start, 0);
        expect(half('deep', true)).toBeGreaterThan(half('deep', false));
      }
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(deep)).toBeGreaterThan(0.1);
    expect(mean(deep)).toBeLessThan(0.25);
    expect(mean(rem)).toBeGreaterThan(0.18);
    expect(mean(rem)).toBeLessThan(0.28);
  });

  it('has HR / HRV / SpO2 in physiological ranges', () => {
    for (const n of nights) {
      for (const p of n.people) {
        expect(p.hr.every((h, i) => i === 0 || h.ts - p.hr[i - 1]!.ts === MIN)).toBe(true);
        expect(p.hr.every((h) => h.bpm > 35 && h.bpm < 110)).toBe(true);
        expect(p.hrv.every((v) => v.rmssdMs > 5 && v.rmssdMs < 150)).toBe(true);
        expect(p.spo2.every((s) => s.pct >= 85 && s.pct <= 100)).toBe(true);
        const sp = median(p.spo2.map((s) => s.pct));
        expect(sp).toBeGreaterThanOrEqual(93);
        expect(sp).toBeLessThanOrEqual(98);
        expect(p.respRate!).toBeGreaterThan(11);
        expect(p.respRate!).toBeLessThan(19);
        // Nadir lands in the middle of the night, not at the edges.
        const sleepHr = p.hr.filter((h) => h.ts > p.sleep.start + 30 * MIN && h.ts < p.sleep.end - 15 * MIN);
        expect(sleepHr.length).toBeGreaterThan(200);
      }
    }
  });

  it('alcohol raises the HR nadir and lowers RMSSD on average', () => {
    const many = simulateNights({ nights: 200, endDate: END, seed: 11 });
    const stat = (alc: boolean) => {
      const sel = many.filter((n) => n.tags.includes('alcohol') === alc).flatMap((n) => n.people.filter((p) => p.personId === 'a'));
      const nadir = sel.map((p) => Math.min(...p.hr.map((h) => h.bpm)));
      const hrv = sel.map((p) => p.hrv.reduce((a, b) => a + b.rmssdMs, 0) / p.hrv.length);
      return { nadir: median(nadir), hrv: median(hrv) };
    };
    const yes = stat(true);
    const no = stat(false);
    expect(yes.nadir).toBeGreaterThan(no.nadir + 2);
    expect(yes.hrv).toBeLessThan(no.hrv);
  });
});

describe('simulateLiveReading', () => {
  it('matches the night for the same minute and is deterministic', () => {
    const n = nights[nights.length - 1]!;
    const ts = n.lightsOut + 123 * MIN + 17_000;
    const live = simulateLiveReading(ts, { seed: 42 });
    expect(live).toEqual(at(n, n.lightsOut + 123 * MIN));
    expect(simulateLiveReading(ts, { seed: 42 })).toEqual(live);
  });

  it('covers the afternoon gap between nights with a plausible reading', () => {
    const noonish = Date.UTC(2026, 9, 28, 8, 0); // 15:00 ICT
    const r = simulateLiveReading(noonish, { seed: 42 });
    expect(r.ts).toBe(noonish);
    expect(r.tempC).toBeGreaterThan(24);
    expect(r.co2).toBeGreaterThan(380);
    expect(r.co2).toBeLessThan(1500);
  });
});
