'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { DrawPath } from '../motion.tsx';
import { linePath, scale } from './common.tsx';

/**
 * Small trend line that draws in on reveal (1.3 s), with an end dot that fades in after it.
 * Hover / touch shows the value at the pointer when `format` is given.
 *
 *   <Sparkline values={[{ ts, v }]} color="var(--person-a)" height={26} band={{ lo, hi }} lineColor="var(--spark-line)" />
 *   `color` = end dot (and line, unless `lineColor`); `band` = ±1 SD wash in --spark-band.
 */
export function Sparkline({
  values,
  color,
  height = 34,
  format,
  band,
  lineColor,
  strokeWidth = 1.6,
  dot = true,
}: {
  values: { ts: number; v: number }[];
  color: string;
  height?: number;
  format?: (v: number, ts: number) => string;
  band?: { lo: number; hi: number };
  lineColor?: string;
  strokeWidth?: number;
  dot?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((e) => {
      const w = e[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [hi, setHi] = useState<number | null>(null);
  const pts = values.filter((p) => Number.isFinite(p.v));
  if (pts.length < 2) return <div ref={ref} style={{ height }} />;
  const w = Math.max(20, width);
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs);
  let hiV = Math.max(...vs);
  if (band && Number.isFinite(band.lo) && Number.isFinite(band.hi)) {
    lo = Math.min(lo, band.lo);
    hiV = Math.max(hiV, band.hi);
  }
  const pad = (hiV - lo) * 0.1 || 0.5;
  const x = scale(pts[0]!.ts, pts.at(-1)!.ts, 3, w - 4);
  const y = scale(lo - pad, hiV + pad, height - 3, 3);
  const last = pts.at(-1)!;
  const h = hi !== null ? pts[hi] : undefined;
  return (
    <div ref={ref} className="chart-box" style={{ height }}>
      {width > 0 && (
        <svg
          width={w}
          height={height}
          onPointerMove={
            format
              ? (e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const ts = pts[0]!.ts + ((e.clientX - r.left) / w) * (last.ts - pts[0]!.ts);
                  let best = 0;
                  for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i]!.ts - ts) < Math.abs(pts[best]!.ts - ts)) best = i;
                  setHi(best);
                }
              : undefined
          }
          onPointerLeave={() => setHi(null)}
          aria-hidden
        >
          {band && Number.isFinite(band.lo) && Number.isFinite(band.hi) && (
            <rect x={0} width={w} y={y(band.hi)} height={Math.max(1, y(band.lo) - y(band.hi))} rx={2} fill="var(--spark-band)" />
          )}
          <DrawPath d={linePath(pts.map((p) => ({ x: x(p.ts), y: y(p.v) })))} fill="none" stroke={lineColor ?? color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
          {dot && <circle className="fade-late" cx={x(last.ts)} cy={y(last.v)} r={3} fill={color} stroke="var(--surface)" strokeWidth={1.5} />}
          {h && (
            <>
              <line x1={x(h.ts)} x2={x(h.ts)} y1={0} y2={height} stroke="var(--hairline-2)" />
              <circle cx={x(h.ts)} cy={y(h.v)} r={3} fill={color} />
            </>
          )}
        </svg>
      )}
      {h && format && (
        <div className="tip" style={{ position: 'absolute', top: -34, left: Math.min(Math.max(0, x(h.ts) - 40), w - 90), padding: '4px 7px' }}>
          {format(h.v, h.ts)}
        </div>
      )}
    </div>
  );
}
