'use client';
import { useState } from 'react';
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import type { Night, Person, RoomEvent, SleepStage } from '@sleep-lab/core';
import { fmt, hm, hourTicks, niceTicks, shortDate, shortDay } from '@/lib/format.ts';
import { Legend, useWidth } from '../ui.tsx';
import { AXIS, FloatTip, GRID, MARGIN, scale, TipRow, Y_WIDTH } from './common.tsx';
import { STAGE_ORDER, stageColor } from './NightStrip.tsx';

// ---------- 5.1 scatter + trend ----------
export interface ScatterSeries {
  name: string;
  color: string;
  points: { x: number; y: number; date: string }[];
}

export function TrendScatter({ series, trend, xLabel, yLabel, xDigits = 0, yDigits = 0 }: { series: ScatterSeries[]; trend: { x: number; y: number }[]; xLabel: string; yLabel: string; xDigits?: number; yDigits?: number }) {
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const xt = niceTicks(Math.min(...xs), Math.max(...xs), 4);
  const yt = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  return (
    <>
      <Legend items={[...series.map((s) => ({ label: s.name, color: s.color, shape: 'dot' as const })), { label: 'LOESS trend (both)', color: 'var(--text)' }]} />
      <ResponsiveContainer width="100%" height={230}>
        <ComposedChart margin={{ ...MARGIN, bottom: 14 }}>
          <CartesianGrid stroke="var(--grid)" />
          <XAxis dataKey="x" type="number" domain={[xt[0]!, xt.at(-1)!]} ticks={xt} {...AXIS} label={{ value: xLabel, position: 'insideBottom', offset: -10, fill: 'var(--muted)', fontSize: 11 }} />
          <YAxis dataKey="y" type="number" width={Y_WIDTH + 4} domain={[yt[0]!, yt.at(-1)!]} ticks={yt} {...AXIS} />
          <ZAxis range={[34, 34]} />
          <Tooltip
            cursor={false}
            content={(p) => {
              const d = p.payload?.[0]?.payload as { x: number; y: number; date?: string } | undefined;
              if (!p.active || !d?.date) return null;
              const s = series.find((ss) => ss.points.includes(d as ScatterSeries['points'][number]));
              return (
                <div className="tip">
                  <div className="tip-title">
                    {shortDay(d.date)} {shortDate(d.date)} · {s?.name}
                  </div>
                  <TipRow value={fmt(d.x, xDigits)} label={xLabel} />
                  <TipRow value={fmt(d.y, yDigits)} label={yLabel} />
                </div>
              );
            }}
          />
          {series.map((s) => (
            <Scatter key={s.name} data={s.points} fill={s.color} fillOpacity={0.75} isAnimationActive={false} />
          ))}
          <Line data={trend} dataKey="y" stroke="var(--text)" strokeWidth={2} dot={false} isAnimationActive={false} legendType="none" />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

// ---------- interval plot (bucket comparison + forest plot) ----------
export interface IntervalRow {
  label: string;
  sub?: string;
  est: number;
  lo: number;
  hi: number;
  color: string;
  group?: string;
  /** 0..1 progress towards the needed sample size, drawn under the label. */
  progress?: number;
}

export function IntervalPlot({ rows, zero, unit, digits = 0, labelW = 118 }: { rows: IntervalRow[]; zero?: number; unit: string; digits?: number; labelW?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(width, 280);
  const vals = rows.flatMap((r) => [r.lo, r.hi, r.est]).filter(Number.isFinite);
  if (zero !== undefined) vals.push(zero);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals), 4);
  const x = scale(ticks[0]!, ticks.at(-1)!, labelW + 6, w - 12);
  const rowH = 34;
  let y = 0;
  const placed = rows.map((r, i) => {
    const newGroup = r.group && r.group !== rows[i - 1]?.group;
    if (newGroup) y += 18;
    const yy = y + rowH / 2;
    y += rowH;
    return { r, y: yy, newGroup, gy: yy - rowH / 2 - 6 };
  });
  const H = y + 22;
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={w} height={H} role="img" aria-label="Estimates with 95% intervals">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={0} y2={H - 18} stroke="var(--grid)" />
              <text x={x(t)} y={H - 4} textAnchor="middle" fill="var(--muted)" fontSize={10}>
                {fmt(t, Math.abs(t) < 10 && t % 1 ? 1 : 0)}
              </text>
            </g>
          ))}
          {zero !== undefined && <line x1={x(zero)} x2={x(zero)} y1={0} y2={H - 18} stroke="var(--text-2)" strokeWidth={1.5} />}
          {placed.map(({ r, y: yy, newGroup, gy }, i) => (
            <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              {newGroup && (
                <text x={0} y={gy} fill="var(--text)" fontSize={11} fontWeight={600}>
                  {r.group}
                </text>
              )}
              <rect x={0} y={yy - rowH / 2} width={w} height={rowH} fill={hover === i ? 'var(--surface-2)' : 'transparent'} />
              <text x={0} y={yy + (r.sub ? -2 : 4)} fill="var(--text)" fontSize={12}>
                {r.label}
              </text>
              {r.sub && (
                <text x={0} y={yy + 11} fill="var(--muted)" fontSize={10}>
                  {r.sub}
                </text>
              )}
              {r.progress !== undefined && (
                <g>
                  <rect x={labelW - 34} y={yy - 7} width={30} height={3} rx={1.5} fill="var(--ring-track)" />
                  <rect x={labelW - 34} y={yy - 7} width={30 * Math.min(1, r.progress)} height={3} rx={1.5} fill="var(--text-2)" />
                </g>
              )}
              {Number.isFinite(r.lo) && Number.isFinite(r.hi) && <line x1={x(r.lo)} x2={x(r.hi)} y1={yy} y2={yy} stroke={r.color} strokeWidth={2} strokeLinecap="round" />}
              {Number.isFinite(r.est) && <circle cx={x(r.est)} cy={yy} r={5} fill={r.color} stroke="var(--surface)" strokeWidth={2} />}
            </g>
          ))}
        </svg>
      )}
      {hover !== null && rows[hover] && (
        <FloatTip x={x(rows[hover].est)} y={(placed[hover]?.y ?? 0) + 14} width={w}>
          <div className="tip-title">{rows[hover].group ? `${rows[hover].group} · ` : ''}{rows[hover].label}</div>
          <TipRow color={rows[hover].color} value={`${fmt(rows[hover].est, digits)} ${unit}`} label="estimate" />
          <TipRow value={`${fmt(rows[hover].lo, digits)} to ${fmt(rows[hover].hi, digits)}`} label="95 % interval" />
          {rows[hover].sub && <TipRow value={rows[hover].sub} label="" />}
        </FloatTip>
      )}
    </div>
  );
}

// ---------- 5.4 correlation matrix ----------
export function CorrMatrix({ labels, matrix }: { labels: string[]; matrix: number[][] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<[number, number] | null>(null);
  const n = labels.length;
  const L = 86;
  const cell = Math.max(14, Math.min(30, Math.floor((Math.max(width, 260) - L - 34) / n)));
  const W = L + n * cell + 34;
  const color = (r: number) =>
    !Number.isFinite(r) ? 'var(--surface-2)' : `color-mix(in oklab, ${r >= 0 ? 'var(--div-pos)' : 'var(--div-neg)'} ${Math.round(Math.min(1, Math.abs(r)) * 100)}%, var(--div-mid))`;
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={W} height={L + n * cell} role="img" aria-label="Correlation matrix">
          {labels.map((l, i) => (
            <g key={l}>
              <text x={L - 4} y={L + i * cell + cell / 2 + 3.5} textAnchor="end" fill="var(--text-2)" fontSize={10}>
                {l}
              </text>
              <text transform={`translate(${L + i * cell + cell / 2 + 3} ${L - 4}) rotate(-60)`} fill="var(--text-2)" fontSize={10}>
                {l}
              </text>
            </g>
          ))}
          {matrix.map((row, i) =>
            row.map((r, j) => (
              <rect
                key={`${i}-${j}`}
                x={L + j * cell + 1}
                y={L + i * cell + 1}
                width={cell - 2}
                height={cell - 2}
                rx={2}
                fill={i === j ? 'var(--surface-2)' : color(r)}
                stroke={hover && hover[0] === i && hover[1] === j ? 'var(--text)' : 'none'}
                onPointerEnter={() => setHover([i, j])}
                onPointerLeave={() => setHover(null)}
              >
                <title>{`${labels[i]} × ${labels[j]}: r = ${fmt(r, 2)}`}</title>
              </rect>
            )),
          )}
        </svg>
      )}
      <div className="row between small" style={{ minHeight: 18 }}>
        <span className="t2">{hover ? `${labels[hover[0]]} × ${labels[hover[1]]}: r = ${fmt(matrix[hover[0]]![hover[1]]!, 2)}` : 'Hover or tap a cell'}</span>
        <span className="row" style={{ gap: 4 }}>
          <span className="muted">−1</span>
          {[-1, -0.5, 0, 0.5, 1].map((v) => (
            <i key={v} className="key-rect" style={{ background: v === 0 ? 'var(--div-mid)' : color(v) }} />
          ))}
          <span className="muted">+1</span>
        </span>
      </div>
    </div>
  );
}

// ---------- 6.1 mirrored hypnograms ----------
const LEVEL: Record<SleepStage, number> = { awake: 0, rem: 1, light: 2, deep: 3 };

export function MirroredHypnogram({ night, people, colors, events, shared }: { night: Night; people: Person[]; colors: string[]; events: RoomEvent[]; shared: { at: number; first: string }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [a, b] = night.people;
  const from = Math.min(a?.sleep.start ?? night.lightsOut, b?.sleep.start ?? night.lightsOut) - 10 * 60_000;
  const to = Math.max(a?.sleep.end ?? night.wake, b?.sleep.end ?? night.wake) + 10 * 60_000;
  const L = 44;
  const w = Math.max(width, 280);
  const x = scale(from, to, L, w - 6);
  const lane = 52;
  const mid = 70;
  const H = mid * 2 + 24;
  const temps = night.room.filter((r) => r.ts >= from && r.ts <= to);
  const tLo = Math.min(...temps.map((r) => r.tempC));
  const tHi = Math.max(...temps.map((r) => r.tempC));
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const draw = (pn: typeof a, dir: 1 | -1) => {
    if (!pn) return null;
    // Awake sits next to the shared axis; deep is furthest away.
    const yOf = (s: SleepStage) => mid - dir * (10 + (LEVEL[s] / 3) * (lane - 14)) - (dir === 1 ? 5 : 0);
    return pn.sleep.stages.map((s, i) => {
      const x0 = x(s.start);
      const x1 = x(s.end);
      return <rect key={i} x={x0} y={yOf(s.stage)} width={Math.max(0.8, x1 - x0 - 0.4)} height={5} rx={1.5} fill={stageColor(s.stage)} />;
    });
  };
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={w} height={H} role="img" aria-label="Mirrored hypnograms around a shared room-temperature axis">
          {hourTicks(from, to, 2).map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={4} y2={H - 18} stroke="var(--grid)" />
              <text x={x(t)} y={H - 4} fill="var(--muted)" fontSize={10} textAnchor="middle">
                {hm(t)}
              </text>
            </g>
          ))}
          {/* shared room axis: temperature as a heat strip */}
          {temps
            .filter((_, i) => i % 3 === 0)
            .map((r) => (
              <rect key={r.ts} x={x(r.ts)} y={mid - 4} width={Math.max(1, x(r.ts + 3 * 60_000) - x(r.ts))} height={8} fill="var(--temp)" opacity={0.15 + 0.85 * ((r.tempC - tLo) / Math.max(0.5, tHi - tLo))} />
            ))}
          <text x={0} y={mid + 3} fill="var(--muted)" fontSize={9}>
            room °C
          </text>
          {a && (
            <text x={0} y={16} fill="var(--text)" fontSize={11} fontWeight={600}>
              <tspan fill={colors[0]}>●</tspan> {name(a.personId)}
            </text>
          )}
          {b && (
            <text x={0} y={H - 30} fill="var(--text)" fontSize={11} fontWeight={600}>
              <tspan fill={colors[1]}>●</tspan> {name(b.personId)}
            </text>
          )}
          {draw(a, 1)}
          {draw(b, -1)}
          {shared.map((s, i) => (
            <line key={i} x1={x(s.at)} x2={x(s.at)} y1={mid - lane + 6} y2={mid + lane - 6} stroke="var(--critical)" strokeWidth={1.5} strokeDasharray="3 2" />
          ))}
          {events
            .filter((e) => e.kind === 'out_of_bed' || e.kind === 'door_open' || e.kind === 'shower')
            .filter((e) => e.start >= from && e.start <= to)
            .map((e, i) => (
              <circle key={`e${i}`} cx={x(e.start)} cy={mid} r={3} fill="var(--text)" />
            ))}
        </svg>
      )}
      <Legend
        items={[
          ...STAGE_ORDER.map((s) => ({ label: s === 'rem' ? 'REM' : s[0]!.toUpperCase() + s.slice(1), color: stageColor(s), shape: 'rect' as const })),
          { label: 'Shared wake', color: 'var(--critical)', shape: 'dash' as const },
          { label: 'Room event', color: 'var(--text)', shape: 'dot' as const },
        ]}
      />
    </div>
  );
}

// ---------- 6.3 thermal preference compromise ----------
export function CompromiseAxis({ marks, lo = 17, hi = 23 }: { marks: { label: string; value: number; color: string; tier: 0 | 1 | 2 }[]; lo?: number; hi?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(width, 260);
  const x = scale(lo, hi, 16, w - 16);
  const y = 44;
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={w} height={112} role="img" aria-label="Each partner's best early-night temperature and tonight's deep-phase target">
          <defs>
            <linearGradient id="cmp-grad">
              <stop offset="0" stopColor="var(--div-pos)" stopOpacity={0.5} />
              <stop offset="1" stopColor="var(--div-neg)" stopOpacity={0.5} />
            </linearGradient>
          </defs>
          <rect x={x(lo)} y={y - 3} width={x(hi) - x(lo)} height={6} rx={3} fill="url(#cmp-grad)" />
          {Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((t) => (
            <text key={t} x={x(t)} y={y + 22} textAnchor="middle" fill="var(--muted)" fontSize={10}>
              {t}°
            </text>
          ))}
          {marks.map((m) =>
            Number.isFinite(m.value) ? (
              <g key={m.label}>
                <line x1={x(m.value)} x2={x(m.value)} y1={m.tier === 0 ? y - 16 : y} y2={m.tier === 0 ? y : y + (m.tier === 1 ? 12 : 30)} stroke={m.color} strokeWidth={m.tier === 2 ? 1 : 2} />
                <circle cx={x(m.value)} cy={y} r={6} fill={m.color} stroke="var(--surface)" strokeWidth={2} />
                <text
                  x={Math.min(w - 4, Math.max(4, x(m.value)))}
                  y={m.tier === 0 ? y - 20 : m.tier === 1 ? y + 38 : y + 58}
                  textAnchor={x(m.value) < 50 ? 'start' : x(m.value) > w - 50 ? 'end' : 'middle'}
                  fill="var(--text)"
                  fontSize={11}
                >
                  {m.label} {fmt(m.value, 1)}°
                </text>
              </g>
            ) : null,
          )}
        </svg>
      )}
    </div>
  );
}
