'use client';
// 04 · The air — pinned 300svh (docs/DESIGN.md §10). p 0 → .7 drives the CO₂ number from the lights-out reading to
// the night mean and wipes the area in; the peak marker pops at .7; the two meters fill from .75. After the pin,
// the last 30 nights of CO₂ means rise in as bars, with the one-sentence comparison.
import { useMemo, useRef } from 'react';
import type { RoomNightMetrics } from '@sleep-lab/core';
import { dur, fmt, hm, MIN, shortDate } from '@/lib/format.ts';
import { linePath, scale } from '../charts/common.tsx';
import { Chapter, easeOut, remap, Reveal, ScrubWipe, setSky, useChapterProgress } from '../motion.tsx';
import { useScrub } from './useScrub.ts';
import { Placeholder, useWidth } from '../ui.tsx';
import { valueAt, type StoryModel } from './model.ts';
import s from './story.module.css';

const DRAW = [0, 0.7] as const;

function AirChart({ model, room }: { model: StoryModel; room: RoomNightMetrics }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const peak = useRef<SVGGElement>(null);
  const H = 168;
  const geo = useMemo(() => {
    const W = Math.max(200, width);
    const x = scale(model.lo, model.wake, 0, W);
    const hi = Math.max(1400, Math.ceil((room.co2Max + 100) / 100) * 100);
    const y = scale(400, hi, H, 4);
    const pts: { x: number; y: number }[] = [];
    const step = Math.max(MIN, ((model.wake - model.lo) / W) * 2);
    for (let t = model.lo; t <= model.wake + 1; t += step) {
      const v = valueAt(model.series, 'co2', t);
      pts.push({ x: x(t), y: Number.isFinite(v) ? y(Math.min(v, hi)) : NaN });
    }
    const f = pts.filter((p) => Number.isFinite(p.y));
    const area = f.length > 1 ? `M${f[0]!.x},${H}${f.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')}L${f.at(-1)!.x},${H}Z` : '';
    // Peak time: the minute closest to the metrics' max (so the label agrees with the headline numbers).
    let pk = { ts: model.lo, d: Infinity };
    for (let t = model.lo; t <= model.wake; t += MIN) {
      const d = Math.abs(valueAt(model.series, 'co2', t) - room.co2Max);
      if (d < pk.d) pk = { ts: t, d };
    }
    return { W, x, y, hi, line: linePath(pts, 12), area, peakTs: pk.ts };
  }, [model, room.co2Max, width]);
  useChapterProgress((p) => {
    peak.current?.classList.toggle('hit', p >= 0.7);
  });
  const px = geo.x(geo.peakTs);
  const py = geo.y(Math.min(room.co2Max, geo.hi));
  const bands = [
    { a: 400, b: 800, f: 'var(--band-good)' },
    { a: 800, b: 1000, f: 'var(--band-warn)' },
    { a: 1000, b: 1500, f: 'var(--band-serious)' },
    { a: 1500, b: geo.hi, f: 'var(--band-critical)' },
  ];
  const labelLeft = px > geo.W * 0.55;
  return (
    <div ref={ref} className={s.airChart} style={{ height: H }} role="img" aria-label={`CO₂ through the night, peak ${fmt(room.co2Max)} ppm at ${hm(geo.peakTs)}`}>
      {width > 0 && (
        <>
          <svg width={geo.W} height={H} className={s.svgAbs} aria-hidden>
            {bands.map((b) => (b.b > b.a ? <rect key={b.a} x={0} y={geo.y(Math.min(b.b, geo.hi))} width={geo.W} height={geo.y(b.a) - geo.y(Math.min(b.b, geo.hi))} fill={b.f} /> : null))}
            <line x1={0} x2={geo.W} y1={geo.y(1000)} y2={geo.y(1000)} stroke="var(--text-2)" strokeOpacity={0.6} strokeDasharray="3 4" />
            <text x={4} y={geo.y(1000) - 6} className={s.svgLabel}>
              1,000
            </text>
            <text x={4} y={geo.y(800) - 6} className={s.svgLabel}>
              800
            </text>
            <text x={4} y={H - 6} className={s.svgLabel}>
              {hm(model.lo)}
            </text>
            <text x={geo.W - 4} y={H - 6} textAnchor="end" className={s.svgLabel}>
              {hm(model.wake)}
            </text>
          </svg>
          <ScrubWipe range={DRAW} style={{ position: 'absolute', inset: 0 }}>
            {(copy) => (
              <svg width={geo.W} height={H} aria-hidden>
                <defs>
                  <linearGradient id={`air-${copy}`} x1={0} x2={0} y1={0} y2={1}>
                    <stop offset={0} stopColor="var(--co2)" stopOpacity={0.45} />
                    <stop offset={1} stopColor="var(--co2)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <path d={geo.area} fill={`url(#air-${copy})`} />
                <path d={geo.line} fill="none" stroke="var(--co2)" strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            )}
          </ScrubWipe>
          <svg width={geo.W} height={H} className={s.svgAbs} aria-hidden style={{ overflow: 'visible' }}>
            <g ref={peak} className="hit-mark">
              <circle cx={px} cy={py} r={5} fill="var(--co2)" stroke="var(--bg)" strokeWidth={2} />
              <text x={labelLeft ? px - 10 : px + 10} y={Math.max(14, py - 10)} textAnchor={labelLeft ? 'end' : 'start'} className={s.svgLabelStrong}>
                PEAK {fmt(room.co2Max)} · {hm(geo.peakTs)}
              </text>
            </g>
          </svg>
        </>
      )}
    </div>
  );
}

function Meters({ room, model }: { room: RoomNightMetrics; model: StoryModel }) {
  const bars = useRef<(HTMLElement | null)[]>([]);
  const overFrac = Math.min(1, room.minutesCo2Over1000 / model.air.nightMin);
  const ach = room.achMorning;
  const need = model.air.achNeeded;
  const span = Math.max(need, ach ?? 0) * 1.25;
  const achFrac = ach !== null ? Math.min(1, ach / span) : 0;
  const fr = [overFrac, achFrac];
  useChapterProgress((p) => {
    const q = remap(p, 0.72, 1);
    fr.forEach((f, i) => {
      const el = bars.current[i];
      if (el) el.style.transform = `scaleX(${(f * easeOut(Math.max(0, Math.min(1, q * 1.4 - i * 0.4)))).toFixed(4)})`;
    });
  });
  return (
    <div className={s.meters}>
      <div className={s.meter}>
        <div className={s.meterTop}>
          <b className="num">{room.minutesCo2Over1000 > 0 ? dur(room.minutesCo2Over1000) : '0m'}</b>
          <span className="t-label">above 1,000 ppm</span>
        </div>
        <div className={s.bar}>
          <i ref={(el) => void (bars.current[0] = el)} />
        </div>
      </div>
      <div className={s.meter}>
        <div className={s.meterTop}>
          <b className="num">{ach !== null ? `${fmt(ach, 2)} ACH` : '– ACH'}</b>
          <span className="t-label">{ach !== null ? `fresh air · needs ${fmt(need, 2)}` : 'no clean decay this morning'}</span>
        </div>
        <div className={s.bar}>
          <i ref={(el) => void (bars.current[1] = el)} />
          {ach !== null && <s style={{ left: `${(need / span) * 100}%` }} aria-hidden />}
        </div>
      </div>
    </div>
  );
}

function Mega({ model, room }: { model: StoryModel; room: RoomNightMetrics }) {
  const ref = useRef<HTMLSpanElement>(null);
  const lbl = useRef<HTMLSpanElement>(null);
  const last = useRef({ v: '', l: '' });
  // While scrubbing, the figure is the live reading under the chart's wipe ("at 01:30"); it becomes the night
  // mean only once the wipe has reached the morning, so a paused scroll never shows a false "mean".
  useScrub((p) => {
    let v: string;
    let l: string;
    if (p >= 0.999) {
      v = fmt(room.co2Mean);
      l = 'night mean';
    } else {
      const t = model.lo + p * (model.wake - model.lo);
      const c = valueAt(model.series, 'co2', t);
      v = Number.isFinite(c) ? fmt(Math.round(c / 5) * 5) : '–';
      l = p <= 0.001 ? `at lights out` : `at ${hm(t)}`;
    }
    if (v !== last.current.v && ref.current) {
      last.current.v = v;
      ref.current.textContent = v;
    }
    if (l !== last.current.l && lbl.current) {
      last.current.l = l;
      lbl.current.textContent = l;
    }
  }, DRAW, [model, room.co2Mean]);
  return (
    <div className={s.mega}>
      <span className="t-mega num accent" aria-label={`${fmt(room.co2Mean)} ppm night mean`}>
        <span ref={ref} aria-hidden>
          {fmt(room.co2Mean)}
        </span>
      </span>
      <span className={`t-label t2 ${s.megaUnit}`} aria-hidden>
        ppm CO₂
        <br />
        <span ref={lbl}>night mean</span>
      </span>
    </div>
  );
}

export function airHeadline(room: RoomNightMetrics): [string, string] {
  if (room.co2Mean >= 1000) return ['Two people.', 'One sealed room.'];
  if (room.co2Max >= 1000) return ['Fresh at first.', 'Stale by morning.'];
  if (room.co2Mean >= 800) return ['Two people.', 'Air just held up.'];
  return ['Two people.', 'Plenty of air.'];
}

export function TheAir({ model, room, history, baseline, index }: { model: StoryModel; room: RoomNightMetrics; history: RoomNightMetrics[] | null; baseline: RoomNightMetrics[] | null; index: number }) {
  const [l1, l2] = airHeadline(room);
  return (
    <>
      <Chapter
        id="air"
        n={4}
        title="The air"
        accent="air"
        pinned={3}
        className="bleed"
        onProgress={(p) => {
          const q = remap(p, 0, 0.2);
          setSky({ dusk: 0, mid: 0, dawn: 1 - q, dim: 0 });
        }}
      >
        <div className="sh-kicker t-label">
          <span>04</span>
          <span>The air</span>
        </div>
        <h2 className={`t-h1 ${s.h1}`}>
          {l1}
          <br />
          <em className="tone">{l2}</em>
        </h2>
        <Mega model={model} room={room} />
        <AirChart model={model} room={room} />
        <div style={{ flex: 1, minHeight: 12 }} />
        <Meters room={room} model={model} />
      </Chapter>
      <AirHistory history={history} baseline={baseline} index={index} room={room} achNeeded={model.air.achNeeded} />
    </>
  );
}

function AirHistory({ history, baseline, room, achNeeded }: { history: RoomNightMetrics[] | null; baseline: RoomNightMetrics[] | null; index: number; room: RoomNightMetrics; achNeeded: number }) {
  if (!history)
    return (
      <div className={s.flow} style={{ ['--ch-accent' as string]: 'var(--ac-air)' }}>
        <div className="t-label t2">Last 30 nights · CO₂ mean</div>
        <div style={{ marginTop: 16 }}>
          <Placeholder height={150} text="Reading the last 30 nights…" />
        </div>
      </div>
    );
  // Same window as the rule report's insight (the 30 nights before this one), so both sentences agree.
  const past = (baseline ?? history.slice(0, -1)).filter((r) => Number.isFinite(r.co2Mean));
  const avg = past.length ? past.reduce((a, r) => a + r.co2Mean, 0) / past.length : NaN;
  const d = room.co2Mean - avg;
  const lo = 400;
  const hi = Math.max(1200, ...history.map((r) => (Number.isFinite(r.co2Mean) ? r.co2Mean : 0))) + 50;
  const pct = (v: number) => ((Math.max(lo, v) - lo) / (hi - lo)) * 100;
  const ach = room.achMorning;
  return (
    <div className={s.flow} style={{ ['--ch-accent' as string]: 'var(--ac-air)' }}>
      <Reveal className="t-label t2">Last {history.length} nights · CO₂ mean</Reveal>
      <Reveal className={s.hist} y={0}>
        {history.map((r, i) => {
          const me = i === history.length - 1;
          return (
            <i
              key={r.date}
              className={me ? s.me : r.co2Mean >= 1000 ? s.hot : undefined}
              style={{ height: `${pct(r.co2Mean)}%`, ['--i' as string]: i }}
              title={`${shortDate(r.date)} · ${fmt(r.co2Mean)} ppm`}
            />
          );
        })}
        <s className={s.histLine} style={{ bottom: `${pct(1000)}%` }} aria-hidden />
      </Reveal>
      <div className={`${s.histAx} t-micro`}>
        <span>{shortDate(history[0]!.date)}</span>
        <span className={s.histKey}>
          <i /> over 1,000
        </span>
        <span>Last night</span>
      </div>
      <Reveal as="p" className={`t-body t2 ${s.lede}`}>
        {Number.isFinite(d) && past.length >= 3 ? (
          Math.abs(d) < 25 ? (
            <>
              Last night was <b>in line with</b> your {past.length}-night average.{' '}
            </>
          ) : (
            <>
              Last night ran <b>{fmt(Math.abs(d))} ppm {d >= 0 ? 'above' : 'below'}</b> your {past.length}-night average.{' '}
            </>
          )
        ) : null}
        {ach !== null && ach < achNeeded ? (
          <>
            The room needs about <b>{fmt(achNeeded / Math.max(0.01, ach), 1)}× the fresh air</b> to keep two sleepers under 1,000.
          </>
        ) : ach !== null ? (
          <>
            Fresh air measured at <b>{fmt(ach, 2)} ACH</b>, enough for two sleepers.
          </>
        ) : null}
      </Reveal>
    </div>
  );
}
