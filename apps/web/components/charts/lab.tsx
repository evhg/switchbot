'use client';
/**
 * Lab charts (docs/DESIGN.md §8, §11 "Lab"). All hand-written SVG so they can animate with transform / opacity only:
 *   TrendScatter       dots glide to new positions when the variables change (500 ms, keyed by person + night);
 *                      the LOESS trend redraws.
 *   IntervalPlot       interval whiskers draw out from the estimate dot (600 ms); the dot pops in.
 *   CorrMatrix         cells fade in along the diagonal (8 ms per step, capped at 400 ms).
 *   MirroredHypnogram  You above, Erik below one shared room-temperature axis; compositor-only wipe on reveal;
 *                      synchrony (shared wake) bands highlighted.
 *   CompromiseAxis     cool → warm track with each partner's best temperature and tonight's deep target.
 * Night mode: no gradients or glows, Erik is drawn hollow / dashed, motion is opacity only.
 */
import { useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import type { Night, Person, RoomEvent, SleepStage } from '@sleep-lab/core';
import { fmt, hm, hourTicks, niceTicks, shortDate, shortDay } from '@/lib/format.ts';
import { DrawPath, useInViewCallback, useMotionPrefs } from '../motion.tsx';
import { Legend, useWidth } from '../ui.tsx';
import { FloatTip, linePath, scale, TipRow, useSvgId } from './common.tsx';
import { STAGE_ORDER, stageColor } from './NightStrip.tsx';
import s from './lab.module.css';

const MONO: CSSProperties = { fontFamily: 'var(--font-mono)' };
const TICK = { fill: 'var(--muted)', fontSize: 9.5, style: { ...MONO, letterSpacing: '0.04em' } } as const;

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
  /** Changes when the variables change: the trend line redraws. */
  trendKey?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRevealClass<HTMLDivElement>();
  const { night } = useMotionPrefs();
  const [hover, setHover] = useState<{ si: number; pi: number } | null>(null);
  const w = Math.max(width, 280);
  const H = 248;
  const L = 34;
  const R = 8;
  const T = 12;
  const B = 40;
  const xs = series.flatMap((ss) => ss.points.map((p) => p.x));
  const ys = series.flatMap((ss) => ss.points.map((p) => p.y));
  const xt = xs.length ? niceTicks(Math.min(...xs), Math.max(...xs), 4) : [0, 1];
  const yt = ys.length ? niceTicks(Math.min(...ys), Math.max(...ys), 3) : [0, 1];
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

  return (
    <div ref={ref} className="chart-box">
      <div ref={box} className={s.scatter}>
        {width > 0 && (
          <svg width={w} height={H} role="img" aria-label={`${yLabel} against ${xLabel}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: 'pan-y' }}>
            {yt.map((t) => (
              <g key={`y${t}`}>
                <line x1={L} x2={w - R} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
                <text x={L - 8} y={y(t) + 3} textAnchor="end" {...TICK}>
                  {fy(t)}
                </text>
              </g>
            ))}
            {xt.map((t) => (
              <text key={`x${t}`} x={x(t)} y={H - B + 16} textAnchor="middle" {...TICK}>
                {fx(t)}
              </text>
            ))}
            <text x={w - R} y={H - 2} textAnchor="end" fill="var(--text-2)" fontSize={9.5} style={{ ...MONO, letterSpacing: '0.12em' }}>
              {xLabel.toUpperCase()} →
            </text>
            <text x={L} y={T - 2} fill="var(--text-2)" fontSize={9.5} style={{ ...MONO, letterSpacing: '0.12em' }}>
              ↑ {yLabel.toUpperCase()}
            </text>
            {series.map((ss, si) =>
              ss.points.map((p, pi) => {
                const hollow = night && si === 1;
                return (
                  <circle
                    key={`${ss.name}-${p.date}`}
                    className={s.dot}
                    r={3.4}
                    cx={0}
                    cy={0}
                    fill={hollow ? 'none' : ss.color}
                    fillOpacity={0.72}
                    stroke={hollow ? ss.color : 'var(--surface)'}
                    strokeWidth={hollow ? 1.3 : 0.8}
                    style={{ transform: `translate(${x(p.x).toFixed(1)}px,${y(p.y).toFixed(1)}px)`, ['--d' as string]: `${Math.min(pi * 6, 420)}ms` }}
                  />
                );
              }),
            )}
            {trendD && !night && <path d={trendD} fill="none" stroke="var(--text)" strokeOpacity={0.12} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" className={s.fadeLate} />}
            {trendD && <DrawPath key={trendKey} d={trendD} fill="none" stroke="var(--text)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" delay={250} />}
            {hp && hover && (
              <circle cx={x(hp.x)} cy={y(hp.y)} r={7} fill="none" stroke={series[hover.si]!.color} strokeWidth={2} pointerEvents="none" />
            )}
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
      <Legend items={[...series.map((ss, i) => ({ label: ss.name, color: ss.color, shape: (night && i === 1 ? 'line' : 'dot') as 'dot' | 'line' })), { label: 'LOESS trend · both', color: 'var(--text)' }]} />
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
  /** 0..1 progress towards the needed sample size, drawn under the label. */
  progress?: number;
}

export function IntervalPlot({
  rows,
  zero,
  unit,
  digits = 0,
  labelW = 118,
  rowH = 32,
  animKey = '',
  progressLabel,
}: {
  rows: IntervalRow[];
  zero?: number;
  unit: string;
  digits?: number;
  labelW?: number;
  rowH?: number;
  /** Changes when the metric changes: whiskers redraw from their dots. */
  animKey?: string;
  /** Mono caption for the sample-size bars (e.g. "n / 35"). */
  progressLabel?: (r: IntervalRow) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRevealClass<HTMLDivElement>();
  const { night } = useMotionPrefs();
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(width, 280);
  const vals = rows.flatMap((r) => [r.lo, r.hi, r.est]).filter(Number.isFinite);
  if (zero !== undefined) vals.push(zero);
  const ticks = vals.length ? niceTicks(Math.min(...vals), Math.max(...vals), 4) : [0, 1];
  const x = scale(ticks[0]!, ticks.at(-1)!, labelW + 10, w - 12);
  const ft = tickFmt(ticks);
  let yy0 = zero !== undefined ? 16 : 0;
  const placed = rows.map((r, i) => {
    const newGroup = !!r.group && r.group !== rows[i - 1]?.group;
    if (newGroup) yy0 += i === 0 ? 18 : 26;
    const yy = yy0 + rowH / 2;
    yy0 += rowH;
    return { r, y: yy, newGroup, gy: yy - rowH / 2 - 7 };
  });
  const H = yy0 + 24;
  const plotTop = 0;
  return (
    <div ref={ref} className="chart-box">
      <div ref={box} className={s.ivp} style={{ ['--d-draw' as string]: '600ms' }}>
        {width > 0 && (
          <svg width={w} height={H} role="img" aria-label="Estimates with 95% intervals">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={plotTop} y2={H - 20} stroke="var(--grid)" />
                <text x={x(t)} y={H - 5} textAnchor="middle" {...TICK}>
                  {ft(t)}
                </text>
              </g>
            ))}
            {zero !== undefined && (
              <g>
                <line x1={x(zero)} x2={x(zero)} y1={plotTop + 12} y2={H - 20} stroke="var(--text-2)" strokeOpacity={0.7} strokeDasharray="3 4" />
                <text x={x(zero)} y={plotTop + 8} textAnchor="middle" fill="var(--muted)" fontSize={9} style={{ ...MONO, letterSpacing: '0.12em' }}>
                  NO EFFECT
                </text>
              </g>
            )}
            {placed.map(({ r, y: yy, newGroup, gy }, i) => {
              const hollow = night && r.color === 'var(--person-b)';
              const ok = Number.isFinite(r.lo) && Number.isFinite(r.hi) && Number.isFinite(r.est);
              const sig = zero !== undefined && ok && (r.lo > zero || r.hi < zero);
              return (
                <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onClick={() => setHover((h) => (h === i ? null : i))}>
                  {newGroup && (
                    <text x={0} y={gy} fill="var(--text)" fontSize={10} fontWeight={600} style={{ ...MONO, letterSpacing: '0.12em' }}>
                      {r.group!.toUpperCase()}
                    </text>
                  )}
                  <rect x={-6} y={yy - rowH / 2 + 1} width={w + 6} height={rowH - 2} rx={9} fill={hover === i ? 'var(--surface-2)' : 'transparent'} />
                  <circle cx={5} cy={yy + (r.sub ? -4 : 0)} r={3} fill={hollow ? 'none' : r.color} stroke={r.color} strokeWidth={hollow ? 1.2 : 0} />
                  <text x={14} y={yy + (r.sub ? -0.5 : 4)} fill="var(--text)" fontSize={12.5} fontWeight={550}>
                    {r.label}
                  </text>
                  {r.sub && (
                    <text x={14} y={yy + 11} fill="var(--muted)" fontSize={9.5} style={MONO}>
                      {r.sub}
                    </text>
                  )}
                  {r.progress !== undefined && (
                    <g>
                      <rect x={labelW - 30} y={yy + 6} width={26} height={3} rx={1.5} fill="var(--ring-track)" />
                      <rect
                        className={s.bar}
                        x={labelW - 30}
                        y={yy + 6}
                        width={26 * Math.min(1, Math.max(0, r.progress))}
                        height={3}
                        rx={1.5}
                        fill={r.progress >= 1 ? 'var(--ch-accent)' : 'var(--text-2)'}
                      />
                      {progressLabel && (
                        <text x={labelW - 4} y={yy - 0.5} textAnchor="end" fill="var(--muted)" fontSize={9} style={MONO}>
                          {progressLabel(r)}
                        </text>
                      )}
                    </g>
                  )}
                  {ok && (
                    <g key={animKey}>
                      <DrawPath d={`M${x(r.est).toFixed(1)},${yy}L${x(r.lo).toFixed(1)},${yy}`} stroke={r.color} strokeWidth={2.4} strokeLinecap="round" opacity={sig || zero === undefined ? 1 : 0.75} delay={Math.min(i * 30, 300)} />
                      <DrawPath d={`M${x(r.est).toFixed(1)},${yy}L${x(r.hi).toFixed(1)},${yy}`} stroke={r.color} strokeWidth={2.4} strokeLinecap="round" opacity={sig || zero === undefined ? 1 : 0.75} delay={Math.min(i * 30, 300)} />
                      <circle
                        className={s.est}
                        cx={x(r.est)}
                        cy={yy}
                        r={sig ? 5.5 : 4.5}
                        fill={hollow ? 'var(--bg)' : r.color}
                        stroke={hollow ? r.color : 'var(--surface)'}
                        strokeWidth={hollow ? 1.6 : 2}
                        style={{ ['--d' as string]: `${Math.min(i * 30, 300)}ms` }}
                      />
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {hover !== null && rows[hover] && (
        <FloatTip x={x(rows[hover].est)} y={(placed[hover]?.y ?? 0) + 16} width={w}>
          <div className="tip-title">
            {rows[hover].group ? `${rows[hover].group} · ` : ''}
            {rows[hover].label}
          </div>
          <TipRow color={rows[hover].color} value={`${zero !== undefined ? sgn(rows[hover].est, digits) : fmt(rows[hover].est, digits)} ${unit}`} label="estimate" />
          <TipRow value={zero !== undefined ? `${sgn(rows[hover].lo, digits)} to ${sgn(rows[hover].hi, digits)}` : `${fmt(rows[hover].lo, digits)} to ${fmt(rows[hover].hi, digits)}`} label="95 % interval" />
          {rows[hover].sub && <TipRow value={rows[hover].sub} label={rows[hover].progress !== undefined ? 'nights tagged vs not' : ''} />}
        </FloatTip>
      )}
    </div>
  );
}

// ───────────────────────────────────────── correlation matrix ─────────────────────────────────────────
export function CorrMatrix({ labels, matrix }: { labels: string[]; matrix: number[][] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRevealClass<HTMLDivElement>();
  const [hover, setHover] = useState<[number, number] | null>(null);
  const n = labels.length;
  const L = 78;
  const cell = Math.max(14, Math.min(30, Math.floor((Math.max(width, 260) - L - 30) / n)));
  const W = L + n * cell + 30;
  const { night } = useMotionPrefs();
  // Night mode has only one hue, so lightness encodes |r| and a minus mark encodes the sign.
  const color = (r: number) =>
    !Number.isFinite(r)
      ? 'var(--surface-2)'
      : `color-mix(in oklab, ${night || r >= 0 ? 'var(--div-pos)' : 'var(--div-neg)'} ${Math.round(Math.min(1, Math.abs(r)) * 100)}%, var(--div-mid))`;
  const hr = hover ? matrix[hover[0]]![hover[1]]! : NaN;
  const pick = (i: number, j: number) => setHover((h) => (h && h[0] === i && h[1] === j ? null : [i, j]));
  return (
    <div ref={ref} className="chart-box">
      <div ref={box} className={s.matrix}>
        {width > 0 && (
          <svg width={W} height={L + n * cell + 4} role="img" aria-label="Correlation matrix">
            {labels.map((l, i) => {
              const on = hover && (hover[0] === i || hover[1] === i);
              return (
                <g key={l}>
                  <text x={L - 6} y={L + i * cell + cell / 2 + 3.5} textAnchor="end" fill={hover && hover[0] === i ? 'var(--text)' : 'var(--text-2)'} fontSize={10} fontWeight={hover && hover[0] === i ? 650 : 450}>
                    {l}
                  </text>
                  <text
                    transform={`translate(${L + i * cell + cell / 2 + 3} ${L - 6}) rotate(-60)`}
                    fill={hover && hover[1] === i ? 'var(--text)' : on ? 'var(--text-2)' : 'var(--text-2)'}
                    fontSize={10}
                    fontWeight={hover && hover[1] === i ? 650 : 450}
                  >
                    {l}
                  </text>
                </g>
              );
            })}
            {matrix.map((row, i) =>
              row.map((r, j) => (
                <rect
                  key={`${i}-${j}`}
                  className={s.cell}
                  x={L + j * cell + 1}
                  y={L + i * cell + 1}
                  width={cell - 2}
                  height={cell - 2}
                  rx={2.5}
                  fill={i === j ? 'var(--surface-2)' : color(r)}
                  stroke={hover && hover[0] === i && hover[1] === j ? 'var(--text)' : 'none'}
                  strokeWidth={1.5}
                  style={{ ['--d' as string]: `${Math.min((i + j) * 8, 400)}ms` }}
                  onPointerEnter={(e) => e.pointerType === 'mouse' && setHover([i, j])}
                  onClick={() => pick(i, j)}
                >
                  <title>{`${labels[i]} × ${labels[j]}: r = ${fmt(r, 2)}`}</title>
                </rect>
              )),
            )}
            {night &&
              matrix.map((row, i) =>
                row.map((r, j) =>
                  i !== j && Number.isFinite(r) && r <= -0.05 ? (
                    <rect key={`m${i}-${j}`} x={L + j * cell + cell * 0.28} y={L + i * cell + cell / 2 - 0.9} width={cell * 0.44} height={1.8} rx={0.9} fill={Math.abs(r) > 0.45 ? 'var(--bg)' : 'var(--text-2)'} pointerEvents="none" />
                  ) : null,
                ),
              )}
          </svg>
        )}
      </div>
      <div className={s.matrixFoot}>
        <div className={s.matrixRead} aria-live="polite">
          {hover ? (
            <>
              <span className="t-label">
                {labels[hover[0]]} × {labels[hover[1]]}
              </span>
              <b className="num">
                <span className="muted">r </span>
                {hr > 0 ? '+' : hr < 0 ? '−' : ''}
                {fmt(Math.abs(hr), 2)}
              </b>
            </>
          ) : (
            <span className="t-label muted">Tap a cell</span>
          )}
        </div>
        {night ? (
          <div className={s.matrixScale} aria-hidden>
            <span className="t-micro muted">weak</span>
            <i className={s.matrixRampNight} />
            <span className="t-micro muted">strong · − = negative</span>
          </div>
        ) : (
          <div className={s.matrixScale} aria-hidden>
            <span className="t-micro muted">−1</span>
            <i />
            <span className="t-micro muted">+1</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────── mirrored hypnograms ─────────────────────────────────────────
const LEVEL: Record<SleepStage, number> = { awake: 0, rem: 1, light: 2, deep: 3 };

export function MirroredHypnogram({ night, people, colors, events, shared }: { night: Night; people: Person[]; colors: string[]; events: RoomEvent[]; shared: { at: number; first: string }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRevealClass<HTMLDivElement>();
  const gid = useSvgId('heat');
  const { night: nightMode } = useMotionPrefs();
  const [a, b] = night.people;
  const from = Math.min(a?.sleep.start ?? night.lightsOut, b?.sleep.start ?? night.lightsOut) - 10 * 60_000;
  const to = Math.max(a?.sleep.end ?? night.wake, b?.sleep.end ?? night.wake) + 10 * 60_000;
  const L = 8;
  const w = Math.max(width, 280);
  const x = scale(from, to, L, w - 8);
  const lane = 56;
  const top = 22;
  const mid = top + lane + 8;
  const bottom = mid + 8 + lane;
  const H = bottom + 34;
  const temps = useMemo(() => night.room.filter((r) => r.ts >= from && r.ts <= to), [night, from, to]);
  const tLo = Math.min(...temps.map((r) => r.tempC));
  const tHi = Math.max(...temps.map((r) => r.tempC));
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;

  const draw = (pn: typeof a, dir: 1 | -1, color: string) => {
    if (!pn) return null;
    // Awake sits next to the shared axis; deep is furthest away.
    const yOf = (st: SleepStage) => (dir === 1 ? mid - 8 - 6 - (LEVEL[st] / 3) * (lane - 12) : mid + 8 + (LEVEL[st] / 3) * (lane - 12));
    const segs = pn.sleep.stages;
    const joins: string[] = [];
    for (let i = 1; i < segs.length; i++) {
      const xx = x(segs[i]!.start).toFixed(1);
      joins.push(`M${xx},${(yOf(segs[i - 1]!.stage) + 3).toFixed(1)}V${(yOf(segs[i]!.stage) + 3).toFixed(1)}`);
    }
    return (
      <g>
        <path d={joins.join('')} stroke="var(--hairline-2)" strokeWidth={1} fill="none" />
        {segs.map((sg, i) => {
          const x0 = x(sg.start);
          const x1 = x(sg.end);
          return <rect key={i} x={x0} y={yOf(sg.stage)} width={Math.max(0.8, x1 - x0 - 0.3)} height={6} rx={2.5} fill={stageColor(sg.stage)} />;
        })}
        <circle cx={L + 3} cy={dir === 1 ? top - 10 : bottom + 10} r={3} fill={nightMode && dir === -1 ? 'none' : color} stroke={color} strokeWidth={1.2} />
      </g>
    );
  };

  // Heat strip as one gradient (cheap): stops every ~15 min.
  const stops = temps.filter((_, i) => i % 15 === 0);
  return (
    <div ref={ref} className="chart-box">
      <div ref={box} className={s.mirror}>
        {width > 0 && (
          <div className={s.wipeOuter}>
            <div className={s.wipeInner}>
              <svg width={w} height={H} role="img" aria-label="Mirrored hypnograms around a shared room-temperature axis">
                <defs>
                  <linearGradient id={gid} x1="0" x2="1" y1="0" y2="0">
                    {stops.map((r) => (
                      <stop key={r.ts} offset={`${(((r.ts - from) / (to - from)) * 100).toFixed(2)}%`} stopColor="var(--temp)" stopOpacity={0.12 + 0.78 * ((r.tempC - tLo) / Math.max(0.5, tHi - tLo))} />
                    ))}
                  </linearGradient>
                </defs>
                {hourTicks(from, to, 2).map((t) => (
                  <g key={t}>
                    <line x1={x(t)} x2={x(t)} y1={top - 2} y2={bottom} stroke="var(--grid)" />
                    <text x={x(t)} y={H - 4} textAnchor="middle" {...TICK}>
                      {hm(t)}
                    </text>
                  </g>
                ))}
                {shared.map((sh, i) => (
                  <rect key={`sb${i}`} x={x(sh.at) - 5} y={top} width={10} height={bottom - top} rx={5} fill="var(--critical)" opacity={nightMode ? 0.14 : 0.13} />
                ))}
                <rect x={L} y={mid - 4} width={w - 8 - L} height={8} rx={4} fill={nightMode ? 'var(--temp)' : `url(#${gid})`} opacity={nightMode ? 0.35 : 1} />
                {a && (
                  <text x={L + 12} y={top - 6.5} fill="var(--text)" fontSize={10} fontWeight={600} style={{ ...MONO, letterSpacing: '0.12em' }}>
                    {name(a.personId).toUpperCase()}
                  </text>
                )}
                {b && (
                  <text x={L + 12} y={bottom + 13.5} fill="var(--text)" fontSize={10} fontWeight={600} style={{ ...MONO, letterSpacing: '0.12em' }}>
                    {name(b.personId).toUpperCase()}
                  </text>
                )}
                {draw(a, 1, colors[0] ?? 'var(--person-a)')}
                {draw(b, -1, colors[1] ?? 'var(--person-b)')}
                {shared.map((sh, i) => (
                  <circle key={`sd${i}`} cx={x(sh.at)} cy={mid} r={3.5} fill="var(--critical)" stroke="var(--surface)" strokeWidth={1.5} />
                ))}
                {events
                  .filter((e) => e.kind === 'out_of_bed' || e.kind === 'door_open' || e.kind === 'shower')
                  .filter((e) => e.start >= from && e.start <= to)
                  .map((e, i) => (
                    <circle key={`e${i}`} cx={x(e.start)} cy={mid} r={2.6} fill="var(--bg)" stroke="var(--text)" strokeWidth={1.3} />
                  ))}
              </svg>
            </div>
          </div>
        )}
      </div>
      <Legend
        items={[
          ...STAGE_ORDER.map((st) => ({ label: st === 'rem' ? 'REM' : st[0]!.toUpperCase() + st.slice(1), color: stageColor(st), shape: 'rect' as const })),
          { label: `Room ${fmt(tLo, 1)}–${fmt(tHi, 1)}°`, color: 'var(--temp)', shape: 'line' as const },
          { label: 'Shared wake', color: 'var(--critical)', shape: 'dot' as const },
          { label: 'Room event', color: 'var(--text)', shape: 'dot' as const },
        ]}
      />
    </div>
  );
}

// ───────────────────────────────────────── thermal compromise ─────────────────────────────────────────
export function CompromiseAxis({ marks, lo = 17, hi = 23 }: { marks: { label: string; value: number; color: string; tier: 0 | 1 | 2 }[]; lo?: number; hi?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRevealClass<HTMLDivElement>();
  const gid = useSvgId('cmp');
  const { night } = useMotionPrefs();
  const w = Math.max(width, 260);
  const x = scale(lo, hi, 18, w - 18);
  const y = 50;
  const anchor = (v: number) => (x(v) < 60 ? 'start' : x(v) > w - 60 ? 'end' : 'middle');
  const tx = (v: number) => Math.min(w - 2, Math.max(2, x(v)));
  return (
    <div ref={ref} className="chart-box">
      <div ref={box} className={s.compromise}>
        {width > 0 && (
          <svg width={w} height={122} role="img" aria-label="Each partner's best early-night temperature and tonight's deep-phase target">
            <defs>
              <linearGradient id={gid}>
                <stop offset="0" stopColor="var(--temp)" stopOpacity={0.85} />
                <stop offset="0.5" stopColor="var(--text-2)" stopOpacity={0.35} />
                <stop offset="1" stopColor="var(--outdoor)" stopOpacity={0.85} />
              </linearGradient>
            </defs>
            <rect x={x(lo)} y={y - 2.5} width={x(hi) - x(lo)} height={5} rx={2.5} fill={night ? 'var(--hairline-2)' : `url(#${gid})`} />
            {marks.map((m, i) =>
              Number.isFinite(m.value) ? (
                <g key={m.label} className={s.mark} style={{ ['--d' as string]: `${i * 120}ms` }}>
                  {m.tier === 0 && <line x1={x(m.value)} x2={x(m.value)} y1={y - 16} y2={y} stroke={m.color} strokeWidth={1.5} />}
                  {m.tier === 1 && <line x1={x(m.value)} x2={x(m.value)} y1={y} y2={y + 30} stroke={m.color} strokeWidth={1.5} strokeDasharray={night ? '4 3' : undefined} />}
                  {m.tier === 2 && <line x1={x(m.value)} x2={x(m.value)} y1={y + 12} y2={y + 52} stroke={m.color} strokeWidth={1} strokeDasharray="2 3" />}
                  {m.tier === 2 ? (
                    <path d={`M${x(m.value)},${y + 5}l5,8h-10z`} fill={m.color} stroke="var(--surface)" strokeWidth={1.5} strokeLinejoin="round" />
                  ) : (
                    <circle cx={x(m.value)} cy={y} r={6.5} fill={m.color} stroke="var(--surface)" strokeWidth={2} />
                  )}
                  <text
                    x={tx(m.value)}
                    y={m.tier === 0 ? y - 22 : m.tier === 1 ? y + 42 : y + 64}
                    textAnchor={anchor(m.value)}
                    fill="var(--text)"
                    fontSize={11.5}
                    fontWeight={550}
                  >
                    {m.label}{' '}
                    <tspan style={MONO} fill="var(--text-2)" fontWeight={500}>
                      {fmt(m.value, 1)}°
                    </tspan>
                  </text>
                </g>
              ) : null,
            )}
            {Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={y + 6} y2={y + 10} stroke="var(--axis)" />
                <text x={x(t)} y={y + 22} textAnchor="middle" {...TICK} stroke="var(--surface)" strokeWidth={5} paintOrder="stroke" strokeLinejoin="round">
                  {t}°
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}
