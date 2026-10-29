'use client';
import { useState } from 'react';
import type { ScoreDriver } from '@sleep-lab/core';
import { signed } from '@/lib/format.ts';
import { Reveal } from '../motion.tsx';
import { useWidth } from '../ui.tsx';
import s from '../story/story.module.css';
import { scale } from './common.tsx';

/**
 * Horizontal waterfall (docs/DESIGN.md §7.2): starts at a typical night (70), each driver moves the running total,
 * ends at the score. Rows double as the list of drivers, so the labels are the legend. Bars grow from their start on
 * reveal; gains in --div-pos (ink), losses in --div-neg (signal), the base in --hairline-2 and the total in --text-2.
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
  const barW = Math.max(96, Math.min(240, width * 0.36));
  const x = scale(lo, hi, 0, barW);
  return (
    <Reveal className={s.wf} y={8}>
      <div ref={ref}>
        {rows.map((r, i) => {
          const a = Math.min(r.from, r.to);
          const b = Math.max(r.from, r.to);
          const x0 = r.kind === 'step' ? x(a) : 0;
          const x1 = x(b);
          const pos = (r.points ?? 0) >= 0;
          const fill = r.kind === 'step' ? (pos ? 'var(--div-pos)' : 'var(--div-neg)') : r.kind === 'total' ? 'var(--text-2)' : 'var(--hairline-2)';
          return (
            <div
              key={i}
              className={`${s.wfRow} ${hover === i ? s.wfHover : ''} ${r.kind === 'total' ? s.wfTotal : ''}`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              style={{ gridTemplateColumns: `minmax(0,1fr) ${barW}px 44px`, ['--i' as string]: i }}
            >
              <span className={s.wfLabel}>{r.label}</span>
              <span className={s.wfTrack} style={{ width: barW }}>
                <i
                  style={{
                    left: x0,
                    width: Math.max(2, x1 - x0),
                    background: fill,
                    transformOrigin: r.kind === 'step' && !pos ? '100% 50%' : '0 50%',
                  }}
                />
              </span>
              <span className={`num ${s.wfNum}`} style={r.kind === 'step' && !pos ? { color: 'var(--signal)' } : undefined}>
                {r.kind === 'step' ? signed(r.points ?? 0) : Math.round(r.to)}
              </span>
            </div>
          );
        })}
      </div>
    </Reveal>
  );
}
