'use client';
/**
 * Body charts, v2 "Instrument" (docs/DESIGN.md §7, §9.3).
 * Rules: the title (in the screen) is the finding; series are labelled on the chart, never with a legend; the person's
 * colour is `var(--person)` (set by the .p-you / .p-erik scope on the page), stages use the person's stage tokens;
 * reference lines are dashed --muted ("typical 53"); only alerts (SpO₂ dips, disagreements) use --signal.
 * Motion: Recharts draws once on mount when scrolled into view; custom SVG reveals with opacity / clip only.
 * Night mode and reduced motion: no draw-ins (useChartAnim), no pops.
 */
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HrSample, Night, PersonNightMetrics, SleepStage, Spo2Sample, StageSegment } from '@sleep-lab/core';
import { dur, fmt, hm, hourTicks, MIN, niceTicks, shortDate, shortDay, signed } from '@/lib/format.ts';
import { median, rollingBand } from '@/lib/stats.ts';
import { useInView, useInViewCallback } from '../motion.tsx';
import { useWidth } from '../ui.tsx';
import { AXIS, CURSOR, FloatTip, GRID, linePath, MARGIN, REF_FRONT, REF_LINE, refLabel, scale, STROKE, Tip, TipRow, useChartAnim, Y_WIDTH } from './common.tsx';
import { STAGE_LABEL, STAGE_ORDER, stageColor } from './NightStrip.tsx';
import s from './body.module.css';

const DASH = '4 3';
const PERSON = 'var(--person)';

/** Minute-median HR in `bucketMin` buckets. */
export function hrMedian(hr: HrSample[], bucketMin = 5): { ts: number; bpm: number }[] {
  const by = new Map<number, number[]>();
  for (const h of hr) {
    const k = Math.floor(h.ts / (bucketMin * MIN)) * bucketMin * MIN;
    const a = by.get(k);
    if (a) a.push(h.bpm);
    else by.set(k, [h.bpm]);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([ts, v]) => ({ ts: ts + (bucketMin * MIN) / 2, bpm: median(v) }));
}

const timeX = (from: number, to: number, step = 2) => ({
  dataKey: 'ts',
  type: 'number' as const,
  domain: [from, to] as [number, number],
  ticks: hourTicks(from, to, step),
  tickFormatter: (v: number) => hm(v),
  ...AXIS,
});

const finiteMin = (xs: number[]) => Math.min(...xs.filter(Number.isFinite));
const finiteMax = (xs: number[]) => Math.max(...xs.filter(Number.isFinite));
const dayTick = (v: number) => shortDate(new Date(v).toISOString().slice(0, 10));

/** Adds `.in` to the element once it scrolls into view (CSS does the motion). */
function useInClass<T extends Element>(threshold = 0.25) {
  const ref = useRef<T>(null);
  useInViewCallback(
    ref,
    (v) => {
      if (v) ref.current?.classList.add(s.in ?? 'in');
    },
    { threshold, rootMargin: '0px 0px -6% 0px' },
  );
  return ref;
}

/** Mounts a Recharts chart once it is in view, so its single draw plays where the reader is looking. Height reserved. */
export function ChartIn({ height, children, style }: { height: number; children: ReactNode; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
  return (
    <div ref={ref} className={s.chartIn} style={{ height, ...style }}>
      {v ? children : null}
    </div>
  );
}

/** Readout dot (§7.1): 7 px, --bg fill, 2 px stroke in the series colour, with an optional label on the chart. */
function Marker({ cx, cy, color, label, anchor = 'middle', below = true, r = 3.5 }: { cx?: number; cy?: number; color: string; label?: string; anchor?: 'start' | 'middle' | 'end'; below?: boolean; r?: number }) {
  if (cx === undefined || cy === undefined || !Number.isFinite(cx) || !Number.isFinite(cy)) return <g />;
  return (
    <g transform={`translate(${cx},${cy})`} pointerEvents="none" className={s.mark}>
      <circle r={r} fill="var(--bg)" stroke={color} strokeWidth={2} />
      {label && (
        <text y={below ? 24 : -12} textAnchor={anchor} className={s.onChart} stroke="var(--bg)" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
          {label}
        </text>
      )}
    </g>
  );
}

const activeDot = (color: string) => ({ r: 3.5, fill: 'var(--bg)', stroke: color, strokeWidth: 2 });

// ───────────────────────────────────────── Hypnogram ─────────────────────────────────────────
const LANE: Record<SleepStage, number> = { awake: 0, rem: 1, light: 2, deep: 3 };

/**
 * Four rows, Awake on top and Deep at the bottom (§7.2): row position carries the stage, the person's stage tokens
 * carry depth. Bars are 12 px on phone, 18 px from 700 px wide. A clip wipe reveals it once.
 */
export function Hypnogram({ stages, start, end, label }: { stages: StageSegment[]; start: number; end: number; label: string }) {
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const inRef = useInClass<HTMLDivElement>(0.3);
  const [hover, setHover] = useState<{ x: number; seg: StageSegment } | null>(null);
  const w = Math.max(width, 260);
  const bar = w >= 600 ? 20 : 12;
  const laneH = bar + (w >= 600 ? 10 : 8);
  const L = 64;
  const R = 2;
  const axisH = 28;
  const height = laneH * 4 + axisH;
  const x = scale(start, end, L, w - R);
  const yTop = (st: SleepStage) => LANE[st] * laneH + 4;
  const segs = stages.filter((g) => g.end > start && g.start < end);
  const ticks = hourTicks(start, end, w >= 700 ? 1 : 2);
  return (
    <div
      ref={(el) => {
        (boxRef as { current: HTMLDivElement | null }).current = el;
        (inRef as { current: HTMLDivElement | null }).current = el;
      }}
      className={`${s.hyp} chart-box`}
      style={{ height }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - r.left;
        const t = start + ((px - L) / (w - R - L)) * (end - start);
        const seg = segs.find((g) => t >= g.start && t < g.end);
        setHover(seg && px >= L ? { x: px, seg } : null);
      }}
      onPointerLeave={() => setHover(null)}
    >
      {width > 0 && (
        <>
          <svg width={w} height={height} role="img" aria-label={label}>
            {STAGE_ORDER.map((st) => (
              <text key={st} x={0} y={yTop(st) + bar / 2} dominantBaseline="central">
                {STAGE_LABEL[st]}
              </text>
            ))}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={0} y2={laneH * 4} stroke="var(--grid)" />
                <text x={x(t)} y={height - 6} textAnchor="middle">
                  {hm(t)}
                </text>
              </g>
            ))}
            <g className={s.wipe}>
              {segs.map((g, i) => {
                const x0 = x(Math.max(start, g.start));
                const x1 = x(Math.min(end, g.end));
                return <rect key={i} x={x0} y={yTop(g.stage)} width={Math.max(1, x1 - x0 - 0.5)} height={bar} rx={Math.min(3, (x1 - x0) / 2)} fill={stageColor(g.stage)} />;
              })}
            </g>
          </svg>
          {hover && (
            <>
              <div className={s.hairline} style={{ left: hover.x, bottom: axisH }} />
              <FloatTip x={hover.x} y={-64} width={w}>
                <div className="tip-title">
                  {hm(hover.seg.start)} – {hm(hover.seg.end)}
                </div>
                <TipRow color={stageColor(hover.seg.stage)} value={STAGE_LABEL[hover.seg.stage]} label={dur((hover.seg.end - hover.seg.start) / MIN)} />
              </FloatTip>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Stage composition: one thin segmented bar, then a quiet list (Deep · Light · REM · Awake). */
export function StageMix({ m }: { m: PersonNightMetrics }) {
  const ref = useInClass<HTMLDivElement>(0.4);
  const val = (st: SleepStage) => (st === 'deep' ? m.deepMin : st === 'rem' ? m.remMin : st === 'light' ? m.lightMin : m.awakeMin);
  const order: SleepStage[] = ['deep', 'light', 'rem', 'awake'];
  const tot = Math.max(1, order.reduce((a, st) => a + val(st), 0));
  return (
    <div ref={ref} className={s.mix}>
      <div className={s.mixBar} role="img" aria-label={order.map((st) => `${STAGE_LABEL[st]} ${dur(val(st))}`).join(', ')}>
        {order.map((st, i) => (
          <div key={st} className={s.mixSeg} style={{ flex: `${Math.max(0.001, val(st))} 1 0`, background: stageColor(st), ['--i' as string]: i }} />
        ))}
      </div>
      <dl className={s.facts}>
        {order.map((st) => (
          <div key={st}>
            <dt>
              <i className={s.swatch} style={{ background: stageColor(st) }} aria-hidden />
              {STAGE_LABEL[st]}
            </dt>
            <dd>
              {dur(val(st))}
              <span className={s.ddSub}>{fmt((val(st) / tot) * 100)}%</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ───────────────────────────────────────── Sleeping heart rate ─────────────────────────────────────────
export function HrCurve({ hr, start, end, nadir, nadirAt, baseline, dash }: { hr: HrSample[]; start: number; end: number; nadir: number; nadirAt: number; baseline: number; dash?: boolean }) {
  const anim = useChartAnim(1000);
  const data = useMemo(() => hrMedian(hr.filter((h) => h.ts >= start && h.ts <= end), 5), [hr, start, end]);
  const vs = data.map((d) => d.bpm);
  const ticks = niceTicks(finiteMin([...vs, baseline]) - 2, finiteMax(vs) + 2, 4);
  const f = (nadirAt - start) / Math.max(1, end - start);
  const H = 240;
  return (
    <ChartIn height={H}>
      <ResponsiveContainer width="100%" height={H}>
        <ComposedChart data={data} margin={{ ...MARGIN, top: 16, bottom: 4 }}>
          <CartesianGrid {...GRID} />
          <XAxis {...timeX(start, end)} />
          <YAxis width={Y_WIDTH} orientation="right" domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} allowDataOverflow {...AXIS} />
          {Number.isFinite(baseline) && <ReferenceLine {...REF_FRONT} y={baseline} {...REF_LINE} label={{ ...refLabel(`typical low ${fmt(baseline)}`), position: 'insideBottomRight' }} />}
          <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.slice(-1).map((x) => ({ label: 'bpm', value: fmt(Number(x.value)), color: PERSON, dash }))} />} />
          <Line dataKey="bpm" stroke={PERSON} strokeWidth={STROKE.primary} strokeDasharray={dash ? DASH : undefined} strokeLinejoin="round" strokeLinecap="round" dot={false} activeDot={activeDot(PERSON)} {...anim} />
          {Number.isFinite(nadir) && (
            <ReferenceDot
              x={nadirAt}
              y={nadir}
              r={5}
              ifOverflow="visible"
              shape={(p: { cx?: number; cy?: number }) => <Marker cx={p.cx} cy={p.cy} color={PERSON} label={`Lowest ${fmt(nadir)} bpm, ${hm(nadirAt)}`} anchor={f < 0.2 ? 'start' : f > 0.8 ? 'end' : 'middle'} />}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartIn>
  );
}

// ───────────────────────────────────────── Last 14 nights (ridgeline) ─────────────────────────────────────────
export function Ridgeline({ nights, personId, selected, onPick, dash }: { nights: Night[]; personId: string; selected: string; onPick: (d: string) => void; dash?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const inRef = useInClass<HTMLDivElement>(0.2);
  const [hover, setHover] = useState<{ x: number; y: number; date: string; bpm: number; min: number } | null>(null);
  const rows = useMemo(
    () =>
      nights.map((n) => {
        const p = n.people.find((x) => x.personId === personId);
        if (!p) return { date: n.date, pts: [] as { m: number; bpm: number }[], nadir: null as { m: number; bpm: number } | null };
        const pts = hrMedian(p.hr.filter((h) => h.ts >= p.sleep.start && h.ts <= p.sleep.end), 10).map((h) => ({ m: (h.ts - p.sleep.start) / MIN, bpm: h.bpm }));
        const nadir = pts.reduce<{ m: number; bpm: number } | null>((a, b) => (!a || b.bpm < a.bpm ? b : a), null);
        return { date: n.date, pts, nadir };
      }),
    [nights, personId],
  );
  const all = rows.flatMap((r) => r.pts.map((p) => p.bpm));
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const L = 64;
  const w = Math.max(width, 260);
  const step = 24;
  const amp = 40;
  const H = rows.length * step + amp + 30;
  const x = scale(0, 540, L, w - 6);
  const yOff = (i: number) => amp + 6 + i * step;
  const yv = (bpm: number) => ((bpm - lo) / Math.max(1, hi - lo)) * amp;
  return (
    <div
      ref={(el) => {
        (ref as { current: HTMLDivElement | null }).current = el;
        (inRef as { current: HTMLDivElement | null }).current = el;
      }}
      className={`chart-box ${s.ridges}`}
    >
      {width > 0 && (
        <svg width={w} height={H} role="img" aria-label="Heart-rate curves for the last 14 nights, from sleep start">
          {[0, 120, 240, 360, 480].map((m) => (
            <g key={m}>
              <line x1={x(m)} x2={x(m)} y1={0} y2={H - 24} stroke="var(--grid)" />
              <text x={x(m)} y={H - 6} textAnchor="middle">
                {m === 0 ? 'Asleep' : `+${m / 60}h`}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const base = yOff(i);
            const pts = r.pts.filter((p) => p.m <= 540).map((p) => ({ x: x(p.m), y: base - yv(p.bpm) }));
            if (pts.length < 2) return null;
            const area = `${linePath(pts)}L${pts.at(-1)!.x},${base}L${pts[0]!.x},${base}Z`;
            const sel = r.date === selected;
            return (
              <g key={r.date} className={s.ridge} style={{ ['--i' as string]: i }}>
                <g onClick={() => onPick(r.date)} className={s.ridgeHit}>
                  <path d={area} fill="var(--bg)" />
                  <path d={linePath(pts)} fill="none" stroke={sel ? PERSON : 'var(--muted)'} strokeWidth={sel ? 2 : 1} strokeDasharray={dash && sel ? '3 2' : undefined} strokeLinejoin="round" />
                  {r.nadir && sel && <circle cx={x(r.nadir.m)} cy={base - yv(r.nadir.bpm)} r={3.5} fill="var(--bg)" stroke={PERSON} strokeWidth={2} />}
                  <text x={0} y={base - 2} className={sel ? s.ridgeSel : undefined}>
                    {shortDate(r.date)}
                  </text>
                  <rect
                    x={L}
                    y={base - step}
                    width={w - L}
                    height={step}
                    fill="transparent"
                    onPointerMove={(e) => {
                      const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                      const px = e.clientX - rect.left;
                      const m = ((px - L) / (w - 6 - L)) * 540;
                      const near = r.pts.reduce((a, b) => (Math.abs(b.m - m) < Math.abs(a.m - m) ? b : a), r.pts[0]!);
                      setHover({ x: px, y: base - step - 56, date: r.date, bpm: near.bpm, min: near.m });
                    }}
                    onPointerLeave={() => setHover(null)}
                  />
                </g>
              </g>
            );
          })}
        </svg>
      )}
      {hover && (
        <FloatTip x={hover.x} y={Math.max(0, hover.y)} width={w}>
          <div className="tip-title">
            {shortDay(hover.date)} {shortDate(hover.date)} · {fmt(hover.min / 60, 1)} h after falling asleep
          </div>
          <TipRow color={PERSON} dash={dash} value={`${fmt(hover.bpm)} bpm`} label="10-min median" />
        </FloatTip>
      )}
    </div>
  );
}

// ───────────────────────────────────────── HRV through the night ─────────────────────────────────────────
export function HrvNight({ hrv, start, end, band, dash }: { hrv: { ts: number; rmssdMs: number }[]; start: number; end: number; band: { mean: number; lo: number; hi: number }; dash?: boolean }) {
  const anim = useChartAnim(1000);
  const data = hrv.filter((h) => h.ts >= start && h.ts <= end).map((h) => ({ ts: h.ts, rmssd: h.rmssdMs }));
  const vs = data.map((d) => d.rmssd);
  const ticks = niceTicks(finiteMin([...vs, band.lo]) - 3, finiteMax([...vs, band.hi]) + 3, 4).filter((t) => t >= 0);
  const H = 220;
  return (
    <ChartIn height={H}>
      <ResponsiveContainer width="100%" height={H}>
        <ComposedChart data={data} margin={{ ...MARGIN, top: 16 }}>
          <CartesianGrid {...GRID} />
          {Number.isFinite(band.lo) && Number.isFinite(band.hi) && <ReferenceArea y1={band.lo} y2={band.hi} fill="var(--text)" fillOpacity={0.05} stroke="none" />}
          {Number.isFinite(band.mean) && <ReferenceLine {...REF_FRONT} y={band.mean} {...REF_LINE} label={refLabel(`typical ${fmt(band.mean)}`)} />}
          <XAxis {...timeX(start, end)} />
          <YAxis width={Y_WIDTH} orientation="right" domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} allowDataOverflow {...AXIS} />
          <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.slice(0, 1).map((x) => ({ label: 'ms RMSSD', value: fmt(Number(x.value), 1), color: PERSON, dash }))} />} />
          <Line dataKey="rmssd" stroke={PERSON} strokeWidth={STROKE.primary} strokeDasharray={dash ? DASH : undefined} strokeLinejoin="round" dot={false} activeDot={activeDot(PERSON)} {...anim} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartIn>
  );
}

// ───────────────────────────────────────── Blood oxygen ─────────────────────────────────────────
export function spo2Dips(spo2: Spo2Sample[]): { ts: number; pct: number; drop: number }[] {
  const s = [...spo2].sort((a, b) => a.ts - b.ts);
  const out: { ts: number; pct: number; drop: number }[] = [];
  let lastDip = -Infinity;
  s.forEach((x, i) => {
    const win = s.slice(Math.max(0, i - 30), i).map((y) => y.pct);
    if (win.length < 10) return;
    const base = median(win);
    if (base - x.pct >= 3 && x.ts - lastDip > 5 * MIN) {
      out.push({ ts: x.ts, pct: x.pct, drop: base - x.pct });
      lastDip = x.ts;
    }
  });
  return out;
}

/** SpO₂ as a 2-minute low in the person colour; dips of ≥ 3 % are the only signal marks. */
export function Spo2Strip({ spo2, start, end, dash }: { spo2: Spo2Sample[]; start: number; end: number; dash?: boolean }) {
  const anim = useChartAnim(1000);
  const data = useMemo(() => {
    const s = spo2.filter((x) => x.ts >= start && x.ts <= end);
    const by = new Map<number, number[]>();
    for (const x of s) {
      const k = Math.floor(x.ts / (2 * MIN)) * 2 * MIN;
      const a = by.get(k);
      if (a) a.push(x.pct);
      else by.set(k, [x.pct]);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([ts, v]) => ({ ts, pct: Math.min(...v) }));
  }, [spo2, start, end]);
  const dips = useMemo(() => spo2Dips(spo2.filter((x) => x.ts >= start && x.ts <= end)), [spo2, start, end]);
  const H = 200;
  return (
    <ChartIn height={H}>
      <ResponsiveContainer width="100%" height={H}>
        <ComposedChart data={data} margin={{ ...MARGIN, top: 16 }}>
          <CartesianGrid {...GRID} />
          <XAxis {...timeX(start, end)} />
          <YAxis width={Y_WIDTH + 6} orientation="right" domain={[88, 100]} ticks={[88, 92, 96, 100]} allowDataOverflow tickFormatter={(v: number) => `${v}%`} {...AXIS} />
          <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.slice(0, 1).map((x) => ({ label: 'SpO₂', value: `${fmt(Number(x.value))}%`, color: PERSON, dash }))} />} />
          <Line dataKey="pct" stroke={PERSON} strokeWidth={STROKE.secondary} strokeDasharray={dash ? DASH : undefined} strokeLinejoin="round" dot={false} activeDot={activeDot(PERSON)} {...anim} />
          {dips.map((d) => {
            const bx = Math.floor(d.ts / (2 * MIN)) * 2 * MIN;
            const by = data.find((p) => p.ts === bx)?.pct ?? d.pct;
            return <ReferenceDot key={d.ts} x={bx} y={Math.max(88, by)} r={3} ifOverflow="visible" shape={(p: { cx?: number; cy?: number }) => <Marker cx={p.cx} cy={p.cy} color="var(--signal)" r={3} />} />;
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartIn>
  );
}

// ───────────────────────────────────────── Skin temperature vs room ─────────────────────────────────────────
export function TempDeviation({ rows }: { rows: { date: string; dev: number | null; room: number }[] }) {
  const anim = useChartAnim(900);
  const data = rows.map((r) => ({ ...r, ts: Date.parse(`${r.date}T00:00:00Z`) }));
  const roomVals = data.map((d) => d.room).filter(Number.isFinite);
  const rt = niceTicks(Math.min(...roomVals), Math.max(...roomVals), 3);
  const devMax = Math.max(0.2, ...data.map((d) => Math.abs(d.dev ?? 0)));
  const dt = niceTicks(-devMax, devMax, 4);
  const tip = (p: { active?: boolean; payload?: readonly { value?: unknown; payload?: unknown }[]; label?: unknown }) => {
    const d = p.payload?.[0]?.payload as { date: string; dev: number | null; room: number } | undefined;
    if (!p.active || !d) return null;
    return (
      <div className="tip">
        <div className="tip-title">
          {shortDay(d.date)} {shortDate(d.date)}
        </div>
        <TipRow color={(d.dev ?? 0) >= 0 ? 'var(--div-neg)' : 'var(--div-pos)'} value={d.dev === null ? '–' : `${signed(d.dev, 2)}°`} label="skin vs typical" />
        <TipRow color="var(--temp)" value={`${fmt(d.room, 1)}°`} label="room average" />
      </div>
    );
  };
  const xAxis = { dataKey: 'ts', type: 'number' as const, domain: ['dataMin - 43200000', 'dataMax + 43200000'] as [string, string], tickFormatter: dayTick, minTickGap: 48, ...AXIS };
  return (
    <div className={s.stackCharts}>
      <div>
        <p className="label">Skin, warmer or cooler than typical</p>
        <ChartIn height={150}>
          <ResponsiveContainer width="100%" height={150}>
            <ComposedChart data={data} margin={{ ...MARGIN, top: 12 }} syncId="tdev">
              <CartesianGrid {...GRID} />
              <XAxis {...xAxis} />
              <YAxis width={Y_WIDTH} orientation="right" domain={[dt[0]!, dt.at(-1)!]} ticks={dt} tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${fmt(v, 1)}°`} {...AXIS} />
              <ReferenceLine y={0} stroke="var(--axis)" />
              <Tooltip cursor={{ fill: 'var(--surface-2)', opacity: 0.6 }} content={tip} />
              <Bar dataKey="dev" maxBarSize={8} radius={[2, 2, 2, 2]} {...anim}>
                {data.map((d) => (
                  <Cell key={d.date} fill={(d.dev ?? 0) >= 0 ? 'var(--div-neg)' : 'var(--muted)'} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </ChartIn>
      </div>
      <div>
        <p className="label">Room average through the night</p>
        <ChartIn height={130}>
          <ResponsiveContainer width="100%" height={130}>
            <ComposedChart data={data} margin={{ ...MARGIN, top: 12 }} syncId="tdev">
              <CartesianGrid {...GRID} />
              <XAxis {...xAxis} />
              <YAxis width={Y_WIDTH} orientation="right" domain={[rt[0]!, rt.at(-1)!]} ticks={rt} tickFormatter={(v: number) => `${fmt(v)}°`} {...AXIS} />
              <Tooltip cursor={CURSOR} content={tip} />
              <Line dataKey="room" stroke="var(--temp)" strokeWidth={STROKE.primary} strokeLinejoin="round" dot={false} activeDot={activeDot('var(--temp)')} {...anim} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartIn>
      </div>
    </div>
  );
}

// ───────────────────────────────────────── Our sleep/wake vs Google's ─────────────────────────────────────────
export function SleepWakeCompare({ stages, ours, start, end }: { stages: StageSegment[]; ours: { start: number; end: number; awake: boolean }[]; start: number; end: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const inRef = useInClass<HTMLDivElement>(0.3);
  const L = 84;
  const w = Math.max(260, width);
  const x = scale(start, end, L, w - 4);
  const diff = useMemo(() => {
    const out: { start: number; end: number }[] = [];
    for (let t = start; t < end; t += MIN) {
      const g = stages.find((q) => t >= q.start && t < q.end);
      const o = ours.find((q) => t >= q.start && t < q.end);
      if (!g || !o || (g.stage === 'awake') === o.awake) continue;
      const last = out.at(-1);
      if (last && last.end === t) last.end = t + MIN;
      else out.push({ start: t, end: t + MIN });
    }
    return out;
  }, [stages, ours, start, end]);
  const lane = (y: number, h: number, segs: { start: number; end: number; fill: string }[]) =>
    segs.map((q, i) => {
      const x0 = x(Math.max(start, q.start));
      const wd = Math.max(1, x(Math.min(end, q.end)) - x0 - 0.5);
      return <rect key={i} x={x0} y={y} width={wd} height={h} rx={Math.min(2, wd / 2)} fill={q.fill} />;
    });
  const label = (y: number, t: string) => (
    <text x={0} y={y} dominantBaseline="central">
      {t}
    </text>
  );
  return (
    <div
      ref={(el) => {
        (ref as { current: HTMLDivElement | null }).current = el;
        (inRef as { current: HTMLDivElement | null }).current = el;
      }}
      className={`chart-box ${s.lanesBox}`}
    >
      {width > 0 && (
        <svg width={w} height={128} role="img" aria-label="Google's stages versus our heart-rate sleep/wake estimate">
          {label(11, 'Google')}
          {label(45, 'Ours')}
          {label(77, 'Differ')}
          <line x1={L} x2={w - 4} y1={77} y2={77} stroke="var(--grid)" />
          <g className={s.lanes}>{lane(2, 18, stages.map((q) => ({ start: q.start, end: q.end, fill: stageColor(q.stage) })))}</g>
          <g className={s.lanes}>{lane(36, 18, ours.map((q) => ({ start: q.start, end: q.end, fill: q.awake ? 'var(--stage-awake)' : 'var(--stage-light)' })))}</g>
          <g className={s.lanes}>{lane(73, 8, diff.map((q) => ({ ...q, fill: 'var(--signal)' })))}</g>
          {hourTicks(start, end, 2).map((t) => (
            <text key={t} x={x(t)} y={120} textAnchor="middle">
              {hm(t)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

// ───────────────────────────────────────── Trend with baseline band ─────────────────────────────────────────
const kTick = (v: number) => (Math.abs(v) >= 1000 ? `${fmt(v / 1000, Math.abs(v) % 1000 ? 1 : 0)}k` : String(v));

/** Last value vs the 30-night rolling baseline (for summaries outside the chart). */
export function trendSummary(all: { date: string; v: number }[]) {
  const band = rollingBand(all.map((r) => r.v), 30, 5);
  let i = all.length - 1;
  while (i >= 0 && !Number.isFinite(all[i]!.v)) i--;
  if (i < 0) return { last: NaN, typical: NaN, delta: NaN, lo: NaN, hi: NaN };
  const typical = band[i]!.mean;
  return { last: all[i]!.v, typical, delta: all[i]!.v - typical, lo: band[i]!.lo, hi: band[i]!.hi };
}

/**
 * One metric over the last `show` nights in the person colour, with the previous 30 nights ±1 SD as a 5 % ink band.
 * Last night gets a readout dot. Labelled by the screen (title = finding); no legend.
 */
export function TrendBand({ rows: all, show, unit, digits = 0, label, dash, height = 220 }: { rows: { date: string; v: number }[]; show: number; unit: string; digits?: number; label: string; dash?: boolean; height?: number }) {
  const anim = useChartAnim(800);
  const fullBand = rollingBand(all.map((r) => r.v), 30, 5);
  const rows = all.slice(-show);
  const band = fullBand.slice(-show);
  const data = rows.map((r, i) => ({ ts: Date.parse(`${r.date}T00:00:00Z`), date: r.date, v: Number.isFinite(r.v) ? r.v : null, band: Number.isFinite(band[i]!.lo) ? ([band[i]!.lo, band[i]!.hi] as [number, number]) : null }));
  const vs = data.flatMap((d) => [d.v ?? NaN, ...(d.band ?? [])]).filter(Number.isFinite);
  const ticks = vs.length ? niceTicks(Math.min(...vs), Math.max(...vs), 3) : [0, 1];
  const last = data.filter((d) => d.v !== null).at(-1);
  return (
    <ChartIn height={height}>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ ...MARGIN, top: 14 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} tickFormatter={dayTick} minTickGap={56} {...AXIS} />
          <YAxis width={Y_WIDTH} orientation="right" domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} tickFormatter={kTick} {...AXIS} />
          <Tooltip
            cursor={CURSOR}
            content={(p) => {
              const d = p.payload?.[0]?.payload as (typeof data)[number] | undefined;
              if (!p.active || !d) return null;
              return (
                <div className="tip">
                  <div className="tip-title">
                    {shortDay(d.date)} {shortDate(d.date)}
                  </div>
                  <TipRow color={PERSON} dash={dash} value={`${fmt(d.v ?? NaN, digits)}${unit ? ` ${unit}` : ''}`} label={label} />
                  {d.band && <TipRow value={`${fmt(d.band[0], digits)}–${fmt(d.band[1], digits)}`} label="typical range" />}
                </div>
              );
            }}
          />
          <Area dataKey="band" stroke="none" fill="var(--text)" fillOpacity={0.06} activeDot={false} connectNulls {...anim} />
          <Line dataKey="v" stroke={PERSON} strokeWidth={STROKE.primary} strokeDasharray={dash ? DASH : undefined} strokeLinejoin="round" dot={false} activeDot={activeDot(PERSON)} connectNulls {...anim} />
          {last && last.v !== null && <ReferenceDot x={last.ts} y={last.v} r={4} ifOverflow="visible" shape={(p: { cx?: number; cy?: number }) => <Marker cx={p.cx} cy={p.cy} color={PERSON} />} />}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartIn>
  );
}
