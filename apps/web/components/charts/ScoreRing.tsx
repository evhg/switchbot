'use client';
import { useRef, useState } from 'react';
import { fmt } from '@/lib/format.ts';
import { useCountUp, useInViewCallback, useMotionPrefs } from '../motion.tsx';
import { useSvgId } from './common.tsx';

/**
 * Score ring(s), v2: outer = headline score, optional inner = second score (recovery). Flat stroke in `color`
 * (no gradient, no glow), thin numerals (300), draws in once on reveal. Night / reduced motion: final state.
 * v2 prefers the linear score scale (§7.2); rings remain for compact person scores.
 *
 *   <ScoreRing value={82} inner={89} color="var(--person-a)" label="You sleep" size={96}
 *              onClick={…} selected centerSub="rec 89" animate glow showValue />
 */
export function ScoreRing({
  value,
  inner,
  color,
  size = 96,
  label,
  selected,
  onClick,
  centerSub,
  animate = true,
  glow = true,
  showValue = true,
}: {
  value: number;
  inner?: number;
  color: string;
  size?: number;
  label: string;
  selected?: boolean;
  onClick?: () => void;
  centerSub?: string;
  animate?: boolean;
  glow?: boolean;
  /** Draw the number in the centre (default true). */
  showValue?: boolean;
}) {
  const { night, level } = useMotionPrefs();
  const ref = useRef<HTMLButtonElement>(null);
  const num = useRef<SVGTextElement>(null);
  const [drawn, setDrawn] = useState(!animate);
  useInViewCallback(ref, (v) => v && setDrawn(true), { threshold: 0.3, rootMargin: '0px' });
  useCountUp(num, value, { dp: 0, format: (v) => fmt(v), duration: 1300 });
  const gid = useSvgId('ring');
  const fid = useSvgId('ringblur');

  const stroke = Math.max(3, size * 0.045);
  const innerStroke = Math.max(3, stroke * 0.57);
  const r = size / 2 - stroke / 2 - 2;
  const ri = r - stroke / 2 - innerStroke / 2 - 3;
  const arc = (rad: number, v: number) => {
    const c = 2 * Math.PI * rad;
    const f = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) / 100 : 0;
    return { c, off: drawn || level === 'none' ? c * (1 - f) : c };
  };
  const o = arc(r, value);
  const i = inner !== undefined ? arc(ri, inner) : null;
  const cx = size / 2;
  void glow;
  void night;
  const showGlow = false;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={onClick ? 'tap' : undefined}
      aria-label={`${label}: ${fmt(value)}${inner !== undefined ? `, recovery ${fmt(inner)}` : ''}`}
      style={{ background: 'none', border: 0, padding: 0, display: 'grid', justifyItems: 'center', gap: 4, width: '100%', cursor: onClick ? 'pointer' : 'default' }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ opacity: selected === false ? 0.5 : 1, transition: 'opacity .2s', overflow: 'visible' }} aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: color }} />
            <stop offset="100%" style={{ stopColor: color }} />
          </linearGradient>
          {showGlow && (
            <filter id={fid} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation={size * 0.06} />
            </filter>
          )}
        </defs>
        <g transform={`rotate(-90 ${cx} ${cx})`} fill="none" strokeLinecap="round">
          {showGlow && (
            // Static twin at the final angle; only its opacity fades in after the draw (no per-frame filter work).
            <circle
              cx={cx}
              cy={cx}
              r={r}
              stroke={color}
              strokeWidth={stroke}
              strokeDasharray={o.c}
              strokeDashoffset={arc(r, value).c * (1 - Math.max(0, Math.min(100, value)) / 100)}
              filter={`url(#${fid})`}
              className="ring-glow"
              style={{ opacity: drawn ? 0.5 : 0, transition: `opacity 900ms var(--ease-out) ${level === 'full' ? 900 : 0}ms` }}
            />
          )}
          <circle cx={cx} cy={cx} r={r} stroke="var(--ring-track)" strokeWidth={stroke} />
          <circle cx={cx} cy={cx} r={r} stroke={`url(#${gid})`} strokeWidth={stroke} strokeDasharray={o.c} strokeDashoffset={o.off} className="ring-arc" />
          {i && (
            <>
              <circle cx={cx} cy={cx} r={ri} stroke="var(--ring-track)" strokeWidth={innerStroke} />
              <circle cx={cx} cy={cx} r={ri} stroke={color} strokeOpacity={0.55} strokeWidth={innerStroke} strokeDasharray={i.c} strokeDashoffset={i.off} className="ring-arc" style={{ transitionDelay: '120ms' }} />
            </>
          )}
        </g>
        <text
          ref={num}
          display={showValue ? undefined : 'none'}
          x="50%"
          y={centerSub ? '46%' : '50%'}
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--text)"
          fontSize={size * 0.3}
          fontWeight={300}
          letterSpacing="-0.03em"
          style={{ fontFamily: 'var(--font)', fontVariantNumeric: 'tabular-nums' }}
        >
          {fmt(value)}
        </text>
        {centerSub && (
          <text x="50%" y="69%" textAnchor="middle" dominantBaseline="central" fill="var(--text-2)" fontSize={Math.max(13, size * 0.12)} style={{ fontFamily: 'var(--font)' }}>
            {centerSub}
          </text>
        )}
      </svg>
    </button>
  );
}
