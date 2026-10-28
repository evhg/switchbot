'use client';
import type { ReactNode } from 'react';

/** Shared Recharts chrome: recessive hairline axes, muted ticks, colours from CSS tokens. */
export const AXIS = {
  tick: { fill: 'var(--muted)', fontSize: 11 },
  axisLine: { stroke: 'var(--axis)' },
  tickLine: false,
  stroke: 'var(--axis)',
} as const;
export const GRID = { stroke: 'var(--grid)', strokeDasharray: undefined, vertical: false } as const;
export const MARGIN = { top: 8, right: 10, bottom: 0, left: 0 };
export const Y_WIDTH = 34;
export const CURSOR = { stroke: 'var(--muted)', strokeWidth: 1 };

export interface TipItem {
  name?: string | number;
  value?: unknown;
  color?: string;
  stroke?: string;
  fill?: string;
  dataKey?: unknown;
  payload?: unknown;
}

/** Recharts tooltip body: value first (strong), series name secondary, keyed by a short line. */
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
