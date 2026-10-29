'use client';
/**
 * Room › Comfort charts (docs/DESIGN.md §7): temperature × humidity scatter, the calendar of nights, the 24-hour clock.
 * Greyscale ink for "how much", --signal only for time above a limit. Labels are sentence case at the caption size.
 */
import { useMemo, useRef, useState } from 'react';
import { Cell, CartesianGrid, ReferenceArea, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { dewPointC, type Night } from '@sleep-lab/core';
import { dur, fmt, hm, ictMinuteOfDay, MIN, shortDate, shortDay, weekdayOf } from '@/lib/format.ts';
import { DrawPath, useInView } from '../../motion.tsx';
import { useWidth } from '../../ui.tsx';
import { AXIS, GRID, MARGIN, TipRow, useChartAnim, Y_WIDTH } from '../common.tsx';
import { stepTicks } from './frame.tsx';
import s from './room.module.css';

// ───────────── Comfort chart ─────────────
export function ComfortChart({ points }: { points: { tempC: number; rh: number; f: number; ts: number }[] }) {
  const anim = useChartAnim(1100);
  const temps = points.map((p) => p.tempC).filter(Number.isFinite);
  const rhs = points.map((p) => p.rh).filter(Number.isFinite);
  const xStep = (temps.length ? Math.max(...temps, 22) - Math.min(...temps, 18) : 4) > 7 ? 2 : 1;
  const xLo = Math.floor((Math.min(18, ...temps) - 0.5) / xStep) * xStep;
  const xHi = Math.ceil((Math.max(22, ...temps) + 0.5) / xStep) * xStep;
  const yStep = (rhs.length ? Math.max(...rhs, 60) - Math.min(...rhs, 40) : 20) > 30 ? 10 : 5;
  const yLo = Math.floor(Math.min(40, ...rhs) / yStep) * yStep;
  const yHi = Math.ceil(Math.max(60, ...rhs) / yStep) * yStep;
  return (
    <ResponsiveContainer width="100%" height={320}>
      <ScatterChart margin={{ ...MARGIN, top: 16, bottom: 6 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="tempC" type="number" name="Temp" domain={[xLo, xHi]} ticks={stepTicks(xLo, xHi, xStep)} interval={0} allowDecimals={false} tickFormatter={(v: number) => `${v}°`} {...AXIS} />
        <YAxis dataKey="rh" type="number" name="RH" orientation="right" width={Y_WIDTH} domain={[yLo, yHi]} ticks={stepTicks(yLo, yHi, yStep)} interval={0} tickFormatter={(v: number) => `${v}%`} {...AXIS} />
        <ZAxis range={[34, 34]} />
        <ReferenceArea
          x1={18}
          x2={22}
          y1={45}
          y2={55}
          fill="var(--text)"
          fillOpacity={0.04}
          stroke="var(--muted)"
          strokeDasharray="4 4"
          strokeWidth={1}
          label={{ value: 'Comfort zone', position: 'insideTopLeft', fill: 'var(--text-2)', fontSize: 13, fontFamily: 'var(--font)' }}
        />
        <Tooltip
          cursor={false}
          content={(p) => {
            const d = p.payload?.[0]?.payload as { tempC: number; rh: number; ts: number } | undefined;
            if (!p.active || !d) return null;
            return (
              <div className="tip">
                <div className="tip-title">{hm(d.ts)}</div>
                <TipRow value={`${fmt(d.tempC, 1)}°`} label="room" />
                <TipRow value={`${fmt(d.rh)}%`} label="humidity" />
                <TipRow value={`${fmt(dewPointC(d.tempC, d.rh), 1)}°`} label="dew point" />
              </div>
            );
          }}
        />
        <Scatter data={points} {...anim}>
          {points.map((p, i) => (
            <Cell key={i} fill="var(--text)" fillOpacity={0.12 + 0.78 * p.f} stroke={i === points.length - 1 ? 'var(--text)' : 'none'} strokeWidth={1.5} />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

// ───────────── Calendar heatmap ─────────────
/** One square per night, Monday-first columns. Intensity of `color` (ink, or signal for minutes over a limit). */
export function CalendarHeatmap({
  cells,
  color,
  max,
  unit,
  onPick,
  selected,
  label,
}: {
  cells: { date: string; value: number }[];
  color: string;
  max: number;
  unit: string;
  onPick?: (date: string) => void;
  selected?: string | null;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, { threshold: 0.2 });
  const [hover, setHover] = useState<{ date: string; value: number } | null>(null);
  if (!cells.length) return null;
  const first = cells[0]!.date;
  const offset = (weekdayOf(first) + 6) % 7;
  const weeks = Math.ceil((offset + cells.length) / 7);
  const gap = 4;
  const left = 28;
  const top = 26;
  const size = Math.max(14, Math.min(36, Math.floor((Math.max(width, 240) - left - gap * weeks) / weeks)));
  const w = left + weeks * (size + gap);
  const h = top + 7 * (size + gap);
  const fill = (v: number) => (v <= 0 ? 'var(--surface-2)' : `color-mix(in srgb, ${color} ${Math.round(16 + 64 * Math.min(1, v / max))}%, var(--surface-2))`);
  const sel = cells.find((c) => c.date === selected);
  const shown = hover ?? sel;
  return (
    <div ref={box} className={`${s.chart} ${seen ? s.heatIn : ''}`}>
      <div ref={ref}>
        {width > 0 && (
          <svg width={w} height={h} role="img" aria-label={label}>
            {['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map((d, i) => (
              <text key={i} x={0} y={top + i * (size + gap) + size / 2 + 5} className={s.tick}>
                {d.slice(0, 1)}
              </text>
            ))}
            {cells.map((c, i) => {
              const k = offset + i;
              const col = Math.floor(k / 7);
              const row = k % 7;
              const firstOfMonth = c.date.endsWith('-01') || (i === 0 && Number(c.date.slice(8)) < 22);
              const isSel = selected === c.date;
              return (
                <g key={c.date} className={s.cell} style={{ transitionDelay: `${col * 30}ms` }}>
                  {firstOfMonth && (
                    <text x={left + col * (size + gap)} y={14} className={s.tick}>
                      {shortDate(c.date).split(' ')[1]}
                    </text>
                  )}
                  <rect
                    x={left + col * (size + gap)}
                    y={top + row * (size + gap)}
                    width={size}
                    height={size}
                    rx={Math.min(4, size / 4)}
                    fill={fill(c.value)}
                    stroke={isSel ? 'var(--text)' : hover?.date === c.date ? 'var(--text-2)' : 'none'}
                    strokeWidth={2}
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
        <span className="sec">{shown ? `${shortDay(shown.date)} ${shortDate(shown.date)} · ${dur(shown.value)}` : onPick ? 'Tap a night to open it' : ''}</span>
        <span className={`${s.heatScale} cap`}>
          None
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <i key={f} style={{ background: fill(f * max) }} />
          ))}
          {dur(max)} or more
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
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
    return Array.from({ length: B }, (_, i) => ({ co2: mean(co2[i]!), temp: mean(temp[i]!), ac: ac[i]![1]! ? ac[i]![0]! / ac[i]![1]! : NaN }));
  }, [nights]);
  const size = Math.min(440, Math.max(280, width));
  const c = size / 2;
  const rOut = c - 30;
  const rCo2In = rOut - 18;
  const rT1 = rCo2In - 10;
  const rT0 = rT1 - size * 0.2;
  const rAc = rT0 - 12;
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
  // CO₂ ring: greyscale by level, signal above 1,000 ppm.
  const co2Fill = (v: number) => (v >= 1000 ? 'var(--signal)' : `color-mix(in srgb, var(--text) ${Math.round(12 + 60 * Math.max(0, Math.min(1, (v - 450) / 550)))}%, var(--surface-2))`);
  const hb = hover !== null ? buckets[hover] : undefined;
  return (
    <div ref={box} className={`${s.chart} ${seen ? s.clockIn : ''}`}>
      <div ref={ref} style={{ width: '100%', display: 'grid', justifyItems: 'center' }}>
        {width > 0 && (
          <svg
            width={size}
            height={size}
            role="img"
            aria-label="24-hour clock of average CO₂, temperature and aircon use"
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
              const [x, y] = ptA(a(h * 4), rOut + 18);
              const [x0, y0] = ptA(a(h * 4), rAc - 4);
              const [x1, y1] = ptA(a(h * 4), rOut);
              return (
                <g key={h}>
                  <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--grid)" />
                  <text x={x} y={y + 5} textAnchor="middle" className={s.tick}>
                    {String(h).padStart(2, '0')}
                  </text>
                </g>
              );
            })}
            <circle cx={c} cy={c} r={rT0} fill="none" stroke="var(--grid)" />
            <circle cx={c} cy={c} r={rT1} fill="none" stroke="var(--grid)" />
            <g className={s.wedges}>
              {buckets.map((b, i) => (
                <path key={i} d={wedge(i, rCo2In, rOut)} fill={Number.isFinite(b.co2) ? co2Fill(b.co2) : 'var(--surface-2)'} opacity={hover === null || hover === i ? 1 : 0.55} />
              ))}
              {buckets.map((b, i) => (Number.isFinite(b.ac) && b.ac > 0.05 ? <path key={`ac${i}`} d={wedge(i, rAc - 5, rAc)} fill="var(--muted)" opacity={0.25 + 0.75 * b.ac} /> : null))}
            </g>
            {tempPath && <DrawPath d={tempPath} fill="none" stroke="var(--temp)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" delay={200} />}
            {hover !== null && <path d={wedge(hover, rAc - 6, rOut)} fill="none" stroke="var(--text)" strokeWidth={1} />}
            <text x={c} y={c + 2} textAnchor="middle" className={s.clockNum}>
              {hb ? `${String(Math.floor(hover! / 4)).padStart(2, '0')}:${String((hover! % 4) * 15).padStart(2, '0')}` : nights.length}
            </text>
            <text x={c} y={c + 24} textAnchor="middle" className={s.tick}>
              {hb ? (Number.isFinite(hb.co2) ? `${fmt(hb.co2)} ppm · ${fmt(hb.temp, 1)}°` : 'No data (daytime)') : 'nights'}
            </text>
            {hb && Number.isFinite(hb.ac) && (
              <text x={c} y={c + 46} textAnchor="middle" className={s.tick}>
                Aircon on {Math.round(hb.ac * 100)}% of nights
              </text>
            )}
          </svg>
        )}
      </div>
      <p className="cap" style={{ textAlign: 'center', marginTop: 'var(--sp-3)' }}>
        Outer ring: CO₂, the stronger the shade the staler the air, in the signal colour above 1,000 ppm. Line: room temperature, {tLo}–{tHi}°. Inner ring: aircon on.
      </p>
    </div>
  );
}
