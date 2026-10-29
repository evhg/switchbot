'use client';
// Today: the story of last night, told chapter by chapter as you scroll (docs/DESIGN.md §10). The chapters live
// in components/story/*; this file owns data, the drill-down sheets and the date (browsing another night re-tells
// that night's story from the top).
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_CURVE, SLEEP_AIR_WEIGHTS, SLEEP_SCORE_WEIGHTS } from '@sleep-lab/core';
import { personColor, personName, useData, useNightDetail, useSelectedNight, withNames } from '@/lib/data/context.tsx';
import { usePlannedCurve } from '@/lib/curve-store.ts';
import { dayLabel, fmt, tidyReport } from '@/lib/format.ts';
import { useTheme } from '@/lib/theme.tsx';
import { EVENT_LABEL, EventGlyph, NightStrip, STAGE_LABEL, STAGE_ORDER, stageColor } from '../charts/NightStrip.tsx';
import { Waterfall } from '../charts/Waterfall.tsx';
import { Sky, StoryAccent } from '../motion.tsx';
import { useStoryChrome } from '../Shell.tsx';
import { Legend, Placeholder, Sheet } from '../ui.tsx';
import { Bodies } from '../story/Bodies.tsx';
import { Drivers, type DriverRow } from '../story/Drivers.tsx';
import { LightsOut } from '../story/LightsOut.tsx';
import { buildStory } from '../story/model.ts';
import { StoryHeader } from '../story/StoryHeader.tsx';
import { TheAir } from '../story/TheAir.tsx';
import { TheNight } from '../story/TheNight.tsx';
import { Tonight } from '../story/Tonight.tsx';
import { Verdict, VerdictSkeleton, type HeroPerson } from '../story/Verdict.tsx';
import s from '../story/story.module.css';

type Sheet = { kind: 'room' } | { kind: 'person'; id: string } | { kind: 'strip' } | { kind: 'waterfall' } | null;

function SubScores({ items }: { items: { label: string; value: number; weight: number }[] }) {
  return (
    <div className={s.subs}>
      {items.map((it) => (
        <div key={it.label} className={s.sub}>
          <span className="t2">
            {it.label} <span className="muted mono">×{it.weight}</span>
          </span>
          <span className={s.subBar}>
            <i style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, it.value / 100))})` }} />
          </span>
          <b className="num">{fmt(it.value)}</b>
        </div>
      ))}
    </div>
  );
}

/** First sentence of the hero verdict, from the people's sleep scores. */
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

/** "Sleep Air 75: humidity > 60% for 2 h held it back" → "Humidity > 60% for 2 h held it back." */
function roomClause(headline: string): string {
  const t = headline.replace(/^Sleep Air \d+:\s*/, '').trim();
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : '';
}

export function TodayScreen() {
  useStoryChrome();
  const { latest, progress, date, setDate } = useData();
  const sel = useSelectedNight();
  const { detail: rawDetail } = useNightDetail(date);
  const [plan] = usePlannedCurve();
  const [sheet, setSheet] = useState<Sheet>(null);
  const { resolved: theme } = useTheme();
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

  const colorOf = (id: string) => personColor(dataset?.people ?? [], id);
  const model = useMemo(
    () => (sel && dataset ? buildStory(sel.night, dataset.people, (id) => personColor(dataset.people, id), detail, DEFAULT_CURVE) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel?.night, dataset?.people, detail],
  );

  if (!dataset || !sel || !model) return <VerdictSkeleton status={progress || 'Loading…'} />;
  const { night, room } = sel;
  const personM = (id: string) => detail?.people.find((p) => p.personId === id) ?? sel.person[id] ?? null;

  const heroPeople: HeroPerson[] = dataset.people.map((p) => {
    const away = !night.people.some((x) => x.personId === p.id);
    const m = away ? null : personM(p.id);
    return { id: p.id, name: p.name, color: colorOf(p.id), sleep: m?.sleepScore ?? NaN, recovery: detail && m ? m.recoveryScore : null, away: away || !m };
  });
  const deepVsBase = (id: string) => {
    const m = detail?.people.find((p) => p.personId === id);
    const b = detail?.personParts[id]?.recovery.baseline;
    return m && b && Number.isFinite(b.deepMin) ? m.deepMin - b.deepMin : NaN;
  };
  const verdict = detail ? `${peopleLead(heroPeople, deepVsBase)} ${roomClause(withNames(detail.report.headline, dataset))}`.trim() : null;

  const isPerson = (label: string) => dataset.people.some((p) => label.startsWith(`${p.id}:`));
  const allDrivers = (detail?.report.drivers ?? []).map((d) => ({ ...d, label: tidyReport(d.label) }));
  const roomDrivers = allDrivers.filter((d) => !isPerson(d.label));
  const bodyDrivers = allDrivers.filter((d) => isPerson(d.label));
  const driverRows: DriverRow[] = allDrivers.map((d) => {
    const p = dataset.people.find((x) => d.label.startsWith(`${x.id}:`));
    return { ...d, source: p ? p.name : 'Room', text: p ? d.label.slice(p.id.length + 1).trim() : d.label };
  });
  const meanRecovery = detail && detail.people.length ? Math.round(detail.people.reduce((a, p) => a + p.recoveryScore, 0) / detail.people.length) : null;
  const vitalsReady = !sel.partial || dataset.nights.length > 30;
  const history = !sel.partial || dataset.nights.length > 30 ? dataset.room.slice(Math.max(0, sel.index - 29), sel.index + 1) : null;
  const latestDate = dataset.nights.at(-1)!.date;
  const focusPerson = sheet?.kind === 'person' ? sheet.id : null;

  return (
    <>
      <Sky initial={{ dusk: 1 }} />
      <StoryAccent />
      <StoryHeader />
      <div key={night.date} className={s.story}>
        <Verdict revealKey={night.date} kicker={night.date === latestDate ? 'The story of last night' : `The story of ${dayLabel(night.date)}`} score={room.sleepAirScore} verdict={verdict} people={heroPeople} onFocus={(f) => setSheet(f === 'room' ? { kind: 'room' } : { kind: 'person', id: f })} />
        <LightsOut model={model} />
        <TheNight model={model} curve={DEFAULT_CURVE} onOpenStrip={() => setSheet({ kind: 'strip' })} />
        <TheAir model={model} room={room} history={history} baseline={history ? dataset.room.slice(Math.max(0, sel.index - 30), sel.index) : null} index={sel.index} />
        <Bodies people={heroPeople} dataset={dataset} index={sel.index} ready={vitalsReady} />
        <Drivers
          rows={driverRows}
          sleepAir={room.sleepAirScore}
          meanRecovery={meanRecovery}
          insights={(detail?.report.insights ?? []).map((t) => withNames(t, dataset))}
          loading={!detail}
          onWaterfall={() => setSheet({ kind: 'waterfall' })}
        />
        <Tonight plan={plan} night={night} room={room} onLatest={night.date !== latestDate ? () => setDate(latestDate) : null} />
      </div>

      <Sheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        kicker={sheet?.kind === 'room' ? 'Sleep Air · room' : focusPerson ? 'Sleep · recovery' : sheet?.kind === 'strip' ? '03 · The night' : sheet?.kind === 'waterfall' ? '06 · What drove it' : undefined}
        title={
          sheet?.kind === 'room'
            ? `Sleep Air ${fmt(room.sleepAirScore)}`
            : focusPerson
              ? `${personName(dataset, focusPerson)} ${fmt(personM(focusPerson)?.sleepScore ?? NaN)}`
              : sheet?.kind === 'strip'
                ? 'Full night strip'
                : sheet?.kind === 'waterfall'
                  ? 'Drivers as waterfalls'
                  : ''
        }
      >
        {sheet?.kind === 'room' &&
          (detail ? (
            <div>
              <SubScores
                items={[
                  { label: 'CO₂', value: detail.roomParts.co2 * 100, weight: SLEEP_AIR_WEIGHTS.co2 },
                  { label: 'On curve', value: detail.roomParts.temp * 100, weight: SLEEP_AIR_WEIGHTS.temp },
                  { label: 'Humidity', value: detail.roomParts.rh * 100, weight: SLEEP_AIR_WEIGHTS.rh },
                  { label: 'Stability', value: detail.roomParts.stability * 100, weight: SLEEP_AIR_WEIGHTS.stability },
                ]}
              />
              <div style={{ marginTop: 18 }}>
                <Waterfall drivers={roomDrivers} total={room.sleepAirScore} totalLabel="Sleep Air" />
              </div>
            </div>
          ) : (
            <Placeholder height={200} />
          ))}
        {focusPerson &&
          (detail?.personParts[focusPerson] ? (
            <div>
              <SubScores
                items={[
                  { label: 'Duration', value: detail.personParts[focusPerson].sleep.duration * 100, weight: SLEEP_SCORE_WEIGHTS.duration },
                  { label: 'Efficiency', value: detail.personParts[focusPerson].sleep.efficiency * 100, weight: SLEEP_SCORE_WEIGHTS.efficiency },
                  { label: 'Deep + REM', value: detail.personParts[focusPerson].sleep.restorative * 100, weight: SLEEP_SCORE_WEIGHTS.restorative },
                  { label: 'Awakenings', value: detail.personParts[focusPerson].sleep.awakenings * 100, weight: SLEEP_SCORE_WEIGHTS.awakenings },
                ]}
              />
              <p className="card-note">
                Recovery {fmt(personM(focusPerson)?.recoveryScore ?? NaN)} compares HRV, HR nadir and breathing rate with {personName(dataset, focusPerson)}&apos;s last{' '}
                {detail.personParts[focusPerson].recovery.baselineNights} nights.
              </p>
              {bodyDrivers.some((d) => d.label.startsWith(`${focusPerson}:`)) && (
                <div style={{ marginTop: 14 }}>
                  <Waterfall
                    drivers={bodyDrivers.filter((d) => d.label.startsWith(`${focusPerson}:`)).map((d) => ({ ...d, label: d.label.slice(focusPerson.length + 1).trim() }))}
                    total={personM(focusPerson)?.recoveryScore ?? 0}
                    totalLabel="Recovery"
                  />
                </div>
              )}
            </div>
          ) : (
            <Placeholder height={200} />
          ))}
        {sheet?.kind === 'strip' && (
          <div>
            <Legend
              items={[
                ...STAGE_ORDER.map((st) => ({ label: STAGE_LABEL[st], color: stageColor(st), shape: 'rect' as const })),
                { label: 'Room °C', color: 'var(--temp)' },
                { label: 'Target', color: 'var(--text-2)', shape: 'dash' as const },
                { label: 'RH', color: 'var(--rh)' },
                { label: 'CO₂', color: 'var(--co2)' },
              ]}
            />
            <NightStrip night={night} people={dataset.people} curve={DEFAULT_CURVE} events={detail?.events ?? []} />
            <div className="legend" style={{ marginTop: 6 }}>
              {(['shower', 'door_open', 'in_bed', 'both_in_bed', 'out_of_bed'] as const).map((k) => (
                <span key={k}>
                  <svg width={14} height={14} aria-hidden>
                    <EventGlyph kind={k} x={7} y={7} s={0.9} />
                  </svg>
                  {EVENT_LABEL[k]}
                </span>
              ))}
              <span>
                <i className="key-line" style={{ color: 'var(--critical)' }} /> AC tick: missed?
              </span>
            </div>
            <p className="card-note">
              {theme === 'night'
                ? 'CO₂ bands, darkest to brightest: <800 · 800–1,000 · 1,000–1,500 · >1,500 ppm.'
                : 'CO₂ bands: green <800 · amber 800–1,000 · orange 1,000–1,500 · red >1,500 ppm.'}{' '}
              Touch the strip to read any minute.
            </p>
          </div>
        )}
        {sheet?.kind === 'waterfall' &&
          (detail ? (
            <div style={{ display: 'grid', gap: 22 }}>
              <div>
                <div className="t-label t2" style={{ marginBottom: 8 }}>
                  What drove Sleep Air · points vs a typical night (70)
                </div>
                <Waterfall drivers={roomDrivers} total={room.sleepAirScore} totalLabel="Sleep Air" />
              </div>
              <div>
                <div className="t-label t2" style={{ marginBottom: 8 }}>
                  Body drivers · vs each person&apos;s 30-night baseline
                </div>
                {bodyDrivers.length && meanRecovery !== null ? (
                  <Waterfall drivers={bodyDrivers.map((d) => ({ ...d, label: withNames(d.label, dataset) }))} total={meanRecovery} totalLabel="Mean recovery" />
                ) : (
                  <p className="small muted">Needs 7+ nights of history.</p>
                )}
              </div>
            </div>
          ) : (
            <Placeholder height={240} />
          ))}
      </Sheet>
    </>
  );
}
