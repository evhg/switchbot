'use client';
import { useMemo, useState } from 'react';
import { downsample, targetAt, type Night, type Person, type RoomEvent, type SleepStage, type TemperatureCurve } from '@sleep-lab/core';
import { CO2_BANDS, fmt, hm, hourTicks, MIN } from '@/lib/format.ts';
import { useWidth } from '../ui.tsx';
import { FloatTip, linePath, scale, TipRow } from './common.tsx';

export const STAGE_ORDER: SleepStage[] = ['awake', 'rem', 'light', 'deep'];
export const STAGE_LABEL: Record<SleepStage, string> = { awake: 'Awake', rem: 'REM', light: 'Light', deep: 'Deep' };
export const stageColor = (s: SleepStage) => `var(--stage-${s})`;

const L = 44;
const R = 8;

export function EventGlyph({ kind, x, y, s = 1 }: { kind: RoomEvent['kind'] | 'ac'; x: number; y: number; s?: number }) {
  const t = `translate(${x} ${y}) scale(${s})`;
  const st = { fill: 'none', stroke: 'var(--text-2)', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  switch (kind) {
    case 'shower':
      return <path transform={t} d="M0,-6 C3,-2 4.5,0.5 4.5,2.5 A4.5,4.5 0 0 1 -4.5,2.5 C-4.5,0.5 -3,-2 0,-6Z" {...st} />;
    case 'door_open':
      return (
        <g transform={t} {...st}>
          <rect x={-4} y={-6} width={8} height={12} rx={1} />
          <circle cx={2} cy={0} r={0.6} fill="var(--text-2)" />
        </g>
      );
    case 'in_bed':
    case 'both_in_bed':
      return (
        <g transform={t} {...st}>
          <path d="M-5,-3 L0,2 L5,-3" />
          {kind === 'both_in_bed' && <path d="M-5,1 L0,6 L5,1" />}
        </g>
      );
    case 'out_of_bed':
      return <path transform={t} d="M-5,3 L0,-2 L5,3" {...st} />;
    case 'ac_missed':
      return <path transform={t} d="M-4,-4 L4,4 M4,-4 L-4,4" {...st} />;
    default:
      return <circle transform={t} r={3} {...st} />;
  }
}

export const EVENT_LABEL: Record<RoomEvent['kind'], string> = {
  shower: 'Shower',
  door_open: 'Door opened',
  in_bed: 'In bed',
  both_in_bed: 'Both in bed',
  out_of_bed: 'Out of bed',
  room_empty: 'Room empty',
  ac_missed: 'AC command missed',
  calibration: 'Calibration',
};

/** Hypnograms for both people stacked over the room traces, on one shared time axis. */
export function NightStrip({ night, people, curve, events }: { night: Night; people: Person[]; curve: TemperatureCurve; events: RoomEvent[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const from = night.lightsOut - 90 * MIN;
  // Night.wake is the alarm; extend the window so a partner who sleeps on isn't clipped.
  const to = Math.max(night.wake, ...night.people.map((p) => p.sleep.end)) + 30 * MIN;

  const room = useMemo(() => downsample(night.room.filter((r) => r.ts >= from && r.ts <= to), 2 * MIN, 'mean'), [night, from, to]);
  const target = useMemo(() => {
    const out: { ts: number; t: number }[] = [];
    for (let t = from; t <= to; t += 5 * MIN) {
      const v = targetAt(curve, night.lightsOut, t);
      if (v !== null) out.push({ ts: t, t: v });
    }
    return out;
  }, [curve, night.lightsOut, from, to]);

  const persons = night.people.filter((p) => p.sleep.stages.length);
  const rows = { hyp: 40, gap: 16, temp: 64, rh: 42, co2: 64, ac: 22, ev: 22, axis: 18 };
  let y = 4;
  const hypY = persons.map(() => {
    const v = y;
    y += rows.hyp + 6;
    return v;
  });
  y += rows.gap - 6;
  const tempY = y; y += rows.temp + rows.gap;
  const rhY = y; y += rows.rh + rows.gap;
  const co2Y = y; y += rows.co2 + 6;
  const acY = y; y += rows.ac;
  const evY = y; y += rows.ev;
  const axisY = y; y += rows.axis;
  const H = y;

  const w = Math.max(width, 280);
  const x = scale(from, to, L, w - R);
  // Scale to the sleep window; the warm pre-cool start is clipped at the top of the row.
  const temps = [...room.filter((r) => r.ts >= night.lightsOut).map((r) => r.tempC), ...target.map((t) => t.t)].filter(Number.isFinite);
  const tLo = Math.floor(Math.min(...temps) - 0.3);
  const tHi = Math.max(tLo + 3, Math.ceil(Math.max(...temps) + 0.3));
  const yT = scale(tLo, tHi, tempY + rows.temp, tempY);
  const above = room.filter((r) => r.tempC > tHi + 0.2);
  const offTop = above.length ? { ts: above[0]!.ts, max: Math.max(...above.map((r) => r.tempC)) } : null;
  const rhs = room.map((r) => r.rh);
  const rLo = Math.floor(Math.min(45, ...rhs) / 5) * 5;
  const rHi = Math.ceil(Math.max(60, ...rhs) / 5) * 5;
  const yR = scale(rLo, rHi, rhY + rows.rh, rhY);
  const cMax = Math.max(1300, ...room.map((r) => r.co2));
  const cHi = Math.ceil(cMax / 100) * 100;
  const yC = scale(400, cHi, co2Y + rows.co2, co2Y);
  const ticks = hourTicks(from, to, w < 360 ? 2 : 1);

  const stageAt = (pi: number, ts: number) => persons[pi]?.sleep.stages.find((s) => ts >= s.start && ts < s.end)?.stage ?? null;
  const readingAt = (ts: number) => {
    let best = room[0];
    for (const r of room) if (Math.abs(r.ts - ts) < Math.abs((best?.ts ?? Infinity) - ts)) best = r;
    return best;
  };

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + L;
    const ts = from + ((px - L) / (w - L - R)) * (to - from);
    setHover(Math.max(from, Math.min(to, ts)));
  };

  const hr = hover !== null ? readingAt(hover) : undefined;
  const hTarget = hover !== null ? targetAt(curve, night.lightsOut, hover) : null;
  const hAc = hover !== null ? night.ac.find((c) => Math.abs(c.ts - hover) < 6 * MIN) : undefined;
  const hEv = hover !== null ? events.find((e) => e.kind !== 'room_empty' && Math.abs(e.start - hover) < 8 * MIN) : undefined;

  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const lvlY = (pi: number, s: SleepStage) => hypY[pi]! + (STAGE_ORDER.indexOf(s) / 3) * (rows.hyp - 8) + 4;

  return (
    <div ref={ref} className="chart-box" style={{ touchAction: 'pan-y' }}>
      {width > 0 && (
        <svg width={w} height={H} style={{ fontFamily: 'var(--font-mono)', letterSpacing: '.08em' }} role="img" aria-label="Night strip: sleep stages and room temperature, humidity and CO2 over the night">
          {/* gridlines */}
          {ticks.map((t) => (
            <line key={t} x1={x(t)} x2={x(t)} y1={hypY[0] ?? tempY} y2={axisY - 2} stroke="var(--grid)" />
          ))}
          {/* lights-out / wake markers */}
          {[night.lightsOut, night.wake].map((t, i) => (
            <g key={i}>
              <line x1={x(t)} x2={x(t)} y1={2} y2={axisY - 2} stroke="var(--axis)" strokeDasharray="2 3" />
            </g>
          ))}

          {/* hypnograms */}
          {persons.map((p, pi) => (
            <g key={p.personId}>
              <text x={0} y={hypY[pi]! + 12} fill="var(--text-2)" fontSize={9.5} fontWeight={500}>
                {name(p.personId).toUpperCase()}
              </text>
              {STAGE_ORDER.map((s) => (
                <text key={s} x={L - 6} y={lvlY(pi, s) + 3} fill="var(--muted)" fontSize={8} textAnchor="end">
                  {s === 'awake' ? 'W' : s === 'rem' ? 'R' : s === 'light' ? 'L' : 'D'}
                </text>
              ))}
              {p.sleep.stages.map((s, i) => {
                const prev = p.sleep.stages[i - 1];
                const x0 = x(Math.max(s.start, from));
                const x1 = x(Math.min(s.end, to));
                return (
                  <g key={i}>
                    {prev && <line x1={x0} x2={x0} y1={lvlY(pi, prev.stage) + 2} y2={lvlY(pi, s.stage) + 2} stroke="var(--hairline-2)" strokeWidth={1} />}
                    <rect x={x0} y={lvlY(pi, s.stage) - 0.5} width={Math.max(1.4, x1 - x0 - 0.5)} height={6} rx={2.5} fill={stageColor(s.stage)} />
                  </g>
                );
              })}
            </g>
          ))}

          {/* temperature */}
          <text x={0} y={tempY + 10} fill="var(--text-2)" fontSize={9.5} fontWeight={500}>°C</text>
          {[tLo, Math.round((tLo + tHi) / 2), tHi].map((v) => (
            <text key={v} x={L - 6} y={yT(v) + 3} fill="var(--muted)" fontSize={9} textAnchor="end">{v}</text>
          ))}
          <path d={linePath(target.map((t) => ({ x: x(t.ts), y: yT(t.t) })))} fill="none" stroke="var(--text-2)" strokeOpacity={0.7} strokeWidth={1.2} strokeDasharray="3 3" />
          <clipPath id="ns-temp-clip">
            <rect x={L} y={tempY - 2} width={w - L - R} height={rows.temp + 4} />
          </clipPath>
          <path clipPath="url(#ns-temp-clip)" d={linePath(room.map((r) => ({ x: x(r.ts), y: yT(r.tempC) })), 12)} fill="none" stroke="var(--temp)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
          {offTop && (
            <g>
              <path d={`M${x(offTop.ts) + 2},${tempY + 6} l4,-6 l4,6`} fill="none" stroke="var(--temp)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              <text x={x(offTop.ts) + 13} y={tempY + 7} fill="var(--temp)" fontSize={9}>
                {fmt(offTop.max, 1)}° pre-cool, off scale
              </text>
            </g>
          )}

          {/* RH */}
          <text x={0} y={rhY + 10} fill="var(--text-2)" fontSize={9.5} fontWeight={500}>RH</text>
          <rect x={L} y={yR(55)} width={w - L - R} height={Math.max(0, yR(45) - yR(55))} fill="var(--rh)" opacity={0.08} />
          {[rLo, rHi].map((v) => (
            <text key={v} x={L - 6} y={yR(v) + 3} fill="var(--muted)" fontSize={9} textAnchor="end">{v}%</text>
          ))}
          <path d={linePath(room.map((r) => ({ x: x(r.ts), y: yR(r.rh) })), 12)} fill="none" stroke="var(--rh)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />

          {/* CO2 with fixed bands */}
          <text x={0} y={co2Y + 10} fill="var(--text-2)" fontSize={9.5} fontWeight={500}>CO₂</text>
          {CO2_BANDS.map((b) => {
            const y0 = yC(Math.min(b.to, cHi));
            const y1 = yC(Math.max(b.from, 400));
            return y1 > y0 ? <rect key={b.key} x={L} y={y0} width={w - L - R} height={y1 - y0} fill={b.fill} /> : null;
          })}
          {[800, 1000, 1500].filter((v) => v < cHi).map((v) => (
            <text key={v} x={L - 6} y={yC(v) + 3} fill="var(--muted)" fontSize={9} textAnchor="end">{v >= 1000 ? `${v / 1000}k` : v}</text>
          ))}
          <defs>
            <linearGradient id="ns-co2" gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={co2Y} y2={co2Y + rows.co2}>
              <stop offset={0} stopColor="var(--co2)" />
              <stop offset={Math.max(0, Math.min(1, (yC(1000) - co2Y) / rows.co2))} stopColor="var(--co2)" />
              <stop offset={Math.max(0, Math.min(1, (yC(1000) - co2Y) / rows.co2))} stopColor="var(--text-2)" />
              <stop offset={1} stopColor="var(--text-2)" />
            </linearGradient>
          </defs>
          <line x1={L} x2={w - R} y1={yC(1000)} y2={yC(1000)} stroke="var(--text-2)" strokeOpacity={0.6} strokeDasharray="3 4" />
          <path d={linePath(room.map((r) => ({ x: x(r.ts), y: yC(r.co2) })), 12)} fill="none" stroke="url(#ns-co2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {/* AC commands */}
          <text x={0} y={acY + 14} fill="var(--text-2)" fontSize={9.5} fontWeight={500}>AC</text>
          <line x1={L} x2={w - R} y1={acY + 11} y2={acY + 11} stroke="var(--grid)" />
          {night.ac.map((c, i) => (
            <g key={i}>
              <line x1={x(c.ts)} x2={x(c.ts)} y1={acY + 4} y2={acY + 18} stroke={c.landed === false ? 'var(--critical)' : c.state.power ? 'var(--setpoint)' : 'var(--muted)'} strokeWidth={2.5} strokeLinecap="round" />
            </g>
          ))}

          {/* events */}
          <text x={0} y={evY + 14} fill="var(--text-2)" fontSize={9.5} fontWeight={500}>EVENTS</text>
          {events
            .filter((e) => e.kind === 'room_empty' && (e.end ?? e.start) > from && e.start < to)
            .map((e, i) => (
              <line key={`e${i}`} x1={x(Math.max(from, e.start))} x2={x(Math.min(to, e.end ?? e.start))} y1={evY + 11} y2={evY + 11} stroke="var(--axis)" strokeWidth={3} strokeLinecap="round" />
            ))}
          {events
            .filter((e) => e.kind !== 'room_empty' && e.start >= from && e.start <= to)
            .map((e, i) => (
              <EventGlyph key={i} kind={e.kind} x={x(e.start)} y={evY + 11} />
            ))}

          {/* axis */}
          {ticks.map((t) => (
            <text key={t} x={x(t)} y={axisY + 12} fill="var(--muted)" fontSize={9.5} textAnchor="middle">{hm(t)}</text>
          ))}

          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={2} y2={axisY} stroke="var(--hairline-2)" strokeWidth={1} />}
          <rect
            x={L}
            y={0}
            width={w - L - R}
            height={axisY}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {hover !== null && hr && (
        <FloatTip x={x(hover)} y={(hypY[0] ?? 0) + rows.hyp * persons.length + 14} width={w}>
          <div className="tip-title">{hm(hover)}</div>
          {persons.map((p, pi) => {
            const s = stageAt(pi, hover);
            return <TipRow key={p.personId} color={s ? stageColor(s) : 'var(--axis)'} value={s ? STAGE_LABEL[s] : '–'} label={name(p.personId)} />;
          })}
          <TipRow color="var(--temp)" value={`${fmt(hr.tempC, 1)} °C`} label={hTarget !== null ? `target ${fmt(hTarget, 1)}` : 'temp'} />
          <TipRow color="var(--rh)" value={`${fmt(hr.rh)} %`} label="RH" />
          <TipRow color="var(--text-2)" value={`${fmt(hr.co2)} ppm`} label="CO₂" />
          {hAc && <TipRow value={hAc.state.power ? `${hAc.state.setpointC}°` : 'OFF'} label={`AC ${hm(hAc.ts)}${hAc.landed === false ? ' · missed?' : ''}`} />}
          {hEv && <TipRow value={EVENT_LABEL[hEv.kind]} label={hm(hEv.start)} />}
        </FloatTip>
      )}
    </div>
  );
}
