'use client';
/**
 * Room › Aircon charts (docs/DESIGN.md §7.2): setpoint vs actual, room response, outdoor vs bedroom.
 * Room °C is the ink hero line; the plan is dashed --muted; the aircon setpoint is a thin --temp step; a command that
 * did not land is a signal ring.
 */
import { useMemo } from 'react';
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { dewPointC, downsample, targetAt, type Night, type TemperatureCurve } from '@sleep-lab/core';
import { fmt, hm, MIN, niceTicks, shortDate, shortDay } from '@/lib/format.ts';
import { median } from '@/lib/stats.ts';
import { DrawPath } from '../../motion.tsx';
import { AXIS, GRID, MARGIN, PLAN_LINE, refLabel, REF_FRONT, TipRow, useChartAnim, Y_WIDTH } from '../common.tsx';
import { EndLabels, Marker, seriesPath, stepPath, stepTicks, TimeChart } from './frame.tsx';

/** Clamped scale for the setpoint chart (§7.1: 17–25 °C). Exported so the screen can state an out-of-range start. */
export const SETPOINT_DOMAIN = [17, 25] as const;

// ───────────── Setpoint vs actual ─────────────
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
  const steps = useMemo(() => {
    const cmds = [...night.ac].sort((a, b) => a.ts - b.ts).filter((c) => c.ts <= to);
    return cmds.map((c) => ({ ts: Math.max(from, c.ts), v: c.state.power ? c.state.setpointC : null }));
  }, [night, from, to]);
  const missed = night.ac.filter((c) => c.landed === false);
  const [lo, hi] = SETPOINT_DOMAIN;
  const near = (t: number) => data.reduce((b, d) => (Math.abs(d.ts - t) < Math.abs(b.ts - t) ? d : b), data[0]!);
  if (!data.length) return null;
  const last = data.at(-1)!;
  const lastSet = steps.filter((s) => s.v !== null).at(-1);
  return (
    <TimeChart
      from={from}
      to={to}
      domain={[lo, hi]}
      ticks={stepTicks(18, 24, 2)}
      fmtY={(v) => `${v}°`}
      label={`Room temperature against the plan and the aircon setpoint, ${night.ac.length} commands`}
      endPad={66}
      hover={(t) => {
        const d = near(t);
        return {
          title: hm(d.ts),
          rows: [
            { label: 'room', value: `${fmt(d.temp, 1)}°`, color: 'var(--text)' },
            ...(d.target !== null ? [{ label: 'plan', value: `${fmt(d.target, 1)}°`, color: 'var(--muted)', dash: true }] : []),
            ...(d.set !== null ? [{ label: 'aircon set', value: `${fmt(d.set, 0)}°`, color: 'var(--temp)' }] : [{ label: 'aircon', value: 'off' }]),
          ],
          dots: [{ v: d.temp, color: 'var(--text)' }],
        };
      }}
      overlay={(g) => (
        <EndLabels
          g={g}
          items={[
            { text: 'Room', v: last.temp },
            ...(last.target !== null ? [{ text: 'Plan', v: last.target, tone: 'muted' as const }] : []),
            ...(lastSet?.v != null ? [{ text: 'Aircon set', v: lastSet.v, tone: 'muted' as const }] : []),
          ]}
          gutter
        />
      )}
    >
      {(g) => (
        <>
          <Marker g={g} t={night.lightsOut} text="Lights out" />
          <path d={stepPath(g, steps, to)} fill="none" stroke="var(--text-2)" strokeOpacity={0.55} strokeWidth={1.5} strokeLinejoin="round" />
          <path d={seriesPath(g, data.map((d) => ({ ts: d.ts, v: d.target })))} fill="none" stroke={PLAN_LINE.stroke} strokeDasharray={PLAN_LINE.strokeDasharray} strokeWidth={1.5} />
          <DrawPath d={seriesPath(g, data.map((d) => ({ ts: d.ts, v: d.temp })), 20 * 60_000, true)} fill="none" stroke="var(--text)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {missed.map((m) => (
            <circle key={m.ts} cx={g.x(m.ts)} cy={g.yc(m.state.setpointC)} r={5} fill="var(--bg)" stroke="var(--signal)" strokeWidth={2} />
          ))}
        </>
      )}
    </TimeChart>
  );
}

// ───────────── Outdoor vs indoor ─────────────
export function OutdoorIndoor({ night }: { night: Night }) {
  const from = night.room[0]?.ts ?? night.lightsOut;
  const to = night.room.at(-1)?.ts ?? night.wake;
  const data = useMemo(() => {
    const room = downsample(night.room, 15 * MIN, 'mean');
    return room.map((r) => {
      const o = night.outdoor.reduce((best, x) => (Math.abs(x.ts - r.ts) < Math.abs(best.ts - r.ts) ? x : best), night.outdoor[0] ?? { ts: 0, tempC: NaN, rh: NaN });
      const near = Math.abs(o.ts - r.ts) <= 45 * MIN;
      return { ts: r.ts, inT: r.tempC, outT: near ? o.tempC : null, inDew: dewPointC(r.tempC, r.rh), outDew: near ? dewPointC(o.tempC, o.rh) : null };
    });
  }, [night]);
  const chart = (keys: ['outT' | 'outDew', 'inT' | 'inDew'], what: string) => {
    const vs = data.flatMap((d) => [d[keys[0]], d[keys[1]]]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (!vs.length) return null;
    const ticks = niceTicks(Math.min(...vs), Math.max(...vs), 3);
    const near = (t: number) => data.reduce((b, d) => (Math.abs(d.ts - t) < Math.abs(b.ts - t) ? d : b), data[0]!);
    const lastOut = data.filter((d) => d[keys[0]] !== null).at(-1);
    const lastIn = data.at(-1);
    return (
      <TimeChart
        from={from}
        to={to}
        domain={[ticks[0]!, ticks.at(-1)!]}
        ticks={ticks}
        fmtY={(v) => `${Math.round(v)}°`}
        height={200}
        label={`Outdoor and bedroom ${what}`}
        endPad={76}
        hover={(t) => {
          const d = near(t);
          return {
            title: `${hm(d.ts)} · ${what}`,
            rows: [
              { label: 'outdoor', value: d[keys[0]] !== null ? `${fmt(d[keys[0]], 1)}°` : '–', color: 'var(--outdoor)' },
              { label: 'bedroom', value: `${fmt(d[keys[1]], 1)}°`, color: 'var(--text)' },
            ],
            dots: [
              { v: d[keys[0]] ?? NaN, color: 'var(--outdoor)' },
              { v: d[keys[1]] ?? NaN, color: 'var(--text)' },
            ],
          };
        }}
        overlay={(g) => (
          <EndLabels
            g={g}
            items={[
              ...(lastOut ? [{ text: 'Outdoor', v: lastOut[keys[0]] as number, tone: 'muted' as const }] : []),
              ...(lastIn ? [{ text: 'Bedroom', v: lastIn[keys[1]] as number }] : []),
            ]}
            gutter
          />
        )}
      >
        {(g) => (
          <>
            <path d={seriesPath(g, data.map((d) => ({ ts: d.ts, v: d[keys[0]] })), 2 * 3_600_000)} fill="none" stroke="var(--outdoor)" strokeWidth={1.5} strokeLinejoin="round" />
            <DrawPath d={seriesPath(g, data.map((d) => ({ ts: d.ts, v: d[keys[1]] })), 2 * 3_600_000)} fill="none" stroke="var(--text)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
      </TimeChart>
    );
  };
  return (
    <div className="vstack" style={{ ['--gap' as string]: 'var(--sp-8)' }}>
      <div>
        <h3 className="label">Air temperature</h3>
        {chart(['outT', 'inT'], 'temperature')}
      </div>
      <div>
        <h3 className="label">Dew point, the moisture the aircon removes</h3>
        {chart(['outDew', 'inDew'], 'dew point')}
      </div>
    </div>
  );
}

// ───────────── Room response ─────────────
export function ResponseScatter({ points }: { points: { outdoor: number; minutes: number; ajar: boolean; date: string }[] }) {
  const anim = useChartAnim();
  const closed = points.filter((p) => !p.ajar);
  const ajar = points.filter((p) => p.ajar);
  const med = median(points.map((p) => p.minutes));
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
        <TipRow value={`${Math.round(d.minutes)} min`} label="to cool 1°" />
        <TipRow value={`${fmt(d.outdoor, 1)}°`} label={`outdoor · ${d.ajar ? 'door ajar' : 'door closed'}`} />
      </div>
    );
  };
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ScatterChart margin={{ ...MARGIN, top: 24, bottom: 4 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="outdoor" type="number" domain={xTicks.length ? [xTicks[0]!, xTicks.at(-1)!] : ['dataMin - 0.5', 'dataMax + 0.5']} ticks={xTicks.length ? xTicks : undefined} tickFormatter={(v: number) => `${fmt(v, 0)}° out`} {...AXIS} />
        <YAxis dataKey="minutes" type="number" orientation="right" width={Y_WIDTH + 12} tickFormatter={(v: number) => `${v} min`} {...AXIS} />
        <ZAxis range={[40, 40]} />
        {Number.isFinite(med) && <ReferenceLine {...REF_FRONT} y={med} {...PLAN_LINE} label={refLabel(`Median ${Math.round(med)} min`)} />}
        <Tooltip cursor={false} content={tip} />
        <Scatter data={closed} fill="var(--muted)" {...anim} shape={(sh: { cx?: number; cy?: number }) => <circle cx={sh.cx} cy={sh.cy} r={3.5} fill="var(--muted)" />} />
        <Scatter data={ajar} fill="var(--text)" {...anim} shape={(sh: { cx?: number; cy?: number }) => <circle cx={sh.cx} cy={sh.cy} r={4.5} fill="var(--bg)" stroke="var(--text)" strokeWidth={1.5} />} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
