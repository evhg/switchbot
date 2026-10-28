'use client';
import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { dewPointC, downsample, targetAt, type Night, type RoomReading, type TemperatureCurve } from '@sleep-lab/core';
import { CO2_BANDS, co2Band, dur, fmt, hm, hourTicks, ictMinuteOfDay, MIN, niceTicks, shortDate, shortDay, weekdayOf } from '@/lib/format.ts';
import { quantile } from '@/lib/stats.ts';
import { median } from '@/lib/stats.ts';
import { Legend, useWidth } from '../ui.tsx';
import { AXIS, CURSOR, FloatTip, GRID, MARGIN, Tip, TipRow, Y_WIDTH } from './common.tsx';

const timeAxis = (from: number, to: number, step = 2) => ({
  dataKey: 'ts',
  type: 'number' as const,
  domain: [from, to] as [number, number],
  ticks: hourTicks(from, to, step),
  tickFormatter: (v: number) => hm(v),
  ...AXIS,
});

// ---------- CO2 ramp + forecast ----------
export function Co2ForecastChart({ actual, forecast, known, until }: { actual: RoomReading[]; forecast: { ts: number; co2: number }[]; known: number; until: number }) {
  const data = useMemo(() => {
    const ds = downsample(actual, 5 * MIN, 'mean').map((r) => ({ ts: r.ts, actual: Math.round(r.co2), fc: null as number | null }));
    const fc = forecast.map((f) => ({ ts: f.ts, actual: null as number | null, fc: Math.round(f.co2) }));
    // Join the forecast to the last observed point so the dashed line starts on the curve.
    const lastKnown = ds.filter((d) => d.ts <= known).at(-1);
    if (lastKnown) lastKnown.fc = lastKnown.actual;
    return [...ds, ...fc].sort((a, b) => a.ts - b.ts);
  }, [actual, forecast, known]);
  const from = data[0]?.ts ?? known;
  const max = Math.max(1200, ...data.map((d) => d.actual ?? d.fc ?? 0));
  const top = Math.ceil(max / 200) * 200;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={data} margin={MARGIN}>
        {CO2_BANDS.map((b) => (
          <ReferenceArea key={b.key} y1={b.from < 400 ? 400 : b.from} y2={Math.min(b.to, top)} fill={b.fill} fillOpacity={1} stroke="none" ifOverflow="hidden" />
        ))}
        <CartesianGrid {...GRID} />
        <XAxis {...timeAxis(from, until)} />
        <YAxis width={Y_WIDTH} domain={[400, top]} ticks={[...new Set([...[400, 800, 1000, 1500, 2000].filter((t) => t <= top), top])]} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v))} {...AXIS} />
        <ReferenceLine x={known} stroke="var(--axis)" strokeDasharray="2 3" />
        <Tooltip
          cursor={CURSOR}
          content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.filter((x) => typeof x.value === 'number').map((x) => ({ label: x.dataKey === 'fc' ? 'forecast' : 'measured', value: `${fmt(Number(x.value))} ppm`, color: 'var(--text-2)', dash: x.dataKey === 'fc' }))} />}
        />
        <Line dataKey="actual" stroke="var(--text-2)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
        <Line dataKey="fc" stroke="var(--text-2)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ---------- ACH tracker ----------
export function AchTracker({ points, needed }: { points: { date: string; ts: number; ach: number | null; ajar: boolean; truth?: number }[]; needed: number }) {
  const closed = points.filter((p) => p.ach !== null && !p.ajar);
  const ajar = points.filter((p) => p.ach !== null && p.ajar);
  const roll = points.map((p, i) => {
    const win = points.slice(Math.max(0, i - 6), i + 1).filter((q) => q.ach !== null && !q.ajar).map((q) => q.ach!);
    return { ts: p.ts, ach: win.length >= 3 ? median(win) : null };
  });
  // Robust top: a few decay fits are glitchy outliers; they're clipped at the top edge (still in the table).
  const max = Math.max(needed + 0.1, quantile(points.map((p) => p.ach ?? NaN), 0.97) * 1.15);
  const yTicks = niceTicks(0, max, 4);
  return (
    <>
      <Legend
        items={[
          { label: 'Door closed', color: 'var(--text-2)', shape: 'dot' },
          { label: 'Door ajar', color: 'var(--s4)', shape: 'dot' },
          { label: '7-night median', color: 'var(--text)' },
          { label: `${needed.toFixed(2)} needed for <1,000 ppm`, color: 'var(--good)', shape: 'dash' },
        ]}
      />
      <ResponsiveContainer width="100%" height={190}>
        <ComposedChart margin={MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => shortDate(new Date(v).toISOString().slice(0, 10))} {...AXIS} minTickGap={30} />
          <YAxis dataKey="ach" width={Y_WIDTH} domain={[0, yTicks.at(-1)!]} ticks={yTicks} allowDataOverflow {...AXIS} />
          <ReferenceLine y={needed} stroke="var(--good)" strokeDasharray="4 3" />
          <Tooltip
            cursor={CURSOR}
            content={(p) => {
              const d = p.payload?.[0]?.payload as { date?: string; ach?: number | null; ajar?: boolean; truth?: number } | undefined;
              if (!p.active || !d?.date) return null;
              return (
                <div className="tip">
                  <div className="tip-title">{shortDay(d.date)} {shortDate(d.date)}</div>
                  <TipRow value={`${fmt(d.ach ?? NaN, 2)} /h`} label={d.ajar ? 'door ajar' : 'door closed'} />
                  {d.truth !== undefined && <TipRow value={fmt(d.truth, 2)} label="sim truth" />}
                </div>
              );
            }}
          />
          <Line data={roll} dataKey="ach" stroke="var(--text)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          <Scatter data={closed} dataKey="ach" fill="var(--text-2)" isAnimationActive={false} shape={(s: { cx?: number; cy?: number }) => <circle cx={s.cx} cy={s.cy} r={4} fill="var(--text-2)" stroke="var(--surface)" strokeWidth={2} />} />
          <Scatter data={ajar} dataKey="ach" fill="var(--s4)" isAnimationActive={false} shape={(s: { cx?: number; cy?: number }) => <circle cx={s.cx} cy={s.cy} r={5} fill="var(--s4)" stroke="var(--surface)" strokeWidth={2} />} />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

// ---------- Ventilation verdict gauge ----------
export function VentGauge({ value, decision = 1000 }: { value: number; decision?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.min(320, Math.max(220, width));
  const h = w * 0.5 + 54;
  const cx = w / 2;
  const r = w / 2 - 16;
  const cy = r + 30;
  const lo = 400;
  const hi = 1600;
  const ang = (v: number) => Math.PI * (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo));
  const pt = (v: number, rr: number) => [cx + rr * Math.cos(ang(v)), cy - rr * Math.sin(ang(v))] as const;
  const arc = (a: number, b: number, rr: number) => {
    const [x0, y0] = pt(a, rr);
    const [x1, y1] = pt(b, rr);
    return `M${x0},${y0} A${rr},${rr} 0 0 1 ${x1},${y1}`;
  };
  const [nx, ny] = pt(value, r - 22);
  const [dx0, dy0] = pt(decision, r - 14);
  const [dx1, dy1] = pt(decision, r + 10);
  const segs = [
    { a: 400, b: 800, c: 'var(--good)' },
    { a: 800, b: 1000, c: 'var(--warn)' },
    { a: 1000, b: 1500, c: 'var(--serious)' },
    { a: 1500, b: 1600, c: 'var(--critical)' },
  ];
  return (
    <div ref={ref} style={{ display: 'grid', justifyItems: 'center' }}>
      {width > 0 && (
        <svg width={w} height={h + 4} role="img" aria-label={`Median nightly CO2 ${Math.round(value)} ppm against the ${decision} ppm decision line`}>
          {segs.map((s) => (
            <path key={s.a} d={arc(s.a + 4, s.b - 4, r)} stroke={s.c} strokeWidth={12} fill="none" strokeLinecap="butt" />
          ))}
          <line x1={dx0} y1={dy0} x2={dx1} y2={dy1} stroke="var(--text)" strokeWidth={2} />
          <text x={dx1} y={dy1 - 4} textAnchor="middle" fill="var(--text-2)" fontSize={10}>
            {decision.toLocaleString('en-US')} decision line
          </text>
          <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--text)" strokeWidth={3} strokeLinecap="round" />
          <circle cx={cx} cy={cy} r={6} fill="var(--text)" />
          <text x={16} y={cy + 16} fill="var(--muted)" fontSize={10} textAnchor="middle">400</text>
          <text x={w - 16} y={cy + 16} fill="var(--muted)" fontSize={10} textAnchor="middle">1.6k</text>
          <text x={cx} y={cy + 30} textAnchor="middle" fill="var(--text)" fontSize={24} fontWeight={600}>
            {fmt(value)} <tspan fontSize={12} fill="var(--muted)" fontWeight={400}>ppm</tspan>
          </text>
        </svg>
      )}
    </div>
  );
}

// ---------- Comfort chart ----------
const stepTicks = (lo: number, hi: number, step: number) => {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
};

export function ComfortChart({ points }: { points: { tempC: number; rh: number; f: number; ts: number }[] }) {
  // Explicit "nice" domains and ticks (recharts' own pick gave 17,19,21,23,24 and 40/48/56/64/70).
  const temps = points.map((p) => p.tempC).filter(Number.isFinite);
  const rhs = points.map((p) => p.rh).filter(Number.isFinite);
  const xStep = (temps.length ? Math.max(...temps, 22) - Math.min(...temps, 18) : 4) > 7 ? 2 : 1;
  const xLo = Math.floor((Math.min(18, ...temps) - 0.5) / xStep) * xStep;
  const xHi = Math.ceil((Math.max(22, ...temps) + 0.5) / xStep) * xStep;
  const yStep = (rhs.length ? Math.max(...rhs, 60) - Math.min(...rhs, 40) : 20) > 30 ? 10 : 5;
  const yLo = Math.floor(Math.min(40, ...rhs) / yStep) * yStep;
  const yHi = Math.ceil(Math.max(60, ...rhs) / yStep) * yStep;
  return (
    <>
      <div className="legend">
        <span>
          <svg width={60} height={10} aria-hidden>
            <defs>
              <linearGradient id="cf-grad">
                <stop offset="0" stopColor="var(--seq)" stopOpacity={0.25} />
                <stop offset="1" stopColor="var(--seq)" stopOpacity={1} />
              </linearGradient>
            </defs>
            <rect width={60} height={10} rx={3} fill="url(#cf-grad)" />
          </svg>
          lights-out → wake (5-min)
        </span>
        <span>
          <i className="key-rect" style={{ border: '1.5px solid var(--good)', background: 'transparent' }} /> comfort box 18–22 °C · 45–55 %
        </span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart margin={{ ...MARGIN, bottom: 10 }}>
          <CartesianGrid stroke="var(--grid)" />
          <XAxis dataKey="tempC" type="number" name="Temp" unit="°" domain={[xLo, xHi]} ticks={stepTicks(xLo, xHi, xStep)} interval={0} allowDecimals={false} {...AXIS} />
          <YAxis dataKey="rh" type="number" name="RH" unit="%" width={Y_WIDTH + 4} domain={[yLo, yHi]} ticks={stepTicks(yLo, yHi, yStep)} interval={0} {...AXIS} />
          <ZAxis range={[36, 36]} />
          <ReferenceArea x1={18} x2={22} y1={45} y2={55} fill="var(--good)" fillOpacity={0.08} stroke="var(--good)" strokeOpacity={0.8} strokeWidth={1.5} />
          <Tooltip
            cursor={false}
            content={(p) => {
              const d = p.payload?.[0]?.payload as { tempC: number; rh: number; ts: number } | undefined;
              if (!p.active || !d) return null;
              return (
                <div className="tip">
                  <div className="tip-title">{hm(d.ts)}</div>
                  <TipRow value={`${fmt(d.tempC, 1)} °C`} label="temp" />
                  <TipRow value={`${fmt(d.rh)} %`} label="RH" />
                  <TipRow value={`${fmt(dewPointC(d.tempC, d.rh), 1)} °C`} label="dew point" />
                </div>
              );
            }}
          />
          <Scatter data={points} isAnimationActive={false}>
            {points.map((p, i) => (
              <Cell key={i} fill="var(--seq)" fillOpacity={0.25 + 0.75 * p.f} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </>
  );
}

// ---------- Calendar heatmap ----------
export function CalendarHeatmap({
  cells,
  color,
  max,
  unit,
  onPick,
  selected,
}: {
  cells: { date: string; value: number }[];
  color: string;
  max: number;
  unit: string;
  onPick?: (date: string) => void;
  selected?: string | null;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ date: string; value: number } | null>(null);
  if (!cells.length) return null;
  const first = cells[0]!.date;
  const offset = (weekdayOf(first) + 6) % 7; // Monday-first rows
  const weeks = Math.ceil((offset + cells.length) / 7);
  const gap = 3;
  const left = 22;
  const size = Math.max(10, Math.min(24, Math.floor((Math.max(width, 200) - left - gap * weeks) / weeks)));
  const w = left + weeks * (size + gap);
  const h = 7 * (size + gap) + 14;
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={w} height={h} role="img" aria-label="Calendar heatmap">
          {['M', '', 'W', '', 'F', '', 'S'].map((d, i) => (
            <text key={i} x={0} y={14 + i * (size + gap) + size / 2 + 3} fill="var(--muted)" fontSize={9}>
              {d}
            </text>
          ))}
          {cells.map((c, i) => {
            const k = offset + i;
            const col = Math.floor(k / 7);
            const row = k % 7;
            const f = Math.max(0, Math.min(1, c.value / max));
            const firstOfMonth = c.date.endsWith('-01') || (i === 0 && Number(c.date.slice(8)) < 20);
            return (
              <g key={c.date}>
                {firstOfMonth && row < 7 && (
                  <text x={left + col * (size + gap)} y={9} fill="var(--muted)" fontSize={9}>
                    {shortDate(c.date).split(' ')[1]}
                  </text>
                )}
                <rect
                  x={left + col * (size + gap)}
                  y={14 + row * (size + gap)}
                  width={size}
                  height={size}
                  rx={3}
                  fill={c.value <= 0 ? 'var(--surface-2)' : `color-mix(in oklab, ${color} ${Math.round(18 + 82 * f)}%, var(--surface))`}
                  stroke={selected === c.date ? 'var(--text)' : hover?.date === c.date ? 'var(--text-2)' : 'none'}
                  strokeWidth={1.5}
                  style={{ cursor: onPick ? 'pointer' : undefined }}
                  onPointerEnter={() => setHover(c)}
                  onPointerLeave={() => setHover(null)}
                  onClick={() => onPick?.(c.date)}
                >
                  <title>{`${shortDay(c.date)} ${shortDate(c.date)}: ${Math.round(c.value)} ${unit}`}</title>
                </rect>
              </g>
            );
          })}
        </svg>
      )}
      <div className="row between small" style={{ marginTop: 4, minHeight: 18 }}>
        <span className="t2">{hover ? `${shortDay(hover.date)} ${shortDate(hover.date)} · ${dur(hover.value)}` : onPick ? 'Tap a day to open that night' : ''}</span>
        <span className="row" style={{ gap: 4 }}>
          <span className="muted">0</span>
          {[0.2, 0.45, 0.7, 1].map((f) => (
            <i key={f} className="key-rect" style={{ background: `color-mix(in oklab, ${color} ${Math.round(18 + 82 * f)}%, var(--surface))` }} />
          ))}
          <span className="muted">{dur(max)}+</span>
        </span>
      </div>
    </div>
  );
}

// ---------- 24 h radial clock ----------
export function RadialClock({ nights }: { nights: Night[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const B = 96; // 15-min buckets
  const buckets = useMemo(() => {
    const co2 = Array.from({ length: B }, () => [] as number[]);
    const temp = Array.from({ length: B }, () => [] as number[]);
    const ac = Array.from({ length: B }, () => [0, 0]);
    for (const n of nights) {
      for (const r of n.room) {
        const b = Math.floor(ictMinuteOfDay(r.ts) / 15);
        co2[b]!.push(r.co2);
        temp[b]!.push(r.tempC);
      }
      const cmds = [...n.ac].sort((a, b) => a.ts - b.ts);
      if (!cmds.length) continue;
      for (let t = n.room[0]?.ts ?? 0; t <= (n.room.at(-1)?.ts ?? 0); t += 15 * MIN) {
        const c = cmds.filter((x) => x.ts <= t).at(-1);
        const b = Math.floor(ictMinuteOfDay(t) / 15);
        ac[b]![1]! += 1;
        if (c?.state.power) ac[b]![0]! += 1;
      }
    }
    return Array.from({ length: B }, (_, i) => ({
      co2: co2[i]!.length ? co2[i]!.reduce((a, b) => a + b, 0) / co2[i]!.length : NaN,
      temp: temp[i]!.length ? temp[i]!.reduce((a, b) => a + b, 0) / temp[i]!.length : NaN,
      ac: ac[i]![1]! ? ac[i]![0]! / ac[i]![1]! : NaN,
    }));
  }, [nights]);
  const size = Math.min(320, Math.max(240, width));
  const c = size / 2;
  const rOut = c - 22;
  const rCo2In = rOut - 18;
  const rT1 = rCo2In - 8;
  const rT0 = rT1 - 58;
  const rAc = rT0 - 10;
  const a = (i: number) => (i / B) * 2 * Math.PI - Math.PI / 2; // midnight at top
  const ptA = (ang: number, r: number) => [c + r * Math.cos(ang), c + r * Math.sin(ang)] as const;
  const wedge = (i: number, r0: number, r1: number) => {
    const a0 = a(i) + 0.004;
    const a1 = a(i + 1) - 0.004;
    const [x0, y0] = ptA(a0, r1);
    const [x1, y1] = ptA(a1, r1);
    const [x2, y2] = ptA(a1, r0);
    const [x3, y3] = ptA(a0, r0);
    return `M${x0},${y0} A${r1},${r1} 0 0 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 0 0 ${x3},${y3}Z`;
  };
  const temps = buckets.map((b) => b.temp).filter(Number.isFinite);
  const tLo = Math.floor(Math.min(...temps));
  const tHi = Math.ceil(Math.max(...temps));
  const rT = (t: number) => rT0 + ((t - tLo) / Math.max(1, tHi - tLo)) * (rT1 - rT0);
  // Walk the clock starting just after a data gap (the 12:00–18:00 hole), so the line runs through midnight.
  let tempPath = '';
  let pen = false;
  const ok = (i: number) => Number.isFinite(buckets[((i % B) + B) % B]!.temp);
  let s0 = 0;
  for (let i = 0; i < B; i++) if (ok(i) && !ok(i - 1)) { s0 = i; break; }
  for (let k = 0; k < B; k++) {
    const i = (s0 + k) % B;
    const b = buckets[i]!;
    if (!Number.isFinite(b.temp)) {
      pen = false;
      continue;
    }
    const [x, y] = ptA(a(i + 0.5), rT(b.temp));
    tempPath += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  if (temps.length === B) tempPath += 'Z';
  const hb = hover !== null ? buckets[hover] : undefined;
  return (
    <div ref={ref} className="chart-box" style={{ display: 'grid', justifyItems: 'center' }}>
      {width > 0 && (
        <svg
          width={size}
          height={size}
          role="img"
          aria-label="24-hour clock of average CO2, temperature and aircon use"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const dx = e.clientX - r.left - c;
            const dy = e.clientY - r.top - c;
            const ang = (Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
            setHover(Math.min(B - 1, Math.floor((ang / (2 * Math.PI)) * B)));
          }}
          onPointerLeave={() => setHover(null)}
        >
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => {
            const [x, y] = ptA(a(h * 4), rOut + 12);
            const [x0, y0] = ptA(a(h * 4), rAc - 4);
            const [x1, y1] = ptA(a(h * 4), rOut);
            return (
              <g key={h}>
                <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--grid)" />
                <text x={x} y={y + 3.5} textAnchor="middle" fill="var(--muted)" fontSize={10}>
                  {String(h).padStart(2, '0')}
                </text>
              </g>
            );
          })}
          <circle cx={c} cy={c} r={rT0} fill="none" stroke="var(--grid)" />
          <circle cx={c} cy={c} r={rT1} fill="none" stroke="var(--grid)" />
          {buckets.map((b, i) =>
            Number.isFinite(b.co2) ? (
              <path key={i} d={wedge(i, rCo2In, rOut)} fill={`var(--${co2Band(b.co2).key})`} opacity={hover === i ? 1 : 0.8} />
            ) : (
              <path key={i} d={wedge(i, rCo2In, rOut)} fill="var(--surface-2)" />
            ),
          )}
          {buckets.map((b, i) => (Number.isFinite(b.ac) && b.ac > 0.05 ? <path key={`ac${i}`} d={wedge(i, rAc - 5, rAc)} fill="var(--setpoint)" opacity={0.2 + 0.8 * b.ac} /> : null))}
          <path d={tempPath} fill="none" stroke="var(--temp)" strokeWidth={2} strokeLinejoin="round" />
          {hover !== null && <path d={wedge(hover, rAc - 6, rOut)} fill="none" stroke="var(--text)" strokeWidth={1} />}
          <text x={c} y={c - 6} textAnchor="middle" fill="var(--text)" fontSize={hb ? 15 : 12} fontWeight={600}>
            {hb ? `${String(Math.floor(hover! / 4)).padStart(2, '0')}:${String((hover! % 4) * 15).padStart(2, '0')}` : `${nights.length}-night`}
          </text>
          <text x={c} y={c + 10} textAnchor="middle" fill="var(--muted)" fontSize={11}>
            {hb ? (Number.isFinite(hb.co2) ? `${fmt(hb.co2)} ppm · ${fmt(hb.temp, 1)}°` : 'no data (day)') : 'average'}
          </text>
          {hb && Number.isFinite(hb.ac) && (
            <text x={c} y={c + 24} textAnchor="middle" fill="var(--muted)" fontSize={10}>
              AC on {Math.round(hb.ac * 100)}% of nights
            </text>
          )}
        </svg>
      )}
      <Legend
        items={[
          { label: 'CO₂ band (outer)', color: 'var(--serious)', shape: 'rect' },
          { label: `Temp ${tLo}–${tHi} °C (line)`, color: 'var(--temp)' },
          { label: 'AC on (inner)', color: 'var(--setpoint)', shape: 'rect' },
        ]}
      />
    </div>
  );
}

// ---------- Setpoint vs actual ----------
export function SetpointChart({ night, curve }: { night: Night; curve: TemperatureCurve }) {
  const from = night.lightsOut - 100 * MIN;
  const to = night.wake + 40 * MIN;
  const data = useMemo(() => {
    const cmds = [...night.ac].sort((a, b) => a.ts - b.ts);
    return downsample(night.room.filter((r) => r.ts >= from && r.ts <= to), 5 * MIN, 'mean').map((r) => {
      const c = cmds.filter((x) => x.ts <= r.ts).at(-1);
      return { ts: r.ts, temp: r.tempC, set: c?.state.power ? c.state.setpointC : null, target: targetAt(curve, night.lightsOut, r.ts) };
    });
  }, [night, curve, from, to]);
  const missed = night.ac.filter((c) => c.landed === false);
  const temps = data.filter((d) => d.ts >= night.lightsOut).map((d) => d.temp);
  return (
    <>
      <Legend
        items={[
          { label: 'Commanded setpoint', color: 'var(--setpoint)' },
          { label: 'Bed-height °C', color: 'var(--temp)' },
          { label: 'Curve target', color: 'var(--text-2)', shape: 'dash' },
          { label: 'Missed?', color: 'var(--critical)', shape: 'dot' },
        ]}
      />
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={data} margin={MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(from, to)} />
          <YAxis width={Y_WIDTH} domain={[Math.floor(Math.min(16.5, ...temps)), Math.ceil(Math.max(23, ...temps))]} allowDataOverflow allowDecimals={false} unit="°" {...AXIS} />
          <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.filter((x) => typeof x.value === 'number').map((x) => ({ label: String(x.name), value: `${fmt(Number(x.value), 1)} °C`, color: x.stroke ?? x.color, dash: x.dataKey === 'target' }))} />} />
          <Line dataKey="set" name="setpoint" type="stepAfter" stroke="var(--setpoint)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="target" name="target" stroke="var(--text-2)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          <Line dataKey="temp" name="room" stroke="var(--temp)" strokeWidth={2} dot={false} isAnimationActive={false} />
          {missed.map((m) => (
            <ReferenceDot key={m.ts} x={Math.round(m.ts / (5 * MIN)) * 5 * MIN} y={m.state.setpointC} r={5} fill="var(--critical)" stroke="var(--surface)" strokeWidth={2} ifOverflow="extendDomain" />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

// ---------- Outdoor vs indoor ----------
export function OutdoorIndoor({ night }: { night: Night }) {
  const from = night.room[0]?.ts ?? night.lightsOut;
  const to = night.room.at(-1)?.ts ?? night.wake;
  const data = useMemo(() => {
    const room = downsample(night.room, 15 * MIN, 'mean');
    return room.map((r) => {
      const o = night.outdoor.reduce((best, x) => (Math.abs(x.ts - r.ts) < Math.abs(best.ts - r.ts) ? x : best), night.outdoor[0] ?? { ts: 0, tempC: NaN, rh: NaN });
      const near = Math.abs(o.ts - r.ts) <= 45 * MIN;
      return {
        ts: r.ts,
        inT: r.tempC,
        outT: near ? o.tempC : null,
        inDew: dewPointC(r.tempC, r.rh),
        outDew: near ? dewPointC(o.tempC, o.rh) : null,
      };
    });
  }, [night]);
  const chart = (keys: ['outT' | 'outDew', 'inT' | 'inDew'], label: string) => {
    const vs = data.flatMap((d) => [d[keys[0]], d[keys[1]]]).filter((v): v is number => typeof v === 'number');
    const ticks = niceTicks(Math.min(...vs), Math.max(...vs), 4);
    return (
    <ResponsiveContainer width="100%" height={150}>
      <LineChart data={data} margin={MARGIN} syncId="outdoor">
        <CartesianGrid {...GRID} />
        <XAxis {...timeAxis(from, to, 3)} />
        <YAxis width={Y_WIDTH} domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} tickFormatter={(v: number) => `${Math.round(v)}°`} {...AXIS} />
        <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => `${hm(Number(l))} · ${label}`} rows={(pl) => pl.filter((x) => typeof x.value === 'number').map((x) => ({ label: String(x.name), value: `${fmt(Number(x.value), 1)} °C`, color: x.stroke }))} />} />
        <Line dataKey={keys[0]} name="outdoor" stroke="var(--outdoor)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
        <Line dataKey={keys[1]} name="bedroom" stroke="var(--temp)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
    );
  };
  return (
    <>
      <Legend items={[{ label: 'Outdoor (Phuket)', color: 'var(--outdoor)' }, { label: 'Bedroom', color: 'var(--temp)' }]} />
      <div className="small t2" style={{ marginBottom: 2 }}>Air temperature</div>
      {chart(['outT', 'inT'], 'temperature')}
      <div className="small t2" style={{ margin: '8px 0 2px' }}>Dew point (moisture the aircon must remove)</div>
      {chart(['outDew', 'inDew'], 'dew point')}
    </>
  );
}

// ---------- Shower impact (small multiples) ----------
export function ShowerMini({ series, start, end, metric }: { series: { ts: number; v: number }[]; start: number; end: number; metric: 'rh' | 'temp' }) {
  const vs = series.map((p) => p.v);
  const ticks = niceTicks(Math.min(...vs), Math.max(...vs), 3);
  return (
    <ResponsiveContainer width="100%" height={110}>
      <LineChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        <CartesianGrid {...GRID} />
        <ReferenceArea x1={start} x2={end} fill="var(--rh)" fillOpacity={0.1} stroke="none" />
        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} ticks={hourTicks(series[0]?.ts ?? 0, series.at(-1)?.ts ?? 0, 1)} tickFormatter={(v: number) => hm(v)} {...AXIS} />
        <YAxis width={36} domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} tickFormatter={(v: number) => `${Math.round(v)}${metric === 'rh' ? '%' : '°'}`} {...AXIS} />
        <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.map((x) => ({ label: metric === 'rh' ? 'RH' : 'temp', value: metric === 'rh' ? `${fmt(Number(x.value))} %` : `${fmt(Number(x.value), 1)} °C`, color: x.stroke }))} />} />
        <Line dataKey="v" stroke={metric === 'rh' ? 'var(--rh)' : 'var(--temp)'} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------- Room response ----------
export function ResponseScatter({ points }: { points: { outdoor: number; minutes: number; ajar: boolean; date: string }[] }) {
  const closed = points.filter((p) => !p.ajar);
  const ajar = points.filter((p) => p.ajar);
  const tip = (p: { active?: boolean; payload?: readonly { payload?: unknown }[] }) => {
    const d = p.payload?.[0]?.payload as (typeof points)[number] | undefined;
    if (!p.active || !d) return null;
    return (
      <div className="tip">
        <div className="tip-title">{shortDay(d.date)} {shortDate(d.date)}</div>
        <TipRow value={`${Math.round(d.minutes)} min`} label="to cool 1 °C" />
        <TipRow value={`${fmt(d.outdoor, 1)} °C`} label={`outdoor · ${d.ajar ? 'door ajar' : 'closed'}`} />
      </div>
    );
  };
  return (
    <>
      <Legend items={[{ label: 'Door closed', color: 'var(--text-2)', shape: 'dot' }, { label: 'Door ajar', color: 'var(--s4)', shape: 'dot' }]} />
      <ResponsiveContainer width="100%" height={180}>
        <ScatterChart margin={{ ...MARGIN, bottom: 4 }}>
          <CartesianGrid stroke="var(--grid)" />
          <XAxis dataKey="outdoor" type="number" unit="°" domain={['dataMin - 0.5', 'dataMax + 0.5']} tickFormatter={(v: number) => fmt(v, 0)} {...AXIS} />
          <YAxis dataKey="minutes" type="number" width={Y_WIDTH} unit="m" {...AXIS} />
          <ZAxis range={[40, 40]} />
          <Tooltip cursor={false} content={tip} />
          <Scatter data={closed} fill="var(--text-2)" isAnimationActive={false} />
          <Scatter data={ajar} fill="var(--s4)" isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
    </>
  );
}

// ---------- Event timeline ----------
export function EventLanes({ from, to, lanes }: { from: number; to: number; lanes: { label: string; items: { start: number; end?: number; kind: string }[] }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);
  const L = 70;
  const w = Math.max(width, 260);
  const x = (t: number) => L + ((t - from) / (to - from)) * (w - L - 6);
  const rowH = 22;
  const kinds = ['in_bed', 'both_in_bed', 'out_of_bed', 'shower', 'door_open', 'room_empty', 'ac_missed'];
  const names: Record<string, string> = { in_bed: 'In bed', both_in_bed: 'Both in bed', out_of_bed: 'Out of bed', shower: 'Shower', door_open: 'Door', room_empty: 'Empty', ac_missed: 'AC missed' };
  const H = kinds.length * rowH + 20;
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={w} height={H} role="img" aria-label="Event timeline">
          {hourTicks(from, to, 3).map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={0} y2={H - 16} stroke="var(--grid)" />
              <text x={x(t)} y={H - 4} fill="var(--muted)" fontSize={10} textAnchor="middle">{hm(t)}</text>
            </g>
          ))}
          {kinds.map((k, ki) => (
            <g key={k}>
              <text x={0} y={ki * rowH + 14} fill="var(--text-2)" fontSize={10.5}>{names[k]}</text>
              {lanes.map((lane, li) =>
                lane.items
                  .filter((e) => e.kind === k)
                  .map((e, i) => {
                    const y = ki * rowH + 5 + li * 8;
                    const x0 = x(Math.max(from, e.start));
                    const x1 = e.end ? x(Math.min(to, e.end)) : x0;
                    const text = `${lane.label}: ${names[k]} ${hm(e.start)}${e.end ? `–${hm(e.end)}` : ''}`;
                    return (
                      <rect
                        key={`${li}-${i}`}
                        x={x0 - (x1 - x0 < 6 ? 3 : 0)}
                        y={y}
                        width={Math.max(6, x1 - x0)}
                        height={6}
                        rx={3}
                        fill={li === 0 ? 'var(--text)' : 'var(--axis)'}
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
      {hover && (
        <FloatTip x={hover.x} y={-34} width={w}>
          {hover.text}
        </FloatTip>
      )}
      <Legend items={lanes.map((l, i) => ({ label: l.label, color: i === 0 ? 'var(--text)' : 'var(--axis)', shape: 'rect' as const }))} />
    </div>
  );
}
