'use client';
// Tonight's planned temperature curve over last night's room (docs/DESIGN.md §7.1, §9.1 scene 7). The plan is the
// one signal line (2 px, drawn in once) with a readout node and its target at each phase start; last night's room is
// a 1.5 px --muted line. Clamped 17–24 °C scale: anything outside is stated in the caption, never drawn off-scale.
// Clock time on the x axis, °C on the right. Hover / touch shows plan, actual and the aircon setpoint at that minute.
import { useMemo, useState } from 'react';
import { targetAt, type Night, type TemperatureCurve } from '@sleep-lab/core';
import { PHASE_LABEL } from '@/lib/curve-store.ts';
import { fmt, hm, hourTicks, MIN } from '@/lib/format.ts';
import { DrawPath } from '../motion.tsx';
import { useWidth } from '../ui.tsx';
import { FloatTip, linePath, scale, TipRow } from './common.tsx';

interface Pt {
  m: number;
  plan: number | null;
  actual: number | null;
  set: number | null;
}

const T_LO = 17;
const T_HI = 24;

export function PlanChart({ plan, last, height }: { plan: TemperatureCurve; last: Night; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const lo = last.lightsOut;
  const startM = Math.min(-30, ...plan.phases.map((p) => p.startMin)) - 15;
  const endM = Math.max(540, Math.round((last.wake - lo) / MIN) + 30);
  const W = Math.max(width, 260);
  const H = height ?? Math.round(Math.max(240, Math.min(340, W * 0.42)));
  const pr = 44;
  const pt = 30;
  const pb = 30;

  const data = useMemo(() => {
    const out: Pt[] = [];
    let ai = 0;
    for (let m = startM; m <= endM; m += 5) {
      const t = lo + m * MIN;
      const win = [] as number[];
      while (ai < last.room.length && last.room[ai]!.ts < t + 2.5 * MIN) {
        if (last.room[ai]!.ts >= t - 2.5 * MIN) win.push(last.room[ai]!.tempC);
        ai++;
      }
      const cmd = [...last.ac].reverse().find((c) => c.ts <= t);
      out.push({ m, plan: targetAt(plan, lo, t), actual: win.length ? win.reduce((a, b) => a + b, 0) / win.length : null, set: cmd && cmd.state.power ? cmd.state.setpointC : null });
    }
    return out;
  }, [plan, last, lo, startM, endM]);

  const geo = useMemo(() => {
    const x = scale(startM, endM, 0, W - pr);
    const y = scale(T_LO, T_HI, H - pb, pt);
    const clampY = (v: number) => y(Math.max(T_LO, Math.min(T_HI, v)));
    const planD = linePath(data.filter((d) => d.plan !== null).map((d) => ({ x: x(d.m), y: clampY(d.plan!) })));
    // Last night's room, only where it was inside the scale (a 29° start is told in the caption instead).
    const actD = linePath(data.map((d) => ({ x: x(d.m), y: d.m < 0 || d.actual === null || d.actual > T_HI || d.actual < T_LO ? NaN : y(d.actual) })), 20);
    let off: number | null = null;
    for (const d of data) if (d.actual !== null && d.actual > T_HI && (off === null || d.actual > off)) off = d.actual;
    const nodes = plan.phases.map((p) => ({ m: p.startMin, c: p.targetC, name: PHASE_LABEL[p.name] ?? p.name, x: x(p.startMin), y: clampY(p.targetC) })).filter((n) => n.x >= 0 && n.x <= W - pr);
    return { x, y, planD, actD, off, nodes };
  }, [data, W, H, startM, endM, plan.phases]);

  const hours = hourTicks(lo + startM * MIN, lo + endM * MIN, W < 560 ? 2 : 1);
  const hp = hover !== null ? data[Math.max(0, Math.min(data.length - 1, Math.round((hover - startM) / 5)))] : undefined;

  return (
    <div>
      <div
        ref={ref}
        className="chart-box"
        style={{ height: H, touchAction: 'pan-y' }}
        role="img"
        aria-label={`${plan.name}: ${plan.phases.map((p) => `${PHASE_LABEL[p.name] ?? p.name} ${fmt(p.targetC, 1)} °C from ${hm(lo + p.startMin * MIN)}`).join(', ')}`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const m = startM + ((e.clientX - r.left) / Math.max(1, W - pr)) * (endM - startM);
          setHover(Math.max(startM, Math.min(endM, m)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {width > 0 && (
          <svg width={W} height={H} aria-hidden style={{ overflow: 'visible' }}>
            {[19, 21, 23].map((v) => (
              <g key={v}>
                <line x1={0} x2={W - pr} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--grid)" />
                <text x={W - pr + 10} y={geo.y(v) + 5}>
                  {v}°
                </text>
              </g>
            ))}
            <path d={geo.actD} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeLinejoin="round" />
            <DrawPath d={geo.planD} fill="none" stroke="var(--signal)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {(() => {
              // A node only where the target changes (a steady curve is one node); labels never collide.
              const changes = geo.nodes.filter((n, i) => i === 0 || Math.abs(n.c - geo.nodes[i - 1]!.c) >= 0.05);
              let lastX = -Infinity;
              return changes.map((n, i) => {
                const label = n.x - lastX >= 48;
                if (label) lastX = n.x;
                return (
                  <g key={n.m} className="fade-late">
                    <circle cx={n.x} cy={n.y} r={4.5} fill="var(--bg)" stroke="var(--signal)" strokeWidth={2} />
                    {label && (
                      <text x={n.x} y={n.y - 12} textAnchor={i === 0 ? 'start' : 'middle'} style={{ fill: 'var(--text)', stroke: 'var(--bg)', strokeWidth: 5, paintOrder: 'stroke', strokeLinejoin: 'round' }}>
                        {fmt(n.c, 1)}°
                      </text>
                    )}
                  </g>
                );
              });
            })()}
            <line x1={0} x2={W - pr} y1={H - pb} y2={H - pb} stroke="var(--axis)" />
            {hours.map((t) => {
              const x = geo.x((t - lo) / MIN);
              if (x < 18 || x > W - pr - 18) return null;
              return (
                <text key={t} x={x} y={H - 8} textAnchor="middle">
                  {hm(t)}
                </text>
              );
            })}
            {hover !== null && <line x1={geo.x(hover)} x2={geo.x(hover)} y1={pt - 8} y2={H - pb} stroke="var(--hairline-2)" />}
          </svg>
        )}
        {hp && hover !== null && (
          <FloatTip x={geo.x(hover)} y={pt} width={W}>
            <div className="tip-title">{hm(lo + hp.m * MIN)}</div>
            {hp.plan !== null && <TipRow color="var(--signal)" value={`${fmt(hp.plan, 1)}°`} label="plan" />}
            {hp.actual !== null && <TipRow color="var(--muted)" value={`${fmt(hp.actual, 1)}°`} label="last night" />}
            {hp.set !== null && <TipRow color="var(--muted)" value={`${fmt(hp.set)}°`} label="aircon set" dash />}
          </FloatTip>
        )}
      </div>
      {geo.off !== null && <p className="cap" style={{ marginTop: 8 }}>Last night’s room is drawn from lights out; before the pre-cool it was {fmt(geo.off, 1)}°, above this 17–24° scale.</p>}
    </div>
  );
}
