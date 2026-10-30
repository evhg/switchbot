'use client';
// Scene 7 · Tonight, and the close (docs/DESIGN.md §9.1). What to change ("Same curve. More air."), one advice card
// whose primary action opens System › Tonight's plan, tonight's tags, the plan chart (plan in signal, last night
// in grey) and last night's aircon log as a disclosure (open on wide desktops).
import { useEffect, useState } from 'react';
import type { Night, RoomNightMetrics, TagKey, TemperatureCurve } from '@sleep-lab/core';
import { addDays, fmt, hm, ictDate, ictHour, MIN } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';
import { PlanChart } from '../charts/PlanChart.tsx';
import { Reveal } from '../motion.tsx';
import { systemHref } from '../nav.tsx';
import { AdviceCard, Button, Chip, Chips, Disclosure, Group, Row, Status } from '../ui.tsx';
import { TAGS, aircon, clock, planTimes, usePlanClock, type PlanClock } from '../system/model.ts';
import { acReason } from './model.ts';
import { Scene, SceneCols, SceneText, VisHead } from './parts.tsx';
import s from './story.module.css';


export function tonightCopy(plan: TemperatureCurve, night: Night, room: RoomNightMetrics): { head: string; tipBold: string; tip: string; short: string; onCurve: number } {
  const nightMin = Math.max(1, (night.wake - night.lightsOut) / MIN);
  const onCurve = Math.round((room.minutesTempInTarget / nightMin) * 100);
  const same = plan.id === night.curveId;
  const stale = room.co2Mean >= 1000 || room.minutesCo2Over1000 >= 90;
  const humid = room.minutesRhOver60 >= 60;
  const head = `${same ? 'Same curve.' : 'New curve.'} ${stale ? 'More air.' : humid ? 'Drier air.' : onCurve < 70 ? 'Earlier start.' : 'Same again.'}`;
  if (stale)
    return { head, onCurve, short: 'Door open 2 cm', tipBold: 'Crack the door 2 cm.', tip: `The curve held last night, ${onCurve}% of the time on target, so keep it. Fresh air is the one thing missing.` };
  if (humid) return { head, onCurve, short: 'Dry cycle first', tipBold: 'Run the dry cycle before bed.', tip: `Humidity sat above 60% for ${fmt(room.minutesRhOver60)} minutes. The curve itself held ${onCurve}% of the night.` };
  if (onCurve < 70) return { head, onCurve, short: 'Pre-cool earlier', tipBold: 'Start the pre-cool earlier.', tip: `The room was on target only ${onCurve}% of last night.` };
  return { head, onCurve, short: 'Keep it as it is', tipBold: 'Keep it as it is.', tip: `The room held the curve ${onCurve}% of the night and the air stayed fresh.` };
}

const reason = (tip: string) =>
  /door/.test(tip) ? 'The simplest way to roughly double the room’s fresh air.' : /dry/.test(tip) ? 'Takes the edge off the humidity before the curve starts.' : /earlier/.test(tip) ? 'Gives the room time to reach the target before lights out.' : 'Nothing in last night’s data asks for a change.';

function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** "Pre-cool at 21:30 to 18.5° (set 17°), nothing while you sleep, off at 09:00." from the plan the controller runs. */
export function planSentence(plan: TemperatureCurve, pc: PlanClock): string {
  const ac = aircon(plan, pc.lightsOut, true, pc.tonight.biasC, pc.wake, pc.sleepOnset);
  const on = ac.steps[0];
  const off = ac.steps.find((x) => x.setC === null);
  const asleep = ac.steps.filter((x) => x.asleep);
  const first = on && on.targetC !== null ? `Pre-cool at ${on.at} to ${fmt(on.targetC, 1)}°${on.setC !== null && Math.abs(on.setC - on.targetC) > 0.05 ? ` (aircon set ${on.setC}°)` : ''}` : 'No pre-cool';
  const night = asleep.length ? `${asleep.length} change${asleep.length === 1 ? '' : 's'} while you sleep` : 'nothing while you sleep';
  return `${first}, ${night}, off at ${off?.at ?? clock(pc.wake + 30)}.`;
}

/** Tonight as the backend sees it: pre-cool decision, presence, live vs dry-run, schedule. */
function LiveTonight({ pc }: { pc: PlanClock }) {
  const t = pc.tonight;
  return (
    <Group className={s.liveTonight}>
      <Row title="Pre-cool" sub={t.precool.text.replace(/^Pre-cool /, '').replace(/^./, (c) => c.toUpperCase())} value={<Status tone={t.precool.tone === 'alert' ? 'alert' : t.precool.tone === 'on' ? 'on' : 'off'}>{t.precool.tone === 'on' ? 'On' : t.precool.tone === 'alert' ? 'Waiting' : 'Off'}</Status>} />
      <Row title="Who’s home" sub={t.status.text} value={t.status.state === 'home' ? 'Home' : t.status.state === 'away' ? 'Away' : 'Unknown'} href={systemHref('presence')} />
      <Row title="Aircon control" value={t.acLive === null ? '–' : <Status tone={t.acLive ? 'on' : 'off'}>{t.acLive ? 'Live' : 'Dry-run'}</Status>} sub={t.acLive ? 'Real commands to the aircon' : t.acLive === false ? 'Logged only, nothing sent' : undefined} />
      <Row title="Schedule" value={<span className="num">{clock(pc.lightsOut)} · asleep {clock(pc.sleepOnset)} · up {clock(pc.wake)}</span>} />
    </Group>
  );
}

export function Tonight({
  plan,
  night,
  room,
  onLatest,
  live = false,
  manualLast = false,
}: {
  plan: TemperatureCurve;
  night: Night;
  room: RoomNightMetrics;
  onLatest: (() => void) | null;
  /** Real household (signed in): tonight's plan and status come from the backend. */
  live?: boolean;
  /** The night told above ran without the controller (aircon by hand). */
  manualLast?: boolean;
}) {
  const base = tonightCopy(plan, night, room);
  const pcLive = usePlanClock();
  const copy =
    live && manualLast
      ? { ...base, head: 'Tonight, Sleep Lab runs the aircon.', tip: `The night above ran by hand. ${planSentence(plan, pcLive)}` }
      : live
        ? { ...base, tip: `${base.tip} ${planSentence(plan, pcLive)}` }
        : base;
  const allAc = [...night.ac].sort((a, b) => a.ts - b.ts);
  const wide = useWide();
  const [armedFor, setArmedFor] = usePref<string>('armedFor', '');
  const [tagStore, setTagStore] = usePref<Record<string, TagKey[]>>('tags', {});
  const now = Date.now();
  const today = ictDate(now);
  const tonight = ictHour(now) >= 12 ? addDays(today, 1) : today;
  const armed = armedFor === today;
  const tags = tagStore[tonight] ?? [];
  const toggle = (k: TagKey) =>
    setTagStore((st) => {
      const cur = st[tonight] ?? [];
      return { ...st, [tonight]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] };
    });
  // Tonight's times come from the same selector and lights-out anchor as System › Tonight's plan.
  const pc = pcLive;
  const times = planTimes(plan, pc.lightsOut, pc.wake);
  return (
    <>
      <Scene id="tonight" title="Tonight">
        <SceneCols
          text={
            <SceneText label="Tonight" title={copy.head} lede={copy.tip}>
              <Reveal delay={180} className={s.advice}>
                {live ? (
                  <>
                    <LiveTonight pc={pcLive} />
                    <div className={s.liveActions}>
                      <Button variant="primary" href={systemHref('plan')}>
                        Edit tonight’s plan
                      </Button>
                      <Button variant="text" href={systemHref('presence')}>
                        Home or away
                      </Button>
                    </div>
                  </>
                ) : (
                <>
                <AdviceCard
                  title={copy.tipBold}
                  reason={reason(copy.tipBold)}
                  primary={{ label: 'Edit tonight’s plan', href: systemHref('plan') }}
                  secondary={{ label: armed ? 'Armed for tonight ✓' : 'Arm tonight', onClick: () => setArmedFor(armed ? '' : today) }}
                />
                <p className="cap">
                  Tonight starts {clock(times.starts)} · asleep by {clock(pc.sleepOnset)} · coolest {fmt(times.coolest, 1)}° · wake {clock(times.wake)}{armed ? ' · saved on this device, the controller picks it up then' : ''}
                </p>
                </>
                )}
              </Reveal>
            </SceneText>
          }
        >
          <Reveal>
            <VisHead title={live ? `Tonight’s plan: ${plan.name}` : 'Tonight’s plan, with last night’s room'} cap="Plan in colour, last night’s room in grey" />
            <PlanChart plan={plan} last={night} />
          </Reveal>
          <Reveal delay={80} className={s.tags}>
            <h3 className="label">Tags for tonight</h3>
            <Chips label="Tags for tonight">
              {TAGS.map((t) => (
                <Chip key={t.key} selected={tags.includes(t.key)} onClick={() => toggle(t.key)}>
                  {t.label}
                </Chip>
              ))}
            </Chips>
            <p className="cap">Tags become filters and experiment arms in the Lab.</p>
          </Reveal>
          <Reveal delay={120}>
            <Disclosure key={wide ? 'open' : 'closed'} title="Last night’s aircon log" count={manualLast ? 'By hand' : `${allAc.length} command${allAc.length === 1 ? '' : 's'}`} defaultOpen={wide} className={s.log}>
              {manualLast && <p className="sec">No commands: the aircon was run by hand this night, so there is nothing to log.</p>}
              <ol className={s.acList}>
                {allAc.map((a, i) => (
                  <li key={i}>
                    <span className="num">{hm(a.ts)}</span>
                    <b className="num">{a.state.power ? `${a.state.setpointC}°` : 'Off'}</b>
                    <span>
                      {acReason(a.reason)}
                      {a.landed === false && <em> · may have been missed</em>}
                    </span>
                  </li>
                ))}
              </ol>
            </Disclosure>
          </Reveal>
        </SceneCols>
      </Scene>
      <footer className={s.close}>
        <Reveal as="p" className={`head ${s.closeLine}`}>
          {onLatest ? 'That was that night.' : 'That was last night.'}
        </Reveal>
        <Reveal className={s.closeActions} delay={80}>
          {onLatest && (
            <Button variant="secondary" onClick={onLatest} icon="arrow-right">
              Jump to the latest night
            </Button>
          )}
          <Button variant="text" onClick={() => window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}>
            Back to top
          </Button>
        </Reveal>
      </footer>
    </>
  );
}
