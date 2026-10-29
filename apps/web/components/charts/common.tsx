'use client';
/**
 * Shared chart theme (docs/DESIGN.md §8). Every Recharts chart spreads these; custom SVG charts use the helpers.
 *
 *   <XAxis {...AXIS} … />  <YAxis width={Y_WIDTH} {...AXIS} … />  <CartesianGrid {...GRID} />
 *   <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} … />} />          glass chip, mono, value-first
 *   <Line {...useChartAnim()} … />                                          animates once (900 ms) on mount;
 *        off in night mode and under reduced motion. Mount the chart in <LazyMount> (components/motion.tsx)
 *        so it animates when scrolled into view, not on page load.
 *   <defs><AreaGradient id="g-co2" color="var(--co2)" /></defs>  <Area fill="url(#g-co2)" />
 *        vertical 35 % → 0 % wash (flat 12 % in night mode — no gradients there).
 *   REF_LINE  – props for dashed reference lines (target °C, 1,000 ppm); refLabel(text) for their right label.
 *   SERIES    – CSS var per data series (you, erik, temp, co2, rh, setpoint, …).
 *   mix(color, pct) – color-mix(in oklab, color pct%, transparent) for washes.
 *   scale(), linePath(), areaPath() – custom-SVG helpers.
 */
import { useId, type ReactNode } from 'react';
import { useMotionPrefs } from '../motion.tsx';

export const MONO = 'var(--font-mono)';

/** Recessive axes: no axis line, no tick lines, mono 9.5 px muted ticks. */
export const AXIS = {
  tick: { fill: 'var(--muted)', fontSize: 9.5, fontFamily: 'var(--font-mono)' },
  axisLine: false,
  tickLine: false,
  stroke: 'var(--axis)',
  tickMargin: 3,
} as const;
/** Horizontal gridlines only. */
export const GRID = { stroke: 'var(--grid)', strokeDasharray: undefined, vertical: false } as const;
export const MARGIN = { top: 8, right: 10, bottom: 0, left: 0 };
export const Y_WIDTH = 34;
/** Crosshair: 1 px hairline. */
export const CURSOR = { stroke: 'var(--hairline-2)', strokeWidth: 1 };
/** Dashed reference line (target °C, 1,000 ppm). */
export const REF_LINE = { stroke: 'var(--text-2)', strokeOpacity: 0.6, strokeDasharray: '3 4', strokeWidth: 1 } as const;
/** Right-end label for a reference line, knocked out of whatever data runs behind it. */
export const refLabel = (value: string) => ({
  value,
  position: 'insideTopRight' as const,
  fill: 'var(--muted)',
  fontSize: 9.5,
  fontFamily: 'var(--font-mono)',
  stroke: 'var(--surface)',
  strokeWidth: 3,
  strokeLinejoin: 'round' as const,
  style: { paintOrder: 'stroke' as const },
});
/** Spread on a labelled ReferenceLine so it (and its label) draw above lines and dots. */
export const REF_FRONT = { zIndex: 650 } as const;

/** Line widths (§8.1). */
export const STROKE = { primary: 2.2, secondary: 1.5, ref: 1 } as const;

/** Series colours. Text is never coloured by series — use a Key dot next to the label. */
export const SERIES = {
  you: 'var(--person-a)',
  erik: 'var(--person-b)',
  temp: 'var(--temp)',
  co2: 'var(--co2)',
  rh: 'var(--rh)',
  setpoint: 'var(--setpoint)',
  dew: 'var(--dew)',
  outdoor: 'var(--outdoor)',
  good: 'var(--good)',
  warn: 'var(--warn)',
  serious: 'var(--serious)',
  critical: 'var(--critical)',
} as const;

/** CO₂ band washes, bottom → top. */
export const CO2_BANDS = [
  { from: 0, to: 800, fill: 'var(--band-good)' },
  { from: 800, to: 1000, fill: 'var(--band-warn)' },
  { from: 1000, to: 1500, fill: 'var(--band-serious)' },
  { from: 1500, to: Infinity, fill: 'var(--band-critical)' },
] as const;

/** Calm's CO₂ tolerance ribbon: ±(50 ppm + 5 %). */
export const co2Tolerance = (ppm: number) => 50 + 0.05 * ppm;

/** Transparent wash of a colour (works with CSS vars). */
export const mix = (color: string, pct: number) => `color-mix(in oklab, ${color} ${pct}%, transparent)`;

/** Recharts animation props: animate once on mount in day themes, never in night / reduced motion. */
export function useChartAnim(duration = 900) {
  const { level } = useMotionPrefs();
  return { isAnimationActive: level === 'full', animationDuration: duration, animationEasing: 'ease-out' as const };
}

/** Vertical area gradient (35 % → 0 %), flat 12 % in night mode. Put inside <defs>. */
export function AreaGradient({ id, color, from = 0.35, to = 0 }: { id: string; color: string; from?: number; to?: number }) {
  const { night } = useMotionPrefs();
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style={{ stopColor: color, stopOpacity: night ? 0.12 : from }} />
      <stop offset="100%" style={{ stopColor: color, stopOpacity: night ? 0.12 : to }} />
    </linearGradient>
  );
}

/** Unique, SVG-safe id for gradients / clip paths. */
export function useSvgId(prefix = 'g') {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

export interface TipItem {
  name?: string | number;
  value?: unknown;
  color?: string;
  stroke?: string;
  fill?: string;
  dataKey?: unknown;
  payload?: unknown;
}

/** Recharts tooltip body: value first (strong), series name secondary, keyed by a short bar. */
export function Tip({
  active,
  payload,
  label,
  title,
  rows,
}: {
  active?: boolean;
  payload?: readonly TipItem[];
  label?: unknown;
  title?: (label: unknown, payload: readonly TipItem[]) => ReactNode;
  rows?: (payload: readonly TipItem[]) => { label: ReactNode; value: ReactNode; color?: string; dash?: boolean }[];
}) {
  if (!active || !payload?.length) return null;
  const items = rows
    ? rows(payload)
    : payload
        .filter((p) => p.value !== null && p.value !== undefined && !(typeof p.value === 'number' && Number.isNaN(p.value)))
        .map((p) => ({ label: String(p.name ?? ''), value: typeof p.value === 'number' ? p.value.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(p.value), color: p.stroke ?? p.color ?? p.fill, dash: false }));
  if (!items.length) return null;
  return (
    <div className="tip">
      {title && <div className="tip-title">{title(label, payload)}</div>}
      {items.map((r, i) => (
        <div className="tip-row" key={i}>
          {r.color && <i className="tip-key" style={{ borderColor: r.color, borderTopStyle: r.dash ? 'dashed' : 'solid' }} />}
          <b>{r.value}</b>
          <span className="lbl">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Floating tooltip for custom SVG charts, clamped inside the chart box, lifted 24 px above the touch point. */
export function FloatTip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 70), Math.max(70, width - 70));
  return (
    <div className="float-tip" style={{ left, top: y }}>
      <div className="tip">{children}</div>
    </div>
  );
}

export function TipRow({ color, value, label, dash }: { color?: string; value: ReactNode; label: ReactNode; dash?: boolean }) {
  return (
    <div className="tip-row">
      {color && <i className="tip-key" style={{ borderColor: color, borderTopStyle: dash ? 'dashed' : 'solid' }} />}
      <b>{value}</b>
      <span className="lbl">{label}</span>
    </div>
  );
}

/** Linear scale helper for custom SVG. */
export function scale(d0: number, d1: number, r0: number, r1: number) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

/** SVG path through points, breaking at non-finite values or gaps longer than `maxGap` in x. */
export function linePath(pts: readonly { x: number; y: number }[], maxGap = Infinity): string {
  let d = '';
  let prevX = -Infinity;
  let pen = false;
  for (const p of pts) {
    if (!Number.isFinite(p.y) || !Number.isFinite(p.x)) {
      pen = false;
      continue;
    }
    d += `${pen && p.x - prevX <= maxGap ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    pen = true;
    prevX = p.x;
  }
  return d;
}

/** Closed area under a line down to `baseY` (finite points only, one segment). */
export function areaPath(pts: readonly { x: number; y: number }[], baseY: number): string {
  const f = pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (f.length < 2) return '';
  return `M${f[0]!.x.toFixed(1)},${baseY.toFixed(1)}${f.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')}L${f.at(-1)!.x.toFixed(1)},${baseY.toFixed(1)}Z`;
}

/** Keeps at most one point per `px` pixels of x (story charts: ≤ 1 point / 2 px). */
export function thinByPixels<T extends { x: number }>(pts: readonly T[], px = 2): T[] {
  const out: T[] = [];
  let last = -Infinity;
  for (const p of pts) {
    if (p.x - last >= px) {
      out.push(p);
      last = p.x;
    }
  }
  if (pts.length && out.at(-1) !== pts.at(-1)) out.push(pts.at(-1)!);
  return out;
}
