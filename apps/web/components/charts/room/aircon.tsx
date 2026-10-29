'use client';
/** Room tab, Aircon section: setpoint vs actual, room response scatter, outdoor vs bedroom. */
import { useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { dewPointC, downsample, targetAt, type Night, type TemperatureCurve } from '@sleep-lab/core';
import { fmt, hm, MIN, niceTicks, shortDate, shortDay } from '@/lib/format.ts';
import { median } from '@/lib/stats.ts';
import { Legend } from '../../ui.tsx';
import { AreaGradient, AXIS, CURSOR, GRID, MARGIN, REF_LINE, refLabel, REF_FRONT, STROKE, Tip, TipRow, useChartAnim, useSvgId, Y_WIDTH } from '../common.tsx';
import { timeAxis } from './shared.ts';
import s from './room.module.css';

const ACTIVE = { r: 3.5, stroke: 'var(--surface)', strokeWidth: 2 };

// ───────────── Setpoint vs actual ─────────────
export function SetpointChart({ night, curve }: { night: Night; curve: TemperatureCurve }) {
  const anim = useChartAnim();
  const gid = useSvgId('spt');
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
  // All plotted temps (incl. the warm room before the pre-cool), so the line never leaves the plot.
  const temps = data.map((d) => d.temp).filter(Number.isFinite);
  const lo = Math.floor(Math.min(16.5, ...temps));
  const hi = Math.ceil(Math.max(23, ...temps));
  return (
    <>
      <Legend
        items={[
          { label: 'Setpoint', color: 'var(--setpoint)' },
          { label: 'Bed-height °C', color: 'var(--temp)' },
          { label: 'Curve target', color: 'var(--text-2)', shape: 'dash' },
          ...(missed.length ? [{ label: 'Missed?', color: 'var(--critical)', shape: 'dot' as const }] : []),
        ]}
      />
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart data={data} margin={{ ...MARGIN, top: 12 }}>
          <defs>
            <AreaGradient id={gid} color="var(--temp)" from={0.22} />
          </defs>
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(from, to)} />
          <YAxis width={Y_WIDTH} domain={[lo, hi]} ticks={niceTicks(lo, hi, 4).filter((t) => t >= lo && t <= hi)} allowDataOverflow tickFormatter={(v: number) => `${v}°`} {...AXIS} />
          <ReferenceLine x={night.lightsOut} stroke="var(--hairline-2)" label={{ value: 'LIGHTS OUT', position: 'insideTopLeft', fill: 'var(--muted)', fontSize: 9.5, fontFamily: 'var(--font-mono)', dx: 2 }} />
          <Tooltip
            cursor={CURSOR}
            content={(p) => (
              <Tip
                {...p}
                title={(l) => hm(Number(l))}
                rows={(pl) => pl.filter((x) => typeof x.value === 'number' && x.name !== 'area').map((x) => ({ label: String(x.name), value: `${fmt(Number(x.value), 1)} °C`, color: x.stroke ?? x.color, dash: x.dataKey === 'target' }))}
              />
            )}
          />
          <Area dataKey="temp" name="area" stroke="none" fill={`url(#${gid})`} baseValue={lo} {...anim} activeDot={false} />
          <Line dataKey="target" name="target" stroke="var(--text-2)" strokeOpacity={0.7} strokeDasharray="3 4" strokeWidth={STROKE.secondary} dot={false} {...anim} activeDot={false} />
          <Line dataKey="set" name="setpoint" type="stepAfter" stroke="var(--setpoint)" strokeWidth={STROKE.secondary + 0.3} dot={false} {...anim} activeDot={{ ...ACTIVE, fill: 'var(--setpoint)' }} />
          <Line dataKey="temp" name="room" stroke="var(--temp)" strokeWidth={STROKE.primary} strokeLinecap="round" dot={false} {...anim} activeDot={{ ...ACTIVE, fill: 'var(--temp)' }} />
          {missed.map((m) => (
            <ReferenceDot
              key={m.ts}
              x={Math.round(m.ts / (5 * MIN)) * 5 * MIN}
              y={m.state.setpointC}
              r={5}
              ifOverflow="extendDomain"
              shape={(p: { cx?: number; cy?: number }) => (
                <g>
                  <circle className={s.pulseRing} cx={p.cx} cy={p.cy} r={6} fill="none" stroke="var(--critical)" strokeWidth={1.5} />
                  <circle cx={p.cx} cy={p.cy} r={4.5} fill="var(--critical)" stroke="var(--surface)" strokeWidth={2} />
                </g>
              )}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

// ───────────── Outdoor vs indoor ─────────────
export function OutdoorIndoor({ night }: { night: Night }) {
  const anim = useChartAnim();
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
    const ticks = niceTicks(Math.min(...vs), Math.max(...vs), 3);
    return (
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={data} margin={{ ...MARGIN, top: 6 }} syncId="outdoor">
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(from, to, 3)} />
          <YAxis width={Y_WIDTH} domain={[ticks[0]!, ticks.at(-1)!]} ticks={ticks} tickFormatter={(v: number) => `${Math.round(v)}°`} {...AXIS} />
          <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} title={(l) => `${hm(Number(l))} · ${label}`} rows={(pl) => pl.filter((x) => typeof x.value === 'number').map((x) => ({ label: String(x.name), value: `${fmt(Number(x.value), 1)} °C`, color: x.stroke }))} />} />
          <Line dataKey={keys[0]} name="outdoor" stroke="var(--outdoor)" strokeWidth={STROKE.secondary + 0.3} dot={false} connectNulls {...anim} activeDot={{ ...ACTIVE, fill: 'var(--outdoor)' }} />
          <Line dataKey={keys[1]} name="bedroom" stroke="var(--temp)" strokeWidth={STROKE.primary} dot={false} {...anim} activeDot={{ ...ACTIVE, fill: 'var(--temp)' }} />
        </LineChart>
      </ResponsiveContainer>
    );
  };
  return (
    <>
      <Legend items={[{ label: 'Outdoor (Phuket)', color: 'var(--outdoor)' }, { label: 'Bedroom', color: 'var(--temp)' }]} />
      <div className={`t-micro ${s.subLabel}`}>Air temperature</div>
      {chart(['outT', 'inT'], 'temperature')}
      <div className={`t-micro ${s.subLabel}`} style={{ marginTop: 12 }}>
        Dew point · moisture the aircon removes
      </div>
      {chart(['outDew', 'inDew'], 'dew point')}
    </>
  );
}

// ───────────── Room response ─────────────
export function ResponseScatter({ points }: { points: { outdoor: number; minutes: number; ajar: boolean; date: string }[] }) {
  const anim = useChartAnim();
  const closed = points.filter((p) => !p.ajar);
  const ajar = points.filter((p) => p.ajar);
  const med = median(points.map((p) => p.minutes));
  // Even 1/2/5 steps for the outdoor axis (no "30° 31°" end tick).
  const outs = points.map((p) => p.outdoor).filter(Number.isFinite);
  const xTicks = outs.length ? niceTicks(Math.min(...outs) - 0.3, Math.max(...outs) + 0.3, 4) : [];
  const tip = (p: { active?: boolean; payload?: readonly { payload?: unknown }[] }) => {
    const d = p.payload?.[0]?.payload as (typeof points)[number] | undefined;
    if (!p.active || !d) return null;
    return (
      <div className="tip">
        <div className="tip-title">
          {shortDay(d.date)} {shortDate(d.date)}
        </div>
        <TipRow value={`${Math.round(d.minutes)} min`} label="to cool 1 °C" />
        <TipRow value={`${fmt(d.outdoor, 1)} °C`} label={`outdoor · ${d.ajar ? 'door ajar' : 'closed'}`} />
      </div>
    );
  };
  const dot = (fill: string, r: number) => (sh: { cx?: number; cy?: number }) => <circle cx={sh.cx} cy={sh.cy} r={r} fill={fill} fillOpacity={0.85} stroke="var(--surface)" strokeWidth={1.5} />;
  return (
    <>
      <Legend
        items={[
          { label: 'Door closed', color: 'var(--text-2)', shape: 'dot' },
          { label: 'Door ajar', color: 'var(--s4)', shape: 'dot' },
          { label: 'Median', color: 'var(--text-2)', shape: 'dash' },
        ]}
      />
      <ResponsiveContainer width="100%" height={190}>
        <ScatterChart margin={{ ...MARGIN, top: 12, bottom: 4 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="outdoor" type="number" domain={xTicks.length ? [xTicks[0]!, xTicks.at(-1)!] : ['dataMin - 0.5', 'dataMax + 0.5']} ticks={xTicks.length ? xTicks : undefined} tickFormatter={(v: number) => `${fmt(v, 0)}°`} {...AXIS} />
          <YAxis dataKey="minutes" type="number" width={Y_WIDTH} tickFormatter={(v: number) => `${v}m`} {...AXIS} />
          <ZAxis range={[40, 40]} />
          {Number.isFinite(med) && <ReferenceLine {...REF_FRONT} y={med} {...REF_LINE} label={refLabel(`MEDIAN ${Math.round(med)}M`)} />}
          <Tooltip cursor={false} content={tip} />
          <Scatter data={closed} fill="var(--text-2)" {...anim} shape={dot('var(--text-2)', 3.5)} />
          <Scatter data={ajar} fill="var(--s4)" {...anim} shape={dot('var(--s4)', 4.5)} />
        </ScatterChart>
      </ResponsiveContainer>
    </>
  );
}
