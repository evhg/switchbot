'use client';
/**
 * Room charts, v2 (docs/DESIGN.md §7). One custom-SVG time frame shared by every Room line chart so they read as one
 * system: horizontal gridlines only at the given ticks, y labels on the right, clock-time x axis, a hairline scrub
 * cursor with a value-first tooltip, and direct end labels (no legends).
 *
 *   <TimeChart from to domain={[lo, hi]} ticks={[…]} fmtY={(v) => `${v}°`} label="aria finding" hover={(t) => …}>
 *     {(g) => <path d={…g.x(t)…g.y(v)…} />}
 *   </TimeChart>
 */
import { useState, type ReactNode } from 'react';
import { hm, hourTicks } from '@/lib/format.ts';
import { useWidth } from '../../ui.tsx';
import { FloatTip, linePath, scale } from '../common.tsx';
import s from './room.module.css';

export interface Geo {
  W: number;
  H: number;
  /** Plot box. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  from: number;
  to: number;
  lo: number;
  hi: number;
  x: (t: number) => number;
  y: (v: number) => number;
  /** y clamped into the plot box (scales are clamped, §7.1). */
  yc: (v: number) => number;
  /** x of the y-axis tick labels. */
  tickX: number;
}

export interface HoverInfo {
  title: ReactNode;
  rows: { label: ReactNode; value: ReactNode; color?: string; dash?: boolean }[];
  /** Readout dots on the cursor: 7 px, --bg fill, 2 px stroke in the series colour. */
  dots?: { v: number; color: string }[];
}

export function TimeChart({
  from,
  to,
  domain,
  ticks,
  fmtY,
  label,
  height,
  xTicks,
  fmtX = hm,
  hover,
  snap,
  children,
  overlay,
  endPad = 0,
  className = '',
}: {
  from: number;
  to: number;
  domain: readonly [number, number];
  ticks: readonly number[];
  fmtY: (v: number) => string;
  /** The finding, for screen readers. */
  label: string;
  /** Fixed height; default scales with width (220 → 340). */
  height?: number;
  xTicks?: readonly number[];
  fmtX?: (t: number) => string;
  hover?: (t: number) => HoverInfo | null;
  /** Snap the cursor to these x values (e.g. one per night). */
  snap?: readonly number[];
  children: (g: Geo) => ReactNode;
  /** Drawn above the cursor (labels that must stay legible). */
  overlay?: (g: Geo) => ReactNode;
  /** Extra room right of the plot for direct end labels (EndLabels with `gutter`). */
  endPad?: number;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [ht, setHt] = useState<number | null>(null);
  const W = Math.max(width, 240);
  const H = height ?? Math.round(Math.max(220, Math.min(340, W * 0.34)));
  const right = W - 56 - endPad;
  const tickX = W - 44;
  const top = 28;
  const bottom = H - 32;
  const [lo, hi] = domain;
  const x = scale(from, to, 0, right);
  const y = scale(lo, hi, bottom, top);
  const yc = (v: number) => y(Math.min(hi, Math.max(lo, v)));
  const g: Geo = { W, H, left: 0, right, top, bottom, from, to, lo, hi, x, y, yc, tickX };
  const spanH = (to - from) / 3_600_000;
  const step = [1, 2, 3, 4, 6].find((st) => (spanH / st) * 64 < right) ?? 6;
  const xt = xTicks ?? hourTicks(from, to, step).filter((t) => x(t) > 18 && x(t) < right - 18);
  const info = ht !== null && hover ? hover(ht) : null;
  const pick = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    const px = Math.min(right, Math.max(0, clientX - r.left));
    let t = from + (px / right) * (to - from);
    if (snap?.length) t = snap.reduce((b, v) => (Math.abs(v - t) < Math.abs(b - t) ? v : b), snap[0]!);
    setHt(t);
  };
  return (
    <div ref={ref} className={`${s.chart} ${className}`} style={{ height: H }} role="img" aria-label={label}>
      {width > 0 && (
        <svg
          width={W}
          height={H}
          aria-hidden
          style={{ touchAction: 'pan-y' }}
          onPointerMove={hover ? (e) => pick(e.clientX, e.currentTarget) : undefined}
          onPointerDown={hover ? (e) => pick(e.clientX, e.currentTarget) : undefined}
          onPointerLeave={() => setHt(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={0} x2={right} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
              <text x={tickX} y={y(v) + 5} className={s.tick}>
                {fmtY(v)}
              </text>
            </g>
          ))}
          <line x1={0} x2={right} y1={bottom} y2={bottom} stroke="var(--axis)" />
          {xt.map((t) => (
            <text key={t} x={x(t)} y={H - 8} textAnchor={xTicks && x(t) < 40 ? 'start' : xTicks && x(t) > right - 40 ? 'end' : 'middle'} className={s.tick}>
              {fmtX(t)}
            </text>
          ))}
          {children(g)}
          {info && ht !== null && (
            <g pointerEvents="none">
              <line x1={x(ht)} x2={x(ht)} y1={top - 8} y2={bottom} stroke="var(--hairline-2)" />
              {info.dots?.filter((d) => Number.isFinite(d.v)).map((d, i) => <circle key={i} cx={x(ht)} cy={yc(d.v)} r={3.5} fill="var(--bg)" stroke={d.color} strokeWidth={2} />)}
            </g>
          )}
          {overlay?.(g)}
        </svg>
      )}
      {info && ht !== null && (
        <FloatTip x={x(ht)} y={-8} width={right}>
          <div className="tip-title">{info.title}</div>
          {info.rows.map((r, i) => (
            <div className="tip-row" key={i}>
              {r.color && <i className="tip-key" style={{ borderColor: r.color, borderTopStyle: r.dash ? 'dashed' : 'solid' }} />}
              <b>{r.value}</b>
              <span className="lbl">{r.label}</span>
            </div>
          ))}
        </FloatTip>
      )}
    </div>
  );
}

/** Path for a series sampled as {ts, v}; breaks at gaps longer than `gapMs`. Values are clamped to the domain. */
export function seriesPath(g: Geo, pts: readonly { ts: number; v: number | null }[], gapMs = 20 * 60_000, clip = false) {
  return linePath(
    pts.map((p) => ({ x: g.x(p.ts), y: p.v === null || !Number.isFinite(p.v) || (clip && (p.v > g.hi || p.v < g.lo)) ? NaN : g.yc(p.v) })),
    g.x(g.from + gapMs) - g.x(g.from),
  );
}

/** Step-after path (setpoints): holds each value until the next. */
export function stepPath(g: Geo, pts: readonly { ts: number; v: number | null }[], end: number) {
  let d = '';
  let pen = false;
  pts.forEach((p, i) => {
    const next = pts[i + 1]?.ts ?? end;
    if (p.v === null || !Number.isFinite(p.v)) {
      pen = false;
      return;
    }
    const yy = g.yc(p.v).toFixed(1);
    d += `${pen ? 'L' : 'M'}${g.x(p.ts).toFixed(1)},${yy}L${g.x(next).toFixed(1)},${yy}`;
    pen = true;
  });
  return d;
}

/**
 * Direct end labels for series (§7.1 "label directly"), stacked so they never collide. Each label sits just left of
 * the plot's right edge, above its line, knocked out of whatever runs behind it.
 */
export function EndLabels({ g, items, at, gutter }: { g: Geo; items: { text: string; v: number; tone?: 'ink' | 'muted' | 'signal' }[]; at?: number; /** Place labels right of the plot (needs TimeChart endPad). */ gutter?: boolean }) {
  const xx = gutter ? g.right + 10 : (at ?? g.right - 4);
  const placed = items
    .filter((it) => Number.isFinite(it.v))
    .map((it) => ({ ...it, y: g.yc(it.v) + (gutter ? 5 : -10) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < placed.length; i++) if (placed[i]!.y - placed[i - 1]!.y < 18) placed[i]!.y = placed[i - 1]!.y + 18;
  return (
    <g pointerEvents="none">
      {placed.map((p) => (
         <text key={p.text} x={xx} y={Math.max(g.top - 6, p.y)} textAnchor={gutter ? 'start' : 'end'} className={`${s.knock} ${p.tone === 'signal' ? s.tickSig : p.tone === 'muted' ? s.tick : s.tickInk}`}>
          {p.text}
        </text>
      ))}
    </g>
  );
}

/** Dotted signal threshold (1,000 ppm, needed ACH) with its value in the right gutter. */
export function Threshold({ g, v, text }: { g: Geo; v: number; text: string }) {
  if (v < g.lo || v > g.hi) return null;
  return (
    <g pointerEvents="none">
      <line x1={0} x2={g.right} y1={g.y(v)} y2={g.y(v)} stroke="var(--signal)" strokeDasharray="2 3" />
      <text x={g.tickX} y={g.y(v) + 5} className={s.tickSig}>
        {text}
      </text>
    </g>
  );
}

/** Vertical marker (lights out, now) with a caption at the top of the plot. */
export function Marker({ g, t, text, anchor = 'start' }: { g: Geo; t: number; text: string; anchor?: 'start' | 'end' }) {
  if (t < g.from || t > g.to) return null;
  const xx = g.x(t);
  return (
    <g pointerEvents="none">
      <line x1={xx} x2={xx} y1={g.top - 8} y2={g.bottom} stroke="var(--hairline-2)" />
      <text x={anchor === 'start' ? xx + 6 : xx - 6} y={g.top - 12} textAnchor={anchor} className={s.tick}>
        {text}
      </text>
    </g>
  );
}

/** Even ticks between lo and hi at `step`. */
export function stepTicks(lo: number, hi: number, step: number) {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}
