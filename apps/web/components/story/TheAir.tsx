'use client';
// Scene 4 · The air (docs/DESIGN.md §7.2, §9.1). How long CO₂ sat above 1,000 ppm (the reading), one sentence,
// then the full-night CO₂ chart with the crossing and the peak labelled on the line, the fresh-air meter and the
// 30-night bars. Lines draw in once on reveal; nothing is scrubbed here.
import { useMemo } from 'react';
import type { RoomNightMetrics } from '@sleep-lab/core';
import { dur, fmt, hm, hourTicks, MIN, shortDate } from '@/lib/format.ts';
import { linePath, scale } from '../charts/common.tsx';
import { DrawPath, Reveal } from '../motion.tsx';
import { Placeholder, useWidth } from '../ui.tsx';
import { GapBands, Scene, SceneCols, SceneText, VisHead } from './parts.tsx';
import { valueAt, type StoryModel } from './model.ts';
import s from './story.module.css';

export function airHeadline(room: RoomNightMetrics): string {
  if (room.co2Mean >= 1000) return 'Two people, one sealed room.';
  if (room.co2Max >= 1000) return 'Fresh at first, stale by morning.';
  if (room.co2Mean >= 800) return 'The air just held up.';
  return 'Plenty of fresh air all night.';
}

function Co2Chart({ model, room, peakAt, crossAt }: { model: StoryModel; room: RoomNightMetrics; peakAt: number; crossAt: number | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(width, 240);
  const H = Math.round(Math.max(220, Math.min(320, W * 0.4)));
  const pr = 52;
  const pt = 34;
  const pb = 30;
  const geo = useMemo(() => {
    const hi = Math.max(1400, Math.ceil((room.co2Max + 100) / 200) * 200);
    const x = scale(model.lo, model.wake, 0, W - pr);
    const y = scale(400, hi, H - pb, pt);
    const step = Math.max(MIN, ((model.wake - model.lo) / W) * 2);
    const pts: { x: number; y: number }[] = [];
    const over: { x: number; y: number }[] = [];
    for (let t = model.lo; t <= model.wake + 1; t += step) {
      const v = valueAt(model.series, 'co2', t);
      pts.push({ x: x(t), y: Number.isFinite(v) ? y(Math.min(v, hi)) : NaN });
      if (Number.isFinite(v)) over.push({ x: x(t), y: y(Math.min(hi, Math.max(1000, v))) });
    }
    const y1000 = y(1000);
    const area = over.length > 1 ? `M${over[0]!.x},${y1000}${over.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')}L${over.at(-1)!.x},${y1000}Z` : '';
    return { x, y, hi, line: linePath(pts, 12), area, ticks: [600, 1000, 1400].filter((v) => v <= hi) };
  }, [model, room.co2Max, W, H]);
  const y1000 = geo.y(1000);
  const frac = Math.max(0, Math.min(1, (y1000 - pt) / (H - pb - pt)));
  const px = geo.x(peakAt);
  const py = geo.y(Math.min(room.co2Max, geo.hi));
  const peakLeft = px > (W - pr) * 0.6;
  const ticks = hourTicks(model.lo, model.wake, W < 520 ? 2 : 1);
  return (
    <div
      ref={ref}
      className={s.chart}
      style={{ height: H }}
      role="img"
      aria-label={`CO₂ through the night${crossAt ? `, crossed 1,000 ppm at ${hm(crossAt)}` : ''}, peak ${fmt(room.co2Max)} ppm at ${hm(peakAt)}`}
    >
      {width > 0 && (
        <svg width={W} height={H} aria-hidden style={{ overflow: 'visible' }}>
          <defs>
            <linearGradient id="air-line" gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={pt} y2={H - pb}>
              <stop offset={frac} stopColor="var(--signal)" />
              <stop offset={frac} stopColor="var(--text)" />
            </linearGradient>
          </defs>
          {geo.ticks.map((v) =>
            v === 1000 ? null : (
              <g key={v}>
                <line x1={0} x2={W - pr} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--grid)" />
                <text x={W - pr + 10} y={geo.y(v) + 5} className={s.tick}>
                  {fmt(v)}
                </text>
              </g>
            ),
          )}
          <GapBands gaps={model.gaps} x={geo.x} from={model.lo} to={model.wake} y0={pt} y1={H - pb} labelY={H - pb - 10} />
          <path d={geo.area} fill="var(--signal-soft)" className="fade-late" />
          <line x1={0} x2={W - pr} y1={y1000} y2={y1000} stroke="var(--signal)" strokeDasharray="2 3" />
          <text x={W - pr + 10} y={y1000 + 5} className={s.tickSig}>
            1,000
          </text>
          <DrawPath d={geo.line} fill="none" stroke="url(#air-line)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {crossAt !== null && (
            <g className="fade-late">
              <circle cx={geo.x(crossAt)} cy={y1000} r={4.5} fill="var(--bg)" stroke="var(--signal)" strokeWidth={2} />
              <text x={geo.x(crossAt) + 10} y={y1000 + 22} textAnchor="start" className={s.tickInk}>
                {hm(crossAt)}
              </text>
            </g>
          )}
          {Number.isFinite(room.co2Max) && (
            <g className="fade-late">
              <circle cx={px} cy={py} r={4.5} fill="var(--bg)" stroke={room.co2Max >= 1000 ? 'var(--signal)' : 'var(--text)'} strokeWidth={2} />
              <text x={peakLeft ? px - 10 : px + 10} y={Math.max(14, py - 12)} textAnchor={peakLeft ? 'end' : 'start'} className={s.tickInk}>
                Peak {fmt(room.co2Max)} · {hm(peakAt)}
              </text>
            </g>
          )}
          <line x1={0} x2={W - pr} y1={H - pb} y2={H - pb} stroke="var(--axis)" />
          {ticks.map((t) => {
            const x = geo.x(t);
            if (x < 16 || x > W - pr - 16) return null;
            return (
              <text key={t} x={x} y={H - 8} textAnchor="middle" className={s.tick}>
                {hm(t)}
              </text>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** Linear 0–0.5 air changes per hour: last night in ink, what two sleepers need as a signal tick. */
function FreshAir({ ach, need, what = 'last night' }: { ach: number | null; need: number; what?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(width, 200);
  const max = Math.max(0.5, Math.ceil(Math.max(need, ach ?? 0) * 12) / 10);
  const x = scale(0, max, 0, W - 2);
  const y = 44;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-6; v += 0.05) ticks.push(Math.round(v * 100) / 100);
  const close = ach !== null && Math.abs(x(ach) - x(need)) < 110;
  return (
    <div ref={ref} className={s.chart} style={{ height: 96 }} role="img" aria-label={ach !== null ? `Fresh air ${fmt(ach, 2)} air changes per hour; about ${fmt(need, 2)} needed` : 'Fresh air not measured this morning'}>
      {width > 0 && (
        <svg width={W} height={96} aria-hidden style={{ overflow: 'visible' }}>
          {ticks.map((v) => {
            const major = Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
            return (
              <g key={v}>
                <line x1={x(v)} x2={x(v)} y1={y - (major ? 9 : 5)} y2={y} stroke="var(--hairline-2)" />
                {major && (
                  <text x={x(v)} y={y + 24} textAnchor={v === 0 ? 'start' : v >= max - 1e-6 ? 'end' : 'middle'} className={s.tick}>
                    {fmt(v, 1)}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={0} x2={W - 2} y1={y} y2={y} stroke="var(--hairline-2)" />
          {ach !== null && (
            <>
              <rect x={0} y={y - 3} width={x(ach)} height={3} fill="var(--text)" />
              <rect x={x(ach) - 1.5} y={y - 18} width={3} height={22} fill="var(--text)" />
              <text x={x(ach)} y={y - 26} textAnchor={close ? (ach < need ? 'end' : 'start') : 'middle'} className={s.tickInk}>
                {fmt(ach, 2)} {what}
              </text>
            </>
          )}
          <rect x={x(need) - 1.5} y={y - 18} width={3} height={22} fill="var(--signal)" />
          <text x={x(need)} y={y - 26} textAnchor={close && ach !== null ? (ach < need ? 'start' : 'end') : 'middle'} className={s.tickSig}>
            {fmt(need, 2)} needed
          </text>
          <text x={W - 2} y={y + 48} textAnchor="end" className={s.tick}>
            air changes per hour
          </text>
        </svg>
      )}
    </div>
  );
}

/** Last 30 nights' CO₂ means: muted bars, nights over 1,000 in signal, last night in ink, dotted 1,000. */
function NightBars({ history }: { history: RoomNightMetrics[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(width, 200);
  const H = 200;
  const pr = 52;
  const pt = 10;
  const pb = 30;
  const vals = history.map((r) => r.co2Mean);
  // Bars start at 0 so their lengths are honest; the one labelled line is the 1,000 threshold.
  const lo = 0;
  const hi = Math.max(1200, ...vals.filter(Number.isFinite)) + 40;
  const y = scale(lo, hi, H - pb, pt);
  // At least 30 slots, newest on the right, so a short history doesn't turn into a few walls.
  const bw = (W - pr) / Math.max(30, history.length);
  const off = (Math.max(30, history.length) - history.length) * bw;
  const lastV = vals.at(-1)!;
  return (
    <div ref={ref} className={s.chart} style={{ height: H }} role="img" aria-label={`Nightly CO₂ average for ${history.length} nights; last night ${fmt(lastV)} ppm`}>
      {width > 0 && (
        <svg width={W} height={H} aria-hidden>
          <line x1={0} x2={W - pr} y1={y(500)} y2={y(500)} stroke="var(--grid)" />
          <text x={W - pr + 10} y={y(500) + 5} className={s.tick}>
            500
          </text>
          <line x1={0} x2={W - pr} y1={y(0)} y2={y(0)} stroke="var(--axis)" />
          {history.map((r, i) => {
            const v = r.co2Mean;
            if (!Number.isFinite(v)) return null;
            const last = i === history.length - 1;
            const fill = v > 1000 ? 'var(--signal)' : last ? 'var(--text)' : 'var(--hairline-2)';
            return (
              <rect key={r.date} x={off + i * bw + bw * 0.18} y={y(v)} width={Math.max(1, bw * 0.64)} height={Math.max(1, y(lo) - y(v))} rx={1.5} fill={fill}>
                <title>{`${shortDate(r.date)} · ${fmt(v)} ppm`}</title>
              </rect>
            );
          })}
          <line x1={0} x2={W - pr} y1={y(1000)} y2={y(1000)} stroke="var(--signal)" strokeDasharray="2 3" />
          <text x={W - pr + 10} y={y(1000) + 5} className={s.tickSig}>
            1,000
          </text>
          <text x={off} y={H - 8} className={s.tick}>
            {shortDate(history[0]!.date)}
          </text>
          <text x={W - pr} y={H - 8} textAnchor="end" className={s.tickInk}>
            Last night {fmt(lastV)}
          </text>
        </svg>
      )}
    </div>
  );
}

/** Fewer than five nights: a bar chart would be one lonely bar, so list them instead. */
function ShortHistory({ history }: { history: RoomNightMetrics[] }) {
  const rows = history.filter((r) => Number.isFinite(r.co2Mean));
  return (
    <>
      <VisHead title={`Nightly CO₂: ${rows.length} night${rows.length === 1 ? '' : 's'} so far`} cap="The 30-night comparison fills in as nights arrive" />
      <ol className={s.shortHist}>
        {rows.map((r, i) => (
          <li key={r.date}>
            <span>{i === rows.length - 1 ? 'Last night' : shortDate(r.date)}</span>
            <b className="num">{fmt(r.co2Mean)} ppm</b>
            <span className="cap">peak {fmt(r.co2Max)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

export function TheAir({
  model,
  room,
  history,
  baseline,
  peakAt,
  crossAt,
}: {
  model: StoryModel;
  room: RoomNightMetrics;
  history: RoomNightMetrics[] | null;
  baseline: RoomNightMetrics[] | null;
  peakAt: number;
  crossAt: number | null;
}) {
  const over = room.minutesCo2Over1000;
  // Same window as the rule report's insight (the 30 nights before this one), so both sentences agree.
  const past = (baseline ?? []).filter((r) => Number.isFinite(r.co2Mean));
  const avg = past.length ? past.reduce((a, r) => a + r.co2Mean, 0) / past.length : NaN;
  const d = room.co2Mean - avg;
  const plateau = model.air.plateau;
  // The morning decay is the measurement; without it, the overnight plateau gives an estimate (assumes two sleepers).
  const ach = room.achMorning ?? plateau?.ach ?? null;
  const estimated = room.achMorning === null && plateau !== null;
  // Still rising at wake: the room never reached balance, so the figure is a ceiling, not an estimate.
  const ceiling = estimated && plateau?.kind === 'upper_bound';
  const need = model.air.achNeeded;
  const morningGap = model.gaps.find((g) => g.start >= model.wake - 30 * MIN && g.start < model.wake + 4 * 60 * MIN);
  const lede = [
    `Last night averaged ${fmt(room.co2Mean)} ppm`,
    Number.isFinite(d) && past.length >= 3 ? (Math.abs(d) < 25 ? `, in line with your ${past.length}-night mean.` : `, ${fmt(Math.abs(d))} ${d >= 0 ? 'above' : 'below'} your ${past.length}-night mean.`) : '.',
    ceiling && plateau
      ? ` CO₂ was still creeping up at wake (${fmt(plateau.ppm)} ppm), so fresh air was at most ${fmt(plateau.ach, 2)} air changes an hour${ach !== null && ach < need ? ', not enough to stay under 1,000' : ', about what two sleepers need, with no room to spare'}.`
      : estimated && plateau
      ? ` CO₂ levelled off around ${fmt(plateau.ppm)} ppm: the fresh air leaking in balanced two sleepers${ach !== null && ach >= need ? ', enough to stay under 1,000' : ', not quite enough to stay under 1,000'}.`
      : ach !== null && ach < need
        ? ` Two sleepers need about ${fmt(need / Math.max(0.01, ach), 1)}× the fresh air this room got.`
        : ach !== null
          ? ' The room got enough fresh air for two sleepers.'
          : '',
  ].join('');
  const nOver = history ? history.filter((r) => r.co2Mean > 1000).length : 0;
  return (
    <Scene id="air" title="The air">
      <SceneCols text={<SceneText label="The air" reading={over > 0 ? dur(over) : '0m'} readingCap="above 1,000 ppm CO₂" title={airHeadline(room)} lede={lede} />}>
        <Reveal>
          <VisHead
            title={crossAt ? `CO₂ crossed 1,000 at ${hm(crossAt)}` : `CO₂ stayed under 1,000 all night`}
            cap={`ppm, ${hm(model.lo)} to ${hm(model.wake)} · peak ${fmt(room.co2Max)} at ${hm(peakAt)}`}
          />
          <Co2Chart model={model} room={room} peakAt={peakAt} crossAt={crossAt} />
        </Reveal>
        <div className={s.pair}>
          <Reveal delay={80}>
            <VisHead
              title={ach !== null ? `Fresh air last night: ${ceiling ? 'at most ' : estimated ? 'about ' : ''}${fmt(ach, 2)}\u00a0air changes an\u00a0hour` : 'Fresh air: not measured this morning'}
              cap={
                ceiling && plateau
                  ? `A ceiling from the CO₂ level at wake (${fmt(plateau.ppm)} ppm, still rising), assuming two sleepers. They need about ${fmt(need, 2)} to stay under 1,000 ppm.`
                  : estimated && plateau
                  ? `Estimated from where CO₂ levelled off (${fmt(plateau.ppm)} ppm), assuming two sleepers. They need about ${fmt(need, 2)} to stay under 1,000 ppm.`
                  : ach === null && morningGap
                    ? `Measured from the CO₂ drop after you get up; the meter was offline from ${hm(morningGap.start)}. Two sleepers need about ${fmt(need, 2)}.`
                    : `Two sleepers need about ${fmt(need, 2)} to stay under 1,000 ppm`
              }
            />
            <FreshAir ach={ach} need={need} what={ceiling ? 'at most' : estimated ? 'estimated' : 'last night'} />
          </Reveal>
          <Reveal delay={140}>
            {history && history.filter((r) => Number.isFinite(r.co2Mean)).length < 5 ? (
              <ShortHistory history={history} />
            ) : history ? (
              <>
                <VisHead title={`${nOver} of the last ${history.length} nights averaged over 1,000\u00a0ppm`} cap="Nightly CO₂ average, nights over 1,000 marked" />
                <NightBars history={history} />
              </>
            ) : (
              <>
                <VisHead title="Last 30 nights" cap="Nightly CO₂ average" />
                <Placeholder height={200} text="Reading the last 30 nights…" />
              </>
            )}
          </Reveal>
        </div>
      </SceneCols>
    </Scene>
  );
}
