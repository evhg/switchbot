'use client';
import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { targetAt, type Night, type TemperatureCurve } from '@sleep-lab/core';
import { fmt, hm, MIN } from '@/lib/format.ts';
import { Legend } from '../ui.tsx';
import { AXIS, CURSOR, GRID, MARGIN, Tip, Y_WIDTH } from './common.tsx';

/** Tonight's planned curve over last night's actual temperature and commanded setpoint (minutes from lights-out). */
export function PlanChart({ plan, last, height = 190 }: { plan: TemperatureCurve; last: Night; height?: number }) {
  const data = useMemo(() => {
    const out: { m: number; plan: number | null; actual: number | null; set: number | null }[] = [];
    const lo = last.lightsOut;
    const end = Math.max(540, Math.round((last.wake - lo) / MIN) + 30);
    let ai = 0;
    for (let m = -90; m <= end; m += 5) {
      const t = lo + m * MIN;
      const win = [] as number[];
      while (ai < last.room.length && last.room[ai]!.ts < t + 2.5 * MIN) {
        if (last.room[ai]!.ts >= t - 2.5 * MIN) win.push(last.room[ai]!.tempC);
        ai++;
      }
      const cmd = [...last.ac].reverse().find((c) => c.ts <= t);
      out.push({
        m,
        plan: targetAt(plan, lo, t),
        actual: win.length ? win.reduce((a, b) => a + b, 0) / win.length : null,
        set: cmd && cmd.state.power ? cmd.state.setpointC : null,
      });
    }
    return out;
  }, [plan, last]);
  const label = (m: number) => hm(last.lightsOut + m * MIN);
  return (
    <div>
      <Legend
        items={[
          { label: "Tonight's plan", color: 'var(--text)', shape: 'line' },
          { label: 'Last night actual', color: 'var(--temp)' },
          { label: 'Last night setpoint', color: 'var(--setpoint)', shape: 'dash' },
        ]}
      />
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="m" type="number" domain={['dataMin', 'dataMax']} ticks={data.filter((d) => d.m % 120 === 0).map((d) => d.m)} tickFormatter={label} {...AXIS} />
          <YAxis width={Y_WIDTH} domain={[(d: number) => Math.floor(d - 0.5), (d: number) => Math.min(26, Math.ceil(d + 0.5))]} allowDataOverflow allowDecimals={false} {...AXIS} unit="°" />
          <Tooltip
            cursor={CURSOR}
            content={(p) => (
              <Tip
                {...p}
                title={(l) => `${label(Number(l))} · ${Number(l) >= 0 ? '+' : ''}${fmt(Number(l) / 60, 1)} h`}
                rows={(pl) =>
                  pl
                    .filter((x) => typeof x.value === 'number')
                    .map((x) => ({ label: String(x.name), value: `${fmt(Number(x.value), 1)} °C`, color: x.stroke ?? x.color, dash: x.dataKey === 'set' }))
                }
              />
            )}
          />
          <Line dataKey="set" name="Setpoint" type="stepAfter" stroke="var(--setpoint)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls={false} />
          <Line dataKey="actual" name="Actual" type="monotone" stroke="var(--temp)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="plan" name="Plan" type="linear" stroke="var(--text)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
