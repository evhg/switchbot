'use client';
/** Room tab live strip: one tile per reading with a count-up value, a 6-hour area sparkline and a ping on each fresh reading. */
import { useRef, useState, type ReactNode } from 'react';
import { CountUp, DrawPath } from '../../motion.tsx';
import { Icon, type IconName } from '../../icons.tsx';
import { useWidth } from '../../ui.tsx';
import { AreaGradient, areaPath, linePath, scale, useSvgId } from '../common.tsx';
import s from './room.module.css';

/** 6-hour sparkline: gradient wash + line that draws in, end dot with a slow live halo. Touch shows the value. */
export function LiveSpark({ values, color, height = 46, format }: { values: { ts: number; v: number }[]; color: string; height?: number; format: (v: number, ts: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gid = useSvgId('ls');
  const [hi, setHi] = useState<number | null>(null);
  const pts = values.filter((p) => Number.isFinite(p.v));
  const w = Math.max(40, width);
  if (pts.length < 2) return <div ref={ref} className={s.sparkWrap} style={{ height }} />;
  const vs = pts.map((p) => p.v);
  const lo = Math.min(...vs);
  const hiV = Math.max(...vs);
  const pad = (hiV - lo) * 0.15 || 0.5;
  const x = scale(pts[0]!.ts, pts.at(-1)!.ts, 0, w - 14);
  const y = scale(lo - pad, hiV + pad, height - 2, 8);
  const xy = pts.map((p) => ({ x: x(p.ts), y: y(p.v) }));
  const last = xy.at(-1)!;
  const h = hi !== null ? pts[hi] : undefined;
  return (
    <div ref={ref} className={s.sparkWrap} style={{ height }}>
      {width > 0 && (
        <svg
          width={w}
          height={height}
          aria-hidden
          style={{ touchAction: 'pan-y' }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - r.left;
            let best = 0;
            for (let i = 0; i < xy.length; i++) if (Math.abs(xy[i]!.x - px) < Math.abs(xy[best]!.x - px)) best = i;
            setHi(best);
          }}
          onPointerLeave={() => setHi(null)}
        >
          <defs>
            <AreaGradient id={gid} color={color} from={0.28} />
          </defs>
          <DrawPath d={linePath(xy)} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
          {/* Wash fades in after the line has drawn (.draw.in ~ .fade-late). */}
          <path className="fade-late" d={areaPath(xy, height)} fill={`url(#${gid})`} />
          <circle className={s.endHalo} cx={last.x} cy={last.y} r={3} fill={color} />
          <circle className="fade-late" cx={last.x} cy={last.y} r={3} fill={color} stroke="var(--surface)" strokeWidth={1.5} />
          {h && (
            <>
              <line x1={x(h.ts)} x2={x(h.ts)} y1={0} y2={height} stroke="var(--hairline-2)" />
              <circle cx={x(h.ts)} cy={y(h.v)} r={3} fill={color} stroke="var(--surface)" strokeWidth={1.5} />
            </>
          )}
        </svg>
      )}
      {h && (
        <div className={s.sparkTip} style={{ left: Math.min(Math.max(x(h.ts), 50), w - 50) }}>
          <div className="tip">{format(h.v, h.ts)}</div>
        </div>
      )}
    </div>
  );
}

export function LiveTile({
  label,
  icon,
  value,
  dp,
  unit,
  color,
  band,
  delta,
  stamp,
  spark,
}: {
  label: string;
  icon: IconName;
  value: number;
  dp: number;
  unit: string;
  color: string;
  /** CSS colour of the CO₂ band: the tile border glows in it. */
  band?: string;
  delta: ReactNode;
  /** Timestamp of the reading; a change after the first one pings the tile. */
  stamp: number | null;
  spark: ReactNode;
}) {
  const first = useRef<number | null>(null);
  if (first.current === null && stamp !== null) first.current = stamp;
  const fresh = stamp !== null && first.current !== null && stamp !== first.current;
  const style = { ['--tile-c' as string]: color, ...(band ? { ['--band-c' as string]: band } : {}) };
  return (
    <div className={`${s.tile} ${band ? s.banded : ''}`} style={style}>
      {fresh && <span key={stamp} className={s.ping} aria-hidden />}
      <div className={`${s.tileLabel} t-label`}>
        <Icon name={icon} size={14} />
        {label}
      </div>
      <div className={s.tileValue}>
        <CountUp value={value} dp={dp} />
        <span className="t-unit">{unit}</span>
      </div>
      <div className={s.tileDelta}>{delta}</div>
      <div className={s.tileSpark}>{spark}</div>
    </div>
  );
}
