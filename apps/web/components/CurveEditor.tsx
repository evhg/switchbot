'use client';
import { useRef, useState } from 'react';
import { DEFAULT_CURVE, targetAt, type TemperatureCurve } from '@sleep-lab/core';
import { PHASE_LABEL, sanitizeCurve } from '@/lib/curve-store.ts';
import { fmt } from '@/lib/format.ts';
import { linePath, scale } from './charts/common.tsx';
import { useWidth } from './ui.tsx';

const M0 = -120;
const M1 = 540;

/** Eight-Sleep-style curve editor: drag a phase handle (time ←→, temperature ↑↓) or type exact values. */
export function CurveEditor({ curve, onChange, onReset }: { curve: TemperatureCurve; onChange: (c: TemperatureCurve) => void; onReset: () => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [drag, setDrag] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const w = Math.max(width, 280);
  const H = 200;
  const L = 32;
  const x = scale(M0, M1, L, w - 12);
  const y = scale(curve.minC, curve.maxC, H - 24, 10);
  const lo = 0; // lights-out reference
  const path = [];
  for (let m = M0; m <= M1; m += 5) path.push({ x: x(m), y: (() => { const v = targetAt(curve, lo, m * 60_000); return v === null ? NaN : y(v); })() });

  const update = (i: number, patch: Partial<TemperatureCurve['phases'][number]>) => {
    const phases = curve.phases.map((p, j) => (j === i ? { ...p, ...patch } : p));
    onChange(sanitizeCurve({ ...curve, phases }));
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag === null || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const m = Math.round((M0 + ((px - L) / (w - 12 - L)) * (M1 - M0)) / 5) * 5;
    const t = Math.round((curve.minC + ((H - 24 - py) / (H - 34)) * (curve.maxC - curve.minC)) * 2) / 2;
    const prev = curve.phases[drag - 1];
    const next = curve.phases[drag + 1];
    const start = drag === 1 ? 0 : Math.max(prev ? prev.startMin + 10 : M0, Math.min(next ? next.startMin - 10 : M1, m)); // onset is lights-out by definition
    update(drag, { startMin: start, targetC: Math.max(curve.minC, Math.min(curve.maxC, t)) });
  };

  return (
    <div>
      <div ref={ref} className="chart-box" style={{ touchAction: drag !== null ? 'none' : 'pan-y' }}>
        {width > 0 && (
          <svg ref={svgRef} width={w} height={H} onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} role="img" aria-label="Temperature curve editor">
            {Array.from({ length: Math.floor(curve.maxC - curve.minC) + 1 }, (_, i) => Math.ceil(curve.minC) + i).map((t) => (
              <g key={t}>
                <line x1={L} x2={w - 12} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
                <text x={L - 6} y={y(t) + 3} textAnchor="end" fill="var(--muted)" fontSize={10}>
                  {t}°
                </text>
              </g>
            ))}
            {[-120, 0, 120, 240, 360, 480].map((m) => (
              <text key={m} x={x(m)} y={H - 6} textAnchor="middle" fill="var(--muted)" fontSize={10}>
                {m === 0 ? 'lights out' : `${m > 0 ? '+' : ''}${m / 60}h`}
              </text>
            ))}
            <line x1={x(0)} x2={x(0)} y1={8} y2={H - 22} stroke="var(--axis)" strokeDasharray="2 3" />
            <path d={linePath(path)} fill="none" stroke="var(--temp)" strokeWidth={2.5} strokeLinejoin="round" />
            {curve.phases.map((p, i) => (
              <g key={p.name} style={{ cursor: 'grab' }}>
                <circle cx={x(p.startMin)} cy={y(p.targetC)} r={16} fill="transparent" onPointerDown={(e) => {
                    svgRef.current?.setPointerCapture?.(e.pointerId);
                    setDrag(i);
                  }} />
                <circle cx={x(p.startMin)} cy={y(p.targetC)} r={drag === i ? 8 : 6} fill="var(--surface)" stroke="var(--temp)" strokeWidth={2.5} pointerEvents="none" />
                <text x={x(p.startMin)} y={y(p.targetC) - 12} textAnchor="middle" fill="var(--text-2)" fontSize={10} pointerEvents="none">
                  {fmt(p.targetC, 1)}°
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
      <table className="data-table" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th>Phase</th>
            <th>Start (min)</th>
            <th>Target °C</th>
            <th>Ramp</th>
          </tr>
        </thead>
        <tbody>
          {curve.phases.map((p, i) => (
            <tr key={p.name}>
              <td>{PHASE_LABEL[p.name]}</td>
              <td>
                <input
                  className="input num"
                  type="number"
                  step={5}
                  value={p.startMin}
                  disabled={p.name === 'onset'}
                  onChange={(e) => Number.isFinite(e.target.valueAsNumber) && update(i, { startMin: e.target.valueAsNumber })}
                  style={{ width: 72, textAlign: 'right', padding: '4px 6px', minHeight: 30 }}
                  aria-label={`${PHASE_LABEL[p.name]} start minutes`}
                />
              </td>
              <td>
                <input
                  className="input num"
                  type="number"
                  step={0.5}
                  min={curve.minC}
                  max={curve.maxC}
                  value={p.targetC}
                  onChange={(e) => Number.isFinite(e.target.valueAsNumber) && update(i, { targetC: e.target.valueAsNumber })}
                  style={{ width: 64, textAlign: 'right', padding: '4px 6px', minHeight: 30 }}
                  aria-label={`${PHASE_LABEL[p.name]} target`}
                />
              </td>
              <td>
                <input type="checkbox" checked={Boolean(p.ramp)} disabled={i === curve.phases.length - 1} onChange={(e) => update(i, { ramp: e.target.checked })} aria-label={`${PHASE_LABEL[p.name]} ramp`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row between" style={{ marginTop: 10 }}>
        <span className="small muted">
          Limits {curve.minC}–{curve.maxC} °C · saved on this device
        </span>
        <button className="btn" type="button" onClick={onReset} disabled={curve === DEFAULT_CURVE}>
          Reset to default
        </button>
      </div>
    </div>
  );
}
