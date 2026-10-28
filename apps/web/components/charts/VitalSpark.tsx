'use client';
import { useState } from 'react';
import { useWidth } from '../ui.tsx';
import { linePath, scale } from './common.tsx';

export interface SparkPoint {
  date: string;
  v: number;
}

/**
 * Stat-tile trend: the last N nights as a de-emphasised line over the personal baseline band (mean ± 1 SD),
 * with tonight's point in the person's colour. Gaps (missing nights) break the line. Hover/tap shows a value.
 */
export function VitalSpark({
  points,
  band,
  color,
  height = 30,
  format,
  label,
}: {
  points: SparkPoint[];
  band: { lo: number; hi: number } | null;
  color: string;
  height?: number;
  format: (v: number, date: string) => string;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const finite = points.filter((p) => Number.isFinite(p.v));
  const w = Math.max(40, width);
  if (finite.length < 2) return <div ref={ref} className="chart-box" style={{ height }} aria-hidden />;

  const vs = finite.map((p) => p.v);
  if (band && Number.isFinite(band.lo) && Number.isFinite(band.hi)) vs.push(band.lo, band.hi);
  const lo = Math.min(...vs);
  const top = Math.max(...vs);
  const pad = (top - lo) * 0.12 || Math.abs(top) * 0.02 || 0.5;
  const n = points.length;
  // Fixed slots per night so a missing night leaves a visible gap.
  const x = (i: number) => scale(0, Math.max(1, n - 1), 4, w - 5)(i);
  const y = scale(lo - pad, top + pad, height - 4, 4);

  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  points.forEach((p, i) => {
    if (Number.isFinite(p.v)) run.push({ x: x(i), y: y(p.v) });
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length) runs.push(run);

  const lastIdx = n - 1;
  const last = points[lastIdx]!;
  const h = hi !== null && Number.isFinite(points[hi]?.v ?? NaN) ? points[hi]! : null;
  const hx = hi !== null ? x(hi) : 0;
  const showBand = band && Number.isFinite(band.lo) && Number.isFinite(band.hi);

  return (
    <div
      ref={ref}
      className="chart-box"
      style={{ height, touchAction: 'pan-y' }}
      role="img"
      aria-label={`${label}, last ${n} nights${Number.isFinite(last.v) ? `, latest ${format(last.v, last.date)}` : ''}`}
    >
      {width > 0 && (
        <svg
          width={w}
          height={height}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const i = Math.round(((e.clientX - r.left - 4) / Math.max(1, w - 9)) * (n - 1));
            setHi(Math.max(0, Math.min(n - 1, i)));
          }}
          onPointerLeave={() => setHi(null)}
          aria-hidden
        >
          {showBand && <rect x={0} y={y(band.hi)} width={w} height={Math.max(1, y(band.lo) - y(band.hi))} rx={3} fill="var(--spark-band)" />}
          {runs.map((r, i) =>
            r.length > 1 ? (
              <path key={i} d={linePath(r)} fill="none" stroke="var(--spark-line)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            ) : (
              <circle key={i} cx={r[0]!.x} cy={r[0]!.y} r={1.5} fill="var(--spark-line)" />
            ),
          )}
          {h && <line x1={hx} x2={hx} y1={0} y2={height} stroke="var(--axis)" />}
          {Number.isFinite(last.v) && <circle cx={x(lastIdx)} cy={y(last.v)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />}
          {h && hi !== lastIdx && <circle cx={hx} cy={y(h.v)} r={3} fill="var(--spark-line)" stroke="var(--surface)" strokeWidth={1.5} />}
        </svg>
      )}
      {h && (
        <div className="tip" style={{ position: 'absolute', bottom: height + 4, left: Math.min(Math.max(0, hx - 48), w - 104), padding: '3px 7px', minWidth: 0, whiteSpace: 'nowrap', zIndex: 5 }}>
          {format(h.v, h.date)}
        </div>
      )}
    </div>
  );
}
