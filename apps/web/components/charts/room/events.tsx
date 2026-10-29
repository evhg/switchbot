'use client';
/** Room › Events charts: the night's event lanes (detected vs simulator truth) and the shower small multiples. */
import { useRef, useState } from 'react';
import { fmt, hm, hourTicks, niceTicks } from '@/lib/format.ts';
import { DrawPath, useInView } from '../../motion.tsx';
import { useWidth } from '../../ui.tsx';
import { FloatTip } from '../common.tsx';
import { seriesPath, TimeChart } from './frame.tsx';
import s from './room.module.css';

// ───────────── Shower impact (small multiples) ─────────────
export function ShowerMini({ series, start, end, metric }: { series: { ts: number; v: number }[]; start: number; end: number; metric: 'rh' | 'temp' }) {
  const vs = series.map((p) => p.v).filter(Number.isFinite);
  if (series.length < 2 || !vs.length) return null;
  const ticks = niceTicks(Math.min(...vs), Math.max(...vs), 3);
  const f = (v: number) => (metric === 'rh' ? `${fmt(v)}%` : `${fmt(v, 1)}°`);
  const near = (t: number) => series.reduce((b, p) => (Math.abs(p.ts - t) < Math.abs(b.ts - t) ? p : b), series[0]!);
  return (
    <TimeChart
      from={series[0]!.ts}
      to={series.at(-1)!.ts}
      domain={[ticks[0]!, ticks.at(-1)!]}
      ticks={ticks}
      fmtY={(v) => `${Math.round(v)}${metric === 'rh' ? '%' : '°'}`}
      height={180}
      label={`${metric === 'rh' ? 'Humidity' : 'Temperature'} around the shower`}
      hover={(t) => {
        const p = near(t);
        return { title: hm(p.ts), rows: [{ label: metric === 'rh' ? 'humidity' : 'room', value: f(p.v) }], dots: [{ v: p.v, color: 'var(--text)' }] };
      }}
    >
      {(g) => (
        <>
          <rect x={g.x(Math.max(g.from, start))} y={g.top} width={Math.max(2, g.x(Math.min(g.to, end)) - g.x(Math.max(g.from, start)))} height={g.bottom - g.top} fill="var(--text)" fillOpacity={0.06} />
          <text x={g.x(Math.max(g.from, start)) + 6} y={g.top - 12} className={s.tick}>
            Shower
          </text>
          <DrawPath d={seriesPath(g, series)} fill="none" stroke="var(--text)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}
    </TimeChart>
  );
}

// ───────────── Event timeline ─────────────
const KINDS = ['in_bed', 'both_in_bed', 'out_of_bed', 'shower', 'door_open', 'room_empty', 'ac_missed'] as const;
const NAMES: Record<string, string> = { in_bed: 'In bed', both_in_bed: 'Both in bed', out_of_bed: 'Out of bed', shower: 'Shower', door_open: 'Door open', room_empty: 'Room empty', ac_missed: 'Aircon missed' };

/** One row per event kind. Detected events are ink; the simulator's truth sits under them at ghost opacity. */
export function EventLanes({ from, to, lanes }: { from: number; to: number; lanes: { label: string; items: { start: number; end?: number; kind: string }[] }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, { threshold: 0.2 });
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);
  const w0 = Math.max(width, 280);
  const L = w0 < 520 ? 104 : 140;
  const w = Math.max(width, 280);
  const x = (t: number) => L + ((t - from) / (to - from)) * (w - L - 8);
  const rowH = 40;
  const H = KINDS.length * rowH + 30;
  const fills = ['var(--text)', 'var(--muted)'];
  const span = (to - from) / 3_600_000;
  const step = [1, 2, 3, 4, 6].find((st) => (span / st) * 64 < w - L) ?? 6;
  return (
    <div ref={box} className={`${s.chart} ${seen ? s.lanesIn : ''}`}>
      <div ref={ref}>
        {width > 0 && (
          <svg width={w} height={H} role="img" aria-label="Events through the night">
            {hourTicks(from, to, step).map((t) =>
              x(t) < L + 12 || x(t) > w - 20 ? null : (
                <g key={t}>
                  <line x1={x(t)} x2={x(t)} y1={0} y2={H - 30} stroke="var(--grid)" />
                  <text x={x(t)} y={H - 8} textAnchor="middle" className={s.tick}>
                    {hm(t)}
                  </text>
                </g>
              ),
            )}
            {KINDS.map((k, ki) => (
              <g key={k}>
                {ki > 0 && <line x1={0} x2={w} y1={ki * rowH} y2={ki * rowH} stroke="var(--hairline)" />}
                <text x={0} y={ki * rowH + 25} className={s.laneLabel}>
                  {NAMES[k]}
                </text>
                {lanes.map((lane, li) =>
                  lane.items
                    .filter((e) => e.kind === k)
                    .map((e, i) => {
                      const y = ki * rowH + 10 + li * 12;
                      const x0 = x(Math.max(from, e.start));
                      const x1 = e.end ? x(Math.min(to, e.end)) : x0;
                      const text = `${lane.label}: ${NAMES[k]} ${hm(e.start)}${e.end ? `–${hm(e.end)}` : ''}`;
                      return (
                        <rect
                          key={`${li}-${i}`}
                          className={s.bar}
                          style={{ transitionDelay: `${ki * 50 + li * 30}ms` }}
                          x={x0 - (x1 - x0 < 8 ? 4 : 0)}
                          y={y}
                          width={Math.max(8, x1 - x0)}
                          height={8}
                          rx={4}
                          fill={fills[li] ?? 'var(--muted)'}
                          fillOpacity={li === 0 ? 1 : 0.5}
                          onPointerEnter={() => setHover({ x: x0, text })}
                          onPointerLeave={() => setHover(null)}
                        >
                          <title>{text}</title>
                        </rect>
                      );
                    }),
                )}
              </g>
            ))}
          </svg>
        )}
      </div>
      {hover && (
        <FloatTip x={hover.x} y={-40} width={w}>
          {hover.text}
        </FloatTip>
      )}
    </div>
  );
}
