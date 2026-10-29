'use client';
// Scene 2 · Before bed (docs/DESIGN.md §9.1). When the pre-cool started (a reading), what it achieved (one
// sentence), the room temperature against the plan (dashed) drawn in once, and the events up to lights out.
import { useMemo } from 'react';
import { targetAt } from '@sleep-lab/core';
import { fmt, hm, MIN } from '@/lib/format.ts';
import { linePath, scale } from '../charts/common.tsx';
import { DrawPath, Reveal } from '../motion.tsx';
import { EventList, useWidth } from '../ui.tsx';
import { Scene, SceneCols, SceneText, VisHead } from './parts.tsx';
import { valueAt, type StoryModel } from './model.ts';
import s from './story.module.css';

const deg = (v: number) => `${fmt(v, 1)}°`;

function PrecoolChart({ model, a, b }: { model: StoryModel; a: number; b: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(width, 240);
  const H = Math.round(Math.max(220, Math.min(340, W * 0.42)));
  const pr = 44;
  const pt = 14;
  const pb = 30;
  const geo = useMemo(() => {
    const pts: { t: number; v: number }[] = [];
    for (let t = a; t <= b; t += MIN) pts.push({ t, v: valueAt(model.series, 'temp', t) });
    const plan: { t: number; v: number }[] = [];
    for (let t = a; t <= b; t += 2 * MIN) {
      const v = targetAt(model.curve, model.lo, t);
      if (v !== null) plan.push({ t, v });
    }
    const vs = [...pts.map((p) => p.v), ...plan.map((p) => p.v)].filter(Number.isFinite);
    const lo = Math.floor(Math.min(...vs) - 0.5);
    const hi = Math.ceil(Math.max(...vs) + 0.5);
    const x = scale(a, b, 0, W - pr);
    const y = scale(lo, hi, H - pb, pt);
    const step = hi - lo > 8 ? 4 : hi - lo > 4 ? 2 : 1;
    const ticks: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
    const hours: number[] = [];
    const firstHalf = Math.ceil(a / (30 * MIN)) * 30 * MIN;
    for (let t = firstHalf; t <= b; t += 30 * MIN) hours.push(t);
    return {
      x,
      y,
      ticks,
      hours: W < 520 ? hours.filter((_, i) => i % 2 === 0) : hours,
      // No pixel gap limit: on wide screens 2-minute steps are wider than any fixed gap (missing data is NaN already).
      line: linePath(pts.map((p) => ({ x: x(p.t), y: Number.isFinite(p.v) ? y(p.v) : NaN }))),
      plan: linePath(plan.map((p) => ({ x: x(p.t), y: y(p.v) }))),
    };
  }, [model, a, b, W, H]);
  const marks = model.precool.facts.map((f) => f.t).filter((t) => t >= a && t <= b);
  const loX = geo.x(model.lo);
  const endV = valueAt(model.series, 'temp', model.lo);
  return (
    <div ref={ref} className={s.chart} style={{ height: H }} role="img" aria-label={`Room temperature from ${hm(a)} to ${hm(b)}: ${deg(model.precool.startTemp)} at the start, ${deg(model.precool.endTemp)} at lights out`}>
      {width > 0 && (
        <svg width={W} height={H} aria-hidden>
          {geo.ticks.map((v) => (
            <g key={v}>
              <line x1={0} x2={W - pr} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--grid)" />
              <text x={W - pr + 10} y={geo.y(v) + 5} className={s.tick}>
                {v}°
              </text>
            </g>
          ))}
          {marks.map((t, i) => (
            <line key={i} x1={geo.x(t)} x2={geo.x(t)} y1={pt} y2={H - pb} stroke="var(--hairline)" />
          ))}
          <line x1={loX} x2={loX} y1={pt - 8} y2={H - pb} stroke="var(--axis)" strokeDasharray="2 3" />
          <text x={loX - 6} y={pt - 1} textAnchor="end" className={s.tick}>
            Lights out
          </text>
          <path d={geo.plan} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 4" />
          <DrawPath d={geo.line} fill="none" stroke="var(--text)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {Number.isFinite(endV) && <circle className="fade-late" cx={loX} cy={geo.y(endV)} r={4.5} fill="var(--bg)" stroke="var(--text)" strokeWidth={2} />}
          <line x1={0} x2={W - pr} y1={H - pb} y2={H - pb} stroke="var(--axis)" />
          {geo.hours.map((t) => (
            <text key={t} x={geo.x(t)} y={H - 8} textAnchor="middle" className={s.tick}>
              {hm(t)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

export function LightsOut({ model }: { model: StoryModel }) {
  const { start, startTemp, endTemp, target, facts } = model.precool;
  const cooled = facts.find((f) => /^Cooled/.test(f.text));
  const ready = cooled && /before bed/.test(cooled.sub);
  const minsBefore = Math.round((model.lo - start) / MIN);
  const title = !cooled ? 'The room was still warm at lights out.' : ready ? 'The room was cool before you were in bed.' : 'The room was cool just after lights out.';
  const drop = Number.isFinite(startTemp) && Number.isFinite(endTemp) ? startTemp - endTemp : NaN;
  const lede = [
    minsBefore > 0 ? `The aircon started ${minsBefore} minutes before lights out${target !== null ? `, aiming for ${deg(target)}` : ''}.` : 'There was no pre-cool before lights out.',
    Number.isFinite(drop) ? `The room went from ${deg(startTemp)} to ${deg(endTemp)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const a = start - 15 * MIN;
  const b = model.lo + 20 * MIN;
  const items = facts.map((f) => ({ time: f.lead, title: f.text.replace('Cooled −', 'Cooled '), detail: f.sub }));
  if (!facts.some((f) => Math.abs(f.t - model.lo) < 2 * MIN))
    items.push({ time: hm(model.lo), title: 'Lights out', detail: Number.isFinite(endTemp) ? `room ${deg(endTemp)}` : '' });
  return (
    <Scene id="before" title="Before bed">
      <SceneCols text={<SceneText label="Before bed" reading={facts[0]?.lead ?? hm(start)} readingCap={minsBefore > 0 ? 'Aircon on for the pre-cool' : 'Lights out'} title={title} lede={lede} />}>
        <Reveal>
          <VisHead
            title={cooled ? cooled.text.replace('−', '') + (ready ? ', ready before bed' : '') : `Room temperature, ${hm(a)} – ${hm(b)}`}
            cap={`Room temperature, ${hm(a)} – ${hm(b)}${target !== null ? ` · plan ${deg(target)} dashed` : ''}`}
          />
          <PrecoolChart model={model} a={a} b={b} />
        </Reveal>
        <Reveal delay={120}>
          <EventList items={items} className={s.events} />
        </Reveal>
      </SceneCols>
    </Scene>
  );
}
