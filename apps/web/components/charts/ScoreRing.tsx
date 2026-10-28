'use client';
import { fmt } from '@/lib/format.ts';

/** Oura-style ring(s). Outer ring carries the headline score; an optional inner ring a second score. */
export function ScoreRing({
  value,
  inner,
  color,
  size = 96,
  label,
  selected,
  onClick,
  centerSub,
}: {
  value: number;
  inner?: number;
  color: string;
  size?: number;
  label: string;
  selected?: boolean;
  onClick?: () => void;
  centerSub?: string;
}) {
  const stroke = Math.max(7, size * 0.085);
  const r = size / 2 - stroke / 2 - 1;
  const ri = r - stroke - 3;
  const arc = (rad: number, v: number) => {
    const c = 2 * Math.PI * rad;
    const f = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) / 100 : 0;
    return { strokeDasharray: `${c * f} ${c}`, c };
  };
  const o = arc(r, value);
  const i = inner !== undefined ? arc(ri, inner) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`${label}: ${fmt(value)}${inner !== undefined ? `, recovery ${fmt(inner)}` : ''}`}
      style={{ background: 'none', border: 0, padding: 0, display: 'grid', justifyItems: 'center', gap: 4, width: '100%' }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ opacity: selected === false ? 0.55 : 1, transition: 'opacity .15s' }}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`} fill="none" strokeLinecap="round">
          <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--ring-track)" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} strokeDasharray={o.strokeDasharray} />
          {i && (
            <>
              <circle cx={size / 2} cy={size / 2} r={ri} stroke="var(--ring-track)" strokeWidth={stroke * 0.7} />
              <circle cx={size / 2} cy={size / 2} r={ri} stroke={color} strokeOpacity={0.5} strokeWidth={stroke * 0.7} strokeDasharray={i.strokeDasharray} />
            </>
          )}
        </g>
        <text x="50%" y={centerSub ? '47%' : '50%'} textAnchor="middle" dominantBaseline="central" fill="var(--text)" fontSize={size * 0.28} fontWeight={600}>
          {fmt(value)}
        </text>
        {centerSub && (
          <text x="50%" y="68%" textAnchor="middle" dominantBaseline="central" fill="var(--muted)" fontSize={Math.max(10, size * 0.11)}>
            {centerSub}
          </text>
        )}
      </svg>
    </button>
  );
}
