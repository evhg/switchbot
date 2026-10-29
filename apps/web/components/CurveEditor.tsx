'use client';
/**
 * Eight-Sleep-style temperature curve editor (docs/DESIGN.md §11 "System"): a mint step line with phase handles
 * as glass knobs. Drag a knob (time ←→, temperature ↑↓; snaps to 5 min / 0.5 °C), use the arrow keys on a focused
 * knob, or pick a phase and type exact values with the steppers. While dragging, a mono chip follows the knob and
 * crosshair guides run to both axes; the knob glides between snapped values. The drag edits a local draft and
 * commits once on release, so only this component re-renders per move.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { DEFAULT_CURVE, type TemperatureCurve } from '@sleep-lab/core';
import { PHASE_LABEL, sanitizeCurve } from '@/lib/curve-store.ts';
import { fmt } from '@/lib/format.ts';
import { AreaGradient, linePath, scale, useSvgId } from './charts/common.tsx';
import { Icon } from './icons.tsx';
import { Button, Toggle, useWidth } from './ui.tsx';
import s from './CurveEditor.module.css';

const M0 = -120;
const M1 = 540;
type Phase = TemperatureCurve['phases'][number];

const pad = (n: number) => String(n).padStart(2, '0');
/** Minutes relative to lights-out → "+0:40" / "−1:30". */
export const relTime = (m: number) => `${m < 0 ? '−' : '+'}${Math.floor(Math.abs(m) / 60)}:${pad(Math.abs(m) % 60)}`;

function stepPath(c: TemperatureCurve, x: (m: number) => number, y: (t: number) => number) {
  const pts: { x: number; y: number }[] = [];
  c.phases.forEach((p, i) => {
    const next = c.phases[i + 1];
    const end = Math.min(M1, next ? next.startMin : M1);
    const t0 = Math.min(c.maxC, Math.max(c.minC, p.targetC));
    pts.push({ x: x(Math.max(M0, p.startMin)), y: y(t0) });
    if (p.ramp && next) pts.push({ x: x(end), y: y(Math.min(c.maxC, Math.max(c.minC, next.targetC))) });
    else pts.push({ x: x(end), y: y(t0) });
  });
  return pts;
}

function Stepper({ label, value, display, onChange, step, min, max, disabled, aria, unit, dp = 0 }: { label: string; value: number; display: string; onChange: (v: number) => void; step: number; min?: number; max?: number; disabled?: boolean; aria: string; unit: string; dp?: number }) {
  // While typing, show the raw text; otherwise the formatted value (19.0, not 19).
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  return (
    <div className={s.stepper} aria-disabled={disabled || undefined}>
      <div className={s.stepLabel}>
        <span className="t-micro">{label}</span>
        <span className={`${s.stepDisplay} mono`}>{display}</span>
      </div>
      <div className={s.stepCtl}>
        <button type="button" className={`${s.stepBtn} tap`} aria-label={`${aria} down`} disabled={disabled || (min !== undefined && value <= min)} onClick={() => onChange(clamp(value - step))}>
          <Icon name="minus" size={16} strokeWidth={2} />
        </button>
        <label className={s.stepVal}>
          <input
            className="num"
            type="number"
            inputMode="decimal"
            step={step}
            min={min}
            max={max}
            value={text ?? value.toFixed(dp)}
            disabled={disabled}
            onFocus={() => setText(String(value))}
            onBlur={() => setText(null)}
            onChange={(e) => {
              setText(e.target.value);
              if (Number.isFinite(e.target.valueAsNumber)) onChange(e.target.valueAsNumber);
            }}
            aria-label={aria}
          />
          <span className="t-micro">{unit}</span>
        </label>
        <button type="button" className={`${s.stepBtn} tap`} aria-label={`${aria} up`} disabled={disabled || (max !== undefined && value >= max)} onClick={() => onChange(clamp(value + step))}>
          <Icon name="plus" size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

export function CurveEditor({ curve, onChange, onReset }: { curve: TemperatureCurve; onChange: (c: TemperatureCurve) => void; onReset: () => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [draft, setDraft] = useState<TemperatureCurve | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [sel, setSel] = useState(() => Math.max(0, curve.phases.findIndex((p) => p.name === 'deep')));
  const svgRef = useRef<SVGSVGElement>(null);
  const raf = useRef(0);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const draftRef = useRef<TemperatureCurve | null>(null);
  const gid = useSvgId('curve');
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const c = draft ?? curve;
  const w = Math.max(width, 280);
  const H = 232;
  const L = 30;
  const R = 16;
  const T = 40;
  const B = 26;
  const x = scale(M0, M1, L, w - R);
  const y = scale(c.minC, c.maxC, H - B, T);
  const pts = stepPath(c, x, y);
  const line = linePath(pts);
  const area = pts.length > 1 ? `${line}L${pts.at(-1)!.x.toFixed(1)},${H - B}L${pts[0]!.x.toFixed(1)},${H - B}Z` : '';
  const yTicks = Array.from({ length: Math.floor(c.maxC) - Math.ceil(c.minC) + 1 }, (_, i) => Math.ceil(c.minC) + i).filter((t) => t % 2 === 0);

  const commit = (next: TemperatureCurve) => onChange(sanitizeCurve(next));
  const patch = (base: TemperatureCurve, i: number, p: Partial<Phase>) => sanitizeCurve({ ...base, phases: base.phases.map((ph, j) => (j === i ? { ...ph, ...p } : ph)) });
  const update = (i: number, p: Partial<Phase>) => commit(patch(curve, i, p));

  /** Pointer position → constrained phase values (5 min / 0.5 °C snaps; onset stays at lights-out). */
  const valuesAt = (base: TemperatureCurve, i: number, px: number, py: number): Partial<Phase> => {
    const m = Math.round((M0 + ((px - L) / (w - R - L)) * (M1 - M0)) / 5) * 5;
    const t = Math.round((base.minC + ((H - B - py) / (H - B - T)) * (base.maxC - base.minC)) * 2) / 2;
    const prev = base.phases[i - 1];
    const next = base.phases[i + 1];
    const start = base.phases[i]!.name === 'onset' ? 0 : Math.max(prev ? prev.startMin + 10 : M0, Math.min(next ? next.startMin - 10 : M1, m));
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
    else if ((k === 'ArrowLeft' || k === 'ArrowRight') && p.name !== 'onset') update(i, { startMin: p.startMin + (k === 'ArrowRight' ? 5 : -5) });
    else return;
    e.preventDefault();
    setSel(i);
  };

  const sp = c.phases[sel] ?? c.phases[0]!;
  const active = drag ?? sel;
  const ap = c.phases[active]!;
  const ax = x(Math.max(M0, ap.startMin));
  const ay = y(ap.targetC);
  const coolest = Math.min(...c.phases.map((p) => p.targetC));

  return (
    <div className={s.editor}>
      <div className={s.readout} aria-live="polite">
        <div className={s.readMain}>
          <span className="t-label accent">{PHASE_LABEL[ap.name]}</span>
          <span className={s.readTemp}>
            {fmt(ap.targetC, 1)}
            <span className="t-unit">°C</span>
          </span>
        </div>
        <div className={s.readSide}>
          <span className="mono">
            {relTime(Math.abs(ap.startMin)).slice(1)} {ap.startMin < 0 ? 'before' : 'after'}
          </span>
          <span className="t-micro muted">lights out · coolest {fmt(coolest, 1)}°</span>
        </div>
      </div>

      <div ref={ref} className={`chart-box ${s.chart}`} data-dragging={drag !== null || undefined}>
        {width > 0 && (
          <svg ref={svgRef} width={w} height={H} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onLostPointerCapture={onUp} role="group" aria-label="Temperature curve editor">
            <defs>
              <AreaGradient id={gid} color="var(--ch-accent)" from={0.28} />
            </defs>
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={L} x2={w - R} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
                <text x={L - 7} y={y(t) + 3} textAnchor="end" fill="var(--muted)" fontSize={9.5} style={{ fontFamily: 'var(--font-mono)' }}>
                  {t}°
                </text>
              </g>
            ))}
            {[-120, 0, 120, 240, 360, 480].map((m) => (
              <text key={m} x={x(m)} y={H - 7} textAnchor="middle" fill={drag !== null && Math.abs(ap.startMin - m) < 30 ? 'var(--text)' : 'var(--muted)'} fontSize={9.5} style={{ fontFamily: 'var(--font-mono)' }}>
                {m === 0 ? '0' : `${m > 0 ? '+' : '−'}${Math.abs(m) / 60}h`}
              </text>
            ))}
            <line x1={x(0)} x2={x(0)} y1={T - 12} y2={H - B} stroke="var(--axis)" strokeDasharray="2 3" />
            <text x={x(0) + 5} y={T - 4} fill="var(--muted)" fontSize={9} style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.12em' }}>
              LIGHTS OUT
            </text>
            <path d={area} fill={`url(#${gid})`} />
            <path d={line} fill="none" stroke="var(--ch-accent)" strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
            {drag !== null && (
              <g className={s.guides} pointerEvents="none">
                <line x1={L} x2={ax} y1={ay} y2={ay} stroke="var(--hairline-2)" strokeDasharray="3 3" />
                <line x1={ax} x2={ax} y1={ay} y2={H - B} stroke="var(--hairline-2)" strokeDasharray="3 3" />
              </g>
            )}
            {c.phases.map((p, i) => {
              const hx = x(Math.max(M0, p.startMin));
              const hy = y(p.targetC);
              const isSel = i === sel;
              // Put the value label under the knob when a neighbouring knob sits close above it.
              const crowded = [c.phases[i - 1], c.phases[i + 1]].some((q) => q && Math.abs(x(Math.max(M0, q.startMin)) - hx) < 46 && y(q.targetC) < hy + 4);
              return (
                <g key={p.name} className={s.handle} data-active={drag === i || undefined} data-sel={isSel || undefined} style={{ transform: `translate(${hx.toFixed(1)}px, ${hy.toFixed(1)}px)` }}>
                  <circle className={s.halo} r={18} />
                  <g className={s.knob}>
                    <circle r={11} className={s.knobBody} />
                    <circle r={3.5} fill="var(--ch-accent)" />
                  </g>
                  {drag !== i && isSel && (
                    <text y={crowded ? 27 : -17} textAnchor="middle" className={s.knobLabel}>
                      {fmt(p.targetC, 1)}°
                    </text>
                  )}
                  <circle
                    r={22}
                    fill="transparent"
                    className={s.hit}
                    tabIndex={0}
                    role="slider"
                    aria-label={`${PHASE_LABEL[p.name]}: target`}
                    aria-valuemin={c.minC}
                    aria-valuemax={c.maxC}
                    aria-valuenow={p.targetC}
                    aria-valuetext={`${fmt(p.targetC, 1)} °C at ${relTime(p.startMin)}`}
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
          <div className={s.chip} style={{ transform: `translate3d(${Math.min(Math.max(ax, 64), w - 64).toFixed(1)}px, ${(ay - 54).toFixed(1)}px, 0)` }} aria-hidden>
            <b className="num">{fmt(ap.targetC, 1)}°</b>
            <span className="mono">{relTime(ap.startMin)}</span>
          </div>
        )}
      </div>

      <div className={s.phases} role="group" aria-label="Phase">
        {c.phases.map((p, i) => (
          <button key={p.name} type="button" className={`${s.phase} tap`} aria-pressed={i === sel} onClick={() => setSel(i)}>
            <span className={s.phaseName}>{PHASE_LABEL[p.name]}</span>
            <span className={`${s.phaseMeta} mono`}>
              {relTime(p.startMin)} · {fmt(p.targetC, 1)}°{p.ramp ? ' ↗' : ''}
            </span>
          </button>
        ))}
      </div>

      <div className={s.edit}>
        <Stepper
          label="Starts"
          value={sp.startMin}
          display={sp.name === 'onset' ? 'at lights out' : relTime(sp.startMin)}
          step={5}
          disabled={sp.name === 'onset'}
          onChange={(v) => update(sel, { startMin: v })}
          aria={`${PHASE_LABEL[sp.name]} start minutes`}
          unit="min"
        />
        <Stepper
          label="Target"
          value={sp.targetC}
          display={`${fmt(sp.targetC, 1)} °C`}
          step={0.5}
          min={c.minC}
          max={c.maxC}
          onChange={(v) => update(sel, { targetC: v })}
          aria={`${PHASE_LABEL[sp.name]} target`}
          dp={1}
          unit="°C"
        />
        <div className={s.rampRow}>
          <div>
            <div className={s.rampTitle}>Ramp into the next phase</div>
            <div className="t-micro muted">{sel === c.phases.length - 1 ? 'Last phase holds until wake' : 'Glide instead of a step'}</div>
          </div>
          <Toggle checked={Boolean(sp.ramp)} disabled={sel === c.phases.length - 1} onChange={(v) => update(sel, { ramp: v })} label={<span className="sr-only">{`${PHASE_LABEL[sp.name]} ramp`}</span>} />
        </div>
      </div>

      <div className={s.foot}>
        <span className="t-micro muted">
          Limits {c.minC}–{c.maxC} °C · saved on this phone
        </span>
        <Button variant="ghost" size="sm" icon="refresh" onClick={onReset} disabled={curve === DEFAULT_CURVE}>
          Reset
        </Button>
      </div>
    </div>
  );
}
