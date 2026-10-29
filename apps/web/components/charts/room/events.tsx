'use client';
/** Room tab, Events section: event lanes (detected vs simulator truth) and shower small multiples. */
import { useRef, useState } from 'react';
import { Area, CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmt, hm, hourTicks, niceTicks } from '@/lib/format.ts';
import { useInView } from '../../motion.tsx';
import { Legend, useWidth } from '../../ui.tsx';
import { AreaGradient, AXIS, CURSOR, FloatTip, GRID, STROKE, Tip, useChartAnim, useSvgId } from '../common.tsx';
import s from './room.module.css';

const MONO = 'var(--font-mono)';

// ───────────── Shower impact (small multiples) ─────────────
export function ShowerMini({ series, start, end, metric }: { series: { ts: number; v: number }[]; start: number; end: number; metric: 'rh' | 'temp' }) {
  const anim = useChartAnim();
  const gid = useSvgId('sh');
  const color = metric === 'rh' ? 'var(--rh)' : 'var(--temp)';
  const vs = series.map((p) => p.v);
  const ticks = niceTicks(Math.min(...vs), Math.max(...vs), 3);
  return (
    <ResponsiveContainer width="100%" height={116}>
      <LineChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <defs>
          <AreaGradient id={gid} color={color} from={0.25} />
        </defs>
        <ReferenceArea x1={start} x2={end} fill="var(--rh)" fillOpacity={0.1} stroke="none" />
        <CartesianGrid {...GRID} />
        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} ticks={hourTicks(series[0]?.ts ?? 0, series.at(-1)?.ts ?? 0, 1)} tickFormatter={(v: number) => hm(v)} {...AXIS} />
        <YAxis width={38} domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} tickFormatter={(v: number) => `${Math.round(v)}${metric === 'rh' ? '%' : '°'}`} {...AXIS} />
        <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.filter((x) => x.dataKey === 'v' && x.name !== 'area').slice(0, 1).map((x) => ({ label: metric === 'rh' ? 'RH' : 'temp', value: metric === 'rh' ? `${fmt(Number(x.value))} %` : `${fmt(Number(x.value), 1)} °C`, color }))} />} />
        <Area dataKey="v" name="area" stroke="none" fill={`url(#${gid})`} baseValue={ticks[0]} {...anim} activeDot={false} />
        <Line dataKey="v" stroke={color} strokeWidth={STROKE.primary} strokeLinecap="round" dot={false} {...anim} activeDot={{ r: 3.5, fill: color, stroke: 'var(--surface)', strokeWidth: 2 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ───────────── Event timeline ─────────────
const KINDS = ['in_bed', 'both_in_bed', 'out_of_bed', 'shower', 'door_open', 'room_empty', 'ac_missed'] as const;
const NAMES: Record<string, string> = { in_bed: 'In bed', both_in_bed: 'Both in bed', out_of_bed: 'Out of bed', shower: 'Shower', door_open: 'Door', room_empty: 'Empty', ac_missed: 'AC missed' };

export function EventLanes({ from, to, lanes }: { from: number; to: number; lanes: { label: string; items: { start: number; end?: number; kind: string }[] }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, { threshold: 0.2 });
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);
  const L = 74;
  const w = Math.max(width, 260);
  const x = (t: number) => L + ((t - from) / (to - from)) * (w - L - 6);
  const rowH = 26;
  const H = KINDS.length * rowH + 22;
  const colors = ['var(--ch-accent)', 'var(--hairline-2)'];
  return (
    <div ref={box} className={`chart-box ${seen ? s.lanesIn : ''}`}>
      <div ref={ref}>
        {width > 0 && (
          <svg width={w} height={H} role="img" aria-label="Event timeline">
            {hourTicks(from, to, 3).map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={0} y2={H - 18} stroke="var(--grid)" />
                <text x={x(t)} y={H - 5} fill="var(--muted)" fontSize={9.5} fontFamily={MONO} textAnchor="middle">
                  {hm(t)}
                </text>
              </g>
            ))}
            {KINDS.map((k, ki) => (
              <g key={k}>
                {ki > 0 && <line x1={0} x2={w} y1={ki * rowH} y2={ki * rowH} stroke="var(--hairline)" />}
                <text x={0} y={ki * rowH + 16} fill="var(--text-2)" fontSize={9.5} fontFamily={MONO} letterSpacing=".08em">
                  {NAMES[k]!.toUpperCase()}
                </text>
                {lanes.map((lane, li) =>
                  lane.items
                    .filter((e) => e.kind === k)
                    .map((e, i) => {
                      const y = ki * rowH + 6 + li * 9;
                      const x0 = x(Math.max(from, e.start));
                      const x1 = e.end ? x(Math.min(to, e.end)) : x0;
                      const text = `${lane.label}: ${NAMES[k]} ${hm(e.start)}${e.end ? `–${hm(e.end)}` : ''}`;
                      return (
                        <rect
                          key={`${li}-${i}`}
                          className={s.bar}
                          style={{ transitionDelay: `${ki * 60 + li * 30}ms` }}
                          x={x0 - (x1 - x0 < 7 ? 3.5 : 0)}
                          y={y}
                          width={Math.max(7, x1 - x0)}
                          height={7}
                          rx={3.5}
                          fill={colors[li] ?? 'var(--axis)'}
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
        <FloatTip x={hover.x} y={-34} width={w}>
          {hover.text}
        </FloatTip>
      )}
      <Legend items={lanes.map((l, i) => ({ label: l.label, color: colors[i] ?? 'var(--axis)', shape: 'rect' as const }))} />
    </div>
  );
}
