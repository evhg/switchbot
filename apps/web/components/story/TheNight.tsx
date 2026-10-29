'use client';
// 03 · The night — pinned 560svh, the centrepiece (docs/DESIGN.md §10). One cursor scrubs both hypnograms, room
// °C, CO₂ and the aircon ticks together. The bright chart is revealed over its ghost by the compositor-only wipe;
// the cursor, its dots and the readouts are moved / rewritten from the chapter's progress (refs only, no renders).
// Captions come from real moments in the data (model.ts) and crossfade as the cursor passes them.
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { targetAt, type TemperatureCurve } from '@sleep-lab/core';
import { fmt, hm, hourTicks, ictMidnight, MIN } from '@/lib/format.ts';
import { co2Tolerance, linePath, scale } from '../charts/common.tsx';
import { STAGE_LABEL } from '../charts/NightStrip.tsx';
import { Icon } from '../icons.tsx';
import { Chapter, Cursor, remap, ScrubWipe, setSky, useReducedMotion } from '../motion.tsx';
import { useScrub } from './useScrub.ts';
import { STAGE_BY_CODE, valueAt, whoLabel, type AcTick, type Moment, type StoryModel } from './model.ts';
import s from './story.module.css';

const KIND_COLOR: Record<Moment['kind'], string> = {
  start: 'var(--ch-accent)',
  sleep: 'var(--stage-light)',
  deep: 'var(--stage-deep)',
  awake: 'var(--stage-awake)',
  hr: 'var(--person-a)',
  co2: 'var(--co2)',
  rh: 'var(--rh)',
  ac: 'var(--temp)',
  alarm: 'var(--text)',
  up: 'var(--text)',
};
export const momentColor = (m: Moment, model: StoryModel) => (m.kind === 'hr' && m.who ? model.people.find((p) => p.id === m.who)?.color ?? KIND_COLOR.hr : KIND_COLOR[m.kind]);

function useBox<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (w: number, h: number) => setBox((b) => (Math.abs(b.w - w) < 1 && Math.abs(b.h - h) < 1 ? b : { w: Math.round(w), h: Math.round(h) }));
    set(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver((e) => {
      const r = e[0]?.contentRect;
      if (r) set(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box];
}

interface Geo {
  W: number;
  H: number;
  x: (t: number) => number;
  hyp: { y: number; h: number }[];
  temp: { y: number; h: number; v: (c: number) => number; lo: number; hi: number };
  co2: { y: number; h: number; v: (c: number) => number; hi: number };
  ac: { y: number };
  axisY: number;
}

const LBL = 15;
function layout(model: StoryModel, W: number, H: number): Geo {
  const n = model.people.length;
  const axisH = 16;
  const acH = 12 + LBL;
  const gaps = 7 * (n + 2);
  const avail = Math.max(120, H - axisH - acH - LBL * (n + 2) - gaps);
  const share = n === 2 ? [0.2, 0.2, 0.27, 0.33] : n === 1 ? [0.3, 0.3, 0.4] : [0.5, 0.5];
  let y = 0;
  const hyp: { y: number; h: number }[] = [];
  for (let i = 0; i < n; i++) {
    y += LBL;
    const h = Math.round(avail * share[i]!);
    hyp.push({ y, h });
    y += h + 7;
  }
  y += LBL;
  const tH = Math.round(avail * share[n]!);
  const tY = y;
  y += tH + 7 + LBL;
  const cH = Math.round(avail * share[n + 1]!);
  const cY = y;
  y += cH + 7;
  const acY = y + LBL - 4;
  const axisY = acY + 12 + 4;

  const x = scale(model.lo, model.end, 0, W);
  const temps: number[] = [];
  for (let t = model.lo; t <= model.end; t += 5 * MIN) {
    const v = valueAt(model.series, 'temp', t);
    if (Number.isFinite(v)) temps.push(v);
  }
  const lo = Math.floor(Math.min(...temps, 19) - 0.3);
  const hi = Math.max(lo + 3, Math.ceil(Math.max(...temps) + 0.3));
  let cMax = 1200;
  for (let t = model.lo; t <= model.end; t += 5 * MIN) cMax = Math.max(cMax, valueAt(model.series, 'co2', t) || 0);
  const cHi = Math.ceil((cMax + 100) / 100) * 100;
  return {
    W,
    H,
    x,
    hyp,
    temp: { y: tY, h: tH, v: scale(lo, hi, tY + tH, tY), lo, hi },
    co2: { y: cY, h: cH, v: scale(400, cHi, cY + cH, cY), hi: cHi },
    ac: { y: acY },
    axisY,
  };
}

/** The data layer (rendered twice: ghost + bright). */
function NightLayer({ model, g, curve, copy }: { model: StoryModel; g: Geo; curve: TemperatureCurve; copy: string }) {
  const paths = useMemo(() => {
    const step = Math.max(MIN, ((model.end - model.lo) / g.W) * 2);
    const temp: { x: number; y: number }[] = [];
    const tgt: { x: number; y: number }[] = [];
    const co2: { x: number; y: number }[] = [];
    const rib: { x: number; hi: number; lo: number }[] = [];
    for (let t = model.lo; t <= model.end + 1; t += step) {
      const x = g.x(t);
      const v = valueAt(model.series, 'temp', t);
      temp.push({ x, y: Number.isFinite(v) ? g.temp.v(v) : NaN });
      const tg = targetAt(curve, model.lo, t);
      if (tg !== null) tgt.push({ x, y: g.temp.v(tg) });
      const c = valueAt(model.series, 'co2', t);
      co2.push({ x, y: Number.isFinite(c) ? g.co2.v(Math.min(c, g.co2.hi)) : NaN });
      if (Number.isFinite(c)) rib.push({ x, hi: g.co2.v(Math.min(g.co2.hi, c + co2Tolerance(c))), lo: g.co2.v(Math.max(400, c - co2Tolerance(c))) });
    }
    const base = g.co2.y + g.co2.h;
    const fin = co2.filter((p) => Number.isFinite(p.y));
    const area = fin.length > 1 ? `M${fin[0]!.x.toFixed(1)},${base}${fin.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')}L${fin.at(-1)!.x.toFixed(1)},${base}Z` : '';
    const ribbon = rib.length > 1 ? `M${rib.map((p) => `${p.x.toFixed(1)},${p.hi.toFixed(1)}`).join('L')}L${[...rib].reverse().map((p) => `${p.x.toFixed(1)},${p.lo.toFixed(1)}`).join('L')}Z` : '';
    return { temp: linePath(temp, 12), tgt: linePath(tgt), co2: linePath(co2, 12), area, ribbon };
  }, [model, g, curve]);
  const y1000 = g.co2.v(1000);
  const gid = `nl-${copy}`;
  return (
    <svg width={g.W} height={g.H} aria-hidden style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`${gid}-c`} gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={g.co2.y} y2={g.co2.y + g.co2.h}>
          <stop offset={0} stopColor="var(--co2)" />
          <stop offset={Math.max(0, Math.min(1, (y1000 - g.co2.y) / g.co2.h))} stopColor="var(--co2)" />
          <stop offset={Math.max(0, Math.min(1, (y1000 - g.co2.y) / g.co2.h))} stopColor="var(--text-2)" />
          <stop offset={1} stopColor="var(--text-2)" />
        </linearGradient>
        <linearGradient id={`${gid}-a`} x1={0} x2={0} y1={0} y2={1}>
          <stop offset={0} stopColor="var(--co2)" stopOpacity={0.3} />
          <stop offset={1} stopColor="var(--co2)" stopOpacity={0} />
        </linearGradient>
      </defs>
      {model.people.map((p, i) => {
        const lane = g.hyp[i]!;
        const lh = lane.h / 4;
        const ly = (code: number) => lane.y + [0, 1, 2, 3][code]! * lh;
        const st = p.night.sleep.stages;
        return (
          <g key={p.id}>
            {st.map((seg, k) => {
              const prev = st[k - 1];
              const code = ['awake', 'rem', 'light', 'deep'].indexOf(seg.stage);
              const x0 = g.x(Math.max(seg.start, model.lo));
              const x1 = g.x(Math.min(seg.end, model.end));
              if (x1 <= x0) return null;
              const pc = prev ? ['awake', 'rem', 'light', 'deep'].indexOf(prev.stage) : -1;
              return (
                <Fragment key={k}>
                  {prev && <line x1={x0} x2={x0} y1={ly(pc) + lh / 2} y2={ly(code) + lh / 2} stroke="var(--hairline-2)" strokeWidth={1} />}
                  <rect x={x0} y={ly(code) + 1.5} width={Math.max(1.6, x1 - x0 - 0.6)} height={Math.max(2, lh - 3)} rx={2.5} fill={`var(--stage-${seg.stage})`} />
                </Fragment>
              );
            })}
          </g>
        );
      })}
      <path d={paths.tgt} fill="none" stroke="var(--text-2)" strokeOpacity={0.7} strokeWidth={1.2} strokeDasharray="3 3" />
      <path d={paths.temp} fill="none" stroke="var(--temp)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
      <path d={paths.ribbon} fill="var(--co2)" opacity={0.12} />
      <path d={paths.area} fill={`url(#${gid}-a)`} />
      <path d={paths.co2} fill="none" stroke={`url(#${gid}-c)`} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Static frame: lane labels, hour grid, CO₂ bands, the 1,000 line and aircon ticks (always visible). */
function Frame({ model, g, acs }: { model: StoryModel; g: Geo; acs: AcTick[] }) {
  const ticks = hourTicks(model.lo, model.end, g.W < 520 ? 2 : 1);
  const bands = [
    { a: 400, b: 800, f: 'var(--band-good)' },
    { a: 800, b: 1000, f: 'var(--band-warn)' },
    { a: 1000, b: 1500, f: 'var(--band-serious)' },
    { a: 1500, b: 99999, f: 'var(--band-critical)' },
  ];
  const lbl = (y: number, text: string, right?: string, color?: string) => (
    <>
      <text x={0} y={y - 5} className={s.svgLabel}>
        {text}
      </text>
      {right && (
        <text x={g.W} y={y - 5} textAnchor="end" className={s.svgLabel} style={color ? { fill: color } : undefined}>
          {right}
        </text>
      )}
    </>
  );
  return (
    <svg width={g.W} height={g.H} className={s.svgAbs} aria-hidden>
      {ticks.map((t) => (
        <line key={t} x1={g.x(t)} x2={g.x(t)} y1={(g.hyp[0]?.y ?? g.temp.y) - 2} y2={g.axisY - 2} stroke="var(--grid)" />
      ))}
      {model.people.map((p, i) => (
        <g key={p.id}>{lbl(g.hyp[i]!.y, p.name.toUpperCase(), i === 0 ? 'AWAKE · REM · LIGHT · DEEP' : undefined)}</g>
      ))}
      {lbl(g.temp.y, 'ROOM °C', `${g.temp.lo}–${g.temp.hi}° · TARGET ┄`)}
      {lbl(g.co2.y, 'CO₂ PPM', '┄ 1,000', 'var(--co2)')}
      {bands.map((b) => {
        const y0 = g.co2.v(Math.min(b.b, g.co2.hi));
        const y1 = g.co2.v(Math.max(b.a, 400));
        return y1 > y0 ? <rect key={b.a} x={0} y={y0} width={g.W} height={y1 - y0} fill={b.f} /> : null;
      })}
      <line x1={0} x2={g.W} y1={g.co2.v(1000)} y2={g.co2.v(1000)} stroke="var(--co2)" strokeOpacity={0.7} strokeDasharray="2 3" />
      {lbl(g.ac.y, 'AIRCON')}
      <line x1={0} x2={g.W} y1={g.ac.y + 6} y2={g.ac.y + 6} stroke="var(--grid)" />
      {acs.map((a, i) => (
        <rect key={i} x={g.x(a.ts) - 1.5} y={g.ac.y} width={3} height={12} rx={1.5} fill={a.missed ? 'var(--critical)' : a.power ? 'var(--setpoint)' : 'var(--muted)'} />
      ))}
      {ticks.map((t) => {
        const x = g.x(t);
        if (x < 10 || x > g.W - 10) return null;
        return (
          <text key={t} x={x} y={g.axisY + 12} textAnchor="middle" className={s.svgLabel}>
            {hm(t).slice(0, 2)}
          </text>
        );
      })}
    </svg>
  );
}

function Readouts({ model, readRefs }: { model: StoryModel; readRefs: React.MutableRefObject<(HTMLElement | null)[]> }) {
  return (
    <dl className={s.reads}>
      {model.people.map((p, i) => (
        <Fragment key={p.id}>
          <dt>
            <i style={{ background: p.color }} />
            {p.name}
          </dt>
          <dd ref={(el) => void (readRefs.current[i] = el)}>–</dd>
        </Fragment>
      ))}
      <dt>Room</dt>
      <dd ref={(el) => void (readRefs.current[model.people.length] = el)}>–</dd>
      <dt>CO₂</dt>
      <dd ref={(el) => void (readRefs.current[model.people.length + 1] = el)}>–</dd>
    </dl>
  );
}

function Stage({ model, curve, acs }: { model: StoryModel; curve: TemperatureCurve; acs: AcTick[] }) {
  const [box, { w, h }] = useBox<HTMLDivElement>();
  const g = useMemo(() => (w > 0 && h > 0 ? layout(model, w, h) : null), [model, w, h]);
  const clock = useRef<HTMLDivElement>(null);
  const reads = useRef<(HTMLElement | null)[]>([]);
  const caps = useRef<(HTMLDivElement | null)[]>([]);
  const prev = useRef<HTMLDivElement>(null);
  const dotT = useRef<HTMLDivElement>(null);
  const dotC = useRef<HTMLDivElement>(null);
  const last = useRef<{ txt: string[]; cap: number; co2hot: boolean | null; model: StoryModel | null }>({ txt: [], cap: -2, co2hot: null, model: null });
  const moments = model.moments;
  useScrub((p) => {
    const t = model.lo + p * (model.end - model.lo);
    const L = last.current;
    if (L.model !== model) {
      L.model = model;
      L.txt = [];
      L.cap = -2;
      L.co2hot = null;
    }
    const set = (i: number, el: HTMLElement | null | undefined, v: string) => {
      if (L.txt[i] === v || !el) return;
      L.txt[i] = v;
      el.textContent = v;
    };
    set(0, clock.current, hm(t));
    const idx = Math.max(0, Math.min(model.series.n - 1, Math.round((t - model.series.t0) / MIN)));
    model.people.forEach((pp, i) => {
      const c = model.stages[i]![idx]!;
      const label = c < 0 ? (t < pp.night.sleep.start ? 'NOT IN BED' : 'UP') : STAGE_LABEL[STAGE_BY_CODE[c]!].toUpperCase();
      set(1 + i, reads.current[i], label);
    });
    const temp = valueAt(model.series, 'temp', t);
    const co2 = valueAt(model.series, 'co2', Math.min(t, model.wake));
    set(10, reads.current[model.people.length], `${fmt(temp, 1)}°`);
    set(11, reads.current[model.people.length + 1], fmt(Math.round(co2 / 5) * 5));
    const hot = co2 >= 1000;
    if (hot !== L.co2hot) {
      L.co2hot = hot;
      reads.current[model.people.length + 1]?.classList.toggle(s.hot!, hot);
    }
    if (g) {
      if (dotT.current) dotT.current.style.transform = `translate3d(0,${(Number.isFinite(temp) ? g.temp.v(Math.max(g.temp.lo, Math.min(g.temp.hi, temp))) : -40).toFixed(1)}px,0)`;
      const cAt = valueAt(model.series, 'co2', t);
      if (dotC.current) dotC.current.style.transform = `translate3d(0,${(Number.isFinite(cAt) ? g.co2.v(Math.min(g.co2.hi, cAt)) : -40).toFixed(1)}px,0)`;
    }
    let k = 0;
    for (let i = 0; i < moments.length; i++) if (moments[i]!.t <= t + 20_000) k = i;
    if (k !== L.cap) {
      L.cap = k;
      caps.current.forEach((el, i) => {
        if (!el) return;
        el.classList.toggle(s.cur!, i === k);
        el.classList.toggle(s.past!, i < k);
      });
      const pm = moments[k - 1];
      if (prev.current) prev.current.textContent = pm ? `Before · ${hm(pm.t)} ${pm.text}` : '';
    }
  }, [0, 1], [model, g]);
  return (
    <>
      <div className={s.nowRow}>
        <div ref={clock} className={`t-clock sm num ${s.now}`}>
          {hm(model.lo)}
        </div>
        <Readouts model={model} readRefs={reads} />
      </div>
      <div ref={box} className={s.nightChart}>
        {g && (
          <>
            <Frame model={model} g={g} acs={acs} />
            <ScrubWipe style={{ position: 'absolute', inset: 0 }}>{(copy) => <NightLayer model={model} g={g} curve={curve} copy={copy} />}</ScrubWipe>
            <div className={s.cursorArea} style={{ height: g.axisY - 2 }}>
              <Cursor className={`accent ${s.cursor}`}>
                {/* The line is drawn only inside the lanes, so it never crosses the lane labels in the gutters. */}
                {[...g.hyp, g.temp, g.co2].map((l, i) => (
                  <i key={i} className={s.cursorSeg} style={{ top: l.y, height: l.h }} />
                ))}
                <div className={s.cursorHead} style={{ top: (g.hyp[0]?.y ?? g.temp.y) - 4 }} />
                <div ref={dotT} className={s.cursorDot} style={{ ['--dc' as string]: 'var(--temp)' }} />
                <div ref={dotC} className={s.cursorDot} style={{ ['--dc' as string]: 'var(--co2)' }} />
              </Cursor>
            </div>
          </>
        )}
      </div>
      <div className={s.caps} aria-live="polite">
        {moments.map((m, i) => (
          <div key={i} ref={(el) => void (caps.current[i] = el)} className={s.cap} style={{ ['--mc' as string]: momentColor(m, model) }}>
            <span className="t-label">
              {hm(m.t)}
              {m.who ? ` · ${whoLabel(m, model.people)}` : ''}
            </span>
            <div className="t-h2">{m.text}</div>
          </div>
        ))}
      </div>
      <div ref={prev} className={`t-micro ${s.prevCap}`} />
    </>
  );
}

export function TheNight({ model, curve, onOpenStrip }: { model: StoryModel; curve: TemperatureCurve; onOpenStrip: () => void }) {
  const reduced = useReducedMotion();
  const dawn0 = ictMidnight(model.date) + 4.5 * 3_600_000;
  return (
    <Chapter
      id="night"
      n={3}
      title="The night"
      accent="night"
      pinned={5.6}
      className="bleed"
      innerClassName={s.nightInner}
      onProgress={(p) => {
        const t = model.lo + p * (model.end - model.lo);
        const d = remap(t, dawn0, model.wake);
        setSky({ dusk: 0, mid: 1 - d, dawn: d, dim: 0 });
      }}
    >
      <div className={s.nightHead}>
        <div className="sh-kicker t-label">
          <span>03</span>
          <span>The night</span>
        </div>
        <button type="button" className={`${s.stripLink} t-label press`} onClick={onOpenStrip}>
          Full night strip <Icon name="arrow-up-right" size={13} />
        </button>
      </div>
      <Stage model={model} curve={curve} acs={model.acs} />
      {reduced && (
        <ol className={s.timeline} aria-label="The night, moment by moment">
          {model.moments.map((m, i) => (
            <li key={i}>
              <span className="mono" style={{ color: momentColor(m, model) }}>
                {hm(m.t)}
              </span>
              <span>
                {m.who ? <i className={s.tlDot} style={{ background: model.people.find((p) => p.id === m.who)?.color }} aria-hidden /> : null}
                {m.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Chapter>
  );
}
