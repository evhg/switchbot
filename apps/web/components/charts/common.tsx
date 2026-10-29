'use client';
/**
 * Shared chart theme, v2 (docs/DESIGN.md §7). Every Recharts chart spreads these; custom SVG charts use the helpers.
 * Rules: the title is the finding; label series on the chart (no legends); ≤ 2 hues + a dashed --muted series;
 * ticks are .cap (13/14/15 px, CSS sets the size), tabular, --muted.
 *
 *   <XAxis {...AXIS} … />  <YAxis width={Y_WIDTH} orientation="right" {...AXIS} … />  <CartesianGrid {...GRID} />
 *   <Tooltip cursor={CURSOR} content={(p) => <Tip {...p} … />} />          --surface, r-m, value-first
 *   <Line {...useChartAnim()} strokeWidth={STROKE.primary} … />           draws once on mount; off at night / reduced
 *   <defs><AreaGradient id="g" color="var(--text)" /></defs>              v2: flat 6 % ink wash (no gradient)
 *   PLAN_LINE   – dashed 4/4 --muted plan / setpoint (on Tonight & plan charts use --signal instead)
 *   THRESHOLD   – dotted 2/3 --signal limit (1,000 ppm, 60 % RH); thresholdLabel(text) labels its right end;
 *                 tint only the area beyond it with --signal-soft
 *   REF_LINE    – v1 name, = PLAN_LINE. refLabel(text) = right-end label.
 *   GHOST       – opacity for unrevealed data ('var(--ghost)')
 *   SERIES      – CSS var per data series (you, erik, temp, co2, rh, setpoint, …)
 *   mix(color, pct), scale(), linePath(), areaPath(), thinByPixels()
 */
import { useId, type ReactNode } from 'react';
import { useMotionPrefs } from '../motion.tsx';

/** @deprecated v1 mono label face; v2 has one family. */
export const MONO = 'var(--font)';

/** Recessive axes: no axis line, no tick lines, --t-cap muted tabular ticks (size from CSS). */
export const AXIS = {
  tick: { fill: 'var(--muted)', fontSize: 13, fontFamily: 'var(--font)' },
  axisLine: false,
  tickLine: false,
  stroke: 'var(--axis)',
  tickMargin: 6,
} as const;
/** Horizontal gridlines only, at key values. */
export const GRID = { stroke: 'var(--grid)', strokeDasharray: undefined, vertical: false } as const;
export const MARGIN = { top: 8, right: 8, bottom: 0, left: 0 };
export const Y_WIDTH = 44;
/** Crosshair: 1 px hairline. */
export const CURSOR = { stroke: 'var(--hairline-2)', strokeWidth: 1 };
/** Plan / setpoint: dashed 4/4 --muted. */
export const PLAN_LINE = { stroke: 'var(--muted)', strokeDasharray: '4 4', strokeWidth: 1.5 } as const;
/** Limit (1,000 ppm, 60 % RH): dotted 2/3 in the signal colour. */
export const THRESHOLD = { stroke: 'var(--signal)', strokeDasharray: '2 3', strokeWidth: 1 } as const;
/** v1 name for reference lines; now the plan style. */
export const REF_LINE = PLAN_LINE;
/** Opacity of not-yet-revealed data. */
export const GHOST = 'var(--ghost)';
const labelBase = {
  position: 'insideTopRight' as const,
  fontSize: 13,
  fontFamily: 'var(--font)',
  stroke: 'var(--bg)',
  strokeWidth: 4,
  strokeLinejoin: 'round' as const,
  style: { paintOrder: 'stroke' as const },
};
/** Right-end label for a plan / reference line, knocked out of whatever runs behind it. */
export const refLabel = (value: string) => ({ ...labelBase, value, fill: 'var(--muted)' });
/** Right-end label for a threshold line. */
export const thresholdLabel = (value: string) => ({ ...labelBase, value, fill: 'var(--signal)' });
/** Spread on a labelled ReferenceLine so it (and its label) draw above lines and dots. */
export const REF_FRONT = { zIndex: 650 } as const;

/** Line widths (§7.1): 2 px hero series, 1.5 px others, 1 px references. */
export const STROKE = { primary: 2, secondary: 1.5, ref: 1 } as const;

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

/** Area wash for <Area fill="url(#id)">. v2: a flat 6 % wash (no gradients); `from`/`to` are ignored. Put in <defs>. */
export function AreaGradient({ id, color }: { id: string; color: string; from?: number; to?: number }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.06 }} />
      <stop offset="100%" style={{ stopColor: color, stopOpacity: 0.06 }} />
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

/** Recharts tooltip body (§7.1): time in .cap above, values in .sec with tabular numerals, keyed by a short bar. */
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

/** Floating tooltip for custom SVG charts, clamped inside the chart box. */
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
