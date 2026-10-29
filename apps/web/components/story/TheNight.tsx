'use client';
// Scene 3 · The night (docs/DESIGN.md §8.3, §9.1). Pinned for about three screens. One signal cursor scrubs both
// hypnograms, room °C against the plan, CO₂ and the aircon ticks; the clock and four readouts follow it. The
// cursor holds on each step's exact minute for the first 35 % of that step, so the readout agrees with the sentence
// being read. Desktop: sticky graphic (steps on the left, instrument on the right). Phone: one step under the chart.
// Per-frame work writes transforms and textContent only (no React renders).
import { useMemo, useRef } from 'react';
import { targetAt } from '@sleep-lab/core';
import { dur, fmt, hm, hourTicks, MIN } from '@/lib/format.ts';
import { linePath, scale } from '../charts/common.tsx';
import { Chapter, useReducedMotion } from '../motion.tsx';
import { useScrub } from './useScrub.ts';
import { Icon } from '../icons.tsx';
import { HypnoBlocks, personScope, STAGE_NAME, useBox } from './parts.tsx';
import { STAGE_BY_CODE, valueAt, type NightStep, type StoryModel } from './model.ts';
import s from './story.module.css';

const HOLD = 0.35;
const DWELL = 0.04;

interface Geo {
  W: number;
  H: number;
  desk: boolean;
  pl: number;
  pr: number;
  plotW: number;
  x: (t: number) => number;
  hyp: { y: number; row: number; gap: number; h: number }[];
  temp: { y: number; h: number; v: (c: number) => number; lo: number; hi: number; ticks: number[] };
  co2: { y: number; h: number; v: (c: number) => number; hi: number; ticks: number[] };
  ac: { y: number; h: number };
  axisY: number;
  bottom: number;
}

function layout(model: StoryModel, W: number, H: number): Geo {
  const desk = W >= 640;
  const pl = desk ? 88 : 0;
  const pr = desk ? 60 : 44;
  const plotW = Math.max(40, W - pl - pr);
  const n = model.people.length;
  const lab = desk ? 0 : 19; // phone: track labels sit above each track
  const gapT = desk ? 22 : 6;
  const row = desk ? Math.max(10, Math.min(18, Math.round(H / 46))) : Math.max(5, Math.min(10, Math.round(H / 56)));
  const rgap = desk ? 4 : 2;
  const hypH = row * 4 + rgap * 3;
  const acH = desk ? 16 : 14;
  const axis = desk ? 30 : 24;
  const fixed = n * (lab + hypH + gapT) + 2 * (lab + gapT) + acH + 8 + axis;
  const free = Math.max(90, H - fixed);
  const tH = Math.round(free / 2);
  const cH = free - tH;
  let y = 4;
  const hyp: Geo['hyp'] = [];
  for (let i = 0; i < n; i++) {
    y += lab;
    hyp.push({ y, row, gap: rgap, h: hypH });
    y += hypH + gapT;
  }
  y += lab;
  const tY = y;
  y += tH + gapT + lab;
  const cY = y;
  y += cH + gapT;
  const acY = y;
  y += acH + 8;
  const axisY = y;

  // Night tracks: room °C on a clamped 18–23 scale (out-of-range values are told in words, §7.1).
  const tLo = 18;
  const tHi = 23;
  let cMax = 1400;
  for (let t = model.lo; t <= model.wake; t += 5 * MIN) cMax = Math.max(cMax, valueAt(model.series, 'co2', t) || 0);
  const cHi = Math.ceil(cMax / 200) * 200;
  return {
    W,
    H,
    desk,
    pl,
    pr,
    plotW,
    x: scale(model.lo, model.end, 0, plotW),
    hyp,
    temp: { y: tY, h: tH, v: scale(tLo, tHi, tY + tH, tY), lo: tLo, hi: tHi, ticks: [19, 21, 23] },
    co2: { y: cY, h: cH, v: scale(400, cHi, cY + cH, cY), hi: cHi, ticks: [600, 1000, cHi >= 1400 ? 1400 : cHi] },
    ac: { y: acY, h: acH },
    axisY,
    bottom: axisY + axis,
  };
}

/** The data, in plot coordinates (x from 0). Rendered twice: the ghost (thin, --ghost) and the revealed copy. */
function DataLayer({ model, g, ghost }: { model: StoryModel; g: Geo; ghost: boolean }) {
  const paths = useMemo(() => {
    const step = Math.max(MIN, ((model.end - model.lo) / g.plotW) * 2);
    const temp: { x: number; y: number }[] = [];
    const plan: { x: number; y: number }[] = [];
    const co2: { x: number; y: number }[] = [];
    const over: { x: number; y: number }[] = [];
    const clampT = (v: number) => Math.max(g.temp.lo, Math.min(g.temp.hi, v));
    for (let t = model.lo; t <= model.end + 1; t += step) {
      const x = g.x(t);
      const v = valueAt(model.series, 'temp', t);
      temp.push({ x, y: Number.isFinite(v) ? g.temp.v(clampT(v)) : NaN });
      const tg = targetAt(model.curve, model.lo, t);
      if (tg !== null) plan.push({ x, y: g.temp.v(clampT(tg)) });
      if (t <= model.wake + 1) {
        const c = valueAt(model.series, 'co2', t);
        co2.push({ x, y: Number.isFinite(c) ? g.co2.v(Math.min(c, g.co2.hi)) : NaN });
        if (Number.isFinite(c)) over.push({ x, y: g.co2.v(Math.min(g.co2.hi, Math.max(1000, c))) });
      }
    }
    const y1000 = g.co2.v(1000);
    const area = over.length > 1 ? `M${over[0]!.x.toFixed(1)},${y1000}${over.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')}L${over.at(-1)!.x.toFixed(1)},${y1000}Z` : '';
    return { temp: linePath(temp, 12), plan: linePath(plan), co2: linePath(co2, 12), area };
  }, [model, g]);
  const y1000 = g.co2.v(1000);
  const gid = `nc-${ghost ? 'g' : 'b'}`;
  return (
    <svg width={g.plotW} height={g.H} aria-hidden style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={g.co2.y} y2={g.co2.y + g.co2.h}>
          <stop offset={Math.max(0, Math.min(1, (y1000 - g.co2.y) / g.co2.h))} stopColor="var(--signal)" />
          <stop offset={Math.max(0, Math.min(1, (y1000 - g.co2.y) / g.co2.h))} stopColor="var(--text)" />
        </linearGradient>
      </defs>
      {model.people.map((p, i) => {
        const lane = g.hyp[i]!;
        return (
          <g key={p.id} className={personScope(i)}>
            <HypnoBlocks stages={p.night.sleep.stages} x={g.x} from={model.lo} to={model.end} y={lane.y} row={lane.row} gap={lane.gap} />
          </g>
        );
      })}
      {!ghost && <path d={paths.area} fill="var(--signal-soft)" />}
      <path d={paths.temp} fill="none" stroke="var(--text)" strokeWidth={ghost ? 1 : 2} strokeLinejoin="round" strokeLinecap="round" />
      <path d={paths.co2} fill="none" stroke={ghost ? 'var(--text)' : `url(#${gid})`} strokeWidth={ghost ? 1 : 2} strokeLinejoin="round" strokeLinecap="round" />
      {model.acs.map((a, i) => (
        <rect key={i} x={g.x(a.ts) - 1} y={g.ac.y} width={2} height={g.ac.h} rx={1} fill={a.missed ? 'var(--signal)' : 'var(--text)'} />
      ))}
    </svg>
  );
}

/** Static frame: track labels, gridlines on the hour, the plan (dashed), the 1,000 ppm threshold and the axes. */
function Frame({ model, g, people }: { model: StoryModel; g: Geo; people: string[] }) {
  const ticks = hourTicks(model.lo, model.end, g.plotW < 520 ? 2 : 1);
  const X = (t: number) => g.pl + g.x(t);
  const right = g.pl + g.plotW;
  const label = (y: number, text: string) =>
    g.desk ? (
      <text x={0} y={y + 14} className={s.trackLabel}>
        {text}
      </text>
    ) : (
      <text x={0} y={y - 6} className={s.trackLabel}>
        {text}
      </text>
    );
  const planD = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    for (let t = model.lo; t <= model.end; t += 4 * MIN) {
      const tg = targetAt(model.curve, model.lo, t);
      if (tg !== null) pts.push({ x: X(t), y: g.temp.v(Math.max(g.temp.lo, Math.min(g.temp.hi, tg))) });
    }
    return linePath(pts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, g]);
  const top = (g.hyp[0]?.y ?? g.temp.y) - 2;
  return (
    <svg width={g.W} height={g.bottom} className={s.svgAbs} aria-hidden>
      {ticks.map((t) => (
        <line key={t} x1={X(t)} x2={X(t)} y1={top} y2={g.ac.y + g.ac.h} stroke="var(--grid)" />
      ))}
      {g.hyp.map((h, i) => (
        <g key={i}>
          {label(h.y, people[i] ?? '')}
          {g.desk &&
            (h.row >= 13 ? ['Awake', 'REM', 'Light', 'Deep'] : ['Awake', '', '', 'Deep']).map((name, k) =>
              name ? (
                <text key={name} x={right + 10} y={h.y + k * (h.row + h.gap) + h.row - 1} className={s.tickSm}>
                  {name}
                </text>
              ) : null,
            )}
        </g>
      ))}
      {label(g.temp.y, 'Room °C')}
      {g.temp.ticks.map((v) => (
        <g key={v}>
          <line x1={g.pl} x2={right} y1={g.temp.v(v)} y2={g.temp.v(v)} stroke="var(--grid)" />
          <text x={right + 10} y={g.temp.v(v) + 5} className={s.tick}>
            {v}°
          </text>
        </g>
      ))}
      <path d={planD} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 4" />
      {g.desk && (
        <text x={g.pl + 6} y={g.temp.y + 16} className={s.tickSm}>
          Dashed: the plan
        </text>
      )}
      {label(g.co2.y, 'CO₂ ppm')}
      {g.co2.ticks.map((v) =>
        v === 1000 ? null : (
          <g key={v}>
            <line x1={g.pl} x2={right} y1={g.co2.v(v)} y2={g.co2.v(v)} stroke="var(--grid)" />
            <text x={right + 10} y={g.co2.v(v) + 5} className={s.tick}>
              {fmt(v)}
            </text>
          </g>
        ),
      )}
      <line x1={g.pl} x2={right} y1={g.co2.v(1000)} y2={g.co2.v(1000)} stroke="var(--signal)" strokeDasharray="2 3" />
      <text x={right + 10} y={g.co2.v(1000) + 5} className={s.tickSig}>
        1,000
      </text>
      {label(g.ac.y - (g.desk ? 2 : 0), 'Aircon')}
      {g.desk && (
        <text x={0} y={g.ac.y + 30} className={s.tickSm}>
          commands
        </text>
      )}
      <line x1={g.pl} x2={right} y1={g.axisY - 2} y2={g.axisY - 2} stroke="var(--axis)" />
      {ticks.map((t) => {
        const x = X(t);
        if (x < g.pl + 14 && !g.desk) return null;
        return (
          <text key={t} x={x} y={g.axisY + 16} textAnchor="middle" className={s.tick}>
            {hm(t)}
          </text>
        );
      })}
    </svg>
  );
}

/** Scroll progress → night time, holding on each step's minute for the first 35 % of its share. */
function timeAt(p: number, steps: readonly NightStep[], model: StoryModel): number {
  const n = steps.length;
  if (!n) return model.lo + p * (model.end - model.lo);
  const pos = [...steps.map((x) => x.t), model.end];
  const f = Math.max(0, Math.min(0.99999, p)) * n;
  const i = Math.floor(f);
  const u = f - i;
  if (p >= 1) return model.end;
  if (u < HOLD) return pos[i]!;
  const k = (u - HOLD) / (1 - HOLD);
  const e = k * k * (3 - 2 * k);
  return pos[i]! + (pos[i + 1]! - pos[i]!) * e;
}

export function TheNight({ model, steps, onOpenStrip }: { model: StoryModel; steps: NightStep[]; onOpenStrip: () => void }) {
  const reduced = useReducedMotion();
  const darkMin = Math.round((model.wake - model.lo) / MIN);
  return (
    <Chapter id="night" title="The night" pinned={2.4} dwell={DWELL} className={s.night} innerClassName={s.nightInner}>
      <Stage model={model} steps={steps} darkMin={darkMin} reduced={reduced} onOpenStrip={onOpenStrip} />
    </Chapter>
  );
}

function Stage({ model, steps, darkMin, reduced, onOpenStrip }: { model: StoryModel; steps: NightStep[]; darkMin: number; reduced: boolean; onOpenStrip: () => void }) {
  const [box, { w, h }] = useBox<HTMLDivElement>();
  const g = useMemo(() => (w > 0 && h > 0 ? layout(model, w, h) : null), [model, w, h]);
  const clock = useRef<HTMLDivElement>(null);
  const reads = useRef<(HTMLElement | null)[]>([]);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const dotT = useRef<HTMLDivElement>(null);
  const dotC = useRef<HTMLDivElement>(null);
  const last = useRef<{ txt: string[]; on: number; hot: boolean | null; key: unknown }>({ txt: [], on: -2, hot: null, key: null });
  const n = model.people.length;

  useScrub((p) => {
    const t = timeAt(p, steps, model);
    const L = last.current;
    if (L.key !== g) {
      L.key = g;
      L.txt = [];
      L.on = -2;
      L.hot = null;
    }
    const set = (i: number, el: HTMLElement | null | undefined, v: string) => {
      if (!el || L.txt[i] === v) return;
      L.txt[i] = v;
      el.textContent = v;
    };
    set(0, clock.current, hm(t));
    const idx = Math.max(0, Math.min(model.series.n - 1, Math.round((t - model.series.t0) / MIN)));
    model.people.forEach((pp, i) => {
      const c = model.stages[i]![idx]!;
      set(1 + i, reads.current[i], c < 0 ? (t < pp.night.sleep.start ? 'Not in bed' : 'Up') : STAGE_NAME[STAGE_BY_CODE[c]!]);
    });
    const temp = valueAt(model.series, 'temp', t);
    const co2 = valueAt(model.series, 'co2', Math.min(t, model.wake));
    set(10, reads.current[n], Number.isFinite(temp) ? `${fmt(temp, 1)}°` : '–');
    set(11, reads.current[n + 1], Number.isFinite(co2) ? fmt(Math.round(co2 / 5) * 5) : '–');
    const hot = co2 >= 1000;
    if (hot !== L.hot) {
      L.hot = hot;
      reads.current[n + 1]?.parentElement?.classList.toggle(s.hot!, hot);
    }
    let on = 0;
    for (let i = 0; i < steps.length; i++) if (steps[i]!.t <= t + 20_000) on = i;
    if (on !== L.on) {
      L.on = on;
      items.current.forEach((el, i) => {
        if (!el) return;
        el.classList.toggle(s.on!, i === on);
        el.classList.toggle(s.past!, i < on);
      });
    }
    if (g) {
      const f = Math.max(0, Math.min(1, (t - model.lo) / (model.end - model.lo)));
      if (outer.current) outer.current.style.transform = `translate3d(${((f - 1) * 100).toFixed(3)}%,0,0)`;
      if (inner.current) inner.current.style.transform = `translate3d(${((1 - f) * 100).toFixed(3)}%,0,0)`;
      if (cursor.current) cursor.current.style.transform = `translate3d(${(f * g.plotW).toFixed(1)}px,0,0)`;
      const ty = Number.isFinite(temp) ? g.temp.v(Math.max(g.temp.lo, Math.min(g.temp.hi, temp))) : -99;
      const cAt = valueAt(model.series, 'co2', t);
      const cy = Number.isFinite(cAt) && t <= model.wake ? g.co2.v(Math.min(g.co2.hi, cAt)) : -99;
      if (dotT.current) {
        dotT.current.style.transform = `translate3d(0,${ty.toFixed(1)}px,0)`;
        dotT.current.style.opacity = ty < 0 ? '0' : '1';
      }
      if (dotC.current) {
        dotC.current.style.transform = `translate3d(0,${cy.toFixed(1)}px,0)`;
        dotC.current.style.opacity = cy < 0 ? '0' : '1';
      }
    }
  }, [0, 1], [g, model, steps]);

  /** Click a step (desktop): scroll to where the cursor holds on it. */
  const goTo = (i: number) => {
    const sec = document.getElementById('night');
    if (!sec) return;
    const top = sec.getBoundingClientRect().top + window.scrollY;
    const range = sec.offsetHeight - window.innerHeight;
    const p = (i + HOLD / 2) / Math.max(1, steps.length);
    window.scrollTo({ top: top + range * (DWELL + p * (1 - 2 * DWELL)), behavior: reduced ? 'auto' : 'smooth' });
  };

  const summary = `${dur(darkMin)} from lights out at ${hm(model.lo)} to the alarm at ${hm(model.wake)}. ${steps.map((x) => `${hm(x.t)}: ${x.title}`).join(' ')}`;

  return (
    <div className={s.nightGrid}>
      <div className={s.nightText}>
        <div className={s.nightHead}>
          <div className={s.nightHeadRow}>
            <p className="label">The night</p>
            <button type="button" className={`${s.textBtn} ${s.phoneOnly}`} onClick={onOpenStrip}>
              Whole night <Icon name="chevron-right" size={16} />
            </button>
          </div>
          <h2 className={`title ${s.nightTitle}`}>{dur(darkMin)} in the dark.</h2>
        </div>
        <ol className={s.steps} aria-label="The night, step by step">
          {steps.map((x, i) => (
            <li key={i} ref={(el) => void (items.current[i] = el)} className={i === 0 ? s.on : undefined}>
              <button type="button" onClick={() => goTo(i)} tabIndex={-1}>
                <time className="num">{hm(x.t)}</time>
                <b>{x.title}</b>
                <span>{x.detail}</span>
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className={`${s.textBtn} ${s.deskOnly}`} onClick={onOpenStrip}>
          The whole night, minute by minute <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <div className={s.nightVis}>
        <div className={s.readout}>
          <div ref={clock} className={`num ${s.clock}`} aria-hidden>
            {hm(model.lo)}
          </div>
          <dl className={s.cells} aria-hidden>
            {model.people.map((p, i) => (
              <div key={p.id}>
                <dt>{p.name}</dt>
                <dd ref={(el) => void (reads.current[i] = el)}>–</dd>
              </div>
            ))}
            <div>
              <dt>Room</dt>
              <dd ref={(el) => void (reads.current[n] = el)} className="num">
                –
              </dd>
            </div>
            <div>
              <dt>CO₂</dt>
              <dd ref={(el) => void (reads.current[n + 1] = el)} className="num">
                –
              </dd>
            </div>
          </dl>
        </div>
        <div ref={box} className={s.nightFig} role="img" aria-label={summary}>
          {g && (
            <>
              <Frame model={model} g={g} people={model.people.map((p) => p.name)} />
              <div className={`wipe ${s.plot}`} style={{ left: g.pl, width: g.plotW, height: g.bottom }}>
                <div className="wipe-ghost" aria-hidden>
                  <DataLayer model={model} g={g} ghost />
                </div>
                <div ref={outer} className="wipe-outer">
                  <div ref={inner} className="wipe-inner">
                    <DataLayer model={model} g={g} ghost={false} />
                  </div>
                </div>
                <div ref={cursor} className={s.cursor} aria-hidden>
                  <i style={{ top: (g.hyp[0]?.y ?? g.temp.y) - 6, height: g.ac.y + g.ac.h - (g.hyp[0]?.y ?? g.temp.y) + 6 }} />
                  <div ref={dotT} className={s.dot} />
                  <div ref={dotC} className={s.dot} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
