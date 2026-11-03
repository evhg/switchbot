'use client';
/**
 * Night sounds on a time axis (Today › Snoring & noise, the Live tab's last hour). Custom SVG, house rules
 * (docs/DESIGN.md §7, components/charts/common.tsx): the title is the finding (the caller's VisHead), no legend,
 * tracks labelled on the chart, ≤ 2 hues + --signal.
 *
 *   Loudness   the minute's average level as a --muted line over a 6 % wash, its quietest 10 % dotted (the floor)
 *   Snoring    one ink bar per minute, height = seconds of that minute classified as snoring (0 … 60)
 *   Moments    loud moments and coughs as short ticks under the snore track
 *   Sleep      optional hypnograms (HypnoBlocks) under it, on the same axis, in each person's colour
 *   Wake-ups   optional vertical marks for Cath's awakenings: --signal when noise came just before, --muted otherwise
 *
 * Touch or hover reads a minute (time, loudness, snoring).
 */
import { useMemo, useState } from 'react';
import type { SleepStage } from '@sleep-lab/core';
import { hm, hourTicks, MIN } from '@/lib/format.ts';
import { dbText, SNORE_MIN_S, type SoundEvent, type SoundMinute } from '@/lib/sound.ts';
import { HypnoBlocks, personScope } from '../story/parts.tsx';
import { useWidth } from '../ui.tsx';
import { areaPath, FloatTip, linePath, mix, scale, TipRow } from './common.tsx';
import s from '../story/story.module.css';

export interface SoundLane {
  name: string;
  stages: readonly { start: number; end: number; stage: SleepStage }[];
}

export interface WakeMark {
  ts: number;
  /** Snoring or a loud moment came just before it. */
  noisy: boolean;
}

export function SoundChart({
  minutes,
  events,
  from,
  to,
  lanes = [],
  wakes = [],
  compact = false,
  tickMin,
  label,
}: {
  minutes: readonly SoundMinute[];
  events: readonly SoundEvent[];
  from: number;
  to: number;
  lanes?: readonly SoundLane[];
  wakes?: readonly WakeMark[];
  /** Short chart (Live tab). */
  compact?: boolean;
  /** Axis tick spacing in minutes (default: hourly, every 2 h when narrow). */
  tickMin?: number;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(width, 240);
  const pr = 52;
  const plotW = W - pr;
  const labH = 20;
  const loudH = compact ? 64 : 96;
  const snoreH = compact ? 40 : 56;
  const tickH = 10;
  const row = compact ? 0 : 7;
  const rgap = 2;
  const hypH = row * 4 + rgap * 3;
  const gapT = 10;

  let y = labH;
  const loudY = y;
  y += loudH + gapT + labH;
  const snoreY = y;
  y += snoreH + 4;
  const momentsY = y;
  y += tickH + gapT;
  const laneYs: number[] = [];
  if (!compact)
    for (let i = 0; i < lanes.length; i++) {
      y += labH;
      laneYs.push(y);
      y += hypH + gapT;
    }
  const axisY = y + 4;
  const H = axisY + 20;

  const x = useMemo(() => scale(from, to, 0, plotW), [from, to, plotW]);
  const geo = useMemo(() => {
    const fin = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v);
    const vals = minutes.flatMap((m) => [m.dbAvg, m.dbFloor].filter(fin));
    const lo = vals.length ? Math.floor((Math.min(...vals) - 3) / 10) * 10 : -80;
    const hiRaw = vals.length ? Math.max(...minutes.map((m) => m.dbAvg).filter(fin)) + 3 : -30;
    const hi = Math.max(lo + 20, Math.ceil(hiRaw / 10) * 10);
    const v = scale(lo, hi, loudY + loudH, loudY);
    const inRange = minutes.filter((m) => m.ts >= from - MIN && m.ts <= to);
    // Gaps over 3 minutes break the line (the listener was off).
    const gapPx = Math.max(6, (3 * MIN * plotW) / Math.max(1, to - from));
    const pts = inRange.map((m) => ({ x: x(m.ts + MIN / 2), y: fin(m.dbAvg) ? v(Math.min(hi, Math.max(lo, m.dbAvg))) : NaN }));
    const floor = inRange.map((m) => ({ x: x(m.ts + MIN / 2), y: fin(m.dbFloor) ? v(Math.min(hi, Math.max(lo, m.dbFloor))) : NaN }));
    // Area segments, so a gap leaves no wash.
    const areas: string[] = [];
    let seg: { x: number; y: number }[] = [];
    for (const p of pts) {
      if (!Number.isFinite(p.y) || (seg.length && p.x - seg.at(-1)!.x > gapPx)) {
        if (seg.length > 1) areas.push(areaPath(seg, loudY + loudH));
        seg = [];
      }
      if (Number.isFinite(p.y)) seg.push(p);
    }
    if (seg.length > 1) areas.push(areaPath(seg, loudY + loudH));
    const ticks = [lo, Math.round((lo + hi) / 20) * 10, hi].filter((t, i, a) => a.indexOf(t) === i);
    return { lo, hi, v, line: linePath(pts, gapPx), floor: linePath(floor, gapPx), areas, ticks, inRange };
  }, [minutes, from, to, x, plotW, loudY, loudH]);

  const barW = Math.max(1, (MIN * plotW) / Math.max(1, to - from) - (to - from > 3 * 3_600_000 ? 0.3 : 1));
  const ticks = tickMin ? stepTicks(from, to, tickMin) : hourTicks(from, to, plotW < 520 ? 2 : 1);
  const moments = events.filter((e) => e.ts >= from && e.ts <= to && (e.kind === 'loud' || e.kind === 'cough' || e.kind === 'other'));

  const [hover, setHover] = useState<SoundMinute | null>(null);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - r.left) / Math.max(1, plotW)) * (to - from);
    let best: SoundMinute | null = null;
    for (const m of geo.inRange) if (!best || Math.abs(m.ts + MIN / 2 - t) < Math.abs(best.ts + MIN / 2 - t)) best = m;
    setHover(best && Math.abs(best.ts + MIN / 2 - t) <= 3 * MIN ? best : null);
  };

  const trackLabel = (yy: number, text: string) => (
    <text x={0} y={yy - 6} className={s.trackLabel}>
      {text}
    </text>
  );

  return (
    <div ref={ref} className={s.chart} style={{ height: H }} role="img" aria-label={label}>
      {width > 0 && (
        <svg width={W} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} aria-hidden style={{ touchAction: 'pan-y' }}>
          {ticks.map((t) => (
            <line key={t} x1={x(t)} x2={x(t)} y1={loudY} y2={axisY - 6} stroke="var(--grid)" />
          ))}
          {trackLabel(loudY, 'Loudness')}
          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={geo.v(t)} y2={geo.v(t)} stroke="var(--grid)" />
              <text x={plotW + 8} y={geo.v(t) + 5} className={s.tickSm}>
                {dbText(t)}
              </text>
            </g>
          ))}
          {geo.areas.map((d, i) => (
            <path key={i} d={d} fill={mix('var(--text)', 6)} />
          ))}
          <path d={geo.floor} fill="none" stroke="var(--muted)" strokeWidth={1} strokeDasharray="2 3" />
          <path d={geo.line} fill="none" stroke="var(--text-2)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />

          {trackLabel(snoreY, 'Snoring')}
          <line x1={0} x2={plotW} y1={snoreY + snoreH} y2={snoreY + snoreH} stroke="var(--grid)" />
          {geo.inRange.map((m) =>
            m.snoreS > 0 ? (
              <rect
                key={m.ts}
                x={x(m.ts)}
                y={snoreY + snoreH - (Math.min(60, m.snoreS) / 60) * snoreH}
                width={barW}
                height={Math.max(1, (Math.min(60, m.snoreS) / 60) * snoreH)}
                fill={m.snoreS >= SNORE_MIN_S ? 'var(--text)' : 'var(--muted)'}
              />
            ) : null,
          )}
          <text x={plotW + 8} y={snoreY + 10} className={s.tickSm}>
            60 s
          </text>
          {moments.map((e) => (
            <rect key={`${e.id}`} x={x(e.ts) - 1} y={momentsY} width={2} height={tickH} rx={1} fill="var(--signal)" />
          ))}
          {moments.length > 0 && (
            <text x={plotW + 8} y={momentsY + 9} className={s.tickSig}>
              Loud
            </text>
          )}

          {!compact &&
            lanes.map((l, i) => (
              <g key={l.name} className={personScope(i)}>
                {trackLabel(laneYs[i]!, l.name)}
                <HypnoBlocks stages={l.stages} x={x} from={from} to={to} y={laneYs[i]!} row={row} gap={rgap} />
              </g>
            ))}
          {!compact && lanes.length > 0 && (
            <>
              <text x={plotW + 8} y={laneYs[0]! + row} className={s.tickSm}>
                Awake
              </text>
              <text x={plotW + 8} y={laneYs[0]! + 3 * (row + rgap) + row} className={s.tickSm}>
                Deep
              </text>
            </>
          )}

          {wakes.map((w) => (
            <line
              key={w.ts}
              x1={x(w.ts)}
              x2={x(w.ts)}
              y1={snoreY - 2}
              y2={(laneYs.at(-1) ?? momentsY) + (laneYs.length ? hypH : tickH)}
              stroke={w.noisy ? 'var(--signal)' : 'var(--muted)'}
              strokeWidth={w.noisy ? 1.5 : 1}
              strokeDasharray={w.noisy ? undefined : '2 3'}
            />
          ))}

          {ticks.map((t) => (
            <text key={t} x={x(t)} y={axisY + 12} textAnchor="middle" className={s.tick}>
              {hm(t)}
            </text>
          ))}
          {hover && <line x1={x(hover.ts + MIN / 2)} x2={x(hover.ts + MIN / 2)} y1={loudY} y2={axisY - 6} stroke="var(--hairline-2)" />}
        </svg>
      )}
      {hover && (
        <FloatTip x={x(hover.ts + MIN / 2)} y={Math.max(0, loudY - 8)} width={W}>
          <div className="tip-title">{hm(hover.ts)}</div>
          <TipRow value={dbText(hover.dbAvg)} label="average" />
          <TipRow value={`${Math.round(hover.snoreS)} s`} label="snoring" />
          {topClass(hover) && <TipRow value={topClass(hover)!} label="mostly" />}
        </FloatTip>
      )}
    </div>
  );
}

function topClass(m: SoundMinute): string | null {
  let best: string | null = null;
  let bs = 0;
  for (const [k, v] of Object.entries(m.classes)) if (v > bs && !/^silence$/i.test(k)) [best, bs] = [k, v];
  return best;
}

function stepTicks(from: number, to: number, stepMin: number): number[] {
  const step = stepMin * MIN;
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
}
