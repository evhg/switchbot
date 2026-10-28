'use client';
import { useMemo, useState } from 'react';
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, LineChart, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HrSample, Night, Spo2Sample, StageSegment } from '@sleep-lab/core';
import { fmt, hm, hourTicks, MIN, niceTicks, shortDate, shortDay } from '@/lib/format.ts';
import { median, rollingBand } from '@/lib/stats.ts';
import { Legend, useWidth } from '../ui.tsx';
import { AXIS, CURSOR, FloatTip, GRID, linePath, MARGIN, scale, Tip, TipRow, Y_WIDTH } from './common.tsx';
import { stageColor } from './NightStrip.tsx';

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

// ---------- 4.1 sleeping HR with nadir ----------
export function HrCurve({ hr, start, end, nadir, nadirAt, baseline, color }: { hr: HrSample[]; start: number; end: number; nadir: number; nadirAt: number; baseline: number; color: string }) {
  const data = useMemo(() => hrMedian(hr.filter((h) => h.ts >= start && h.ts <= end), 5), [hr, start, end]);
  const vs = data.map((d) => d.bpm);
  const ticks = niceTicks(Math.min(...vs, baseline) - 2, Math.max(...vs) + 2, 4);
  return (
    <>
      <Legend items={[{ label: 'Heart rate (5-min median)', color }, { label: '30-night nadir baseline', color: 'var(--text-2)', shape: 'dash' }, { label: 'Nadir', color, shape: 'dot' }]} />
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis {...timeX(start, end)} />
          <YAxis width={Y_WIDTH} domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} {...AXIS} />
          {Number.isFinite(baseline) && <ReferenceLine y={baseline} stroke="var(--text-2)" strokeDasharray="4 3" />}
          <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.map((x) => ({ label: 'bpm', value: fmt(Number(x.value)), color }))} />} />
          <Line dataKey="bpm" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
          {Number.isFinite(nadir) && (
            <ReferenceDot
              x={nadirAt}
              y={nadir}
              r={5}
              fill={color}
              stroke="var(--surface)"
              strokeWidth={2}
              label={{ value: `${fmt(nadir)} bpm · ${hm(nadirAt)}`, position: 'bottom', fill: 'var(--text)', fontSize: 11, offset: 8 }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

// ---------- 4.2 ridgeline ----------
export function Ridgeline({ nights, personId, color, selected, onPick }: { nights: Night[]; personId: string; color: string; selected: string; onPick: (d: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
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
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={w} height={H} role="img" aria-label="Ridgeline of nightly heart-rate curves">
          {[0, 120, 240, 360, 480].map((m) => (
            <g key={m}>
              <line x1={x(m)} x2={x(m)} y1={0} y2={H - 16} stroke="var(--grid)" />
              <text x={x(m)} y={H - 4} textAnchor="middle" fill="var(--muted)" fontSize={10}>
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
              <g key={r.date} onClick={() => onPick(r.date)} style={{ cursor: 'pointer' }}>
                <path d={area} fill="var(--surface)" />
                <path d={area} fill={color} fillOpacity={sel ? 0.28 : 0.1} />
                <path d={linePath(pts)} fill="none" stroke={color} strokeWidth={sel ? 2 : 1.25} strokeOpacity={sel ? 1 : 0.75} />
                {r.nadir && <circle cx={x(r.nadir.m)} cy={base - yv(r.nadir.bpm)} r={2.5} fill="var(--text)" />}
                <text x={0} y={base - 2} fill={sel ? 'var(--text)' : 'var(--muted)'} fontSize={10} fontWeight={sel ? 600 : 400}>
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
                    setHover({ x: px, y: base - step - 40, date: r.date, bpm: near.bpm, min: near.m });
                  }}
                  onPointerLeave={() => setHover(null)}
                />
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
          <TipRow color={color} value={`${fmt(hover.bpm)} bpm`} label="10-min median" />
        </FloatTip>
      )}
    </div>
  );
}

// ---------- 4.3 HRV through the night ----------
export function HrvNight({ hrv, start, end, band, color }: { hrv: { ts: number; rmssdMs: number }[]; start: number; end: number; band: { mean: number; lo: number; hi: number }; color: string }) {
  const data = hrv.filter((h) => h.ts >= start && h.ts <= end).map((h) => ({ ts: h.ts, rmssd: h.rmssdMs }));
  const vs = data.map((d) => d.rmssd);
  const ticks = niceTicks(Math.min(...vs, band.lo || Infinity) - 3, Math.max(...vs, band.hi || -Infinity) + 3, 4);
  return (
    <>
      <Legend
        items={[
          { label: 'RMSSD (5-min windows)', color },
          { label: '30-night mean ±1 SD', color: 'var(--text-2)', shape: 'rect' },
        ]}
      />
      <ResponsiveContainer width="100%" height={170}>
        <LineChart data={data} margin={MARGIN}>
          <CartesianGrid {...GRID} />
          {Number.isFinite(band.lo) && <ReferenceArea y1={band.lo} y2={band.hi} fill="var(--text-2)" fillOpacity={0.1} stroke="none" />}
          {Number.isFinite(band.mean) && <ReferenceLine y={band.mean} stroke="var(--text-2)" strokeDasharray="4 3" />}
          <XAxis {...timeX(start, end)} />
          <YAxis width={Y_WIDTH} domain={[Math.max(0, ticks[0]!), ticks.at(-1)!]} ticks={ticks.filter((t) => t >= 0)} unit="" {...AXIS} />
          <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.map((x) => ({ label: 'ms RMSSD', value: fmt(Number(x.value), 1), color }))} />} />
          <Line dataKey="rmssd" stroke={color} strokeWidth={1.75} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
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

export function Spo2Strip({ spo2, start, end, color }: { spo2: Spo2Sample[]; start: number; end: number; color: string }) {
  const data = useMemo(() => {
    const s = spo2.filter((x) => x.ts >= start && x.ts <= end);
    const by = new Map<number, number[]>();
    for (const x of s) {
      const k = Math.floor(x.ts / (2 * MIN)) * 2 * MIN;
      by.set(k, [...(by.get(k) ?? []), x.pct]);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([ts, v]) => ({ ts, pct: Math.min(...v) }));
  }, [spo2, start, end]);
  const dips = useMemo(() => spo2Dips(spo2.filter((x) => x.ts >= start && x.ts <= end)), [spo2, start, end]);
  return (
    <>
      <Legend items={[{ label: 'SpO₂ (2-min min)', color }, { label: `Dips ≥3 % (${dips.length})`, color: 'var(--critical)', shape: 'dot' }]} />
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={data} margin={MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis {...timeX(start, end)} />
          <YAxis width={Y_WIDTH + 8} domain={[88, 100]} ticks={[88, 92, 96, 100]} allowDataOverflow unit="%" {...AXIS} />
          <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => hm(Number(l))} rows={(pl) => pl.map((x) => ({ label: 'SpO₂', value: `${fmt(Number(x.value))} %`, color }))} />} />
          <Line dataKey="pct" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          {dips.map((d) => {
            const bx = Math.floor(d.ts / (2 * MIN)) * 2 * MIN;
            const by = data.find((p) => p.ts === bx)?.pct ?? d.pct;
            return <ReferenceDot key={d.ts} x={bx} y={Math.max(88, by)} r={4} fill="var(--critical)" stroke="var(--surface)" strokeWidth={2} />;
          })}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

// ---------- 4.6 temperature deviation vs room temperature ----------
export function TempDeviation({ rows }: { rows: { date: string; dev: number | null; room: number }[] }) {
  const data = rows.map((r) => ({ ...r, ts: Date.parse(`${r.date}T00:00:00Z`) }));
  const roomVals = data.map((d) => d.room).filter(Number.isFinite);
  const rt = niceTicks(Math.min(...roomVals), Math.max(...roomVals), 3);
  const devMax = Math.max(0.2, ...data.map((d) => Math.abs(d.dev ?? 0)));
  const dt = niceTicks(-devMax, devMax, 4);
  const tick = (v: number) => shortDate(new Date(v).toISOString().slice(0, 10));
  const tip = (unit: string, digits: number) => (p: { active?: boolean; payload?: readonly { value?: unknown; payload?: unknown }[]; label?: unknown }) => {
    const d = p.payload?.[0]?.payload as { date: string; dev: number | null; room: number } | undefined;
    if (!p.active || !d) return null;
    return (
      <div className="tip">
        <div className="tip-title">{shortDay(d.date)} {shortDate(d.date)}</div>
        <TipRow value={`${d.dev !== null && d.dev > 0 ? '+' : ''}${fmt(d.dev ?? NaN, 2)} °C`} label="skin temp vs baseline" />
        <TipRow color="var(--temp)" value={`${fmt(d.room, digits)} ${unit}`} label="room mean" />
      </div>
    );
  };
  return (
    <>
      <div className="small t2">Skin temperature deviation (°C vs 30-night baseline)</div>
      <ResponsiveContainer width="100%" height={110}>
        <ComposedChart data={data} margin={MARGIN} syncId="tdev">
          <CartesianGrid {...GRID} />
          <XAxis dataKey="ts" type="number" domain={['dataMin - 43200000', 'dataMax + 43200000']} tickFormatter={tick} minTickGap={40} {...AXIS} />
          <YAxis width={Y_WIDTH} domain={[dt[0]!, dt.at(-1)!]} ticks={dt} {...AXIS} />
          <ReferenceLine y={0} stroke="var(--axis)" />
          <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={tip('°C', 1)} />
          <Bar dataKey="dev" isAnimationActive={false} maxBarSize={8} radius={[2, 2, 2, 2]}>
            {data.map((d) => (
              <Cell key={d.date} fill={(d.dev ?? 0) >= 0 ? 'var(--div-neg)' : 'var(--div-pos)'} />
            ))}
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>
      <div className="small t2" style={{ marginTop: 6 }}>Room mean temperature, lights-out → wake (°C)</div>
      <ResponsiveContainer width="100%" height={100}>
        <LineChart data={data} margin={MARGIN} syncId="tdev">
          <CartesianGrid {...GRID} />
          <XAxis dataKey="ts" type="number" domain={['dataMin - 43200000', 'dataMax + 43200000']} tickFormatter={tick} minTickGap={40} {...AXIS} />
          <YAxis width={Y_WIDTH} domain={[rt[0]!, rt.at(-1)!]} ticks={rt} {...AXIS} />
          <Tooltip cursor={CURSOR} content={tip('°C', 1)} />
          <Line dataKey="room" stroke="var(--temp)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

// ---------- 4.7 our HR-based sleep/wake vs Google stages ----------
export function SleepWakeCompare({ stages, ours, start, end }: { stages: StageSegment[]; ours: { start: number; end: number; awake: boolean }[]; start: number; end: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const L = 64;
  const w = Math.max(260, width);
  const x = scale(start, end, L, w - 6);
  const lane = (y: number, segs: { start: number; end: number; fill: string }[]) =>
    segs.map((s, i) => <rect key={i} x={x(Math.max(start, s.start))} y={y} width={Math.max(0.5, x(Math.min(end, s.end)) - x(Math.max(start, s.start)) - 0.5)} height={14} fill={s.fill} />);
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={w} height={74} role="img" aria-label="Google stages versus our heart-rate sleep/wake estimate">
          <text x={0} y={15} fill="var(--text-2)" fontSize={11}>Google</text>
          <text x={0} y={39} fill="var(--text-2)" fontSize={11}>Ours (HR)</text>
          {lane(4, stages.map((s) => ({ start: s.start, end: s.end, fill: stageColor(s.stage) })))}
          {lane(28, ours.map((s) => ({ start: s.start, end: s.end, fill: s.awake ? 'var(--stage-awake)' : 'var(--stage-light)' })))}
          {hourTicks(start, end, 2).map((t) => (
            <text key={t} x={x(t)} y={66} textAnchor="middle" fill="var(--muted)" fontSize={10}>
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
export function TrendBand({ rows: all, show, color, unit, digits = 0, label }: { rows: { date: string; v: number }[]; show: number; color: string; unit: string; digits?: number; label: string }) {
  // Band from the full history so the first visible nights have a baseline too.
  const fullBand = rollingBand(all.map((r) => r.v), 30, 5);
  const rows = all.slice(-show);
  const band = fullBand.slice(-show);
  const data = rows.map((r, i) => ({ ts: Date.parse(`${r.date}T00:00:00Z`), date: r.date, v: Number.isFinite(r.v) ? r.v : null, band: Number.isFinite(band[i]!.lo) ? ([band[i]!.lo, band[i]!.hi] as [number, number]) : null, mean: Number.isFinite(band[i]!.mean) ? band[i]!.mean : null }));
  const vs = data.flatMap((d) => [d.v ?? NaN, ...(d.band ?? [])]).filter(Number.isFinite);
  const ticks = niceTicks(Math.min(...vs), Math.max(...vs), 3);
  const last = data.filter((d) => d.v !== null).at(-1);
  return (
    <div>
      <div className="row between small">
        <span className="t2">{label}</span>
        <b className="num">
          {fmt(last?.v ?? NaN, digits)} {unit}
        </b>
      </div>
      <ResponsiveContainer width="100%" height={110}>
        <ComposedChart data={data} margin={MARGIN}>
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
                  <div className="tip-title">{shortDay(d.date)} {shortDate(d.date)}</div>
                  <TipRow color={color} value={`${fmt(d.v ?? NaN, digits)} ${unit}`} label={label} />
                  {d.band && <TipRow value={`${fmt(d.band[0], digits)}–${fmt(d.band[1], digits)}`} label="baseline ±1 SD" />}
                </div>
              );
            }}
          />
          <Area dataKey="band" stroke="none" fill="var(--text-2)" fillOpacity={0.12} isAnimationActive={false} connectNulls />
          <Line dataKey="v" stroke={color} strokeWidth={2} dot={data.length <= 31 ? { r: 2.5, fill: color, strokeWidth: 0 } : false} isAnimationActive={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

