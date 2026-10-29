'use client';
/** Room tab, Air section: CO₂ ramp + forecast, fresh-air (ACH) tracker, ventilation gauge. */
import { useMemo, useRef } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts';
import { downsample, type RoomReading } from '@sleep-lab/core';
import { co2Band, fmt, hm, MIN, niceTicks, shortDate, shortDay } from '@/lib/format.ts';
import { median, quantile } from '@/lib/stats.ts';
import { useInView, useMotionPrefs } from '../../motion.tsx';
import { Legend, useWidth } from '../../ui.tsx';
import { AreaGradient, AXIS, CO2_BANDS, co2Tolerance, CURSOR, GRID, MARGIN, REF_LINE, refLabel, REF_FRONT, STROKE, Tip, TipRow, useChartAnim, useSvgId, Y_WIDTH } from '../common.tsx';
import { timeAxis } from './shared.ts';
import s from './room.module.css';

const ppmTick = (v: number) => fmt(v);

/**
 * Vertical gradient for a stroke whose colour changes at a threshold (objectBoundingBox: 0 = the series max).
 * Returns null when the series is flat (a zero-height bbox would hide the stroke).
 */
function thresholdStops(vals: number[], threshold: number) {
  const f = vals.filter(Number.isFinite);
  if (f.length < 2) return null;
  const hi = Math.max(...f);
  const lo = Math.min(...f);
  if (hi - lo < 1) return null;
  return Math.min(1, Math.max(0, (hi - threshold) / (hi - lo)));
}

// ───────────── CO₂ ramp + forecast ─────────────
export function Co2ForecastChart({ actual, forecast, known, until }: { actual: RoomReading[]; forecast: { ts: number; co2: number }[]; known: number; until: number }) {
  const anim = useChartAnim();
  const gLine = useSvgId('co2l');
  const gFc = useSvgId('co2f');
  const gArea = useSvgId('co2a');
  const data = useMemo(() => {
    const ds = downsample(actual, 5 * MIN, 'mean').map((r) => ({ ts: r.ts, actual: Math.round(r.co2), fc: null as number | null, rib: null as [number, number] | null }));
    const fc = forecast.map((f) => {
      const v = Math.round(f.co2);
      const tol = co2Tolerance(v);
      return { ts: f.ts, actual: null as number | null, fc: v, rib: [Math.round(v - tol), Math.round(v + tol)] as [number, number] };
    });
    // Join the forecast to the last observed point so the dashed line (and ribbon) start on the curve.
    const lastKnown = ds.filter((d) => d.ts <= known).at(-1);
    if (lastKnown) {
      lastKnown.fc = lastKnown.actual;
      lastKnown.rib = [lastKnown.actual!, lastKnown.actual!];
    }
    return [...ds, ...fc].sort((a, b) => a.ts - b.ts);
  }, [actual, forecast, known]);
  const from = data[0]?.ts ?? known;
  const max = Math.max(1200, ...data.map((d) => Math.max(d.actual ?? 0, d.rib?.[1] ?? 0)));
  const top = Math.ceil(max / 200) * 200;
  const yTicks = [...new Set([...[400, 800, 1000, 1500, 2000].filter((t) => t < top - 120), top])];
  const aStop = thresholdStops(data.map((d) => d.actual ?? NaN), 1000);
  const fStop = thresholdStops(data.map((d) => d.fc ?? NaN), 1000);
  const end = data.filter((d) => d.fc !== null).at(-1);
  const stroke = (id: string, stop: number | null) => (stop === null ? 'var(--text-2)' : `url(#${id})`);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ ...MARGIN, top: 14, right: 14 }}>
        <defs>
          {[
            [gLine, aStop],
            [gFc, fStop],
          ].map(([id, stop]) =>
            stop === null ? null : (
              <linearGradient key={id as string} id={id as string} x1="0" y1="0" x2="0" y2="1">
                <stop offset={stop as number} stopColor="var(--co2)" />
                <stop offset={stop as number} stopColor="var(--text-2)" />
              </linearGradient>
            ),
          )}
          <AreaGradient id={gArea} color="var(--co2)" from={0.22} />
        </defs>
        {CO2_BANDS.map((b) => (
          <ReferenceArea key={b.from} y1={Math.max(400, b.from)} y2={Math.min(b.to, top)} fill={b.fill} fillOpacity={1} stroke="none" ifOverflow="hidden" />
        ))}
        <CartesianGrid {...GRID} />
        <XAxis {...timeAxis(from, until)} />
        <YAxis width={Y_WIDTH + 4} domain={[400, top]} ticks={yTicks} tickFormatter={ppmTick} {...AXIS} />
        <ReferenceLine {...REF_FRONT} y={1000} {...REF_LINE} label={refLabel('1,000')} />
        <ReferenceLine x={known} stroke="var(--hairline-2)" strokeWidth={1} label={{ value: 'NOW', position: 'insideTopLeft', fill: 'var(--muted)', fontSize: 9.5, fontFamily: 'var(--font-mono)', dx: 2 }} />
        <Tooltip
          cursor={CURSOR}
          content={(p) => (
            <Tip
              {...p}
              title={(l) => hm(Number(l))}
              rows={(pl) =>
                pl
                  .filter((x) => typeof x.value === 'number' && (x.dataKey === 'actual' || x.dataKey === 'fc'))
                  .map((x) => ({ label: x.dataKey === 'fc' ? 'forecast' : 'measured', value: `${fmt(Number(x.value))} ppm`, color: 'var(--co2)', dash: x.dataKey === 'fc' }))
              }
            />
          )}
        />
        <Area dataKey="actual" stroke="none" fill={`url(#${gArea})`} baseValue={400} connectNulls={false} {...anim} activeDot={false} />
        <Area dataKey="rib" stroke="none" fill="var(--co2)" fillOpacity={0.12} connectNulls {...anim} activeDot={false} />
        <Line dataKey="actual" stroke={stroke(gLine, aStop)} strokeWidth={STROKE.primary} strokeLinecap="round" dot={false} connectNulls={false} {...anim} activeDot={{ r: 3.5, fill: 'var(--co2)', stroke: 'var(--surface)', strokeWidth: 2 }} />
        <Line dataKey="fc" stroke={stroke(gFc, fStop)} strokeWidth={STROKE.secondary + 0.3} strokeDasharray="4 4" dot={false} connectNulls {...anim} activeDot={{ r: 3.5, fill: 'var(--co2)', stroke: 'var(--surface)', strokeWidth: 2 }} />
        {end && end.fc !== null && <ReferenceDot x={end.ts} y={end.fc} r={4} fill={end.fc >= 1000 ? 'var(--co2)' : 'var(--text-2)'} stroke="var(--surface)" strokeWidth={2} ifOverflow="extendDomain" />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ───────────── ACH tracker ─────────────
export function AchTracker({ points, needed }: { points: { date: string; ts: number; ach: number | null; ajar: boolean; truth?: number }[]; needed: number }) {
  const anim = useChartAnim();
  const closed = points.filter((p) => p.ach !== null && !p.ajar);
  const ajar = points.filter((p) => p.ach !== null && p.ajar);
  const roll = points.map((p, i) => {
    const win = points.slice(Math.max(0, i - 6), i + 1).filter((q) => q.ach !== null && !q.ajar).map((q) => q.ach!);
    return { ts: p.ts, ach: win.length >= 3 ? median(win) : null };
  });
  // Robust top: a few decay fits are glitchy outliers; they're clipped at the top edge (still in the table).
  const max = Math.max(needed + 0.1, quantile(points.map((p) => p.ach ?? NaN), 0.97) * 1.15);
  const yTicks = niceTicks(0, max, 4);
  const top = yTicks.at(-1)!;
  const dot = (fill: string, r: number) => (sh: { cx?: number; cy?: number }) => <circle cx={sh.cx} cy={sh.cy} r={r} fill={fill} stroke="var(--surface)" strokeWidth={1.5} />;
  return (
    <>
      <Legend
        items={[
          { label: 'Door closed', color: 'var(--text-2)', shape: 'dot' },
          { label: 'Door ajar', color: 'var(--s4)', shape: 'dot' },
          { label: '7-night median', color: 'var(--text)' },
          { label: `${needed.toFixed(2)} needed`, color: 'var(--good)', shape: 'dash' },
        ]}
      />
      <ResponsiveContainer width="100%" height={196}>
        <ComposedChart margin={{ ...MARGIN, top: 12 }}>
          <ReferenceArea y1={needed} y2={top} fill="var(--band-good)" fillOpacity={1} stroke="none" ifOverflow="hidden" />
          <CartesianGrid {...GRID} />
          <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => shortDate(new Date(v).toISOString().slice(0, 10))} {...AXIS} minTickGap={30} />
          <YAxis dataKey="ach" width={Y_WIDTH} domain={[0, top]} ticks={yTicks} tickFormatter={(v: number) => fmt(v, 1)} allowDataOverflow {...AXIS} />
          <ReferenceLine {...REF_FRONT} y={needed} stroke="var(--good)" strokeOpacity={0.8} strokeDasharray="3 4" label={{ ...refLabel(`NEEDED ${needed.toFixed(2)}`), fill: 'var(--good-text)' }} />
          <Tooltip
            cursor={CURSOR}
            content={(p) => {
              const d = p.payload?.[0]?.payload as { date?: string; ach?: number | null; ajar?: boolean; truth?: number } | undefined;
              if (!p.active || !d?.date) return null;
              return (
                <div className="tip">
                  <div className="tip-title">
                    {shortDay(d.date)} {shortDate(d.date)}
                  </div>
                  <TipRow value={`${fmt(d.ach ?? NaN, 2)} /h`} label={d.ajar ? 'door ajar' : 'door closed'} />
                  {d.truth !== undefined && <TipRow value={fmt(d.truth, 2)} label="sim truth" />}
                </div>
              );
            }}
          />
          <Line data={roll} dataKey="ach" stroke="var(--text)" strokeWidth={STROKE.primary} strokeLinecap="round" dot={false} connectNulls {...anim} />
          <Scatter data={closed} dataKey="ach" fill="var(--text-2)" {...anim} shape={dot('var(--text-2)', 3.5)} />
          <Scatter data={ajar} dataKey="ach" fill="var(--s4)" {...anim} shape={dot('var(--s4)', 4.5)} />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

// ───────────── Ventilation verdict gauge ─────────────
const GAUGE_SEGS = [
  { a: 400, b: 800, c: 'var(--good)' },
  { a: 800, b: 1000, c: 'var(--warn)' },
  { a: 1000, b: 1500, c: 'var(--serious)' },
  { a: 1500, b: 1600, c: 'var(--critical)' },
] as const;

/** Semicircle gauge: the 30-night median CO₂ needle against the 1,000 ppm decision line. The needle swings in on reveal. */
export function VentGauge({ value, decision = 1000, label = '30-night median' }: { value: number; decision?: number; label?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, { threshold: 0.35 });
  const { level } = useMotionPrefs();
  const w = Math.min(300, Math.max(220, width));
  const r = w / 2 - 18;
  const cx = w / 2;
  const cy = r + 36;
  const h = cy + 10;
  const lo = 400;
  const hi = 1600;
  const frac = (v: number) => (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo);
  const ang = (v: number) => Math.PI * (1 - frac(v));
  const pt = (v: number, rr: number) => [cx + rr * Math.cos(ang(v)), cy - rr * Math.sin(ang(v))] as const;
  const arc = (a: number, b: number, rr: number) => {
    const [x0, y0] = pt(a, rr);
    const [x1, y1] = pt(b, rr);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${rr},${rr} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  const [dx0, dy0] = pt(decision, r - 13);
  const [dx1, dy1] = pt(decision, r + 9);
  const [lx, ly] = pt(decision, r + 18);
  const shown = seen || level === 'none';
  const rot = Number.isFinite(value) ? frac(value) * 180 : 0;
  const band = Number.isFinite(value) ? co2Band(value).key : 'good';
  return (
    <div ref={box} className={s.gauge} style={{ ['--band-c' as string]: `var(--${band})` }}>
      <div ref={ref} style={{ width: '100%', display: 'grid', justifyItems: 'center' }}>
        {width > 0 && (
          <svg width={w} height={h} role="img" aria-label={`Median nightly CO2 ${Math.round(value)} ppm against the ${decision} ppm decision line`}>
            <path d={arc(lo, hi, r)} stroke="var(--ring-track)" strokeWidth={12} fill="none" strokeLinecap="round" />
            {GAUGE_SEGS.map((sg) => (
              <path key={sg.a} d={arc(sg.a + 6, sg.b - 6, r)} stroke={sg.c} strokeOpacity={value >= sg.a ? 0.95 : 0.35} strokeWidth={6} fill="none" strokeLinecap="round" />
            ))}
            {[400, 800, 1500].map((t) => {
              const [tx, ty] = pt(t, r - 20);
              return (
                <text key={t} x={tx} y={ty + 3} textAnchor={t < 1000 ? 'start' : 'end'} fill="var(--muted)" fontSize={9.5} fontFamily="var(--font-mono)">
                  {fmt(t)}
                </text>
              );
            })}
            <line x1={dx0} y1={dy0} x2={dx1} y2={dy1} stroke="var(--text)" strokeWidth={1.5} />
            <text x={lx} y={ly - 2} textAnchor="middle" fill="var(--text-2)" fontSize={9.5} fontFamily="var(--font-mono)" letterSpacing=".08em">
              {fmt(decision)} DECISION
            </text>
            {/* Needle drawn pointing at 400 (left) and rotated clockwise into place. */}
            <g className={s.gaugeNeedle} style={{ transformOrigin: `${cx}px ${cy}px`, transform: `rotate(${shown ? rot : 0}deg)` }}>
              <line x1={cx} y1={cy} x2={cx - (r - 26)} y2={cy} stroke="var(--text)" strokeWidth={2.5} strokeLinecap="round" />
              <circle cx={cx - (r - 26)} cy={cy} r={3} fill="var(--band-c)" />
            </g>
            <circle cx={cx} cy={cy} r={7} fill="var(--surface)" stroke="var(--text)" strokeWidth={2} />
          </svg>
        )}
      </div>
      <div className={s.gaugeReadout}>
        <div className={s.gaugeValue}>
          {fmt(value)}
          <span className="t-unit">ppm</span>
        </div>
        <div className="t-label muted">{label}</div>
      </div>
    </div>
  );
}
