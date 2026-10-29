// The Today story's data model (docs/DESIGN.md §10): everything the chapters scrub through, computed once per
// night (memoised by the caller). Pure functions, no React. Per-minute typed arrays make the per-frame lookups
// in the scrubbed chapters O(1) — the frame loop never searches the raw series.
import { targetAt, type Night, type Person, type PersonNight, type SleepStage, type TemperatureCurve } from '@sleep-lab/core';
import { ACH_FOR_1000, pulldownWindow } from '@/lib/analysis.ts';
import type { NightDetail } from '@/lib/data/types.ts';
import { MIN, dur, fmt, hm } from '@/lib/format.ts';

export const STAGE_CODE: Record<SleepStage, number> = { awake: 0, rem: 1, light: 2, deep: 3 };
export const STAGE_BY_CODE: SleepStage[] = ['awake', 'rem', 'light', 'deep'];

/** Per-minute room series from `t0` (NaN where there is no reading within 5 min). */
export interface MinuteSeries {
  t0: number;
  n: number;
  temp: Float32Array;
  rh: Float32Array;
  co2: Float32Array;
}

export function minuteSeries(night: Night, t0: number, t1: number): MinuteSeries {
  const n = Math.max(1, Math.round((t1 - t0) / MIN) + 1);
  const temp = new Float32Array(n).fill(NaN);
  const rh = new Float32Array(n).fill(NaN);
  const co2 = new Float32Array(n).fill(NaN);
  const rs = night.room;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * MIN;
    while (j < rs.length - 1 && rs[j + 1]!.ts <= t) j++;
    const a = rs[j];
    const b = rs[j + 1];
    if (!a) continue;
    if (b && a.ts <= t && b.ts >= t && b.ts - a.ts <= 10 * MIN) {
      const f = b.ts === a.ts ? 0 : (t - a.ts) / (b.ts - a.ts);
      temp[i] = a.tempC + (b.tempC - a.tempC) * f;
      rh[i] = a.rh + (b.rh - a.rh) * f;
      co2[i] = a.co2 + (b.co2 - a.co2) * f;
    } else if (Math.abs(a.ts - t) <= 5 * MIN) {
      temp[i] = a.tempC;
      rh[i] = a.rh;
      co2[i] = a.co2;
    } else if (b && Math.abs(b.ts - t) <= 5 * MIN) {
      temp[i] = b.tempC;
      rh[i] = b.rh;
      co2[i] = b.co2;
    }
  }
  return { t0, n, temp, rh, co2 };
}

/** Value at time t (nearest minute, then the closest finite neighbour within 10 min). */
export function valueAt(s: MinuteSeries, key: 'temp' | 'rh' | 'co2', t: number): number {
  const arr = s[key];
  const i = Math.max(0, Math.min(s.n - 1, Math.round((t - s.t0) / MIN)));
  const v = arr[i]!;
  if (Number.isFinite(v)) return v;
  for (let k = 1; k <= 10; k++) {
    if (i - k >= 0 && Number.isFinite(arr[i - k]!)) return arr[i - k]!;
    if (i + k < s.n && Number.isFinite(arr[i + k]!)) return arr[i + k]!;
  }
  return NaN;
}

/** Per-minute stage codes (−1 = not in bed / no data). */
export function stageMinutes(p: PersonNight, t0: number, n: number): Int8Array {
  const out = new Int8Array(n).fill(-1);
  for (const s of p.sleep.stages) {
    const a = Math.max(0, Math.ceil((s.start - t0) / MIN));
    const b = Math.min(n, Math.ceil((s.end - t0) / MIN));
    for (let i = a; i < b; i++) out[i] = STAGE_CODE[s.stage];
  }
  return out;
}

export type MomentKind = 'start' | 'sleep' | 'deep' | 'awake' | 'hr' | 'co2' | 'rh' | 'ac' | 'alarm' | 'up';
export interface Moment {
  t: number;
  kind: MomentKind;
  /** Person id the moment is about (kicker shows their name). */
  who?: string;
  text: string;
}

export interface StoryPerson {
  id: string;
  name: string;
  color: string;
  night: PersonNight;
  /** First non-awake stage start. */
  onset: number | null;
}

export interface PrecoolFact {
  t: number;
  /** Left column: the time of the fact. */
  lead: string;
  text: string;
  sub: string;
}

export interface AcTick {
  ts: number;
  set: number;
  power: boolean;
  missed: boolean;
  reason: string;
}

export interface StoryModel {
  date: string;
  /** The curve the night is told against (targets, the plan line). */
  curve: TemperatureCurve;
  lo: number;
  wake: number;
  /** Last person up (the chart runs lights-out → end). */
  end: number;
  people: StoryPerson[];
  series: MinuteSeries;
  stages: Int8Array[];
  precool: { start: number; end: number; startTemp: number; endTemp: number; target: number | null; facts: PrecoolFact[] };
  moments: Moment[];
  /** Aircon commands in the chart window. */
  acs: AcTick[];
  air: {
    atLightsOut: number;
    mean: number;
    peak: { ts: number; v: number };
    minsOver1000: number;
    nightMin: number;
    ach: number | null;
    achNeeded: number;
  };
}

export const possessive = (name: string) => (name.toLowerCase() === 'you' ? 'Your' : `${name}’s`);
const lowerYou = (name: string) => (name.toLowerCase() === 'you' ? 'you' : name);
const mins = (ms: number) => Math.round(ms / MIN);
const durShort = (min: number) => dur(min);
const deg = (v: number) => `${fmt(v, 1).replace(/\.0$/, '')}°`;
/** "target 20.5° (set 20°)" when the curve target and the integer IR setpoint differ, else "20°". */
export function targetLabel(target: number | null, setC: number): string {
  if (target === null || !Number.isFinite(target) || Math.abs(target - setC) < 0.05) return `${setC}°`;
  return `${deg(target)} (set ${setC}°)`;
}
const reasonTarget = (reason: string): number | null => {
  const m = /([\d.]+)°C/.exec(reason);
  return m ? Number(m[1]) : null;
};

/** Turns an AC command's machine reason into a short caption. */
export function acCaption(reason: string, setC: number, power: boolean, landed?: boolean | null): string {
  if (!power) return 'Aircon off';
  if (/^resend/.test(reason)) return `Aircon command re-sent, ${setC}°`;
  const tl = targetLabel(reasonTarget(reason), setC);
  const corr = /^correction:\s*([+−-]\d+)\s*\(room ([\d.]+)° (above|below) target\)/.exec(reason);
  if (corr) return corr[3] === 'below' ? `Room ran cold. Aircon nudged to ${setC}°` : `Room ran warm. Aircon nudged to ${setC}°`;
  const phase = /^curve:\s*(\w+)/.exec(reason);
  const missed = landed === false ? ' (missed?)' : '';
  if (phase) {
    const ph = phase[1]!;
    if (ph === 'precool') return `Aircon pre-cool, target ${tl}${missed}`;
    if (ph === 'onset') return `Lights out: fan to low, ${setC}°${missed}`;
    return `Curve stepped to ${tl} for the ${ph} phase${missed}`;
  }
  if (/^schedule/.test(reason)) return `Aircon scheduled, ${setC}°${missed}`;
  return `Aircon set ${setC}°${missed}`;
}

/** Tidy reason for the aircon log ("curve: deep phase 19.0°C (set 19)" → "Curve · deep phase 19.0°C"). */
export function acReason(reason: string): string {
  return reason
    .replace(/\s*\(set \d+(, bias [^)]+)?\)/, '')
    .replace(/\bprecool\b/g, 'pre-cool')
    .replace(/,?\s*([\d.]+)°C/, (_, v: string) => `, target ${deg(Number(v))}`)
    .replace(/(\d)°C/g, '$1°')
    .replace(/^(curve|correction|schedule|manual|resend):\s*/, (_, k: string) => `${k[0]!.toUpperCase()}${k.slice(1)} · `);
}

export function buildStory(night: Night, people: readonly Person[], colorOf: (id: string) => string, detail: NightDetail | null, curve: TemperatureCurve): StoryModel {
  const lo = night.lightsOut;
  const wake = night.wake;
  const end = Math.max(wake, ...night.people.map((p) => p.sleep.end));
  const sp: StoryPerson[] = people
    .map((pp) => {
      const pn = night.people.find((x) => x.personId === pp.id);
      if (!pn) return null;
      const first = pn.sleep.stages.find((s) => s.stage !== 'awake');
      return { id: pp.id, name: pp.name, color: colorOf(pp.id), night: pn, onset: first ? first.start : null };
    })
    .filter((x): x is StoryPerson => !!x);

  // Pre-cool: first power-on command (if it came before lights-out) → the last person into bed.
  const pull = pulldownWindow(night);
  // Lights out runs up to the moment lights go out; anyone getting into bed later is a moment in The night.
  const bedtime = lo;
  const pcStart = pull && pull.start < lo ? pull.start : lo - 90 * MIN;
  const seriesStart = Math.min(pcStart, lo) - 5 * MIN;
  const series = minuteSeries(night, seriesStart, end + 30 * MIN);
  const stages = sp.map((p) => stageMinutes(p.night, seriesStart, series.n));
  const startTemp = valueAt(series, 'temp', pcStart);
  const endTemp = valueAt(series, 'temp', bedtime);
  const target = targetAt(curve, lo, lo);

  const facts: PrecoolFact[] = [];
  const firstCmd = [...night.ac].sort((a, b) => a.ts - b.ts).find((c) => c.state.power && c.ts < lo + 5 * MIN);
  if (firstCmd) {
    facts.push({
      t: firstCmd.ts,
      lead: hm(firstCmd.ts),
      text: acCaption(firstCmd.reason, firstCmd.state.setpointC, true).replace(/^Aircon pre-cool, target /, 'Aircon pre-cool to '),
      sub: `${mins(lo - firstCmd.ts)} min before bed`,
    });
  }
  for (const p of [...sp].sort((a, b) => a.night.sleep.start - b.night.sleep.start)) {
    const t = p.night.sleep.start;
    if (t > lo) continue;
    const tc = valueAt(series, 'temp', t);
    const co2 = valueAt(series, 'co2', t);
    const rh = valueAt(series, 'rh', t);
    facts.push({
      t,
      lead: hm(t),
      text: `${p.name} in bed`,
      sub: p === sp.find((x) => x.night.sleep.start === Math.min(...sp.map((y) => y.night.sleep.start)))
        ? `room ${fmt(tc, 1)}°, ${fmt(rh)}% RH`
        : `CO₂ ${fmt(co2)} ppm${co2 < 800 ? ', still fresh' : ''}`,
    });
  }
  // How long the pull-down took to reach the bedtime target (within 0.5 °C).
  if (Number.isFinite(startTemp) && Number.isFinite(endTemp)) {
    let reached: number | null = null;
    for (let t = pcStart; t <= bedtime; t += MIN) {
      const tg = targetAt(curve, lo, t) ?? target;
      if (tg !== null && valueAt(series, 'temp', t) <= tg + 0.5) {
        reached = t;
        break;
      }
    }
    const delta = endTemp - startTemp;
    const dl = `${delta < 0 ? '−' : '+'}${fmt(Math.abs(delta), 1)}°`;
    facts.push({
      t: reached ?? bedtime,
      lead: hm(reached ?? bedtime),
      text: reached !== null ? `Cooled ${dl} in ${mins(reached - pcStart)} minutes` : `${fmt(endTemp - (target ?? endTemp), 1)}° above target at lights out`,
      sub: reached !== null ? (reached <= lo ? 'ready before bed' : 'just after lights out') : 'the pull-down ran short',
    });
  }
  facts.sort((a, b) => a.t - b.t);

  // ---------- moments (captions in The night) ----------
  const ms: (Moment & { pri: number })[] = [];
  const inBed = sp.filter((p) => p.night.sleep.start <= lo + 2 * MIN).map((p) => p.name);
  ms.push({
    t: lo,
    kind: 'start',
    text: inBed.length === sp.length && sp.length > 1 ? 'Lights out. Both in bed.' : inBed.length ? `Lights out. ${inBed.join(' and ')} in bed.` : 'Lights out.',
    pri: 10,
  });
  const lastUp = sp.length > 1 ? [...sp].sort((a, b) => b.night.sleep.end - a.night.sleep.end)[0]!.id : null;
  for (const p of sp) {
    if (p.night.sleep.start > lo + 2 * MIN) ms.push({ t: p.night.sleep.start, kind: 'start', who: p.id, text: `${p.name} came to bed`, pri: 6 });
    if (p.onset !== null) {
      const lat = mins(p.onset - p.night.sleep.start);
      ms.push({ t: p.onset, kind: 'sleep', who: p.id, text: `${p.name} fell asleep${lat > 0 ? ` after ${lat} min` : ''}`, pri: 9 });
    }
    // Longest deep stretch (adjacent deep segments merged).
    let best: { start: number; end: number } | null = null;
    let run: { start: number; end: number } | null = null;
    for (const s of p.night.sleep.stages) {
      if (s.stage === 'deep') run = run && s.start - run.end < 2 * MIN ? { start: run.start, end: s.end } : { start: s.start, end: s.end };
      else run = null;
      if (run && (!best || run.end - run.start > best.end - best.start)) best = { ...run };
    }
    if (best && best.end - best.start >= 10 * MIN) ms.push({ t: best.start, kind: 'deep', who: p.id, text: `${possessive(p.name)} deepest stretch: ${mins(best.end - best.start)} min`, pri: 8 });
    // Awakenings ≥ 4 min between onset and the final wake (two longest).
    const finalWake = p.night.sleep.stages.at(-1)?.stage === 'awake' ? p.night.sleep.stages.at(-1)!.start : p.night.sleep.end;
    p.night.sleep.stages
      .filter((s) => s.stage === 'awake' && p.onset !== null && s.start > p.onset && s.start < finalWake && s.end - s.start >= 4 * MIN)
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, 2)
      .forEach((s) => ms.push({ t: s.start, kind: 'awake', who: p.id, text: `${p.name} woke for ${mins(s.end - s.start)} min`, pri: 5 }));
    // HR nadir.
    const m = detail?.people.find((x) => x.personId === p.id);
    if (m && Number.isFinite(m.hrNadir) && Number.isFinite(m.hrNadirAtMin)) {
      const t = p.night.sleep.start + m.hrNadirAtMin * MIN;
      if (t > lo && t < end) ms.push({ t, kind: 'hr', who: p.id, text: `${possessive(p.name)} heart rate bottomed out: ${fmt(m.hrNadir)} bpm`, pri: 7 });
    }
    // Up.
    const up = p.night.sleep.end;
    const late = mins(up - wake);
    const upText = late > 5 ? `${p.name} slept on ${late} min past the alarm` : `${p.name} got up`;
    ms.push({ t: up, kind: 'up', who: p.id, text: p.id === lastUp ? `${upText}. Morning, both of you.` : upText, pri: p.id === lastUp ? 8 : 6 });
  }
  // CO₂ thresholds (first crossing inside the sleep window), RH > 60 % (sustained 10 min), peak.
  const scanEnd = Math.min(wake, end);
  for (const th of [1000, 1500]) {
    for (let t = lo; t <= scanEnd; t += MIN) {
      if (valueAt(series, 'co2', t) >= th) {
        if (t > lo + 5 * MIN) ms.push({ t, kind: 'co2', text: `CO₂ crossed ${fmt(th)} ppm`, pri: th === 1000 ? 9 : 8 });
        break;
      }
    }
  }
  for (let t = lo; t <= scanEnd; t += MIN) {
    let ok = true;
    for (let k = 0; k < 10 && ok; k++) ok = valueAt(series, 'rh', t + k * MIN) > 60;
    if (ok) {
      if (t > lo + 5 * MIN) ms.push({ t, kind: 'rh', text: 'Humidity climbed past 60%', pri: 6 });
      break;
    }
  }
  let peak = { ts: lo, v: -Infinity };
  for (let t = lo; t <= wake; t += MIN) {
    const v = valueAt(series, 'co2', t);
    if (v > peak.v) peak = { ts: t, v };
  }
  if (Number.isFinite(peak.v) && peak.v >= 800) ms.push({ t: peak.ts, kind: 'co2', text: `CO₂ peaked at ${fmt(Math.round(peak.v))} ppm`, pri: 7 });
  for (const c of night.ac) {
    if (c.ts <= lo + MIN || c.ts > end) continue;
    ms.push({ t: c.ts, kind: 'ac', text: acCaption(c.reason, c.state.setpointC, c.state.power, c.landed), pri: c.landed === false ? 7 : 6.5 });
  }
  // Room warmed past the curve target (sustained 15 min, after the first hour).
  for (let t = lo + 60 * MIN; t <= scanEnd; t += MIN) {
    let ok = true;
    for (let k = 0; k < 15 && ok; k += 3) {
      const tg = targetAt(curve, lo, t + k * MIN);
      ok = tg !== null && valueAt(series, 'temp', t + k * MIN) > tg + 0.7;
    }
    if (ok) {
      const tg = targetAt(curve, lo, t)!;
      ms.push({ t, kind: 'ac', text: `Room warmed to ${deg(valueAt(series, 'temp', t))}, above the ${deg(tg)} target`, pri: 6 });
      break;
    }
  }
  ms.push({ t: wake, kind: 'alarm', text: sp.length > 1 ? `Alarm at ${hm(wake)}` : `Alarm at ${hm(wake)}. Morning.`, pri: 8 });

  // Cap at 12, dropping the lowest-priority ones; keep moments ≥ 6 min apart (higher priority wins).
  ms.sort((a, b) => b.pri - a.pri || a.t - b.t);
  const kept: typeof ms = [];
  for (const m of ms) {
    if (kept.length >= 12) break;
    if (kept.some((k) => Math.abs(k.t - m.t) < 6 * MIN && !(k.kind === 'start' && m.kind === 'start'))) continue;
    kept.push(m);
  }
  // Fill long silences (> 70 min without a caption) with the best remaining moment inside the gap.
  const near = (m: { t: number }) => kept.some((k) => Math.abs(k.t - m.t) < 6 * MIN);
  for (let guard = 0; guard < 6 && kept.length < 16; guard++) {
    const ts = [lo, ...kept.map((k) => k.t).sort((a, b) => a - b), end];
    let added = false;
    for (let i = 0; i < ts.length - 1 && !added; i++) {
      if (ts[i + 1]! - ts[i]! <= 70 * MIN) continue;
      const mid = (ts[i]! + ts[i + 1]!) / 2;
      const cand = ms
        .filter((m) => !kept.includes(m) && m.t > ts[i]! + 10 * MIN && m.t < ts[i + 1]! - 10 * MIN && !near(m))
        .sort((a, b) => b.pri - a.pri || Math.abs(a.t - mid) - Math.abs(b.t - mid))[0];
      if (cand) {
        kept.push(cand);
        added = true;
      }
    }
    if (!added) break;
  }
  kept.sort((a, b) => a.t - b.t);
  const moments: Moment[] = kept.map(({ pri: _p, ...m }) => m);

  // ---------- air ----------
  let sum = 0;
  let cnt = 0;
  let over = 0;
  for (let t = lo; t <= wake; t += MIN) {
    const v = valueAt(series, 'co2', t);
    if (!Number.isFinite(v)) continue;
    sum += v;
    cnt++;
    if (v > 1000) over++;
  }
  return {
    date: night.date,
    curve,
    lo,
    wake,
    end,
    people: sp,
    series,
    stages,
    precool: { start: pcStart, end: bedtime, startTemp, endTemp, target, facts },
    moments,
    acs: night.ac.filter((c) => c.ts >= lo && c.ts <= end).map((c) => ({ ts: c.ts, set: c.state.setpointC, power: c.state.power, missed: c.landed === false, reason: c.reason })),
    air: {
      atLightsOut: valueAt(series, 'co2', lo),
      mean: cnt ? sum / cnt : NaN,
      peak,
      minsOver1000: over,
      nightMin: Math.max(1, mins(wake - lo)),
      ach: null,
      achNeeded: ACH_FOR_1000,
    },
  };
}

export const whoLabel = (m: Moment, people: readonly StoryPerson[]) => (m.who ? people.find((p) => p.id === m.who)?.name ?? '' : '');
export { lowerYou, durShort };

// ───────────────────────── v2 selectors (docs/DESIGN.md §9.1, §11) ─────────────────────────

/** Time of the highest raw CO₂ reading inside the sleep window (lights out → wake), the one the headline peak uses. */
export function co2PeakAt(night: Night, peak: number): number {
  let best: { ts: number; d: number } = { ts: night.lightsOut, d: Infinity };
  for (const r of night.room) {
    if (r.ts < night.lightsOut || r.ts >= night.wake) continue;
    const d = Math.abs(r.co2 - peak);
    if (d < best.d) best = { ts: r.ts, d };
  }
  return best.ts;
}

/** First minute inside the sleep window at or above `ppm` (interpolated per-minute series), or null. */
export function co2CrossAt(model: StoryModel, ppm = 1000): number | null {
  for (let t = model.lo; t <= model.wake; t += MIN) if (valueAt(model.series, 'co2', t) >= ppm) return t;
  return null;
}

export interface NightStep {
  t: number;
  title: string;
  detail: string;
}

const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);

/**
 * The six steps "The night" holds on (§9.1 scene 3): lights out, then the strongest moments in between (CO₂
 * crossing 1,000, the deepest stretch, aircon corrections, the room warming, long wakes), then wake with the CO₂
 * peak. Every time and value comes from the model (core data); the full list stays in `model.moments`.
 */
export function nightSteps(model: StoryModel, co2Peak: number, peakAt: number, minsOver1000: number, max = 6): NightStep[] {
  const ms = model.moments;
  if (!ms.length) return [];
  const temp = (t: number) => valueAt(model.series, 'temp', t);
  const co2 = (t: number) => valueAt(model.series, 'co2', Math.min(t, model.wake));
  const rh = (t: number) => valueAt(model.series, 'rh', t);
  const first = ms[0]!;
  // The closing step: the last person up (or the alarm).
  const ends = ms.filter((m) => m.kind === 'up' || m.kind === 'alarm');
  const last = ends.at(-1) ?? ms.at(-1)!;
  const rank = (m: Moment): number => {
    if (m.kind === 'co2' && /crossed 1,000/.test(m.text)) return 10;
    if (m.kind === 'deep') return 9;
    if (m.kind === 'ac' && /nudged|ran (warm|cold)/i.test(m.text)) return 8;
    if (m.kind === 'ac' && /warmed/.test(m.text)) return 7.5;
    if (m.kind === 'co2' && /crossed/.test(m.text)) return 7;
    if (m.kind === 'awake') return 6;
    if (m.kind === 'rh') return 5.5;
    if (m.kind === 'hr') return 5;
    if (m.kind === 'sleep') return 4;
    if (m.kind === 'ac') return 3;
    return 1;
  };
  const middle = ms
    .filter((m) => m !== first && m !== last && m.t > first.t + 15 * MIN && m.t < last.t - 15 * MIN && !/peaked/.test(m.text))
    .sort((a, b) => rank(b) - rank(a) || a.t - b.t);
  const chosen: Moment[] = [];
  for (const m of middle) {
    if (chosen.length >= max - 2) break;
    if (chosen.some((c) => Math.abs(c.t - m.t) < 25 * MIN)) continue;
    chosen.push(m);
  }
  const pick = [first, ...chosen.sort((a, b) => a.t - b.t), last];
  return pick.map((m, i) => {
    const t = m.t;
    const tc = temp(t);
    const room = Number.isFinite(tc) ? `Room ${fmt(tc, 1)}°` : 'Room –';
    let detail = '';
    if (i === pick.length - 1) {
      detail = Number.isFinite(co2Peak)
        ? `CO₂ peaked at ${fmt(Math.round(co2Peak))} ppm at ${hm(peakAt)}${minsOver1000 > 0 ? `, ${dur(minsOver1000)} above 1,000 overall` : ''}.`
        : `${room}.`;
    } else if (i === 0) {
      const h = rh(t);
      detail = `${room}${Number.isFinite(h) ? `, humidity ${fmt(h)}%` : ''}.`;
    } else if (m.kind === 'co2') {
      detail = 'Two sleepers, a closed room, no fresh air coming in.';
    } else if (m.kind === 'ac' || m.kind === 'deep') {
      const tg = targetAt(model.curve, model.lo, t);
      detail = tg !== null && Number.isFinite(tc) ? `${room} against a ${deg(tg)} plan.` : `${room}.`;
    } else {
      const c = co2(t);
      detail = `${room}${Number.isFinite(c) ? `, CO₂ ${fmt(Math.round(c / 5) * 5)} ppm` : ''}.`;
    }
    return { t, title: sentence(m.text), detail };
  });
}
