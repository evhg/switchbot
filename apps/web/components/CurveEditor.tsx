'use client';
/**
 * Tonight's plan instrument (docs/DESIGN.md §6 "Instrument keys", "Dial", §7 chart guide, §9.5 Tonight's plan).
 *
 *   ┌ card ───────────────────────────────────────────────┐
 *   │ Target temperature                 Limits 17–24 °C │
 *   │ chart: plan in --signal, last night in --muted,     │
 *   │        selected phase shaded, nodes draggable       │
 *   ├ instrument keys (6 phases, joined strip) ───────────┤
 *   └─────────────────────────────────────────────────────┘
 *   Deep window                     (.head + one .sec line)
 *   [ Starts dial ] [ Target dial ]
 *   [ Glide into the next phase ……………………… switch ]
 *   Saved on this phone                 ↺ Reset to default
 *
 * Drag a node (time ←→, temperature ↑↓; snaps to 5 min / 0.5 °C), use the arrow keys on a focused node, or pick a
 * phase with the keys and use the dials. The drag edits a local draft and commits once on release.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { DEFAULT_CURVE, type TemperatureCurve } from '@sleep-lab/core';
import { sanitizeCurve } from '@/lib/curve-store.ts';
import { fmt } from '@/lib/format.ts';
import { linePath, scale, useSvgId } from './charts/common.tsx';
import { PHASE_ABOUT, PHASE_NAME, clock, relSleepWords, relWords } from './system/model.ts';
import { Button, Dial, InstrumentKeys, Switch, useWidth } from './ui.tsx';
import s from './CurveEditor.module.css';

const M0 = -120;
/** Lights out + 11 h: 09:00 for a 22:00 lights out, the OFF after an 08:30 wake. */
const M1 = 660;
type Phase = TemperatureCurve['phases'][number];
type PhaseName = Phase['name'];

const pad = (n: number) => String(n).padStart(2, '0');
/** Minutes relative to lights-out → "+0:40" / "−1:30". */
export const relTime = (m: number) => `${m < 0 ? '−' : '+'}${Math.floor(Math.abs(m) / 60)}:${pad(Math.abs(m) % 60)}`;

function stepPath(c: TemperatureCurve, x: (m: number) => number, y: (t: number) => number) {
  const pts: { x: number; y: number }[] = [];
  const cl = (t: number) => Math.min(c.maxC, Math.max(c.minC, t));
  c.phases.forEach((p, i) => {
    const next = c.phases[i + 1];
    const end = Math.min(M1, next ? next.startMin : M1);
    pts.push({ x: x(Math.max(M0, p.startMin)), y: y(cl(p.targetC)) });
    pts.push({ x: x(end), y: y(p.ramp && next ? cl(next.targetC) : cl(p.targetC)) });
  });
  return pts;
}

export interface CurveEditorProps {
  curve: TemperatureCurve;
  onChange: (c: TemperatureCurve) => void;
  onReset: () => void;
  /** Typical lights out, minute of day: the chart and keys show clock times. */
  lightsOut: number;
  /** Last night's room temperature, minutes relative to that night's lights out. */
  actual?: readonly { m: number; t: number }[];
  /**
   * The curve is shown resolved (every phase from lights out); phases in `anchored` count from sleep onset, which is
   * `offsetMin` after lights out, and say so ("4 h 30 min after you fall asleep").
   */
  sleepOnset?: { offsetMin: number; anchored: readonly PhaseName[] };
  /** Disables "Reset to default". Default: `curve === DEFAULT_CURVE`. */
  isDefault?: boolean;
}

export function CurveEditor({ curve, onChange, onReset, lightsOut, actual, sleepOnset, isDefault }: CurveEditorProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [draft, setDraft] = useState<TemperatureCurve | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [sel, setSel] = useState(() => Math.max(0, curve.phases.findIndex((p) => p.name === 'deep')));
  const svgRef = useRef<SVGSVGElement>(null);
  const raf = useRef(0);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const draftRef = useRef<TemperatureCurve | null>(null);
  const clipId = useSvgId('plan-clip');
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const c = draft ?? curve;
  const w = Math.max(width, 280);
  const wide = w >= 640;
  const H = wide ? 300 : 248;
  const L = 6;
  const R = wide ? 48 : 40;
  const T = 34;
  const B = 34;
  const x = scale(M0, M1, L, w - R);
  const y = scale(c.minC, c.maxC, H - B, T);
  const pts = stepPath(c, x, y);
  const line = linePath(pts);
  const yTicks: number[] = [];
  for (let t = Math.ceil(c.minC); t <= c.maxC; t += 2) yTicks.push(t);
  // Clock ticks on even hours (every 2 h; every 3 h on narrow phones).
  const every = w < 360 ? 180 : 120;
  const xTicks: number[] = [];
  for (let m = M0; m <= M1; m++) if ((((lightsOut + m) % 1440) + 1440) % every === 0) xTicks.push(m);
  const actualPath = actual?.length ? linePath(actual.filter((p) => p.m >= M0 && p.m <= M1).map((p) => ({ x: x(p.m), y: y(p.t) })), 6) : '';
  const actualEnd = actual?.filter((p) => p.m >= M0 && p.m <= M1).at(-1);

  const commit = (next: TemperatureCurve) => onChange(sanitizeCurve(next));
  const patch = (base: TemperatureCurve, i: number, p: Partial<Phase>) => sanitizeCurve({ ...base, phases: base.phases.map((ph, j) => (j === i ? { ...ph, ...p } : ph)) });
  const update = (i: number, p: Partial<Phase>) => commit(patch(curve, i, p));
  const startBounds = (base: TemperatureCurve, i: number) => {
    const prev = base.phases[i - 1];
    const next = base.phases[i + 1];
    return [prev ? prev.startMin + 10 : M0, next ? next.startMin - 10 : M1] as const;
  };

  /** Pointer position → constrained phase values (5 min / 0.5 °C snaps; onset stays at lights-out). */
  const valuesAt = (base: TemperatureCurve, i: number, px: number, py: number): Partial<Phase> => {
    const m = Math.round((M0 + ((px - L) / (w - R - L)) * (M1 - M0)) / 5) * 5;
    const t = Math.round((base.minC + ((H - B - py) / (H - B - T)) * (base.maxC - base.minC)) * 2) / 2;
    const [lo, hi] = startBounds(base, i);
    const start = base.phases[i]!.name === 'onset' ? 0 : Math.max(lo, Math.min(hi, m));
    return { startMin: start, targetC: Math.max(base.minC, Math.min(base.maxC, t)) };
  };

  const onDown = (i: number) => (e: RPointerEvent<SVGElement>) => {
    e.preventDefault();
    svgRef.current?.setPointerCapture?.(e.pointerId);
    draftRef.current = curve;
    setDraft(curve);
    setDrag(i);
    setSel(i);
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (drag === null || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    pending.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const pt = pending.current;
      const base = draftRef.current;
      if (!pt || !base || drag === null) return;
      const v = valuesAt(base, drag, pt.x, pt.y);
      const cur = base.phases[drag]!;
      if (v.startMin === cur.startMin && v.targetC === cur.targetC) return;
      const next = patch(base, drag, v);
      draftRef.current = next;
      setDraft(next);
    });
  };
  const onUp = () => {
    if (drag === null) return;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const d = draftRef.current;
    draftRef.current = null;
    setDrag(null);
    setDraft(null);
    if (d && d !== curve) commit(d);
  };
  const onKey = (i: number) => (e: KeyboardEvent<SVGElement>) => {
    const p = curve.phases[i]!;
    const k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowDown') update(i, { targetC: p.targetC + (k === 'ArrowUp' ? 0.5 : -0.5) });
    else if ((k === 'ArrowLeft' || k === 'ArrowRight') && p.name !== 'onset') {
      const [lo, hi] = startBounds(curve, i);
      update(i, { startMin: Math.max(lo, Math.min(hi, p.startMin + (k === 'ArrowRight' ? 5 : -5))) });
    } else return;
    e.preventDefault();
    setSel(i);
  };

  const sp = c.phases[sel] ?? c.phases[0]!;
  const spNext = c.phases[sel + 1];
  const active = drag ?? sel;
  const ap = c.phases[active]!;
  const ax = x(Math.max(M0, ap.startMin));
  const ay = y(ap.targetC);
  const bandX0 = x(Math.max(M0, sp.startMin));
  const bandX1 = x(Math.min(M1, spNext ? spNext.startMin : M1));
  const [lo, hi] = startBounds(curve, sel);
  const isOnset = sp.name === 'onset';
  const last = sel === c.phases.length - 1;
  const at = (m: number) => clock(lightsOut + m);

  return (
    <div className={s.editor}>
      <div className={`card ${s.instrument}`}>
        <div className={s.head}>
          <h2 className={s.title}>Target temperature</h2>
          <span className="sec">
            Limits {c.minC}–{c.maxC} °C
          </span>
        </div>

        <div ref={ref} className={`chart-box ${s.chart}`} data-dragging={drag !== null || undefined}>
          {width > 0 && (
            <svg
              ref={svgRef}
              width={w}
              height={H}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onLostPointerCapture={onUp}
              role="group"
              aria-label={`Tonight's plan. Coolest ${fmt(Math.min(...c.phases.map((p) => p.targetC)), 1)} degrees.`}
            >
              <defs>
                <clipPath id={clipId}>
                  <rect x={L} y={T} width={w - R - L} height={H - B - T} />
                </clipPath>
              </defs>
              {/* selected phase band */}
              <rect className={s.band} x={bandX0} y={T - 14} width={Math.max(0, bandX1 - bandX0)} height={H - B - T + 14} />
              {yTicks.map((t) => (
                <g key={t}>
                  <line x1={L} x2={w - R} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
                  <text x={w - R + 10} y={y(t) + 5} textAnchor="start">
                    {t}°
                  </text>
                </g>
              ))}
              <line x1={L} x2={w - R} y1={H - B} y2={H - B} stroke="var(--axis)" />
              {xTicks.map((m) => (
                <text key={m} x={x(m)} y={H - 8} textAnchor="middle" className={drag !== null && Math.abs(ap.startMin - m) < 30 ? s.tickOn : undefined}>
                  {at(m)}
                </text>
              ))}
              <line x1={x(0)} x2={x(0)} y1={T - 14} y2={H - B} stroke="var(--hairline-2)" strokeDasharray="2 3" />
              <text x={x(0) + 6} y={T - 18} textAnchor="start">
                Lights out
              </text>
              {actualPath && (
                <g clipPath={`url(#${clipId})`}>
                  <path className={s.actual} d={actualPath} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                </g>
              )}
              {actualEnd && w >= 420 && (
                <text x={x(actualEnd.m) - 4} y={y(Math.min(c.maxC, Math.max(c.minC, actualEnd.t))) + (actualEnd.t > sp.targetC ? -10 : 20)} textAnchor="end">
                  Last night
                </text>
              )}
              <path d={line} fill="none" stroke="var(--signal)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              {drag !== null && (
                <g pointerEvents="none">
                  <line x1={ax} x2={w - R} y1={ay} y2={ay} stroke="var(--hairline-2)" strokeDasharray="3 3" />
                  <line x1={ax} x2={ax} y1={ay} y2={H - B} stroke="var(--hairline-2)" strokeDasharray="3 3" />
                </g>
              )}
              {c.phases.map((p, i) => {
                const hx = x(Math.max(M0, p.startMin));
                const hy = y(p.targetC);
                const isSel = i === sel;
                // Label below the node (last night's trace usually runs above the plan), above only near the floor.
                const below = hy < T + 30 || hy < y(18);
                return (
                  <g key={p.name} className={s.handle} data-active={drag === i || undefined} data-sel={isSel || undefined} style={{ transform: `translate(${hx.toFixed(1)}px, ${hy.toFixed(1)}px)` }}>
                    <circle className={s.halo} r={16} />
                    <circle className={s.node} r={isSel ? 6.5 : 5} />
                    {isSel && drag !== i && (
                      <text y={below ? 28 : -16} textAnchor="middle" className={s.nodeLabel}>
                        {fmt(p.targetC, 1)}°
                      </text>
                    )}
                    <circle
                      r={22}
                      fill="transparent"
                      className={s.hit}
                      tabIndex={0}
                      role="slider"
                      aria-label={`${PHASE_NAME[p.name]}: target`}
                      aria-valuemin={c.minC}
                      aria-valuemax={c.maxC}
                      aria-valuenow={p.targetC}
                      aria-valuetext={`${fmt(p.targetC, 1)} °C from ${at(p.startMin)}`}
                      onPointerDown={onDown(i)}
                      onKeyDown={onKey(i)}
                      onFocus={() => setSel(i)}
                    />
                  </g>
                );
              })}
            </svg>
          )}
          {drag !== null && width > 0 && (
            <div className={s.chip} style={{ transform: `translate3d(${Math.min(Math.max(ax, 60), w - 60).toFixed(1)}px, ${Math.max(0, ay - 58).toFixed(1)}px, 0)` }} aria-hidden>
              <b className="num">{fmt(ap.targetC, 1)}°</b>
              <span className="num">{at(ap.startMin)}</span>
            </div>
          )}
        </div>

        <div className={s.keys}>
          <InstrumentKeys<PhaseName>
            label="Phases"
            value={c.phases[sel]!.name}
            onChange={(id) => setSel(Math.max(0, c.phases.findIndex((p) => p.name === id)))}
            items={c.phases.map((p) => ({
              id: p.name,
              name: PHASE_NAME[p.name],
              meta: `${at(p.startMin)} · ${fmt(p.targetC, 1)}°`,
              glides: Boolean(p.ramp),
            }))}
          />
        </div>
      </div>

      <section className={s.phase} aria-live="polite" aria-label="Selected phase">
        <div>
          <h2 className="head">{PHASE_NAME[sp.name]}</h2>
          <p className="sec">{PHASE_ABOUT[sp.name]}</p>
        </div>
        <div className={s.dials}>
          <Dial
            label="Starts"
            value={<span className="num">{at(sp.startMin)}</span>}
            meaning={isOnset ? 'Always at lights out' : sleepOnset?.anchored.includes(sp.name) ? relSleepWords(sp.startMin - sleepOnset.offsetMin) : relWords(sp.startMin)}
            onDec={() => update(sel, { startMin: Math.max(lo, sp.startMin - 5) })}
            onInc={() => update(sel, { startMin: Math.min(hi, sp.startMin + 5) })}
            decLabel="Earlier"
            incLabel="Later"
            decDisabled={isOnset || sp.startMin <= lo}
            incDisabled={isOnset || sp.startMin >= hi}
          />
          <Dial
            label="Target"
            value={
              <span className="num">
                {fmt(sp.targetC, 1)}
                <span className="unit">°C</span>
              </span>
            }
            meaning={`Aircon set point ${Math.round(sp.targetC)}°`}
            onDec={() => update(sel, { targetC: sp.targetC - 0.5 })}
            onInc={() => update(sel, { targetC: sp.targetC + 0.5 })}
            decLabel="Cooler"
            incLabel="Warmer"
            decDisabled={sp.targetC <= c.minC}
            incDisabled={sp.targetC >= c.maxC}
          />
        </div>
        <div className={`card ${s.glide}`}>
          <div className={s.glideT}>
            <b>Glide into the next phase</b>
            <span>
              {last
                ? 'The last phase holds until the aircon turns off.'
                : spNext!.targetC === sp.targetC
                  ? `${PHASE_NAME[spNext!.name]} is also ${fmt(sp.targetC, 1)}°, so there is nothing to glide yet.`
                  : `From ${fmt(sp.targetC, 1)}° to ${fmt(spNext!.targetC, 1)}° gradually, instead of one step.`}
            </span>
          </div>
          <Switch checked={Boolean(sp.ramp)} disabled={last} onChange={(v) => update(sel, { ramp: v })} label={<span className="sr-only">Glide from {PHASE_NAME[sp.name]} into the next phase</span>} />
        </div>
        <div className={s.foot}>
          <span className="cap">Saved on this phone</span>
          <Button variant="text" icon="refresh" onClick={onReset} disabled={isDefault ?? curve === DEFAULT_CURVE}>
            Reset to default
          </Button>
        </div>
      </section>
    </div>
  );
}
