'use client';
// 07 · Tonight — pinned 230svh (docs/DESIGN.md §10.07). p 0 → .8 wipes the plan in with a dot on its tip; the tip
// sentence and the CTA pill rise in from .85. After the pin: the aircon log row by row, then the finale.
import { useRef } from 'react';
import type { Night, RoomNightMetrics, TemperatureCurve } from '@sleep-lab/core';
import { fmt, hm, ictDate, MIN } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';
import { PlanChart } from '../charts/PlanChart.tsx';
import { Icon } from '../icons.tsx';
import { Chapter, easeOut, remap, Reveal, setSky, useChapterProgress, useMotionPrefs } from '../motion.tsx';
import { Button } from '../ui.tsx';
import { acReason } from './model.ts';
import s from './story.module.css';

export function tonightCopy(plan: TemperatureCurve, night: Night, room: RoomNightMetrics): { head: [string, string]; tipBold: string; tip: string } {
  const nightMin = Math.max(1, (night.wake - night.lightsOut) / MIN);
  const onCurve = Math.round((room.minutesTempInTarget / nightMin) * 100);
  const same = plan.id === night.curveId || (plan.id === 'default-v1' && night.curveId.startsWith('default'));
  const stale = room.co2Mean >= 1000 || room.minutesCo2Over1000 >= 90;
  const humid = room.minutesRhOver60 >= 60;
  const head: [string, string] = [same ? 'Same curve.' : 'New curve.', stale ? 'More air.' : humid ? 'Drier air.' : onCurve < 70 ? 'Earlier start.' : 'Same again.'];
  if (stale)
    return { head, tipBold: 'Crack the door 2 cm.', tip: ` The curve held last night (${onCurve}% on target), so keep it. Fresh air is the one thing missing.` };
  if (humid) return { head, tipBold: 'Run the dry cycle before bed.', tip: ` Humidity sat above 60% for ${fmt(room.minutesRhOver60)} min; the curve itself held ${onCurve}% of the night.` };
  if (onCurve < 70) return { head, tipBold: 'Start the pre-cool earlier.', tip: ` The room was on target only ${onCurve}% of last night.` };
  return { head, tipBold: 'Keep it as it is.', tip: ` The room held the curve ${onCurve}% of the night and the air stayed fresh.` };
}

function Cta({ plan, night, tip }: { plan: TemperatureCurve; night: Night; tip: { tipBold: string; tip: string } }) {
  const tipRef = useRef<HTMLParagraphElement>(null);
  const cta = useRef<HTMLDivElement>(null);
  const { level } = useMotionPrefs();
  const [armedFor, setArmedFor] = usePref<string>('armedFor', '');
  const tonight = ictDate(Date.now());
  const armed = armedFor === tonight;
  const pre = plan.phases.find((p) => p.name === 'precool') ?? plan.phases[0]!;
  const preAt = hm(night.lightsOut + pre.startMin * MIN);
  useChapterProgress((p) => {
    const q = easeOut(remap(p, 0.78, 1));
    const lift = level === 'full' ? 1 : 0;
    if (tipRef.current) {
      // The tip is legible (dimmed) from the start, so the stage never looks empty mid-scrub.
      const tq = easeOut(remap(p, 0.35, 0.8));
      tipRef.current.style.opacity = (0.32 + 0.68 * tq).toFixed(3);
      tipRef.current.style.transform = `translate3d(0,${((1 - tq) * 10 * lift).toFixed(1)}px,0)`;
    }
    if (cta.current) {
      cta.current.style.opacity = String(q);
      cta.current.style.transform = `translate3d(0,${((1 - q) * 30 * lift).toFixed(1)}px,0)`;
    }
  });
  return (
    <>
      <p ref={tipRef} className={`${s.tip} will`}>
        <b>{tip.tipBold}</b>
        {tip.tip}
      </p>
      <div ref={cta} className={`${s.ctaBlock} will`}>
      <div className={s.cta}>
        <div className={s.ctaText}>
          {plan.name.replace(/\s*\(default\)$/, '')}
          <span className="t-micro">
            Pre-cool ~{preAt} · target {fmt(pre.targetC, 1).replace(/\.0$/, '')}°
          </span>
        </div>
        <Button variant={armed ? 'ghost' : 'primary'} onClick={() => setArmedFor(armed ? '' : tonight)} aria-pressed={armed}>
          {armed ? (
            <>
              <Icon name="check" size={16} /> Armed
            </>
          ) : (
            'Arm tonight'
          )}
        </Button>
      </div>
      <div className={s.ctaFoot}>
        <Button variant="quiet" href="/settings#curve" icon="edit">
          Edit curve
        </Button>
        {armed && <span className="t-micro t2">Saved on this device · the controller picks it up at {preAt}</span>}
      </div>
      </div>
    </>
  );
}

export function Tonight({ plan, night, room, onLatest }: { plan: TemperatureCurve; night: Night; room: RoomNightMetrics; onLatest: (() => void) | null }) {
  const copy = tonightCopy(plan, night, room);
  const allAc = [...night.ac].sort((a, b) => a.ts - b.ts);
  return (
    <>
      <Chapter id="tonight" n={7} title="Tonight" accent="tonight" pinned={2.3} className="bleed" onProgress={(p) => setSky({ dusk: 0.6 * remap(p, 0, 0.6), mid: 0, dawn: 0, dim: 0 })}>
        <div className="sh-kicker t-label">
          <span>07</span>
          <span>Tonight</span>
        </div>
        <h2 className={`t-h1 ${s.h1}`}>
          {copy.head[0]}
          <br />
          <em className="tone">{copy.head[1]}</em>
        </h2>
        <div className={s.planBox}>
          <PlanChart plan={plan} last={night} height={220} scrub={[0, 0.8]} />
        </div>
        <Cta plan={plan} night={night} tip={copy} />
      </Chapter>
      <div className={s.flow} style={{ ['--ch-accent' as string]: 'var(--ac-tonight)' }}>
        <Reveal className="t-label t2">
          Aircon log · {allAc.length} command{allAc.length === 1 ? '' : 's'}
        </Reveal>
        <ul className={s.acList}>
          {allAc.map((a, i) => (
            <Reveal as="li" key={i} className={s.acr} style={{ ['--i' as string]: i % 4 }}>
              <span className="mono">{hm(a.ts)}</span>
              <b className={`num ${a.state.power ? '' : s.off}`}>{a.state.power ? `${a.state.setpointC}°` : 'OFF'}</b>
              <span>
                {acReason(a.reason)}
                {a.landed === false && <em className={s.missed}> · missed?</em>}
              </span>
            </Reveal>
          ))}
        </ul>
      </div>
      <div className={s.end}>
        <Reveal as="p" className={s.endBig}>
          That was
          <br />
          {onLatest ? 'that night.' : 'last night.'}
          <br />
          <span>Sleep well.</span>
        </Reveal>
        {onLatest && (
          <Button variant="ghost" onClick={onLatest} icon="arrow-right">
            Jump to latest night
          </Button>
        )}
      </div>
    </>
  );
}
