'use client';
// Today: the story of last night, told scene by scene as you scroll (docs/DESIGN.md §8.3, §9.1).
//   1 Last night · 2 Before bed · 3 The night (pinned, scrubbed) · 4 The air · 5 Your bodies · 6 What drove it
//   · 7 Tonight · close.
// This file owns the data wiring (components/story/model.ts), the phone top bar (current scene + progress line),
// the desktop "On this page" rail and the drill-in sheets. Browsing another night re-tells that night from the top.
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_CURVE, MANUAL_COMFORT_TARGET_C, SLEEP_AIR_WEIGHTS, SLEEP_SCORE_WEIGHTS, type PersonNightMetrics } from '@sleep-lab/core';
import { personColor, personName, useData, useNightDetail, useNightInfo, useSelectedNight, withNames } from '@/lib/data/context.tsx';
import { curveById, fetchNightCurveId } from '@/lib/data/supabase.ts';
import { tonightDate } from '@/lib/tonight.ts';
import { usePlannedCurve } from '@/lib/curve-store.ts';
import { dayLabel, dur, fmt, hm, ictDate as ictDateOf, ictMidnight as ictMidnightOf, tidyReport } from '@/lib/format.ts';
import { clock, planTimes } from '../system/model.ts';
import { EVENT_LABEL, EventGlyph, NightStrip } from '../charts/NightStrip.tsx';
import { Waterfall } from '../charts/Waterfall.tsx';
import { subscribeScroll, useActiveChapter } from '../motion.tsx';
import { setTopbarProgress, useChrome } from '../nav.tsx';
import { useStoryChrome } from '../Shell.tsx';
import { EventList, OnThisPage, Placeholder, Sheet } from '../ui.tsx';
import { VitalsHistory } from '../Vitals.tsx';
import { Bodies } from '../story/Bodies.tsx';
import { Drivers, type DriverRow } from '../story/Drivers.tsx';
import { LightsOut } from '../story/LightsOut.tsx';
import { buildStory, co2CrossAt, co2PeakAt, nightSteps, whoLabel } from '../story/model.ts';
import { TheAir } from '../story/TheAir.tsx';
import { ConnectHealthCard } from '../story/ConnectHealth.tsx';
import { qualityNote, roomVerdict } from '../story/real.ts';
import { TheNight } from '../story/TheNight.tsx';
import { Tonight, tonightCopy } from '../story/Tonight.tsx';
import { Verdict, VerdictSkeleton, type HeroPerson } from '../story/Verdict.tsx';
import s from '../story/story.module.css';

type SheetKind = { kind: 'room' } | { kind: 'person'; id: string } | { kind: 'strip' } | { kind: 'waterfall' } | { kind: 'vitals' } | null;

const SCENES = [
  { id: 'verdict', label: 'Last night' },
  { id: 'before', label: 'Before bed' },
  { id: 'night', label: 'The night' },
  { id: 'air', label: 'The air' },
  { id: 'bodies', label: 'Your bodies' },
  { id: 'drivers', label: 'What drove it' },
  { id: 'tonight', label: 'Tonight' },
] as const;

function SubScores({ items }: { items: { label: string; value: number; weight: number }[] }) {
  return (
    <ul className={s.subs}>
      {items.map((it) => (
        <li key={it.label}>
          <span>
            {it.label} <span className="cap">weight {it.weight}</span>
          </span>
          <span className={s.subBar} aria-hidden>
            <i style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, it.value / 100))})` }} />
          </span>
          <b className="num">{fmt(it.value)}</b>
        </li>
      ))}
    </ul>
  );
}

/** First sentence of the verdict, from the people's sleep scores. */
function peopleLead(people: HeroPerson[], deepVsBase: (id: string) => number): string {
  const here = people.filter((p) => !p.away && Number.isFinite(p.sleep));
  if (!here.length) return 'No sleep data last night.';
  if (here.length === 1) return here[0]!.sleep >= 80 ? `${here[0]!.name} slept well.` : `${here[0]!.name} had a light night.`;
  const good = here.filter((p) => p.sleep >= 80);
  // "Deep" only when both actually got at least their usual deep sleep (not just a high score).
  if (good.length === here.length) return here.every((p) => p.sleep >= 85 && deepVsBase(p.id) >= 0) ? 'You both slept deep.' : 'You both slept well.';
  if (!good.length) return 'A rough night for both.';
  const low = here.find((p) => p.sleep < 80)!;
  return low.name.toLowerCase() === 'you' ? `${good[0]!.name} slept well, you less so.` : `${low.name} slept lighter.`;
}

/** "Sleep Air 75: humidity > 60% for 2 h held it back" → "Humidity above 60% for 2h 00m held the room back." */
function roomClause(headline: string): string {
  const t = tidyReport(headline.replace(/^Sleep Air \d+:\s*/, '').trim()).replace(/held it back/, 'held the room back');
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : '';
}

/** Phone top bar: the scene being read, and the 2 px page progress line (one scroll subscriber, no renders). */
function useStoryTopbar() {
  const active = useActiveChapter();
  useChrome({ title: SCENES.find((c) => c.id === active)?.label ?? 'Last night' });
  useEffect(() => {
    let max = 1;
    const measure = () => {
      max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener('resize', measure);
    const off = subscribeScroll((y) => setTopbarProgress(y / max));
    return () => {
      off();
      ro.disconnect();
      window.removeEventListener('resize', measure);
      setTopbarProgress(0);
    };
  }, []);
}

export function TodayScreen() {
  useStoryChrome({ topbar: true });
  useStoryTopbar();
  const { latest, progress, date, setDate, sourceKind } = useData();
  const sel = useSelectedNight();
  const { detail: rawDetail } = useNightDetail(date);
  const info = useNightInfo(date);
  const [localPlan] = usePlannedCurve();
  const live = sourceKind === 'supabase';
  // Real household: tonight's plan is the curve on tonight's nights row (the backend's default when there is none yet).
  const [tonightCurve, setTonightCurve] = useState<string | null>(null);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    fetchNightCurveId(tonightDate()).then((id) => alive && setTonightCurve(id), () => undefined);
    return () => {
      alive = false;
    };
  }, [live]);
  const plan = live ? curveById(tonightCurve, latest?.curves) : localPlan;
  const [sheet, setSheet] = useState<SheetKind>(null);
  const dataset = latest;
  // useNightDetail keeps the previous night's detail while the next loads: never mix nights.
  const detail = rawDetail && sel && rawDetail.date === sel.night.date ? rawDetail : null;

  // Re-tell the story from the top when another night is chosen.
  const firstDate = useRef<string | null>(null);
  useEffect(() => {
    if (!date) return;
    if (firstDate.current === null) {
      firstDate.current = date;
      return;
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [date]);

  // The night is told against the curve it was planned with (the simulator's nights all use the default).
  const curve = useMemo(() => (sel ? curveById(sel.night.curveId, dataset?.curves) : DEFAULT_CURVE), [sel, dataset?.curves]);
  const nightInfo = info && sel && info.date === sel.night.date ? info : null;
  const model = useMemo(
    () => (sel && dataset ? buildStory(sel.night, dataset.people, (id) => personColor(dataset.people, id), detail, curve, nightInfo) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel?.night, dataset?.people, detail, curve, nightInfo],
  );
  const room = sel?.room;
  const peakAt = useMemo(() => (sel && room ? co2PeakAt(sel.night, room.co2Max) : 0), [sel, room]);
  const steps = useMemo(() => (model && room ? nightSteps(model, room.co2Max, peakAt, room.minutesCo2Over1000) : []), [model, room, peakAt]);
  const crossAt = useMemo(() => (model ? co2CrossAt(model) : null), [model]);

  if (!dataset || !sel || !model || !room) return <VerdictSkeleton status={progress || 'Loading…'} />;
  const { night } = sel;
  const personM = (id: string) => detail?.people.find((p) => p.personId === id) ?? sel.person[id] ?? null;

  // That person's typical night: the mean of the 30 nights before this one (as in the Your bodies table).
  const typicalOf = (id: string, f: (m: PersonNightMetrics) => number): number | null => {
    const xs = (dataset.person[id] ?? []).slice(Math.max(0, sel.index - 30), sel.index).flatMap((m) => (m && Number.isFinite(f(m)) ? [f(m)] : []));
    return xs.length >= 7 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const heroPeople: HeroPerson[] = dataset.people.map((p) => {
    const away = !night.people.some((x) => x.personId === p.id);
    const m = away ? null : personM(p.id);
    return {
      id: p.id,
      name: p.name,
      color: personColor(dataset.people, p.id),
      sleep: m?.sleepScore ?? NaN,
      recovery: detail && m ? m.recoveryScore : null,
      asleep: m?.totalSleepMin,
      away: away || !m,
      hrv: m?.rmssdMean,
      hrvTypical: typicalOf(p.id, (x) => x.rmssdMean),
      low: m?.hrNadir,
    };
  });
  const deepVsBase = (id: string) => {
    const m = detail?.people.find((p) => p.personId === id);
    const b = detail?.personParts[id]?.recovery.baseline;
    return m && b && Number.isFinite(b.deepMin) ? m.deepMin - b.deepMin : NaN;
  };
  const roomOnly = model.roomOnly;
  const everSynced = dataset.nights.some((n) => n.people.length > 0);
  const manual = model.control === 'manual';
  const verdict = roomOnly
    ? roomVerdict(model.series, night.lightsOut, night.wake, room.co2Max, peakAt, crossAt)
    : detail
      ? `${peopleLead(heroPeople, deepVsBase)} ${roomClause(withNames(detail.report.headline, dataset))}`.trim()
      : null;
  const note = qualityNote(nightInfo, night.lightsOut, night.wake, room.achMorning === null && !model.air.plateau);
  const report = nightInfo?.report ?? null;

  const isPerson = (label: string) => dataset.people.some((p) => label.startsWith(`${p.id}:`));
  const allDrivers = (detail?.report.drivers ?? []).map((d) => ({ ...d, label: tidyReport(d.label) }));
  const roomDrivers = allDrivers.filter((d) => !isPerson(d.label));
  const bodyDrivers = allDrivers.filter((d) => isPerson(d.label));
  const driverRows: DriverRow[] = allDrivers.map((d) => {
    const p = dataset.people.find((x) => d.label.startsWith(`${x.id}:`));
    const text = (p ? d.label.slice(p.id.length + 1).trim() : d.label).replace(/^HR nadir/, 'Lowest heart rate').replace(/\s?°C/g, '°');
    return { ...d, source: p ? p.name : 'Room', text };
  });
  const meanRecovery = detail && detail.people.length ? Math.round(detail.people.reduce((a, p) => a + p.recoveryScore, 0) / detail.people.length) : null;
  const vitalsReady = !sel.partial || dataset.nights.length > 30;
  const history = !sel.partial || dataset.nights.length > 30 ? dataset.room.slice(Math.max(0, sel.index - 29), sel.index + 1) : null;
  const baseline = history ? dataset.room.slice(Math.max(0, sel.index - 30), sel.index) : null;
  const latestDate = dataset.nights.at(-1)!.date;
  const isLatest = night.date === latestDate;
  const focusPerson = sheet?.kind === 'person' ? sheet.id : null;
  const tonight = tonightCopy(plan, night, room);
  const glance = [
    { label: 'Lights out', value: hm(night.lightsOut) },
    manual ? { label: 'Aircon', value: 'By hand' } : { label: 'On the curve', value: `${tonight.onCurve}%` },
    { label: 'CO₂ over 1,000', value: room.minutesCo2Over1000 > 0 ? dur(room.minutesCo2Over1000) : 'Never' },
    { label: 'Tonight', value: live && isLatest ? `Pre-cool ${clock(planTimes(plan, Math.round((night.lightsOut - ictMidnightOf(night.date)) / 60_000) + 1440).starts)}` : tonight.short },
  ];

  return (
    <>
      <div key={night.date} className={s.story}>
        <Verdict
          label={isLatest ? 'Last night' : dayLabel(night.date)}
          revealKey={night.date}
          score={room.sleepAirScore}
          verdict={verdict}
          people={heroPeople}
          glance={glance}
          model={model}
          onFocus={(f) => setSheet(f === 'room' ? { kind: 'room' } : { kind: 'person', id: f })}
          roomOnly={roomOnly}
          note={note}
          side={<ConnectHealthCard everSynced={everSynced} />}
        />
        <LightsOut model={model} />
        <TheNight model={model} steps={steps} onOpenStrip={() => setSheet({ kind: 'strip' })} />
        <TheAir model={model} room={room} history={history} baseline={baseline} peakAt={peakAt} crossAt={crossAt} />
        {!roomOnly && <Bodies people={heroPeople} dataset={dataset} index={sel.index} detail={detail} ready={vitalsReady} onHistory={() => setSheet({ kind: 'vitals' })} />}
        <Drivers
          rows={driverRows}
          sleepAir={room.sleepAirScore}
          meanRecovery={meanRecovery}
          insights={(report?.insights.length ? report.insights : detail?.report.insights ?? []).map((t) => tidyReport(withNames(t, dataset)))}
          loading={!detail}
          onWaterfall={() => setSheet({ kind: 'waterfall' })}
          note={manual ? `The aircon was run by hand this night, so temperature is scored against the steady ${MANUAL_COMFORT_TARGET_C}° comfort target, not the plan stored for it (${curve.name}).` : null}
          report={report ? { headline: tidyReport(withNames(report.headline, dataset)), when: report.createdAt ? `${dayLabel(ictDateOf(report.createdAt))} ${hm(report.createdAt)}` : report.generatedBy } : null}
        />
        <Tonight plan={plan} night={night} room={room} onLatest={!isLatest ? () => setDate(latestDate) : null} live={live && isLatest} manualLast={manual} />
      </div>
      <OnThisPage items={roomOnly ? SCENES.filter((x) => x.id !== 'bodies') : SCENES} />

      <Sheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        wide={sheet?.kind === 'strip' || sheet?.kind === 'vitals'}
        title={
          sheet?.kind === 'room'
            ? `Room score ${fmt(room.sleepAirScore)}`
            : focusPerson
              ? `${personName(dataset, focusPerson)}: sleep ${fmt(personM(focusPerson)?.sleepScore ?? NaN)}`
              : sheet?.kind === 'strip'
                ? 'The whole night'
                : sheet?.kind === 'waterfall'
                  ? 'What drove it, step by step'
                  : sheet?.kind === 'vitals'
                    ? 'Vitals, last 14 nights'
                    : ''
        }
      >
        {sheet?.kind === 'room' &&
          (detail ? (
            <div className={s.sheetBody}>
              <p className="sec">Four parts, weighted. A typical night scores {70}.</p>
              <SubScores
                items={[
                  { label: 'CO₂', value: detail.roomParts.co2 * 100, weight: SLEEP_AIR_WEIGHTS.co2 },
                  { label: manual ? 'Comfort band' : 'On the curve', value: detail.roomParts.temp * 100, weight: SLEEP_AIR_WEIGHTS.temp },
                  { label: 'Humidity', value: detail.roomParts.rh * 100, weight: SLEEP_AIR_WEIGHTS.rh },
                  { label: 'Stability', value: detail.roomParts.stability * 100, weight: SLEEP_AIR_WEIGHTS.stability },
                ]}
              />
              <h3 className="label">From a typical night to {fmt(room.sleepAirScore)}</h3>
              <Waterfall drivers={roomDrivers} total={room.sleepAirScore} totalLabel="Room score" />
            </div>
          ) : (
            <Placeholder height={200} />
          ))}
        {focusPerson &&
          (detail?.personParts[focusPerson] ? (
            <div className={s.sheetBody}>
              <SubScores
                items={[
                  { label: 'Duration', value: detail.personParts[focusPerson].sleep.duration * 100, weight: SLEEP_SCORE_WEIGHTS.duration },
                  { label: 'Efficiency', value: detail.personParts[focusPerson].sleep.efficiency * 100, weight: SLEEP_SCORE_WEIGHTS.efficiency },
                  { label: 'Deep + REM', value: detail.personParts[focusPerson].sleep.restorative * 100, weight: SLEEP_SCORE_WEIGHTS.restorative },
                  { label: 'Awakenings', value: detail.personParts[focusPerson].sleep.awakenings * 100, weight: SLEEP_SCORE_WEIGHTS.awakenings },
                ]}
              />
              <p className="sec">
                Recovery {fmt(personM(focusPerson)?.recoveryScore ?? NaN)} compares HRV, the lowest heart rate and breathing rate with {personName(dataset, focusPerson)}&rsquo;s last{' '}
                {detail.personParts[focusPerson].recovery.baselineNights} nights.
              </p>
              {bodyDrivers.some((d) => d.label.startsWith(`${focusPerson}:`)) && (
                <>
                  <h3 className="label">What moved recovery</h3>
                  <Waterfall
                    drivers={bodyDrivers.filter((d) => d.label.startsWith(`${focusPerson}:`)).map((d) => ({ ...d, label: d.label.slice(focusPerson.length + 1).trim() }))}
                    total={personM(focusPerson)?.recoveryScore ?? 0}
                    totalLabel="Recovery"
                  />
                </>
              )}
            </div>
          ) : (
            <Placeholder height={200} />
          ))}
        {sheet?.kind === 'strip' && (
          <div className={s.sheetBody}>
            <p className="sec">Both hypnograms over room temperature (plan dashed), humidity and CO₂. Touch the strip to read any minute.</p>
            <NightStrip night={night} people={dataset.people} curve={curve} events={detail?.events ?? []} />
            <div className={`cap ${s.glyphKey}`}>
              {(['shower', 'door_open', 'in_bed', 'both_in_bed', 'out_of_bed'] as const).map((k) => (
                <span key={k}>
                  <svg width={16} height={16} aria-hidden>
                    <EventGlyph kind={k} x={8} y={8} s={0.9} />
                  </svg>
                  {EVENT_LABEL[k]}
                </span>
              ))}
              <span>
                <svg width={16} height={16} aria-hidden>
                  <line x1={8} x2={8} y1={2} y2={14} stroke="var(--signal)" strokeWidth={2} strokeLinecap="round" />
                </svg>
                Aircon command that may have been missed
              </span>
            </div>
            <h3 className="label">Every moment</h3>
            <EventList items={model.moments.map((m) => ({ time: hm(m.t), title: m.text, detail: m.who ? whoLabel(m, model.people) : undefined }))} />
          </div>
        )}
        {sheet?.kind === 'waterfall' &&
          (detail ? (
            <div className={s.sheetBody}>
              <h3 className="label">Room score, against a typical night ({70})</h3>
              <Waterfall drivers={roomDrivers} total={room.sleepAirScore} totalLabel="Room score" />
              <h3 className="label">Bodies, against each person&rsquo;s 30-night baseline</h3>
              {bodyDrivers.length && meanRecovery !== null ? (
                <Waterfall drivers={bodyDrivers.map((d) => ({ ...d, label: withNames(d.label, dataset) }))} total={meanRecovery} totalLabel="Mean recovery" />
              ) : (
                <p className="sec">Needs 7 or more nights of history.</p>
              )}
            </div>
          ) : (
            <Placeholder height={240} />
          ))}
        {sheet?.kind === 'vitals' && <VitalsHistory dataset={dataset} index={sel.index} />}
      </Sheet>
    </>
  );
}
