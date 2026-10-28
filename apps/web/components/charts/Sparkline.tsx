'use client';
import { useState } from 'react';
import { useWidth } from '../ui.tsx';
import { linePath, scale } from './common.tsx';

/** Small trend line with an end dot; hover shows the value at the pointer. */
export function Sparkline({ values, color, height = 34, format }: { values: { ts: number; v: number }[]; color: string; height?: number; format?: (v: number, ts: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const pts = values.filter((p) => Number.isFinite(p.v));
  if (pts.length < 2) return <div ref={ref} style={{ height }} />;
  const w = Math.max(40, width);
  const vs = pts.map((p) => p.v);
  const lo = Math.min(...vs);
  const hiV = Math.max(...vs);
  const pad = (hiV - lo) * 0.1 || 0.5;
  const x = scale(pts[0]!.ts, pts.at(-1)!.ts, 3, w - 5);
  const y = scale(lo - pad, hiV + pad, height - 3, 3);
  const last = pts.at(-1)!;
  const h = hi !== null ? pts[hi] : undefined;
  return (
    <div ref={ref} className="chart-box" style={{ height }}>
      {width > 0 && (
        <svg
          width={w}
          height={height}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const ts = pts[0]!.ts + ((e.clientX - r.left) / w) * (last.ts - pts[0]!.ts);
            let best = 0;
            for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i]!.ts - ts) < Math.abs(pts[best]!.ts - ts)) best = i;
            setHi(best);
          }}
          onPointerLeave={() => setHi(null)}
          aria-hidden
        >
          <path d={linePath(pts.map((p) => ({ x: x(p.ts), y: y(p.v) })))} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(last.ts)} cy={y(last.v)} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={2} />
          {h && (
            <>
              <line x1={x(h.ts)} x2={x(h.ts)} y1={0} y2={height} stroke="var(--muted)" />
              <circle cx={x(h.ts)} cy={y(h.v)} r={3} fill={color} />
            </>
          )}
        </svg>
      )}
      {h && format && (
        <div className="tip" style={{ position: 'absolute', top: -30, left: Math.min(Math.max(0, x(h.ts) - 40), w - 90), padding: '3px 6px' }}>
          {format(h.v, h.ts)}
        </div>
      )}
    </div>
  );
}
