'use client';
// 02 · Lights out — pinned 250svh (docs/DESIGN.md §10). Scroll scrubs the clock from the pre-cool command to the
// last person into bed: the °C readout, the "since" delta, the temperature line (compositor wipe) with a dot on
// its tip, and the fact rows lighting up as their moment passes. Readouts change only when their text changes.
import { useMemo, useRef } from 'react';
import { fmt, hm } from '@/lib/format.ts';
import { linePath, scale } from '../charts/common.tsx';
import { Chapter, ScrubWipe, setSky } from '../motion.tsx';
import { useScrub } from './useScrub.ts';
import { useWidth } from '../ui.tsx';
import { valueAt, type StoryModel } from './model.ts';
import s from './story.module.css';

const RANGE = [0, 0.8] as const;
const H = 132;

function Clock({ model }: { model: StoryModel }) {
  const { start, end } = model.precool;
  const hh = useRef<HTMLSpanElement>(null);
  const mm = useRef<HTMLSpanElement>(null);
  const temp = useRef<HTMLSpanElement>(null);
  const since = useRef<HTMLSpanElement>(null);
  const facts = useRef<(HTMLLIElement | null)[]>([]);
  const label = useRef<HTMLSpanElement>(null);
  const last = useRef({ clock: '', temp: '', since: '', on: -1 });
  useScrub((p) => {
    const t = start + p * (end - start);
    const c = hm(t);
    if (c !== last.current.clock) {
      last.current.clock = c;
      if (hh.current) hh.current.textContent = c.slice(0, 2);
      if (mm.current) mm.current.textContent = c.slice(3);
    }
    const v = valueAt(model.series, 'temp', t);
    const tv = fmt(v, 1);
    if (tv !== last.current.temp) {
      last.current.temp = tv;
      if (temp.current) temp.current.textContent = tv;
    }
    const d = v - model.precool.startTemp;
    const sv = t - start < 4 * 60_000 ? 'pre-cool starting' : `${d < 0 ? '−' : '+'}${fmt(Math.abs(d), 1)}° since ${hm(start)}`;
    if (sv !== last.current.since) {
      last.current.since = sv;
      if (since.current) since.current.textContent = sv;
    }
    if (label.current) {
      const lv = p >= 1 ? 'Room air · lights out' : 'Room air';
      if (label.current.textContent !== lv) label.current.textContent = lv;
    }
    let on = -1;
    model.precool.facts.forEach((f, i) => {
      if (f.t <= t + 30_000 || p >= 1) on = i;
    });
    if (on !== last.current.on) {
      last.current.on = on;
      facts.current.forEach((el, i) => el?.classList.toggle(s.on!, i <= on));
    }
  }, RANGE, [model]);
  const c0 = hm(end);
  return (
    <>
      <div className={`t-clock num ${s.clock}`} aria-label={`Lights out ${hm(model.lo)}`}>
        <span ref={hh}>{c0.slice(0, 2)}</span>
        <span className={s.colon}>:</span>
        <span ref={mm}>{c0.slice(3)}</span>
      </div>
      <div className={s.therm}>
        <div className={`t-big num ${s.thermNum}`}>
          <span ref={temp}>{fmt(model.precool.endTemp, 1)}</span>
          <span className={s.thermUnit}>°C</span>
        </div>
        <div className={`t-label ${s.thermSide}`}>
          <span ref={label}>Room air</span>
          <span ref={since} className="t2" style={{ textTransform: 'none', letterSpacing: '.04em' }}>
            at lights out
          </span>
        </div>
      </div>
      <MiniTemp model={model} />
      <ul className={s.facts}>
        {model.precool.facts.map((f, i) => (
          <li key={i} ref={(el) => void (facts.current[i] = el)} className={s.fact}>
            <span className="mono">{f.lead}</span>
            <div>
              {f.text} <span>· {f.sub}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function MiniTemp({ model }: { model: StoryModel }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const dot = useRef<HTMLDivElement>(null);
  const { start, end, target } = model.precool;
  const geo = useMemo(() => {
    const w = Math.max(width, 200);
    const pts: { t: number; v: number }[] = [];
    const step = Math.max(60_000, (end - start) / (w / 2));
    for (let t = start; t <= end + 1; t += step) pts.push({ t, v: valueAt(model.series, 'temp', t) });
    const vs = pts.map((p) => p.v).filter(Number.isFinite);
    const lo = Math.min(...vs, target ?? Infinity) - 0.6;
    const hi = Math.max(...vs, (target ?? 0) + 1) + 0.4;
    const x = scale(start, end, 2, w - 2);
    const y = scale(lo, hi, H - 6, 8);
    return { w, x, y, d: linePath(pts.map((p) => ({ x: x(p.t), y: y(p.v) }))) };
  }, [model, width, start, end, target]);
  useScrub((p) => {
    if (!dot.current) return;
    const t = start + p * (end - start);
    const v = valueAt(model.series, 'temp', t);
    dot.current.style.transform = `translate3d(${geo.x(t).toFixed(1)}px,${(Number.isFinite(v) ? geo.y(v) : -50).toFixed(1)}px,0)`;
  }, RANGE, [geo]);
  return (
    <div ref={ref} className={s.mini} style={{ height: H }}>
      {width > 0 && (
        <>
          <svg width={geo.w} height={H} className={s.svgAbs} aria-hidden>
            {target !== null && (
              <>
                <line x1={0} x2={geo.w} y1={geo.y(target)} y2={geo.y(target)} stroke="var(--text-2)" strokeOpacity={0.6} strokeDasharray="3 4" />
                <text x={geo.w} y={geo.y(target) - 7} textAnchor="end" className={s.svgLabel}>
                  TARGET {fmt(target, 1).replace(/\.0$/, '')}°
                </text>
              </>
            )}
          </svg>
          <ScrubWipe range={RANGE} style={{ position: 'absolute', inset: 0 }}>
            <svg width={geo.w} height={H} aria-hidden>
              <path d={geo.d} fill="none" stroke="var(--temp)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </ScrubWipe>
          <div ref={dot} className={`${s.tipDot} will`} style={{ ['--dc' as string]: 'var(--temp)' }} aria-hidden />
        </>
      )}
    </div>
  );
}

export function LightsOut({ model }: { model: StoryModel }) {
  return (
    <Chapter
      id="lights"
      n={2}
      title="Lights out"
      accent="lights"
      pinned={2.5}
      className="bleed"
      onProgress={(p) => setSky({ dusk: 1 - p, mid: p, dawn: 0, dim: 0.55 * (1 - p) })}
    >
      <div className="sh-kicker t-label">
        <span>02</span>
        <span>Lights out</span>
      </div>
      <Clock model={model} />
    </Chapter>
  );
}
