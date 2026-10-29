'use client';
/** Room tab, Comfort section: temp × RH scatter, calendar heatmap, 24-hour radial clock. */
import { useMemo, useRef, useState } from 'react';
import { Cell, CartesianGrid, ReferenceArea, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { dewPointC, type Night } from '@sleep-lab/core';
import { co2Band, dur, fmt, hm, ictMinuteOfDay, MIN, shortDate, shortDay, weekdayOf } from '@/lib/format.ts';
import { DrawPath, useInView } from '../../motion.tsx';
import { Legend, useWidth } from '../../ui.tsx';
import { AXIS, GRID, MARGIN, TipRow, useChartAnim, useSvgId, Y_WIDTH } from '../common.tsx';
import s from './room.module.css';

const MONO = 'var(--font-mono)';

// ───────────── Comfort chart ─────────────
const stepTicks = (lo: number, hi: number, step: number) => {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
};

export function ComfortChart({ points }: { points: { tempC: number; rh: number; f: number; ts: number }[] }) {
  const anim = useChartAnim(1100);
  const gid = useSvgId('cf');
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
          <svg width={44} height={8} aria-hidden>
            <defs>
              <linearGradient id={gid}>
                <stop offset="0" stopColor="var(--temp)" stopOpacity={0.2} />
                <stop offset="1" stopColor="var(--temp)" stopOpacity={1} />
              </linearGradient>
            </defs>
            <rect width={44} height={8} rx={4} fill={`url(#${gid})`} />
          </svg>
          lights-out → wake
        </span>
        <span>
          <i className="key-rect" style={{ border: '1.5px dashed var(--good)', background: 'transparent' }} /> comfort 18–22 °C · 45–55 %
        </span>
      </div>
      <ResponsiveContainer width="100%" height={230}>
        <ScatterChart margin={{ ...MARGIN, top: 12, bottom: 6 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="tempC" type="number" name="Temp" domain={[xLo, xHi]} ticks={stepTicks(xLo, xHi, xStep)} interval={0} allowDecimals={false} tickFormatter={(v: number) => `${v}°`} {...AXIS} />
          <YAxis dataKey="rh" type="number" name="RH" width={Y_WIDTH} domain={[yLo, yHi]} ticks={stepTicks(yLo, yHi, yStep)} interval={0} tickFormatter={(v: number) => `${v}%`} {...AXIS} />
          <ZAxis range={[30, 30]} />
          <ReferenceArea
            x1={18}
            x2={22}
            y1={45}
            y2={55}
            fill="var(--good)"
            fillOpacity={0.07}
            stroke="var(--good)"
            strokeOpacity={0.7}
            strokeDasharray="3 4"
            strokeWidth={1}
            radius={6}
            label={{ value: 'COMFORT', position: 'insideTopLeft', fill: 'var(--good-text)', fontSize: 9.5, fontFamily: MONO }}
          />
          <Tooltip
            cursor={false}
            content={(p) => {
              const d = p.payload?.[0]?.payload as { tempC: number; rh: number; ts: number } | undefined;
              if (!p.active || !d) return null;
              return (
                <div className="tip">
                  <div className="tip-title">{hm(d.ts)}</div>
                  <TipRow value={`${fmt(d.tempC, 1)} °C`} label="temp" color="var(--temp)" />
                  <TipRow value={`${fmt(d.rh)} %`} label="RH" color="var(--rh)" />
                  <TipRow value={`${fmt(dewPointC(d.tempC, d.rh), 1)} °C`} label="dew point" color="var(--dew)" />
                </div>
              );
            }}
          />
          <Scatter data={points} {...anim}>
            {points.map((p, i) => (
              <Cell key={i} fill="var(--temp)" fillOpacity={0.18 + 0.82 * p.f} stroke={i === points.length - 1 ? 'var(--text)' : 'none'} strokeWidth={1.5} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </>
  );
}

// ───────────── Calendar heatmap ─────────────
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
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, { threshold: 0.2 });
  const [hover, setHover] = useState<{ date: string; value: number } | null>(null);
  if (!cells.length) return null;
  const first = cells[0]!.date;
  const offset = (weekdayOf(first) + 6) % 7; // Monday-first rows
  const weeks = Math.ceil((offset + cells.length) / 7);
  const gap = 3;
  const left = 20;
  const top = 16;
  const size = Math.max(10, Math.min(26, Math.floor((Math.max(width, 200) - left - gap * weeks) / weeks)));
  const w = left + weeks * (size + gap);
  const h = top + 7 * (size + gap);
  const fill = (v: number) => (v <= 0 ? 'var(--surface-2)' : `color-mix(in oklab, ${color} ${Math.round(22 + 78 * Math.min(1, v / max))}%, var(--surface-2))`);
  const sel = cells.find((c) => c.date === selected);
  const shownCell = hover ?? sel;
  return (
    <div ref={box} className={`chart-box ${seen ? s.heatIn : ''}`}>
      <div ref={ref}>
        {width > 0 && (
          <svg width={w} height={h} role="img" aria-label="Calendar heatmap">
            {['M', '', 'W', '', 'F', '', 'S'].map((d, i) => (
              <text key={i} x={0} y={top + i * (size + gap) + size / 2 + 3} fill="var(--muted)" fontSize={9} fontFamily={MONO}>
                {d}
              </text>
            ))}
            {cells.map((c, i) => {
              const k = offset + i;
              const col = Math.floor(k / 7);
              const row = k % 7;
              const firstOfMonth = c.date.endsWith('-01') || (i === 0 && Number(c.date.slice(8)) < 20);
              const isSel = selected === c.date;
              return (
                <g key={c.date} className={s.cell} style={{ transitionDelay: `${col * 40}ms` }}>
                  {firstOfMonth && (
                    <text x={left + col * (size + gap)} y={9} fill="var(--muted)" fontSize={9} fontFamily={MONO} letterSpacing=".1em">
                      {shortDate(c.date).split(' ')[1]?.toUpperCase()}
                    </text>
                  )}
                  <rect
                    x={left + col * (size + gap)}
                    y={top + row * (size + gap)}
                    width={size}
                    height={size}
                    rx={Math.min(5, size / 4)}
                    fill={fill(c.value)}
                    stroke={isSel ? 'var(--text)' : hover?.date === c.date ? 'var(--text-2)' : 'none'}
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
      </div>
      <div className={s.heatFoot}>
        <span className="t-label t2">{shownCell ? `${shortDay(shownCell.date)} ${shortDate(shownCell.date)} · ${dur(shownCell.value)}` : onPick ? 'Tap a day to open it' : ''}</span>
        <span className={`${s.heatScale} t-micro`}>
          0
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <i key={f} style={{ background: fill(f * max) }} />
          ))}
          {dur(max)}+
        </span>
      </div>
    </div>
  );
}

// ───────────── 24 h radial clock ─────────────
export function RadialClock({ nights }: { nights: Night[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, { threshold: 0.25 });
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
  const rCo2In = rOut - 16;
  const rT1 = rCo2In - 8;
  const rT0 = rT1 - 58;
  const rAc = rT0 - 10;
  const a = (i: number) => (i / B) * 2 * Math.PI - Math.PI / 2; // midnight at top
  const ptA = (ang: number, r: number) => [c + r * Math.cos(ang), c + r * Math.sin(ang)] as const;
  const wedge = (i: number, r0: number, r1: number) => {
    const a0 = a(i) + 0.006;
    const a1 = a(i + 1) - 0.006;
    const [x0, y0] = ptA(a0, r1);
    const [x1, y1] = ptA(a1, r1);
    const [x2, y2] = ptA(a1, r0);
    const [x3, y3] = ptA(a0, r0);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r1},${r1} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)} A${r0},${r0} 0 0 0 ${x3.toFixed(1)},${y3.toFixed(1)}Z`;
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
  for (let i = 0; i < B; i++)
    if (ok(i) && !ok(i - 1)) {
      s0 = i;
      break;
    }
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
    <div ref={box} className={`chart-box ${seen ? s.clockIn : ''}`} style={{ display: 'grid', justifyItems: 'center' }}>
      <div ref={ref} style={{ width: '100%', display: 'grid', justifyItems: 'center' }}>
        {width > 0 && (
          <svg
            width={size}
            height={size}
            role="img"
            aria-label="24-hour clock of average CO2, temperature and aircon use"
            style={{ touchAction: 'pan-y' }}
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
                  <text x={x} y={y + 3.5} textAnchor="middle" fill="var(--muted)" fontSize={9.5} fontFamily={MONO}>
                    {String(h).padStart(2, '0')}
                  </text>
                </g>
              );
            })}
            <circle cx={c} cy={c} r={rT0} fill="none" stroke="var(--grid)" />
            <circle cx={c} cy={c} r={rT1} fill="none" stroke="var(--grid)" />
            <g className={s.wedges}>
              {buckets.map((b, i) =>
                Number.isFinite(b.co2) ? (
                  <path key={i} d={wedge(i, rCo2In, rOut)} fill={`var(--${co2Band(b.co2).key})`} opacity={hover === null ? 0.75 : hover === i ? 1 : 0.45} />
                ) : (
                  <path key={i} d={wedge(i, rCo2In, rOut)} fill="var(--surface-2)" />
                ),
              )}
              {buckets.map((b, i) => (Number.isFinite(b.ac) && b.ac > 0.05 ? <path key={`ac${i}`} d={wedge(i, rAc - 5, rAc)} fill="var(--setpoint)" opacity={0.2 + 0.8 * b.ac} /> : null))}
            </g>
            {tempPath && <DrawPath d={tempPath} fill="none" stroke="var(--temp)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" delay={200} />}
            {hover !== null && <path d={wedge(hover, rAc - 6, rOut)} fill="none" stroke="var(--text)" strokeWidth={1} />}
            <text x={c} y={c - 4} textAnchor="middle" fill="var(--num-color)" fontSize={hb ? 22 : 26} fontWeight={750} letterSpacing="-0.04em" fontFamily="var(--font-num)">
              {hb ? `${String(Math.floor(hover! / 4)).padStart(2, '0')}:${String((hover! % 4) * 15).padStart(2, '0')}` : nights.length}
            </text>
            <text x={c} y={c + 14} textAnchor="middle" fill="var(--muted)" fontSize={9.5} fontFamily={MONO} letterSpacing=".1em">
              {hb ? (Number.isFinite(hb.co2) ? `${fmt(hb.co2)} PPM · ${fmt(hb.temp, 1)}°` : 'NO DATA (DAY)') : 'NIGHTS'}
            </text>
            {hb && Number.isFinite(hb.ac) && (
              <text x={c} y={c + 28} textAnchor="middle" fill="var(--muted)" fontSize={9.5} fontFamily={MONO} letterSpacing=".1em">
                AC ON {Math.round(hb.ac * 100)}% OF NIGHTS
              </text>
            )}
          </svg>
        )}
      </div>
      <Legend
        items={[
          { label: 'CO₂ band (outer)', color: 'var(--serious)', shape: 'rect' },
          { label: `Temp ${tLo}–${tHi} °C`, color: 'var(--temp)' },
          { label: 'AC on (inner)', color: 'var(--setpoint)', shape: 'rect' },
        ]}
      />
    </div>
  );
}
