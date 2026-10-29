'use client';
// Tonight's planned temperature curve over last night's actual room temperature and commanded setpoint
// (minutes from lights-out). Custom SVG (docs/DESIGN.md §8.3): the plan is the chapter accent with a gradient
// fill, last night's actual a dotted --text-2 line, the setpoint a dashed --setpoint step. Phase labels sit on the
// axis. With `scrub` (inside a <Chapter>) the plan is wiped in by scroll with a dot riding its tip and phase labels
// appearing as the dot passes them; without it the plan draws in on reveal. Touch / hover shows a glass tooltip.
import { useMemo, useRef, useState } from 'react';
import { targetAt, type Night, type TemperatureCurve } from '@sleep-lab/core';
import { PHASE_LABEL } from '@/lib/curve-store.ts';
import { fmt, hm, MIN } from '@/lib/format.ts';
import { DrawPath, ScrubWipe } from '../motion.tsx';
import { useScrub } from '../story/useScrub.ts';
import { Key, useWidth } from '../ui.tsx';
import { FloatTip, linePath, scale, TipRow } from './common.tsx';

interface Pt {
  m: number;
  plan: number | null;
  actual: number | null;
  set: number | null;
}

const SHORT: Record<string, string> = { precool: 'Pre-cool', onset: 'Onset', deep: 'Deep', middle: 'Middle', late: 'Late', wake: 'Wake' };
const LABEL = { fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.12em', fill: 'var(--muted)' } as const;

export function PlanChart({ plan, last, height = 230, scrub }: { plan: TemperatureCurve; last: Night; height?: number; scrub?: readonly [number, number] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const dot = useRef<HTMLDivElement>(null);
  const phaseRefs = useRef<(SVGGElement | null)[]>([]);
  const lo = last.lightsOut;
  const endM = Math.max(540, Math.round((last.wake - lo) / MIN) + 30);

  const data = useMemo(() => {
    const out: Pt[] = [];
    let ai = 0;
    for (let m = -90; m <= endM; m += 5) {
      const t = lo + m * MIN;
      const win = [] as number[];
      while (ai < last.room.length && last.room[ai]!.ts < t + 2.5 * MIN) {
        if (last.room[ai]!.ts >= t - 2.5 * MIN) win.push(last.room[ai]!.tempC);
        ai++;
      }
      const cmd = [...last.ac].reverse().find((c) => c.ts <= t);
      out.push({
        m,
        plan: targetAt(plan, lo, t),
        actual: win.length ? win.reduce((a, b) => a + b, 0) / win.length : null,
        set: cmd && cmd.state.power ? cmd.state.setpointC : null,
      });
    }
    return out;
  }, [plan, last, lo, endM]);

  const W = Math.max(width, 260);
  const top = 22;
  const axisH = 34;
  const plotB = height - axisH;
  const geo = useMemo(() => {
    const plans = data.map((d) => d.plan).filter((v): v is number => v !== null);
    const sets = data.map((d) => d.set).filter((v): v is number => v !== null);
    const yLo = Math.floor(Math.min(...plans, ...sets) - 0.7);
    const yHi = Math.ceil(Math.max(...plans, ...sets) + 1.2);
    const x = scale(-90, endM, 0, W);
    const y = scale(yLo, yHi, plotB, top);
    const ticks: number[] = [];
    const stepT = yHi - yLo > 6 ? 2 : 1;
    for (let v = Math.ceil(yLo + 0.5); v < yHi; v += stepT) ticks.push(v);
    const pPts = data.filter((d) => d.plan !== null).map((d) => ({ x: x(d.m), y: y(d.plan!) }));
    const planD = linePath(pPts);
    const planArea = pPts.length > 1 ? `${planD}L${pPts.at(-1)!.x.toFixed(1)},${plotB}L${pPts[0]!.x.toFixed(1)},${plotB}Z` : '';
    // Last night's actual can start far above the plan (a hot room before the pre-cool). Keep the scale for the
    // plan, pin the off-scale part to the top edge and say so with a marker instead of squashing the curve.
    const actD = linePath(data.map((d) => ({ x: x(d.m), y: d.actual === null ? NaN : y(Math.min(yHi, d.actual)) })));
    let off: { x: number; v: number } | null = null;
    for (const d of data) if (d.actual !== null && d.actual > yHi && (!off || d.actual > off.v)) off = { x: x(d.m), v: d.actual };
    // Setpoint as a step line.
    let setD = '';
    let prev: number | null = null;
    for (const d of data) {
      if (d.set === null) {
        prev = null;
        continue;
      }
      setD += prev === null ? `M${x(d.m).toFixed(1)},${y(d.set).toFixed(1)}` : `L${x(d.m).toFixed(1)},${y(prev).toFixed(1)}L${x(d.m).toFixed(1)},${y(d.set).toFixed(1)}`;
      prev = d.set;
    }
    // Phase labels, skipping ones that would collide.
    const phases: { m: number; name: string; c: number; x: number }[] = [];
    for (const p of plan.phases) {
      const px = x(p.startMin);
      if (px < 0 || px > W) continue;
      if (phases.length && px - phases.at(-1)!.x < phases.at(-1)!.name.length * 7 + 10) continue;
      phases.push({ m: p.startMin, name: SHORT[p.name] ?? p.name, c: p.targetC, x: px });
    }
    return { x, y, yLo, yHi, ticks, planD, planArea, actD, setD, phases, off };
  }, [data, W, endM, plotB, plan.phases]);

  useScrub((p) => {
    if (!scrub) return;
    const m = -90 + p * (endM + 90);
    const tg = targetAt(plan, lo, lo + m * MIN);
    if (dot.current) {
      dot.current.style.transform = `translate3d(${geo.x(m).toFixed(1)}px,${(tg !== null ? geo.y(tg) : -40).toFixed(1)}px,0)`;
      dot.current.style.opacity = p > 0 && p < 1 ? '1' : '0';
    }
    geo.phases.forEach((ph, i) => phaseRefs.current[i]?.classList.toggle('hit', m >= ph.m - 1 || p >= 1));
  }, scrub ?? [0, 1], [geo]);

  const hp = hover !== null ? data[Math.max(0, Math.min(data.length - 1, Math.round((hover + 90) / 5)))] : undefined;
  const planLayer = (copy: string) => (
    <svg width={W} height={height} aria-hidden style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`plan-g-${copy}`} x1={0} x2={0} y1={0} y2={1}>
          <stop offset={0} stopColor="var(--ch-accent)" stopOpacity={0.3} />
          <stop offset={1} stopColor="var(--ch-accent)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={geo.planArea} fill={`url(#plan-g-${copy})`} />
      {scrub ? (
        <path d={geo.planD} fill="none" stroke="var(--ch-accent)" strokeWidth={2.6} strokeLinejoin="round" strokeLinecap="round" />
      ) : (
        <DrawPath d={geo.planD} fill="none" stroke="var(--ch-accent)" strokeWidth={2.6} strokeLinejoin="round" strokeLinecap="round" />
      )}
    </svg>
  );

  return (
    <div>
      <div className="legend">
        <span style={{ color: 'var(--ch-accent)' }}>
          <Key color="var(--ch-accent)" /> Tonight&apos;s plan
        </span>
        <span>
          <i className="key-dash" style={{ color: 'var(--text-2)', borderTopStyle: 'dotted' }} /> Last night actual
        </span>
        <span>
          <Key color="var(--setpoint)" shape="dash" /> Setpoint
        </span>
      </div>
      <div
        ref={ref}
        className="chart-box"
        style={{ height, touchAction: 'pan-y' }}
        role="img"
        aria-label={`${plan.name}: ${plan.phases.map((p) => `${PHASE_LABEL[p.name] ?? p.name} ${fmt(p.targetC, 1)} °C from ${p.startMin} min`).join(', ')}`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const m = -90 + ((e.clientX - r.left) / Math.max(1, W)) * (endM + 90);
          setHover(Math.max(-90, Math.min(endM, m)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {width > 0 && (
          <>
            <svg width={W} height={height} style={{ position: 'absolute', inset: 0 }} aria-hidden>
              {geo.ticks.map((v) => (
                <line key={v} x1={0} x2={W} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--grid)" />
              ))}
              <clipPath id="plan-clip">
                <rect x={0} y={top - 2} width={W} height={plotB - top + 2} />
              </clipPath>
              <path d={geo.setD} clipPath="url(#plan-clip)" fill="none" stroke="var(--setpoint)" strokeOpacity={0.8} strokeWidth={1.4} strokeDasharray="4 3" />
              <path d={geo.actD} clipPath="url(#plan-clip)" fill="none" stroke="var(--text-2)" strokeWidth={1.5} strokeDasharray="0.5 3.5" strokeLinecap="round" />
              <line x1={0} x2={W} y1={plotB} y2={plotB} stroke="var(--hairline)" />
            </svg>
            {scrub ? (
              <ScrubWipe range={scrub} ghost={false} style={{ position: 'absolute', inset: 0 }}>
                {(copy) => planLayer(copy)}
              </ScrubWipe>
            ) : (
              <div style={{ position: 'absolute', inset: 0 }}>{planLayer('static')}</div>
            )}
            <svg width={W} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden>
              {/* Tick labels sit above every series, knocked out of the lines behind them. */}
              {geo.ticks.map((v) => (
                <text key={v} x={W} y={geo.y(v) - 4} textAnchor="end" style={{ ...LABEL, stroke: 'var(--bg)', strokeWidth: 3, paintOrder: 'stroke', strokeLinejoin: 'round' }}>
                  {v}°
                </text>
              ))}
              {geo.off && (
                <text x={Math.max(2, Math.min(geo.off.x + 4, W - 90))} y={top + 11} style={{ ...LABEL, fill: 'var(--text-2)', stroke: 'var(--bg)', strokeWidth: 3, paintOrder: 'stroke' }}>
                  ↑ OFF SCALE {fmt(geo.off.v, 0)}°
                </text>
              )}
              {geo.phases.map((ph, i) => (
                <g key={ph.m} ref={(el) => void (phaseRefs.current[i] = el)} className={scrub ? 'hit-mark' : undefined} style={{ transformOrigin: `${ph.x}px ${plotB}px` }}>
                  <line x1={ph.x} x2={ph.x} y1={plotB} y2={plotB + 6} stroke="var(--text-2)" />
                  <text x={Math.min(ph.x + 2, W - 50)} y={plotB + 17} style={LABEL}>
                    {ph.name.toUpperCase()}
                  </text>
                  <text x={Math.min(ph.x + 2, W - 50)} y={plotB + 29} style={{ ...LABEL, fill: 'var(--text-2)' }}>
                    {fmt(ph.c, 1).replace(/\.0$/, '')}°
                  </text>
                </g>
              ))}
              {hover !== null && <line x1={geo.x(hover)} x2={geo.x(hover)} y1={top - 6} y2={plotB} stroke="var(--hairline-2)" />}
            </svg>
            {scrub && <div ref={dot} className="plan-dot" style={{ position: 'absolute', left: -5, top: -5, width: 10, height: 10, borderRadius: 5, background: 'var(--ch-accent)', boxShadow: '0 0 0 2px var(--bg)', opacity: 0, willChange: 'transform', pointerEvents: 'none' }} aria-hidden />}
            {hp && hover !== null && (
              <FloatTip x={geo.x(hover)} y={top} width={W}>
                <div className="tip-title">
                  {hm(lo + hp.m * MIN)} · {hp.m >= 0 ? '+' : '−'}
                  {fmt(Math.abs(hp.m) / 60, 1)} h
                </div>
                {hp.plan !== null && <TipRow color="var(--ch-accent)" value={`${fmt(hp.plan, 1)} °C`} label="plan" />}
                {hp.actual !== null && <TipRow color="var(--text-2)" value={`${fmt(hp.actual, 1)} °C`} label="actual" dash />}
                {hp.set !== null && <TipRow color="var(--setpoint)" value={`${fmt(hp.set)} °C`} label="setpoint" dash />}
              </FloatTip>
            )}
          </>
        )}
      </div>
    </div>
  );
}
