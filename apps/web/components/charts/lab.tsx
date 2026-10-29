'use client';
/**
 * Lab charts, v2 "Instrument" (docs/DESIGN.md §7, §9.4). Hand-written SVG, animated with opacity / transform / stroke
 * draw only, once. Type comes from CSS (.chart-box text = caption size); series are labelled on the chart, never in
 * a legend. You are ink, Erik is steel blue (night: hollow / dashed); --signal only marks what is beyond "no effect"
 * or a shared wake-up. Night mode and reduced motion: no glides, no pops.
 *
 *   TrendScatter       dots glide to new positions when the variables change; the trend line redraws.
 *   IntervalPlot       estimates with 95 % intervals (forest plot / buckets), with breathing room.
 *   CorrMatrix         diverging cells with r printed in each (drill-in only).
 *   MirroredHypnogram  You above, Erik below one shared room-temperature strip; shared wake-ups marked.
 *   CompromiseAxis     cool → warm track with each partner's best temperature and tonight's deep target.
 */
import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Night, Person, RoomEvent, SleepStage } from '@sleep-lab/core';
import { fmt, hm, hourTicks, niceTicks, shortDate, shortDay } from '@/lib/format.ts';
import { DrawPath, useInViewCallback, useMotionPrefs } from '../motion.tsx';
import { useWidth } from '../ui.tsx';
import { FloatTip, linePath, scale, TipRow, useSvgId } from './common.tsx';
import { stageColor } from './NightStrip.tsx';
import s from './lab.module.css';

/** Adds `.in` to the element once it is revealed (drives the CSS-module entrance states). */
function useRevealClass<T extends Element>() {
  const ref = useRef<T>(null);
  useInViewCallback(ref, (v) => v && ref.current?.classList.add(s.in!), { threshold: 0.12 });
  return ref;
}

const sgn = (v: number, dp: number) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), dp)}` : '–');

/** Tick label with just enough decimals for the tick step. */
const tickFmt = (ticks: number[]) => {
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 1;
  const dp = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return (t: number) => (t < 0 ? `−${fmt(-t, dp)}` : fmt(t, dp));
};

// ───────────────────────────────────────── scatter + trend ─────────────────────────────────────────
export interface ScatterSeries {
  name: string;
  color: string;
  points: { x: number; y: number; date: string }[];
}

export function TrendScatter({
  series,
  trend,
  xLabel,
  yLabel,
  xDigits = 0,
  yDigits = 0,
  trendKey = '',
}: {
  series: ScatterSeries[];
  trend: { x: number; y: number }[];
  xLabel: string;
  yLabel: string;
  xDigits?: number;
  yDigits?: number;
  trendKey?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRevealClass<HTMLDivElement>();
  const { night } = useMotionPrefs();
  const [hover, setHover] = useState<{ si: number; pi: number } | null>(null);
  const w = Math.max(width, 280);
  const H = w >= 700 ? 380 : 300;
  const L = 8;
  const R = 48;
  const T = 30;
  const B = 52;
  const xs = series.flatMap((ss) => ss.points.map((p) => p.x));
  const ys = series.flatMap((ss) => ss.points.map((p) => p.y));
  const xt = xs.length ? niceTicks(Math.min(...xs), Math.max(...xs), 5) : [0, 1];
  const yt = ys.length ? niceTicks(Math.min(...ys), Math.max(...ys), 4) : [0, 1];
  const x = scale(xt[0]!, xt.at(-1)!, L, w - R);
  const y = scale(yt[0]!, yt.at(-1)!, H - B, T);
  const trendD = linePath(trend.map((p) => ({ x: x(p.x), y: y(p.y) })));
  const fx = tickFmt(xt);
  const fy = tickFmt(yt);

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best: { si: number; pi: number; d: number } | null = null;
    series.forEach((ss, si) =>
      ss.points.forEach((p, pi) => {
        const d = Math.hypot(x(p.x) - px, y(p.y) - py);
        if (d < 26 && (!best || d < best.d)) best = { si, pi, d };
      }),
    );
    const b = best as { si: number; pi: number } | null;
    setHover(b ? { si: b.si, pi: b.pi } : null);
  };
  const hp = hover ? series[hover.si]?.points[hover.pi] : undefined;
  const lastTrend = [...trend].reverse().find((p) => Number.isFinite(p.y));

  return (
    <div ref={ref} className="chart-box">
      <div ref={box} className={s.scatter}>
        {width > 0 && (
          <svg width={w} height={H} role="img" aria-label={`${yLabel} against ${xLabel}, one dot per person-night`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: 'pan-y' }}>
            <text x={w} y={14} textAnchor="end">
              {yLabel}
            </text>
            {yt.map((t) => (
              <g key={`y${t}`}>
                <line x1={L} x2={w - R} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
                <text x={w} y={y(t) + 4} textAnchor="end">
                  {fy(t)}
                </text>
              </g>
            ))}
            {xt.map((t) => (
              <text key={`x${t}`} x={x(t)} y={H - B + 22} textAnchor="middle">
                {fx(t)}
              </text>
            ))}
            <text x={w - R} y={H - 4} textAnchor="end">
              {xLabel}
            </text>
            {series.map((ss, si) =>
              ss.points.map((p, pi) => {
                const hollow = night && si === 1;
                return (
                  <circle
                    key={`${ss.name}-${p.date}`}
                    className={s.dot}
                    r={3.5}
                    cx={0}
                    cy={0}
                    fill={hollow ? 'none' : ss.color}
                    fillOpacity={si === 0 ? 0.85 : 0.75}
                    stroke={hollow ? ss.color : 'none'}
                    strokeWidth={hollow ? 1.3 : 0}
                    style={{ transform: `translate(${x(p.x).toFixed(1)}px,${y(p.y).toFixed(1)}px)`, ['--d' as string]: `${Math.min(pi * 5, 360)}ms` }}
                  />
                );
              }),
            )}
            {trendD && <DrawPath key={trendKey} d={trendD} fill="none" stroke="var(--text)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" delay={250} />}
            {lastTrend && (
              // Named in the clear band above the plot (on the dots it was unreadable), with a short line sample.
              <g>
                <line x1={L} x2={L + 22} y1={9} y2={9} stroke="var(--text)" strokeWidth={2} strokeLinecap="round" />
                <text x={L + 30} y={14} className={s.ink}>
                  Trend, both of you
                </text>
              </g>
            )}
            {hp && hover && <circle cx={x(hp.x)} cy={y(hp.y)} r={7} fill="none" stroke={series[hover.si]!.color} strokeWidth={2} pointerEvents="none" />}
          </svg>
        )}
      </div>
      {hp && hover && (
        <FloatTip x={x(hp.x)} y={y(hp.y) + 14} width={w}>
          <div className="tip-title">
            {shortDay(hp.date)} {shortDate(hp.date)} · {series[hover.si]!.name}
          </div>
          <TipRow value={fmt(hp.x, xDigits)} label={xLabel} />
          <TipRow value={fmt(hp.y, yDigits)} label={yLabel} />
        </FloatTip>
      )}
    </div>
  );
}

// ───────────────────────────────────────── interval plot (buckets + forest) ─────────────────────────────────────────
export interface IntervalRow {
  label: string;
  sub?: string;
  est: number;
  lo: number;
  hi: number;
  color: string;
  group?: string;
  /** 0..1 progress towards the needed sample size. */
  progress?: number;
}

/**
 * One group per question ("Door ajar"), one row per person under it. The dashed vertical is "no effect"; a row whose
 * interval clears it is drawn in full ink, others are quieter. Labels sit in a left column; phone keeps it narrow.
 */
export function IntervalPlot({
  rows,
  zero,
  unit,
  digits = 0,
  animKey = '',
  progressLabel,
  axisLabel,
}: {
  rows: IntervalRow[];
  zero?: number;
  unit: string;
  digits?: number;
  /** Changes when the metric changes: whiskers redraw. */
  animKey?: string;
  /** Caption for the sample-size bar (e.g. "12 of 35 nights"). */
  progressLabel?: (r: IntervalRow) => string;
  /** Axis title with the unit, e.g. "Change in deep sleep, min". */
  axisLabel?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRevealClass<HTMLDivElement>();
  const { night } = useMotionPrefs();
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(width, 280);
  const wide = w >= 640;
  const labelW = wide ? (progressLabel ? 220 : 160) : progressLabel ? 60 : 104;
  const rowH = wide ? 40 : 44;
  const vals = rows.flatMap((r) => [r.lo, r.hi, r.est]).filter(Number.isFinite);
  if (zero !== undefined) vals.push(zero);
  const ticks = vals.length ? niceTicks(Math.min(...vals), Math.max(...vals), 4) : [0, 1];
  const x = scale(ticks[0]!, ticks.at(-1)!, labelW + 16, w - 16);
  const ft = tickFmt(ticks);
  let yy0 = zero !== undefined ? 28 : 8;
  const placed = rows.map((r, i) => {
    const newGroup = !!r.group && r.group !== rows[i - 1]?.group;
    if (newGroup) yy0 += i === 0 ? 30 : 46;
    const yy = yy0 + rowH / 2;
    yy0 += rowH;
    return { r, y: yy, newGroup, gy: yy - rowH / 2 - 10 };
  });
  const H = yy0 + 34 + (axisLabel ? 24 : 0);
  const axisY = H - (axisLabel ? 24 : 0);
  return (
    <div ref={ref} className="chart-box">
      <div ref={box} className={s.ivp}>
        {width > 0 && (
          <svg width={w} height={H} role="img" aria-label="Estimates with 95% intervals">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={zero !== undefined ? 24 : 0} y2={axisY - 30} stroke="var(--grid)" />
                <text x={x(t)} y={axisY - 8} textAnchor="middle">
                  {zero !== undefined && t > 0 ? '+' : ''}
                  {ft(t)}
                </text>
              </g>
            ))}
            {axisLabel && (
              <text x={w - 16} y={H - 4} textAnchor="end" className={s.ink}>
                {axisLabel}
              </text>
            )}
            {zero !== undefined && (
              <g>
                <line x1={x(zero)} x2={x(zero)} y1={24} y2={axisY - 30} stroke="var(--muted)" strokeDasharray="4 4" />
                <text x={x(zero)} y={14} textAnchor="middle">
                  No effect
                </text>
              </g>
            )}
            {placed.map(({ r, y: yy, newGroup, gy }, i) => {
              const hollow = night && r.color === 'var(--person-b)';
              const ok = Number.isFinite(r.lo) && Number.isFinite(r.hi) && Number.isFinite(r.est);
              const sig = zero !== undefined && ok && (r.lo > zero || r.hi < zero);
              const quiet = zero !== undefined && !sig;
              return (
                <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onClick={() => setHover((h) => (h === i ? null : i))}>
                  {newGroup && (
                    <text x={0} y={gy} className={s.group}>
                      {r.group}
                    </text>
                  )}
                  <rect x={-8} y={yy - rowH / 2 + 2} width={w + 8} height={rowH - 4} rx={8} fill={hover === i ? 'var(--surface-2)' : 'transparent'} />
                  <circle cx={5} cy={yy - (progressLabel && wide ? 0 : 0)} r={4} fill={hollow ? 'none' : r.color} stroke={r.color} strokeWidth={hollow ? 1.3 : 0} />
                  <text x={18} y={yy} dominantBaseline="central" className={s.rowLabel}>
                    {r.label}
                    {r.sub && !progressLabel && <tspan className={s.rowSub}>{`  ${r.sub}`}</tspan>}
                  </text>
                  {r.progress !== undefined && progressLabel && (
                    <g>
                      {wide && (
                        <text x={labelW - 4} y={yy} textAnchor="end" dominantBaseline="central">
                          {progressLabel(r)}
                        </text>
                      )}
                    </g>
                  )}
                  {ok && (
                    <g key={animKey} opacity={quiet ? 0.55 : 1}>
                      <DrawPath d={`M${x(r.est).toFixed(1)},${yy}L${x(r.lo).toFixed(1)},${yy}`} stroke={r.color} strokeWidth={2} strokeLinecap="round" delay={Math.min(i * 30, 300)} />
                      <DrawPath d={`M${x(r.est).toFixed(1)},${yy}L${x(r.hi).toFixed(1)},${yy}`} stroke={r.color} strokeWidth={2} strokeLinecap="round" delay={Math.min(i * 30, 300)} />
                      <circle className={s.est} cx={x(r.est)} cy={yy} r={5} fill={hollow ? 'var(--bg)' : r.color} stroke={sig ? 'var(--signal)' : hollow ? r.color : 'var(--bg)'} strokeWidth={2} style={{ ['--d' as string]: `${Math.min(i * 30, 300)}ms` }} />
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {hover !== null && rows[hover] && (
        <FloatTip x={x(rows[hover].est)} y={(placed[hover]?.y ?? 0) + 18} width={w}>
          <div className="tip-title">
            {rows[hover].group ? `${rows[hover].group} · ` : ''}
            {rows[hover].label}
          </div>
          <TipRow color={rows[hover].color} value={`${zero !== undefined ? sgn(rows[hover].est, digits) : fmt(rows[hover].est, digits)} ${unit}`} label="estimate" />
          <TipRow value={zero !== undefined ? `${sgn(rows[hover].lo, digits)} to ${sgn(rows[hover].hi, digits)}` : `${fmt(rows[hover].lo, digits)} to ${fmt(rows[hover].hi, digits)}`} label="95% interval" />
          {rows[hover].sub && <TipRow value={rows[hover].sub} label={rows[hover].progress !== undefined ? 'nights tagged vs not' : ''} />}
        </FloatTip>
      )}
    </div>
  );
}

// ───────────────────────────────────────── correlation matrix ─────────────────────────────────────────
/** Diverging cells (--div-neg → --div-mid → --div-pos) with r printed in each cell. Scrolls sideways on a phone. */
export function CorrMatrix({ labels, matrix }: { labels: string[]; matrix: number[][] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRevealClass<HTMLDivElement>();
  const [hover, setHover] = useState<[number, number] | null>(null);
  const n = labels.length;
  const L = 112;
  const T = 112;
  const cell = Math.max(38, Math.min(48, Math.floor((Math.max(width, 260) - L - 72) / n)));
  const W = L + n * cell + 72;
  const { night } = useMotionPrefs();
  const color = (r: number) =>
    !Number.isFinite(r) ? 'var(--surface-2)' : `color-mix(in oklab, ${night || r >= 0 ? 'var(--div-pos)' : 'var(--div-neg)'} ${Math.round(Math.min(1, Math.abs(r)) * 100)}%, var(--div-mid))`;
  const hr = hover ? matrix[hover[0]]![hover[1]]! : NaN;
  const pick = (i: number, j: number) => setHover((h) => (h && h[0] === i && h[1] === j ? null : [i, j]));
  const short = (r: number) => (Number.isFinite(r) ? `${r < 0 ? '−' : ''}${fmt(Math.abs(r), 2).replace(/^0/, '')}` : '');
  return (
    <div ref={ref} className="chart-box">
      <div className={s.matrixRead} aria-live="polite">
        {hover ? (
          <>
            <span className="sec">
              {labels[hover[0]]} × {labels[hover[1]]}
            </span>
            <b className="head num">r {short(hr)}</b>
          </>
        ) : (
          <span className="sec">Tap a cell to read it.</span>
        )}
      </div>
      <div className="scroll-x">
        <div ref={box} className={s.matrix}>
          {width > 0 && (
            <svg width={W} height={T + n * cell + 4} role="img" aria-label="Correlation matrix of 14 room, tag and body features">
              {labels.map((l, i) => (
                <g key={l}>
                  <text x={L - 10} y={T + i * cell + cell / 2} textAnchor="end" dominantBaseline="central" className={hover && hover[0] === i ? s.ink : undefined}>
                    {l}
                  </text>
                  <text transform={`translate(${L + i * cell + cell / 2 + 4} ${T - 10}) rotate(-55)`} className={hover && hover[1] === i ? s.ink : undefined}>
                    {l}
                  </text>
                </g>
              ))}
              {matrix.map((row, i) =>
                row.map((r, j) => (
                  <g key={`${i}-${j}`} className={s.cell} style={{ ['--d' as string]: `${Math.min((i + j) * 8, 400)}ms` }} onPointerEnter={(e) => e.pointerType === 'mouse' && setHover([i, j])} onClick={() => pick(i, j)}>
                    <rect x={L + j * cell + 1} y={T + i * cell + 1} width={cell - 2} height={cell - 2} rx={4} fill={i === j ? 'var(--bg)' : color(r)} stroke={hover && hover[0] === i && hover[1] === j ? 'var(--text)' : 'none'} strokeWidth={1.5}>
                      <title>{`${labels[i]} × ${labels[j]}: r = ${fmt(r, 2)}`}</title>
                    </rect>
                    {i !== j && (
                      <text x={L + j * cell + cell / 2} y={T + i * cell + cell / 2} textAnchor="middle" dominantBaseline="central" className={Math.abs(r) > 0.45 ? s.onStrong : s.cellV} pointerEvents="none">
                        {short(r)}
                      </text>
                    )}
                  </g>
                )),
              )}
            </svg>
          )}
        </div>
      </div>
      <div className={s.matrixScale} aria-hidden>
        {night ? (
          <>
            <span className="cap">weak</span>
            <i className={s.rampNight} />
            <span className="cap">strong · a minus sign marks a negative link</span>
          </>
        ) : (
          <>
            <span className="cap">−1, opposite</span>
            <i />
            <span className="cap">+1, together</span>
          </>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────── mirrored hypnograms ─────────────────────────────────────────
const LEVEL: Record<SleepStage, number> = { awake: 0, rem: 1, light: 2, deep: 3 };

export function MirroredHypnogram({ night, people, events, shared }: { night: Night; people: Person[]; colors?: string[]; events: RoomEvent[]; shared: { at: number; first: string }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRevealClass<HTMLDivElement>();
  const gid = useSvgId('heat');
  const { night: nightMode } = useMotionPrefs();
  const [a, b] = night.people;
  const from = Math.min(a?.sleep.start ?? night.lightsOut, b?.sleep.start ?? night.lightsOut) - 10 * 60_000;
  const to = Math.max(a?.sleep.end ?? night.wake, b?.sleep.end ?? night.wake) + 10 * 60_000;
  const L = 0;
  const w = Math.max(width, 280);
  const x = scale(from, to, L, w);
  const bar = w >= 1000 ? 12 : w >= 700 ? 10 : 7;
  const lane = bar * 4 + 3 * 6;
  const top = 30;
  const mid = top + lane + 14;
  const bottom = mid + 14 + lane;
  const H = bottom + 56;
  const temps = useMemo(() => night.room.filter((r) => r.ts >= from && r.ts <= to), [night, from, to]);
  const tLo = Math.min(...temps.map((r) => r.tempC));
  const tHi = Math.max(...temps.map((r) => r.tempC));
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;

  const draw = (pn: typeof a, dir: 1 | -1, scope: string) => {
    if (!pn) return null;
    // Awake sits next to the shared strip; deep is furthest away.
    const yOf = (st: SleepStage) => (dir === 1 ? mid - 10 - bar - LEVEL[st] * (bar + 6) : mid + 10 + LEVEL[st] * (bar + 6));
    return (
      <g className={scope}>
        {pn.sleep.stages.map((sg, i) => {
          const x0 = x(sg.start);
          const x1 = x(sg.end);
          return <rect key={i} x={x0} y={yOf(sg.stage)} width={Math.max(0.8, x1 - x0 - 0.4)} height={bar} rx={2} fill={stageColor(sg.stage)} />;
        })}
      </g>
    );
  };

  const stops = temps.filter((_, i) => i % 15 === 0);
  return (
    <div ref={ref} className="chart-box">
      <div ref={box} className={s.mirror}>
        {width > 0 && (
          <svg width={w} height={H} role="img" aria-label={`Mirrored hypnograms around a shared room-temperature strip, ${shared.length} shared wake-ups`}>
            <defs>
              <linearGradient id={gid} x1="0" x2="1" y1="0" y2="0">
                {stops.map((r) => (
                  <stop key={r.ts} offset={`${(((r.ts - from) / (to - from)) * 100).toFixed(2)}%`} stopColor="var(--temp)" stopOpacity={0.15 + 0.75 * ((r.tempC - tLo) / Math.max(0.5, tHi - tLo))} />
                ))}
              </linearGradient>
            </defs>
            {hourTicks(from, to, w >= 700 ? 1 : 2).map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={top - 4} y2={bottom} stroke="var(--grid)" />
                <text x={x(t)} y={H - 6} textAnchor="middle">
                  {hm(t)}
                </text>
              </g>
            ))}
            {shared.map((sh, i) => (
              <rect key={`sb${i}`} x={x(sh.at) - 5} y={top - 4} width={10} height={bottom - top + 4} rx={5} fill="var(--signal-soft)" />
            ))}
            <rect x={L} y={mid - 4} width={w - L} height={8} rx={4} fill={nightMode ? 'var(--temp)' : `url(#${gid})`} opacity={nightMode ? 0.35 : 1} />
            {a && (
              <text x={L} y={top - 14} className={s.ink}>
                {name(a.personId)}
              </text>
            )}
            {b && (
              <text x={L} y={bottom + 22} className={s.ink}>
                {name(b.personId)}
              </text>
            )}
            <text x={w} y={top - 14} textAnchor="end">
              Room {fmt(tLo, 1)}–{fmt(tHi, 1)}° along the middle
            </text>
            <g className={s.wipe}>
              {draw(a, 1, 'p-you')}
              {draw(b, -1, 'p-erik')}
            </g>
            {shared.map((sh, i) => (
              <circle key={`sd${i}`} cx={x(sh.at)} cy={mid} r={4} fill="var(--bg)" stroke="var(--signal)" strokeWidth={2} />
            ))}
            {events
              .filter((e) => e.kind === 'out_of_bed' || e.kind === 'door_open' || e.kind === 'shower')
              .filter((e) => e.start >= from && e.start <= to)
              .map((e, i) => (
                <circle key={`e${i}`} cx={x(e.start)} cy={mid} r={2.6} fill="var(--bg)" stroke="var(--text)" strokeWidth={1.3} />
              ))}
          </svg>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────── thermal compromise ─────────────────────────────────────────
export function CompromiseAxis({ marks, lo = 17, hi = 23 }: { marks: { label: string; value: number; color: string; tier: 0 | 1 | 2 }[]; lo?: number; hi?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRevealClass<HTMLDivElement>();
  const { night } = useMotionPrefs();
  const w = Math.max(width, 260);
  const x = scale(lo, hi, 18, w - 18);
  const y = 66;
  const anchor = (v: number) => (x(v) < 90 ? 'start' : x(v) > w - 90 ? 'end' : 'middle');
  const tx = (v: number) => Math.min(w - 2, Math.max(2, x(v)));
  return (
    <div ref={ref} className="chart-box">
      <div ref={box} className={s.compromise}>
        {width > 0 && (
          <svg width={w} height={172} role="img" aria-label="Each partner's best early-night temperature and tonight's deep-phase target">
            <rect x={x(lo)} y={y - 1.5} width={x(hi) - x(lo)} height={3} rx={1.5} fill="var(--hairline-2)" />
            <text x={x(lo) - 18} y={y + 52} textAnchor="start">← Cooler</text>
            <text x={x(hi) + 18} y={y + 52} textAnchor="end">Warmer →</text>
            {Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={y + 5} y2={y + 10} stroke="var(--axis)" />
                <text x={x(t)} y={y + 30} textAnchor="middle">
                  {t}°
                </text>
              </g>
            ))}
            {marks.map((m, i) =>
              Number.isFinite(m.value) ? (
                <g key={m.label} className={s.mark} style={{ ['--d' as string]: `${i * 120}ms` }}>
                  {m.tier === 0 && <line x1={x(m.value)} x2={x(m.value)} y1={y - 22} y2={y} stroke={m.color} strokeWidth={1.5} />}
                  {m.tier === 1 && <line x1={x(m.value)} x2={x(m.value)} y1={y + 40} y2={y + 64} stroke={m.color} strokeWidth={1.5} strokeDasharray={night ? '4 3' : undefined} />}
                  {m.tier === 2 ? (
                    <circle cx={x(m.value)} cy={y} r={5} fill="var(--bg)" stroke="var(--signal)" strokeWidth={2} />
                  ) : (
                    <circle cx={x(m.value)} cy={y} r={6} fill={night && m.tier === 1 ? 'var(--bg)' : m.color} stroke={m.color} strokeWidth={night && m.tier === 1 ? 1.5 : 0} />
                  )}
                  <text x={tx(m.value)} y={m.tier === 0 ? y - 30 : m.tier === 1 ? y + 82 : y - 52} textAnchor={anchor(m.value)} className={s.ink} stroke="var(--bg)" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
                    {m.label} {fmt(m.value, 1)}°
                  </text>
                </g>
              ) : null,
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
