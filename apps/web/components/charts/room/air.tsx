'use client';
/**
 * Room › Air charts (docs/DESIGN.md §7.2): the 6-hour "right now" trace, the CO₂ ramp + forecast, the 30-night bars,
 * the fresh-air (ACH) tracker and the linear meters that replace v1's speedometer gauge.
 * Ink for measured data, --signal only above a limit, dashed --muted for forecasts and plans.
 */
import { useMemo, useState } from 'react';
import { downsample, type RoomNightMetrics, type RoomReading } from '@sleep-lab/core';
import { co2Band, fmt, hm, MIN, niceTicks, shortDate, shortDay } from '@/lib/format.ts';
import { median, quantile } from '@/lib/stats.ts';
import { DrawPath } from '../../motion.tsx';
import { useWidth } from '../../ui.tsx';
import { co2Tolerance, FloatTip, scale, useSvgId } from '../common.tsx';
import { EndLabels, Marker, seriesPath, Threshold, TimeChart, type Geo } from './frame.tsx';
import s from './room.module.css';

const ppm = (v: number) => fmt(v);
/** The one rounding rule for CO₂ forecasts, everywhere they are shown (docs/DESIGN.md §11). */
export const round10 = (v: number) => Math.round(v / 10) * 10;

/** userSpaceOnUse gradient that turns the stroke from ink to signal above `limit`. */
function LimitStroke({ id, g, limit, below = 'var(--text)' }: { id: string; g: Geo; limit: number; below?: string }) {
  const f = Math.max(0, Math.min(1, (g.y(limit) - g.top) / (g.bottom - g.top)));
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={g.top} y2={g.bottom}>
      <stop offset={f} stopColor="var(--signal)" />
      <stop offset={f} stopColor={below} />
    </linearGradient>
  );
}

/** Area between a series and a limit, only where the series is above it (tinted --signal-soft). */
function overPath(g: Geo, pts: readonly { ts: number; v: number }[], limit: number) {
  const f = pts.filter((p) => Number.isFinite(p.v));
  if (f.length < 2 || !f.some((p) => p.v > limit)) return '';
  const yl = g.y(limit);
  return `M${g.x(f[0]!.ts).toFixed(1)},${yl}${f.map((p) => `L${g.x(p.ts).toFixed(1)},${g.yc(Math.max(limit, p.v)).toFixed(1)}`).join('')}L${g.x(f.at(-1)!.ts).toFixed(1)},${yl}Z`;
}

// ───────────── Hero: the last 6 hours ─────────────
export function NowTrace({ history, current }: { history: RoomReading[]; current?: RoomReading | null }) {
  const gid = useSvgId('nt');
  const pts = useMemo(() => {
    const d = downsample(history, 5 * MIN, 'mean');
    // End on the exact reading the hero shows, so the line's end label and the big number agree.
    const cur = current ?? history.at(-1);
    if (cur && d.length && d.at(-1)!.ts < cur.ts) d.push(cur);
    else if (cur && d.length) d[d.length - 1] = cur;
    return d;
  }, [history, current]);
  if (pts.length < 3) return <div className={s.traceEmpty} />;
  const from = pts[0]!.ts;
  const to = pts.at(-1)!.ts;
  const vals = pts.map((p) => p.co2);
  const hiV = Math.max(...vals);
  const top = Math.ceil((Math.max(hiV > 900 ? 1050 : 0, hiV) + 60) / 100) * 100;
  const bottom = Math.max(350, Math.floor((Math.min(...vals) - 60) / 100) * 100);
  const near = (t: number) => pts.reduce((b, p) => (Math.abs(p.ts - t) < Math.abs(b.ts - t) ? p : b), pts[0]!);
  return (
    <TimeChart
      from={from}
      to={to}
      domain={[bottom, top]}
      ticks={[]}
      fmtY={ppm}
      height={132}
      label={`CO₂ over the last 6 hours, now ${fmt(vals.at(-1)!)} ppm`}
      xTicks={[from, to]}
      fmtX={(t) => (t === to ? 'Now' : '6 h ago')}
      hover={(t) => {
        const p = near(t);
        return {
          title: hm(p.ts),
          rows: [
            { label: 'CO₂', value: `${fmt(p.co2)} ppm` },
            { label: 'room', value: `${fmt(p.tempC, 1)}°` },
            { label: 'humidity', value: `${fmt(p.rh)}%` },
          ],
          dots: [{ v: p.co2, color: p.co2 >= 1000 ? 'var(--signal)' : 'var(--text)' }],
        };
      }}
      className={s.trace}
    >
      {(g) => {
        const line = pts.map((p) => ({ ts: p.ts, v: p.co2 }));
        const last = line.at(-1)!;
        return (
          <>
            <defs>
              <LimitStroke id={gid} g={g} limit={1000} />
            </defs>
            <path d={overPath(g, line, 1000)} fill="var(--signal-soft)" />
            {hiV > 900 && <Threshold g={g} v={1000} text="1,000" />}
            {(hiV <= 900 || Math.abs(g.yc(last.v) - g.y(1000)) > 18) && (
              <text x={g.tickX} y={g.yc(last.v) + 5} className={last.v >= 1000 ? s.tickSig : s.tickInk}>
                {fmt(last.v)}
              </text>
            )}
            <DrawPath d={seriesPath(g, line)} fill="none" stroke={`url(#${gid})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={g.x(last.ts)} cy={g.yc(last.v)} r={3.5} fill="var(--bg)" stroke={last.v >= 1000 ? 'var(--signal)' : 'var(--text)'} strokeWidth={2} />
          </>
        );
      }}
    </TimeChart>
  );
}

// ───────────── CO₂ ramp + forecast ─────────────
export function Co2ForecastChart({ actual, forecast, known, until, nowLabel = 'Now' }: { actual: RoomReading[]; forecast: { ts: number; co2: number }[]; known: number; until: number; nowLabel?: string }) {
  const gid = useSvgId('fc');
  const meas = useMemo(() => downsample(actual.filter((r) => r.ts <= until), 5 * MIN, 'mean').map((r) => ({ ts: r.ts, v: r.co2 })), [actual, until]);
  const fc = useMemo(() => {
    const k = meas.filter((m) => m.ts <= known).at(-1);
    const f = forecast.map((p) => ({ ts: p.ts, v: p.co2 }));
    return k ? [k, ...f.filter((p) => p.ts > k.ts)] : f;
  }, [meas, forecast, known]);
  const from = meas[0]?.ts ?? known;
  const hiV = Math.max(1200, ...meas.map((m) => m.v), ...fc.map((p) => p.v + co2Tolerance(p.v)));
  const top = Math.ceil((hiV + 50) / 200) * 200;
  const ticks = [400, 600, 800, 1200, 1400, 1600, 1800, 2000, 2400].filter((t) => t <= top);
  const end = fc.at(-1);
  const near = <T extends { ts: number }>(arr: readonly T[], t: number) => (arr.length ? arr.reduce((b, p) => (Math.abs(p.ts - t) < Math.abs(b.ts - t) ? p : b), arr[0]!) : undefined);
  return (
    <TimeChart
      from={from}
      to={until}
      domain={[400, top]}
      ticks={ticks}
      fmtY={ppm}
      label={end ? `CO₂ measured until ${hm(known)}, forecast ${fmt(end.v)} ppm at ${hm(end.ts)}` : 'CO₂ measured'}
      hover={(t) => {
        const m = t <= known ? near(meas, t) : undefined;
        const f = t > known ? near(fc, t) : undefined;
        const p = m ?? f;
        if (!p) return null;
        return {
          title: hm(p.ts),
          rows: [{ label: m ? 'measured' : 'forecast', value: `${m ? '' : '≈'}${fmt(p.v)} ppm`, dash: !m }],
          dots: [{ v: p.v, color: p.v >= 1000 ? 'var(--signal)' : m ? 'var(--text)' : 'var(--muted)' }],
        };
      }}
      overlay={(g) =>
        end ? (
          <EndLabels
            g={g}
            items={[
              {
                text: `Forecast ≈${fmt(round10(end.v))} at ${hm(end.ts)}`,
                // Keep the label off the measured line: below the forecast range when the measurement ended higher.
                v: (meas.filter((m) => m.ts <= until).at(-1)?.v ?? 0) > end.v && meas.at(-1)!.ts > known ? end.v - co2Tolerance(end.v) - 40 : end.v + co2Tolerance(end.v),
                tone: 'muted',
              },
            ]}
          />
        ) : null
      }
    >
      {(g) => {
        const rib = fc.length > 1 ? `M${fc.map((p) => `${g.x(p.ts).toFixed(1)},${g.yc(p.v + co2Tolerance(p.v) * (p === fc[0] ? 0 : 1)).toFixed(1)}`).join('L')}L${[...fc].reverse().map((p) => `${g.x(p.ts).toFixed(1)},${g.yc(p.v - co2Tolerance(p.v) * (p === fc[0] ? 0 : 1)).toFixed(1)}`).join('L')}Z` : '';
        return (
          <>
            <defs>
              <LimitStroke id={gid} g={g} limit={1000} />
            </defs>
            <path d={overPath(g, meas, 1000)} fill="var(--signal-soft)" />
            {rib && <path d={rib} fill="var(--text)" fillOpacity={0.06} className="fade-late" />}
            <Threshold g={g} v={1000} text="1,000" />
            <Marker g={g} t={known} text={nowLabel} />
            <DrawPath d={seriesPath(g, meas)} fill="none" stroke={`url(#${gid})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {fc.length > 1 && <path d={seriesPath(g, fc, Infinity)} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 4" className="fade-late" />}
            {end && <circle cx={g.x(end.ts)} cy={g.yc(end.v)} r={3.5} fill="var(--bg)" stroke={end.v >= 1000 ? 'var(--signal)' : 'var(--text)'} strokeWidth={2} className="fade-late" />}
          </>
        );
      }}
    </TimeChart>
  );
}

// ───────────── Nightly CO₂ bars ─────────────
/** Nightly CO₂ means: --muted bars, nights over 1,000 in signal, the open night in ink, dotted 1,000. Tap opens a night. */
export function NightBars({ nights, selected, onPick }: { nights: RoomNightMetrics[]; selected?: string; onPick?: (date: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const W = Math.max(width, 240);
  const H = Math.round(Math.max(200, Math.min(280, W * 0.28)));
  const pr = 56;
  const pt = 16;
  const pb = 32;
  const vals = nights.map((r) => r.co2Mean);
  const top = Math.ceil((Math.max(1200, ...vals.filter(Number.isFinite)) + 50) / 200) * 200;
  // Bars start at 0 so their lengths are honest; one labelled 1,000 threshold plus 500 / 1,500 grid lines.
  const y = scale(0, top, H - pb, pt);
  // At least 30 slots, newest on the right: a first week of real data reads as a few bars, not one wall.
  const bw = (W - pr) / Math.max(30, nights.length);
  const off = (Math.max(30, nights.length) - nights.length) * bw;
  const idx = (clientX: number, el: Element) => Math.max(0, Math.min(nights.length - 1, Math.floor((clientX - el.getBoundingClientRect().left - off) / bw)));
  const h = hi !== null ? nights[hi] : undefined;
  const sel = nights.findIndex((n) => n.date === selected);
  return (
    <div ref={ref} className={s.chart} style={{ height: H }}>
      {width > 0 && (
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={`Nightly CO₂ average for ${nights.length} nights, ${vals.filter((v) => v > 1000).length} over 1,000 ppm`}
          style={{ touchAction: 'pan-y', cursor: onPick ? 'pointer' : undefined }}
          onPointerMove={(e) => setHi(idx(e.clientX, e.currentTarget))}
          onPointerLeave={() => setHi(null)}
          onClick={(e) => onPick?.(nights[idx(e.clientX, e.currentTarget)]!.date)}
        >
          {[500, 1500, 2000].filter((v) => v <= top).map((v) => (
            <g key={v}>
              <line x1={0} x2={W - pr} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
              <text x={W - pr + 12} y={y(v) + 5} className={s.tick}>
                {fmt(v)}
              </text>
            </g>
          ))}
          {nights.map((r, i) => {
            const v = r.co2Mean;
            if (!Number.isFinite(v)) return null;
            const isSel = i === sel;
            const fill = v > 1000 ? 'var(--signal)' : isSel ? 'var(--text)' : 'var(--muted)';
            const op = isSel ? 1 : v > 1000 ? 0.9 : hi === i ? 0.8 : 0.42;
            return <rect key={r.date} className={s.col} style={{ animationDelay: `${i * 14}ms` }} x={off + i * bw + bw * 0.25} y={y(v)} width={Math.max(1.5, bw * 0.5)} height={Math.max(1, y(0) - y(v))} rx={Math.min(2, bw * 0.2)} fill={fill} fillOpacity={op} />;
          })}
          <line x1={0} x2={W - pr} y1={y(1000)} y2={y(1000)} stroke="var(--signal)" strokeDasharray="2 3" />
          <text x={W - pr + 12} y={y(1000) + 5} className={s.tickSig}>
            1,000
          </text>
          <line x1={0} x2={W - pr} y1={H - pb} y2={H - pb} stroke="var(--axis)" />
          {nights.length > 3 && (
            <text x={off} y={H - 8} className={s.tick}>
              {nights[0] ? shortDate(nights[0].date) : ''}
            </text>
          )}
          {sel >= 0 && (
            <text x={Math.min(W - pr, Math.max(60, off + sel * bw + bw / 2))} y={H - 8} textAnchor={sel > nights.length - 4 ? 'end' : 'middle'} className={s.tickInk}>
              {shortDate(nights[sel]!.date)}
            </text>
          )}
          {hi !== null && <rect x={off + hi * bw} y={pt - 8} width={bw} height={H - pb - pt + 8} fill="var(--text)" fillOpacity={0.05} pointerEvents="none" />}
        </svg>
      )}
      {h && (
        <FloatTip x={off + hi! * bw + bw / 2} y={-8} width={W - pr}>
          <div className="tip-title">
            {shortDay(h.date)} {shortDate(h.date)}
          </div>
          <div className="tip-row">
            <b>{fmt(h.co2Mean)} ppm</b>
            <span className="lbl">average</span>
          </div>
          <div className="tip-row">
            <b>{fmt(h.minutesCo2Over1000)} min</b>
            <span className="lbl">over 1,000</span>
          </div>
        </FloatTip>
      )}
    </div>
  );
}

// ───────────── Linear meter (replaces the speedometer) ─────────────
/**
 * A linear scale with labelled ticks, an ink marker for the reading and a signal tick for the limit / need.
 * `extra` adds a muted dashed marker (e.g. "with an ERV").
 */
export function Meter({
  min,
  max,
  step,
  value,
  valueLabel,
  limit,
  limitLabel,
  extra,
  fmtTick,
  unitLabel,
  label,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  valueLabel: string;
  limit: number;
  limitLabel: string;
  extra?: { v: number; label: string };
  fmtTick: (v: number) => string;
  unitLabel?: string;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(width, 240);
  const H = unitLabel ? 112 : 92;
  const x = scale(min, max, 1, W - 1);
  const yb = 52;
  const ticks: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
  const items = [
    { v: value, text: valueLabel, cls: s.tickInk },
    { v: limit, text: limitLabel, cls: s.tickSig },
    ...(extra ? [{ v: extra.v, text: extra.label, cls: s.tick }] : []),
  ]
    .filter((it) => Number.isFinite(it.v))
    .sort((a, b) => a.v - b.v);
  // Labels sit above their markers. Two close markers split their labels outwards (left one ends at its marker, right
  // one starts at it); anything still touching moves up a row.
  const edge = (v: number): 'start' | 'end' | 'middle' => (x(v) < 70 ? 'start' : x(v) > W - 70 ? 'end' : 'middle');
  const anchors = items.map((it) => edge(it.v));
  items.forEach((it, i) => {
    const nx = items[i + 1];
    if (nx && x(nx.v) - x(it.v) < 140) {
      if (anchors[i] === 'middle') anchors[i] = 'end';
      if (anchors[i + 1] === 'middle') anchors[i + 1] = 'start';
    }
  });
  const anchor = (i: number) => anchors[i]!;
  const ends = [-Infinity, -Infinity];
  const rowOf = items.map((it, i) => {
    const w = it.text.length * 7.6 + 10;
    const a = anchors[i];
    const x0 = a === 'start' ? x(it.v) : a === 'end' ? x(it.v) - w : x(it.v) - w / 2;
    const r = x0 > ends[0]! ? 0 : 1;
    ends[r] = x0 + w;
    return r;
  });
  return (
    <div ref={ref} className={s.chart} style={{ height: H }} role="img" aria-label={label}>
      {width > 0 && (
        <svg width={W} height={H} aria-hidden>
          <line x1={x(min)} x2={x(max)} y1={yb} y2={yb} stroke="var(--hairline-2)" />
          {ticks.map((v, i) => (
            <g key={v}>
              <line x1={x(v)} x2={x(v)} y1={yb - 6} y2={yb} stroke="var(--hairline-2)" />
              {(i % 2 === 0 || W / ticks.length > 72) && (
                <text x={x(v)} y={yb + 24} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'} className={s.tick}>
                  {fmtTick(v)}
                </text>
              )}
            </g>
          ))}
          {Number.isFinite(value) && <rect x={x(min)} y={yb - 3} width={Math.max(0, x(Math.min(max, value)) - x(min))} height={3} fill="var(--text)" className={s.meterFill} />}
          {items.map((it, i) => {
            const xx = x(Math.min(max, Math.max(min, it.v)));
            const ty = rowOf[i] ? 12 : 30;
            const color = it.cls === s.tickSig ? 'var(--signal)' : it.cls === s.tickInk ? 'var(--text)' : 'var(--muted)';
            return (
              <g key={it.text}>
                <line x1={xx} x2={xx} y1={ty + 6} y2={yb + 4} stroke={color} strokeWidth={it.cls === s.tick ? 1.5 : 3} strokeDasharray={it.cls === s.tick ? '3 3' : undefined} />
                <text x={anchor(i) === 'start' ? xx - 1.5 : anchor(i) === 'end' ? xx + 1.5 : xx} y={ty} textAnchor={anchor(i)} className={it.cls}>
                  {it.text}
                </text>
              </g>
            );
          })}
          {unitLabel && (
            <text x={W - 1} y={H - 6} textAnchor="end" className={s.tick}>
              {unitLabel}
            </text>
          )}
        </svg>
      )}
    </div>
  );
}

// ───────────── Fresh-air (ACH) tracker ─────────────
export function AchTracker({ points, needed }: { points: { date: string; ts: number; ach: number | null; ajar: boolean; truth?: number }[]; needed: number }) {
  const valid = points.filter((p) => p.ach !== null);
  const roll = useMemo(
    () =>
      points.map((p, i) => {
        const win = points.slice(Math.max(0, i - 6), i + 1).filter((q) => q.ach !== null && !q.ajar).map((q) => q.ach!);
        return { ts: p.ts, v: win.length >= 3 ? median(win) : null };
      }),
    [points],
  );
  if (valid.length < 2) return null;
  // Robust top: a few decay fits are glitchy outliers; they're clipped at the top edge (still in the table).
  const max = Math.max(needed + 0.1, quantile(valid.map((p) => p.ach!), 0.97) * 1.15);
  const ticks = niceTicks(0, max, 4);
  const top = ticks.at(-1)!;
  const from = points[0]!.ts;
  const to = points.at(-1)!.ts;
  const monthTicks = points.filter((p) => p.date.endsWith('-01')).map((p) => p.ts);
  return (
    <TimeChart
      from={from}
      to={to}
      domain={[0, top]}
      ticks={ticks.filter((t) => Math.abs(t - needed) > top * 0.06)}
      fmtY={(v) => fmt(v, 1)}
      xTicks={monthTicks.length ? monthTicks : [from, to]}
      fmtX={(t) => shortDate(new Date(t).toISOString().slice(0, 10))}
      snap={valid.map((p) => p.ts)}
      label={`Fresh air per night; ${fmt(needed, 2)} air changes per hour needed`}
      hover={(t) => {
        const d = valid.find((p) => p.ts === t);
        if (!d) return null;
        return {
          title: `${shortDay(d.date)} ${shortDate(d.date)}`,
          rows: [{ label: d.ajar ? 'door ajar' : 'door closed', value: `${fmt(d.ach, 2)} /h` }, ...(d.truth !== undefined ? [{ label: 'sim truth', value: fmt(d.truth, 2) }] : [])],
          dots: [{ v: d.ach!, color: 'var(--text)' }],
        };
      }}
    >
      {(g) => (
        <>
          <Threshold g={g} v={needed} text={fmt(needed, 2)} />
          {valid.map((p) =>
            p.ajar ? (
              <circle key={p.date} cx={g.x(p.ts)} cy={g.yc(p.ach!)} r={4} fill="var(--bg)" stroke="var(--text)" strokeWidth={1.5} />
            ) : (
              <circle key={p.date} cx={g.x(p.ts)} cy={g.yc(p.ach!)} r={3} fill="var(--muted)" />
            ),
          )}
          <DrawPath d={seriesPath(g, roll, 3 * 86_400_000)} fill="none" stroke="var(--text)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}
    </TimeChart>
  );
}

/** The CO₂ band word for a reading, as a sentence ("Fresh.", "Stuffy."). */
export const bandWord = (v: number) => co2Band(v).label;
