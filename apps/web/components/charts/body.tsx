'use client';
/**
 * Body tab charts (docs/DESIGN.md §8, §11 "Body"). Recharts charts mount when scrolled into view (ChartIn) so their
 * draw animation plays in front of the reader; custom SVG charts reveal with compositor-only transforms. Night mode:
 * no gradients / pops (calm fades), Erik's lines dashed (`dash`). Reduced motion: final states.
 */
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HrSample, Night, PersonNightMetrics, SleepStage, Spo2Sample, StageSegment } from '@sleep-lab/core';
import { dur, fmt, hm, hourTicks, MIN, niceTicks, shortDate, shortDay, signed } from '@/lib/format.ts';
import { median, rollingBand } from '@/lib/stats.ts';
import { Icon, type IconName } from '../icons.tsx';
import { useInView, useInViewCallback, useMotionPrefs } from '../motion.tsx';
import { DeltaChip, Legend, useWidth, type Tone } from '../ui.tsx';
import { AreaGradient, AXIS, CURSOR, FloatTip, GRID, linePath, MARGIN, REF_LINE, refLabel, REF_FRONT, scale, STROKE, Tip, TipRow, useChartAnim, useSvgId, Y_WIDTH } from './common.tsx';
import { STAGE_LABEL, STAGE_ORDER, stageColor } from './NightStrip.tsx';
import s from './body.module.css';

const DASH = '4 3';

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

/** Adds `.in` to the element once it scrolls into view (CSS does the motion). */
function useInClass<T extends Element>(threshold = 0.25) {
  const ref = useRef<T>(null);
  useInViewCallback(
    ref,
    (v) => {
      if (v) ref.current?.classList.add('in', s.in ?? 'in');
    },
    { threshold, rootMargin: '0px 0px -6% 0px' },
  );
  return ref;
}

/**
 * Mounts a Recharts chart only once it is in view, so its 1 s draw plays where the reader is looking. The height is
 * reserved up front: nothing shifts when it mounts.
 */
export function ChartIn({ height, children, style }: { height: number; children: ReactNode; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
  return (
    <div ref={ref} className={s.chartIn} style={{ height, ...style }}>
      {v ? children : null}
    </div>
  );
}

/** Marker drawn by ReferenceDot `shape`: halo + dot + optional mono label, popping in after the line draws. */
function Marker({ cx, cy, color, label, anchor = 'middle', below = true, delay = 950, r = 4.5 }: { cx?: number; cy?: number; color: string; label?: string; anchor?: 'start' | 'middle' | 'end'; below?: boolean; delay?: number; r?: number }) {
  if (cx === undefined || cy === undefined || !Number.isFinite(cx) || !Number.isFinite(cy)) return <g />;
  const st = { ['--pop-delay' as string]: `${delay}ms` } as CSSProperties;
  return (
    <g transform={`translate(${cx},${cy})`} style={st} pointerEvents="none">
      <circle r={r + 6} fill={color} opacity={0} className={s.halo} />
      <g className={s.pop}>
        <circle r={r} fill={color} stroke="var(--surface)" strokeWidth={2} />
      </g>
      {label && (
        <text
          className={s.fadeIn}
          y={below ? 20 : -12}
          textAnchor={anchor}
          fill="var(--text)"
          fontSize={10}
          fontWeight={500}
          letterSpacing="0.08em"
          style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}
        >
          {label}
        </text>
      )}
    </g>
  );
}

// ---------- Hypnogram (Body hero) ----------
const LANE: Record<SleepStage, number> = { awake: 0, rem: 1, light: 2, deep: 3 };

export function Hypnogram({ stages, start, end, height = 148, label }: { stages: StageSegment[]; start: number; end: number; height?: number; label: string }) {
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const inRef = useInClass<HTMLDivElement>(0.3);
  const [hover, setHover] = useState<{ x: number; seg: StageSegment } | null>(null);
  const L = 44;
  const R = 2;
  const axisH = 20;
  const w = Math.max(width, 260);
  const laneH = (height - axisH) / 4;
  const bar = Math.min(16, laneH * 0.62);
  const x = scale(start, end, L, w - R);
  const yMid = (st: SleepStage) => LANE[st] * laneH + laneH / 2;
  const segs = stages.filter((g) => g.end > start && g.start < end);
  const body = (ghost: boolean) => (
    <g>
      {segs.map((g, i) => {
        const prev = segs[i - 1];
        const x0 = x(Math.max(start, g.start));
        const x1 = x(Math.min(end, g.end));
        return (
          <g key={i}>
            {prev && prev.stage !== g.stage && <line x1={x0} x2={x0} y1={yMid(prev.stage)} y2={yMid(g.stage)} stroke="var(--hairline-2)" strokeWidth={1} />}
            <rect x={x0} y={yMid(g.stage) - bar / 2} width={Math.max(1, x1 - x0 - 0.6)} height={bar} rx={Math.min(2.5, (x1 - x0) / 2)} fill={ghost ? 'var(--text-2)' : stageColor(g.stage)} />
          </g>
        );
      })}
    </g>
  );
  const ticks = hourTicks(start, end, 2);
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
              <g key={st}>
                <line x1={L} x2={w - R} y1={yMid(st)} y2={yMid(st)} stroke="var(--grid)" />
                <text x={0} y={yMid(st)} dominantBaseline="central" fill="var(--muted)" fontSize={9.5} letterSpacing="0.1em" style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
                  {STAGE_LABEL[st]}
                </text>
              </g>
            ))}
            <g className={s.ghost}>{body(true)}</g>
            {ticks.map((t) => (
              <text key={t} x={x(t)} y={height - 4} textAnchor="middle" fill="var(--muted)" fontSize={9.5} style={{ fontFamily: 'var(--font-mono)' }}>
                {hm(t)}
              </text>
            ))}
          </svg>
          {/* Bright copy revealed left → right by two counter-translating wrappers (compositor only). */}
          <div className={s.hypLayer} style={{ left: L, width: w - R - L + 1 }} aria-hidden>
            <div className={s.hypOuter}>
              <div className={s.hypInner}>
                <svg width={w} height={height} style={{ marginLeft: -L }}>
                  {body(false)}
                </svg>
              </div>
            </div>
          </div>
          {hover && (
            <>
              <div style={{ position: 'absolute', left: hover.x, top: 0, bottom: axisH, width: 1, background: 'var(--hairline-2)', pointerEvents: 'none' }} />
              <FloatTip x={hover.x} y={-58} width={w}>
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

/** Stage composition: a segmented bar that grows in, plus a 4-column readout. */
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
      <div className={s.mixGrid}>
        {order.map((st) => (
          <div key={st} className={s.mixCell}>
            <span className={`${s.mixLabel} t-micro`}>
              <i style={{ background: stageColor(st) }} />
              {STAGE_LABEL[st]}
            </span>
            <span className={s.mixVal}>{dur(val(st))}</span>
            <span className={`${s.mixPct} t-micro`}>{fmt((val(st) / tot) * 100)} %</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 4.1 sleeping HR with nadir ----------
export function HrCurve({ hr, start, end, nadir, nadirAt, baseline, color, dash }: { hr: HrSample[]; start: number; end: number; nadir: number; nadirAt: number; baseline: number; color: string; dash?: boolean }) {
  const anim = useChartAnim(1000);
  const gid = useSvgId('hr');
  const data = useMemo(() => hrMedian(hr.filter((h) => h.ts >= start && h.ts <= end), 5), [hr, start, end]);
  const vs = data.map((d) => d.bpm);
  const ticks = niceTicks(finiteMin([...vs, baseline]) - 2, finiteMax(vs) + 2, 4);
  const f = (nadirAt - start) / Math.max(1, end - start);
  const H = 196;
  return (
    <>
      <Legend items={[{ label: 'Heart rate · 5-min median', color, shape: dash ? 'dash' : 'line' }, { label: '30-night nadir', color: 'var(--text-2)', shape: 'dash' }, { label: 'Nadir', color, shape: 'dot' }]} />
      <ChartIn height={H}>
        <ResponsiveContainer width="100%" height={H}>
          <ComposedChart data={data} margin={{ ...MARGIN, top: 12, bottom: 4 }}>
            <defs>
              <AreaGradient id={gid} color={color} from={0.32} />
            </defs>
            <CartesianGrid {...GRID} />
            <XAxis {...timeX(start, end)} />
            <YAxis width={Y_WIDTH} domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} allowDataOverflow {...AXIS} />
            {Number.isFinite(baseline) && <ReferenceLine {...REF_FRONT} y={baseline} {...REF_LINE} label={refLabel(`BASE ${fmt(baseline)}`)} />}
            <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.slice(-1).map((x) => ({ label: 'bpm', value: fmt(Number(x.value)), color, dash }))} />} />
            <Area dataKey="bpm" baseValue={ticks[0]} stroke="none" fill={`url(#${gid})`} {...anim} activeDot={false} />
            <Line dataKey="bpm" stroke={color} strokeWidth={STROKE.primary} strokeDasharray={dash ? DASH : undefined} strokeLinejoin="round" strokeLinecap="round" dot={false} activeDot={{ r: 4, fill: color, stroke: 'var(--surface)', strokeWidth: 2 }} {...anim} />
            {Number.isFinite(nadir) && (
              <ReferenceDot
                x={nadirAt}
                y={nadir}
                r={5}
                ifOverflow="visible"
                shape={(p: { cx?: number; cy?: number }) => <Marker cx={p.cx} cy={p.cy} color={color} label={`${fmt(nadir)} bpm · ${hm(nadirAt)}`} anchor={f < 0.18 ? 'start' : f > 0.82 ? 'end' : 'middle'} />}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartIn>
    </>
  );
}

// ---------- 4.2 ridgeline ----------
export function Ridgeline({ nights, personId, color, selected, onPick, dash }: { nights: Night[]; personId: string; color: string; selected: string; onPick: (d: string) => void; dash?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const inRef = useInClass<HTMLDivElement>(0.2);
  const gid = useSvgId('ridge');
  const { night } = useMotionPrefs();
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
  const L = 50;
  const w = Math.max(width, 260);
  const step = 17;
  const amp = 34;
  const H = rows.length * step + amp + 18;
  const x = scale(0, 540, L, w - 6);
  const yOff = (i: number) => amp + 4 + i * step;
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
        <svg width={w} height={H} role="img" aria-label="Ridgeline of nightly heart-rate curves">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: color, stopOpacity: night ? 0.14 : 0.3 }} />
              <stop offset="100%" style={{ stopColor: color, stopOpacity: night ? 0.14 : 0.04 }} />
            </linearGradient>
          </defs>
          {[0, 120, 240, 360, 480].map((m) => (
            <g key={m}>
              <line x1={x(m)} x2={x(m)} y1={0} y2={H - 16} stroke="var(--grid)" />
              <text x={x(m)} y={H - 4} textAnchor="middle" fill="var(--muted)" fontSize={9.5} style={{ fontFamily: 'var(--font-mono)' }}>
                +{m / 60}h
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
                  <path d={area} fill="var(--surface)" />
                  <path d={area} fill={`url(#${gid})`} opacity={sel ? 1 : 0.55} />
                  <path d={linePath(pts)} fill="none" stroke={color} strokeWidth={sel ? 2.2 : 1.2} strokeOpacity={sel ? 1 : 0.6} strokeDasharray={dash ? '3 2' : undefined} strokeLinejoin="round" />
                  {r.nadir && <circle cx={x(r.nadir.m)} cy={base - yv(r.nadir.bpm)} r={sel ? 3 : 2.2} fill={sel ? color : 'var(--text-2)'} stroke={sel ? 'var(--surface)' : 'none'} strokeWidth={1.5} />}
                  <text x={0} y={base - 3} fill={sel ? 'var(--text)' : 'var(--muted)'} fontSize={9.5} fontWeight={sel ? 600 : 400} letterSpacing="0.06em" style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
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
                      setHover({ x: px, y: base - step - 48, date: r.date, bpm: near.bpm, min: near.m });
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
            {shortDay(hover.date)} {shortDate(hover.date)} · +{fmt(hover.min / 60, 1)} h
          </div>
          <TipRow color={color} dash={dash} value={`${fmt(hover.bpm)} bpm`} label="10-min median" />
        </FloatTip>
      )}
    </div>
  );
}

// ---------- 4.3 HRV through the night ----------
export function HrvNight({ hrv, start, end, band, color, dash }: { hrv: { ts: number; rmssdMs: number }[]; start: number; end: number; band: { mean: number; lo: number; hi: number }; color: string; dash?: boolean }) {
  const anim = useChartAnim(1000);
  const gid = useSvgId('hrv');
  const data = hrv.filter((h) => h.ts >= start && h.ts <= end).map((h) => ({ ts: h.ts, rmssd: h.rmssdMs }));
  const vs = data.map((d) => d.rmssd);
  const ticks = niceTicks(finiteMin([...vs, band.lo]) - 3, finiteMax([...vs, band.hi]) + 3, 4).filter((t) => t >= 0);
  const H = 180;
  return (
    <>
      <Legend
        items={[
          { label: 'RMSSD · 5-min windows', color, shape: dash ? 'dash' : 'line' },
          { label: '30-night mean ±1 SD', color: 'var(--text-2)', shape: 'rect' },
        ]}
      />
      <ChartIn height={H}>
        <ResponsiveContainer width="100%" height={H}>
          <ComposedChart data={data} margin={{ ...MARGIN, top: 12 }}>
            <defs>
              <AreaGradient id={gid} color={color} from={0.28} />
            </defs>
            <CartesianGrid {...GRID} />
            {Number.isFinite(band.lo) && Number.isFinite(band.hi) && <ReferenceArea y1={band.lo} y2={band.hi} fill="var(--text-2)" fillOpacity={0.08} stroke="none" />}
            {Number.isFinite(band.mean) && <ReferenceLine {...REF_FRONT} y={band.mean} {...REF_LINE} label={refLabel(`BASE ${fmt(band.mean)}`)} />}
            <XAxis {...timeX(start, end)} />
            <YAxis width={Y_WIDTH} domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} allowDataOverflow {...AXIS} />
            <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.slice(0, 1).map((x) => ({ label: 'ms RMSSD', value: fmt(Number(x.value), 1), color, dash }))} />} />
            <Area dataKey="rmssd" baseValue={ticks[0]} stroke="none" fill={`url(#${gid})`} activeDot={false} {...anim} />
            <Line dataKey="rmssd" stroke={color} strokeWidth={1.8} strokeDasharray={dash ? DASH : undefined} strokeLinejoin="round" dot={false} activeDot={{ r: 4, fill: color, stroke: 'var(--surface)', strokeWidth: 2 }} {...anim} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartIn>
    </>
  );
}

// ---------- 4.4 SpO2 strip ----------
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

export function Spo2Strip({ spo2, start, end, color, dash }: { spo2: Spo2Sample[]; start: number; end: number; color: string; dash?: boolean }) {
  const anim = useChartAnim(1000);
  const gid = useSvgId('o2');
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
  const H = 150;
  return (
    <>
      <Legend items={[{ label: 'SpO₂ · 2-min low', color, shape: dash ? 'dash' : 'line' }, { label: `Dips ≥3 % (${dips.length})`, color: 'var(--critical)', shape: 'dot' }]} />
      <ChartIn height={H}>
        <ResponsiveContainer width="100%" height={H}>
          <ComposedChart data={data} margin={{ ...MARGIN, top: 12 }}>
            <defs>
              <AreaGradient id={gid} color={color} from={0.26} />
            </defs>
            <CartesianGrid {...GRID} />
            <XAxis {...timeX(start, end)} />
            <YAxis width={Y_WIDTH + 6} domain={[88, 100]} ticks={[88, 92, 96, 100]} allowDataOverflow tickFormatter={(v: number) => `${v}%`} {...AXIS} />
            <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.slice(0, 1).map((x) => ({ label: 'SpO₂', value: `${fmt(Number(x.value))} %`, color, dash }))} />} />
            <Area dataKey="pct" baseValue={88} stroke="none" fill={`url(#${gid})`} activeDot={false} {...anim} />
            <Line dataKey="pct" stroke={color} strokeWidth={STROKE.secondary} strokeDasharray={dash ? DASH : undefined} strokeLinejoin="round" dot={false} activeDot={{ r: 4, fill: color, stroke: 'var(--surface)', strokeWidth: 2 }} {...anim} />
            {dips.map((d, i) => {
              const bx = Math.floor(d.ts / (2 * MIN)) * 2 * MIN;
              const by = data.find((p) => p.ts === bx)?.pct ?? d.pct;
              return (
                <ReferenceDot
                  key={d.ts}
                  x={bx}
                  y={Math.max(88, by)}
                  r={4}
                  ifOverflow="visible"
                  shape={(p: { cx?: number; cy?: number }) => <Marker cx={p.cx} cy={p.cy} color="var(--critical)" r={3.5} delay={900 + Math.min(i, 12) * 60} />}
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartIn>
    </>
  );
}

// ---------- 4.6 temperature deviation vs room temperature ----------
export function TempDeviation({ rows }: { rows: { date: string; dev: number | null; room: number }[] }) {
  const anim = useChartAnim(900);
  const gid = useSvgId('room');
  const data = rows.map((r) => ({ ...r, ts: Date.parse(`${r.date}T00:00:00Z`) }));
  const roomVals = data.map((d) => d.room).filter(Number.isFinite);
  const rt = niceTicks(Math.min(...roomVals), Math.max(...roomVals), 3);
  const devMax = Math.max(0.2, ...data.map((d) => Math.abs(d.dev ?? 0)));
  const dt = niceTicks(-devMax, devMax, 4);
  const tick = (v: number) => shortDate(new Date(v).toISOString().slice(0, 10));
  const tip = (p: { active?: boolean; payload?: readonly { value?: unknown; payload?: unknown }[]; label?: unknown }) => {
    const d = p.payload?.[0]?.payload as { date: string; dev: number | null; room: number } | undefined;
    if (!p.active || !d) return null;
    return (
      <div className="tip">
        <div className="tip-title">
          {shortDay(d.date)} {shortDate(d.date)}
        </div>
        <TipRow color={(d.dev ?? 0) >= 0 ? 'var(--div-neg)' : 'var(--div-pos)'} value={d.dev === null ? '–' : `${signed(d.dev, 2)} °C`} label="skin vs baseline" />
        <TipRow color="var(--temp)" value={`${fmt(d.room, 1)} °C`} label="room mean" />
      </div>
    );
  };
  const xAxis = { dataKey: 'ts', type: 'number' as const, domain: ['dataMin - 43200000', 'dataMax + 43200000'] as [string, string], tickFormatter: tick, minTickGap: 40, ...AXIS };
  return (
    <>
      <div className={`${s.chartLabel} t-label`}>
        <span>Skin · °C vs base</span>
        <Legend
          items={[
            { label: 'Warmer', color: 'var(--div-neg)', shape: 'rect' },
            { label: 'Cooler', color: 'var(--div-pos)', shape: 'rect' },
          ]}
        />
      </div>
      <ChartIn height={120}>
        <ResponsiveContainer width="100%" height={120}>
          <ComposedChart data={data} margin={{ ...MARGIN, right: 18 }} syncId="tdev">
            <CartesianGrid {...GRID} />
            <XAxis {...xAxis} />
            <YAxis width={Y_WIDTH} domain={[dt[0]!, dt.at(-1)!]} ticks={dt} {...AXIS} />
            <ReferenceLine y={0} stroke="var(--axis)" />
            <Tooltip cursor={{ fill: 'var(--surface-2)', opacity: 0.6 }} content={tip} />
            <Bar dataKey="dev" maxBarSize={8} radius={[2.5, 2.5, 2.5, 2.5]} {...anim}>
              {data.map((d) => (
                <Cell key={d.date} fill={(d.dev ?? 0) >= 0 ? 'var(--div-neg)' : 'var(--div-pos)'} />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </ChartIn>
      <div className={`${s.chartLabel} t-label`} style={{ marginTop: 10 }}>
        <span>Room mean · night</span>
        <Legend items={[{ label: 'Room °C', color: 'var(--temp)' }]} />
      </div>
      <ChartIn height={110}>
        <ResponsiveContainer width="100%" height={110}>
          <ComposedChart data={data} margin={{ ...MARGIN, right: 18 }} syncId="tdev">
            <defs>
              <AreaGradient id={gid} color="var(--temp)" from={0.25} />
            </defs>
            <CartesianGrid {...GRID} />
            <XAxis {...xAxis} />
            <YAxis width={Y_WIDTH} domain={[rt[0]!, rt.at(-1)!]} ticks={rt} {...AXIS} />
            <Tooltip cursor={CURSOR} content={tip} />
            <Area dataKey="room" baseValue={rt[0]} stroke="none" fill={`url(#${gid})`} activeDot={false} {...anim} />
            <Line dataKey="room" stroke="var(--temp)" strokeWidth={STROKE.primary} strokeLinejoin="round" dot={false} activeDot={{ r: 4, fill: 'var(--temp)', stroke: 'var(--surface)', strokeWidth: 2 }} {...anim} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartIn>
    </>
  );
}

// ---------- 4.7 our HR-based sleep/wake vs Google stages ----------
export function SleepWakeCompare({ stages, ours, start, end }: { stages: StageSegment[]; ours: { start: number; end: number; awake: boolean }[]; start: number; end: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const inRef = useInClass<HTMLDivElement>(0.3);
  const L = 70;
  const w = Math.max(260, width);
  const x = scale(start, end, L, w - 4);
  // Minutes where the two disagree on awake vs asleep, merged into runs.
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
      const wd = Math.max(1, x(Math.min(end, q.end)) - x0 - 0.6);
      return <rect key={i} x={x0} y={y} width={wd} height={h} rx={Math.min(2.5, wd / 2)} fill={q.fill} />;
    });
  const label = (y: number, t: string) => (
    <text x={0} y={y} dominantBaseline="central" fill="var(--text-2)" fontSize={9.5} letterSpacing="0.1em" style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
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
        <svg width={w} height={96} role="img" aria-label="Google stages versus our heart-rate sleep/wake estimate">
          {label(11, 'Google')}
          {label(37, 'Ours · HR')}
          {label(59, 'Differ')}
          <line x1={L} x2={w - 4} y1={59} y2={59} stroke="var(--grid)" />
          <g className={s.lanes}>{lane(2, 18, stages.map((q) => ({ start: q.start, end: q.end, fill: stageColor(q.stage) })))}</g>
          <g className={s.lanes}>{lane(28, 18, ours.map((q) => ({ start: q.start, end: q.end, fill: q.awake ? 'var(--stage-awake)' : 'var(--stage-light)' })))}</g>
          <g className={s.lanes}>{lane(55, 8, diff.map((q) => ({ ...q, fill: 'var(--critical)' })))}</g>
          {hourTicks(start, end, 2).map((t) => (
            <text key={t} x={x(t)} y={88} textAnchor="middle" fill="var(--muted)" fontSize={9.5} style={{ fontFamily: 'var(--font-mono)' }}>
              {hm(t)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

// ---------- 4.8 trends with baseline band ----------
// Thousands as '12k' so step counts fit the narrow y axis.
const kTick = (v: number) => (Math.abs(v) >= 1000 ? `${fmt(v / 1000, Math.abs(v) % 1000 ? 1 : 0)}k` : String(v));
export function TrendBand({
  rows: all,
  show,
  color,
  unit,
  digits = 0,
  label,
  icon,
  better,
  id,
  className = '',
  dash,
}: {
  rows: { date: string; v: number }[];
  show: number;
  color: string;
  unit: string;
  digits?: number;
  label: string;
  icon?: IconName;
  /** Which direction is good (for the delta chip tone). */
  better?: 'up' | 'down';
  id?: string;
  className?: string;
  dash?: boolean;
}) {
  const anim = useChartAnim(800);
  // Band from the full history so the first visible nights have a baseline too.
  const fullBand = rollingBand(all.map((r) => r.v), 30, 5);
  const rows = all.slice(-show);
  const band = fullBand.slice(-show);
  const data = rows.map((r, i) => ({ ts: Date.parse(`${r.date}T00:00:00Z`), date: r.date, v: Number.isFinite(r.v) ? r.v : null, band: Number.isFinite(band[i]!.lo) ? ([band[i]!.lo, band[i]!.hi] as [number, number]) : null, mean: Number.isFinite(band[i]!.mean) ? band[i]!.mean : null }));
  const vs = data.flatMap((d) => [d.v ?? NaN, ...(d.band ?? [])]).filter(Number.isFinite);
  const ticks = vs.length ? niceTicks(Math.min(...vs), Math.max(...vs), 3) : [0, 1];
  const last = data.filter((d) => d.v !== null).at(-1);
  const delta = last && last.mean !== null && last.v !== null ? last.v - last.mean : NaN;
  const shown = Number.isFinite(delta) ? signed(delta, digits) : '';
  const tone: Tone = !better || !Number.isFinite(delta) || /^±/.test(shown) ? 'neutral' : (delta > 0) === (better === 'up') ? 'good' : 'bad';
  return (
    <div id={id} className={`${s.trend} ${className}`.trim()}>
      <div className={s.trendHead}>
        <span className={`${s.trendLabel} t-label`}>
          {icon && <Icon name={icon} size={14} />}
          {label}
        </span>
        <span className={s.trendVal}>
          {shown && (
            <DeltaChip tone={tone} dir={/^±/.test(shown) ? 'flat' : delta > 0 ? 'up' : 'down'} title="vs 30-night baseline">
              {shown.replace(/^[+−±]/, '')}
            </DeltaChip>
          )}
          <span className={s.trendNum}>
            {fmt(last?.v ?? NaN, digits)}
            {unit && <span className="t-unit">{unit}</span>}
          </span>
        </span>
      </div>
      <ChartIn height={104}>
        <ResponsiveContainer width="100%" height={104}>
          <ComposedChart data={data} margin={{ ...MARGIN, top: 10, right: 18 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => shortDate(new Date(v).toISOString().slice(0, 10))} minTickGap={40} {...AXIS} />
            <YAxis width={Y_WIDTH} domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} tickFormatter={kTick} {...AXIS} />
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
                    <TipRow color={color} dash={dash} value={`${fmt(d.v ?? NaN, digits)}${unit ? ` ${unit}` : ''}`} label={label} />
                    {d.band && <TipRow value={`${fmt(d.band[0], digits)}–${fmt(d.band[1], digits)}`} label="baseline ±1 SD" />}
                  </div>
                );
              }}
            />
            <Area dataKey="band" stroke="none" fill="var(--text-2)" fillOpacity={0.1} activeDot={false} connectNulls {...anim} />
            <Line
              dataKey="v"
              stroke={color}
              strokeWidth={1.8}
              strokeDasharray={dash ? DASH : undefined}
              strokeLinejoin="round"
              dot={data.length <= 31 ? { r: 2.2, fill: color, strokeWidth: 0 } : false}
              activeDot={{ r: 4, fill: color, stroke: 'var(--surface)', strokeWidth: 2 }}
              connectNulls
              {...anim}
            />
            {last && last.v !== null && <ReferenceDot x={last.ts} y={last.v} r={4} ifOverflow="visible" shape={(p: { cx?: number; cy?: number }) => <Marker cx={p.cx} cy={p.cy} color={color} r={3.5} delay={850} />} />}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartIn>
    </div>
  );
}
