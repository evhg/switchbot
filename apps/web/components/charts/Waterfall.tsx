'use client';
import { useState } from 'react';
import type { ScoreDriver } from '@sleep-lab/core';
import { signed } from '@/lib/format.ts';
import { useWidth } from '../ui.tsx';
import { scale } from './common.tsx';

/**
 * Horizontal waterfall: starts at a typical night (70), each driver moves the running total,
 * ends at the score. Rows double as the list of drivers, so the labels are the legend.
 */
export function Waterfall({ drivers, start = 70, total, totalLabel }: { drivers: ScoreDriver[]; start?: number; total: number; totalLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const rows: { label: string; from: number; to: number; kind: 'base' | 'step' | 'total'; points?: number }[] = [{ label: 'Typical night', from: 0, to: start, kind: 'base' }];
  let run = start;
  for (const d of drivers) {
    rows.push({ label: d.label, from: run, to: run + d.points, kind: 'step', points: d.points });
    run += d.points;
  }
  rows.push({ label: totalLabel, from: 0, to: total, kind: 'total' });
  const lo = Math.max(0, Math.floor(Math.min(...rows.map((r) => Math.min(r.from, r.to)).filter((v) => v > 0), start) / 10) * 10 - 10);
  const hi = Math.min(100, Math.ceil(Math.max(...rows.map((r) => Math.max(r.from, r.to))) / 10) * 10);
  const barW = Math.max(96, Math.min(240, width * 0.34));
  const x = scale(lo, hi, 0, barW);
  const rowH = 34;
  return (
    <div ref={ref} className="chart-box">
      {rows.map((r, i) => {
        const a = Math.min(r.from, r.to);
        const b = Math.max(r.from, r.to);
        const x0 = r.kind === 'step' ? x(a) : 0;
        const x1 = x(b);
        const fill = r.kind === 'step' ? ((r.points ?? 0) >= 0 ? 'var(--div-pos)' : 'var(--div-neg)') : 'var(--axis)';
        return (
          <div
            key={i}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            style={{
              display: 'grid',
              gridTemplateColumns: `minmax(0,1fr) ${barW}px 38px`,
              alignItems: 'center',
              gap: 8,
              minHeight: rowH,
              borderTop: i ? '1px solid var(--border)' : undefined,
              background: hover === i ? 'var(--surface-2)' : undefined,
            }}
          >
            <span style={{ fontSize: 12.5, color: r.kind === 'step' ? 'var(--text)' : 'var(--text-2)', fontWeight: r.kind === 'total' ? 600 : 400, lineHeight: 1.25, padding: '4px 0' }}>{r.label}</span>
            <svg width={barW} height={16} aria-hidden>
              <rect x={0} y={7.5} width={barW} height={1} fill="var(--grid)" />
              <rect x={x0} y={2} width={Math.max(2, x1 - x0)} height={12} rx={3} fill={fill} opacity={r.kind === 'base' ? 0.6 : 1} />
            </svg>
            <span className="num" style={{ fontSize: 13, textAlign: 'right', fontWeight: 600, color: 'var(--text)' }}>
              {r.kind === 'step' ? signed(r.points ?? 0) : Math.round(r.to)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
