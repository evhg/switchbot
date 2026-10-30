'use client';
/**
 * Room tab, v2 "Instrument" (docs/DESIGN.md §9.2).
 *
 *   Header      "Room" + one sentence
 *   Hero        Right now: CO₂ at display size (signal above 1,000), one status line, ONE piece of advice,
 *               temperature and humidity as two readouts, the last 6 hours as one quiet trace.
 *   Sections    1 CO₂ ramp and forecast (one segmented control: Tonight / Check a night)
 *               2 Setpoint vs actual (+ the aircon log as a disclosure)
 *               3 Nights over 1,000 ppm (30-night bars + morning CO₂, fresh air, ERV as facts)
 *   More        Ten drill-ins, each in a sheet (phone) / right panel (desktop).
 *
 * Desktop: each section is chart + a facts column from 1440 px; the "On this page" rail appears from 1760 px.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_CURVE, MANUAL_COMFORT_TARGET_C, manualComfortCurve, dewPointC, FALLBACK_GEN_LPS, fitBuildup, forecastCo2, forecastCo2Occupied, type RoomReading } from '@sleep-lab/core';
import { useData, useLive, useNightDetail, useSelectedNight } from '@/lib/data/context.tsx';
import { ACH_FOR_1000, acRuntimeMin, coolingResponse, pulldownWindow, showerImpact, steadyCo2 } from '@/lib/analysis.ts';
import { addDays, co2Band, dur, fmt, hm, ictDate, ictHour, ictMidnight, HOUR, MIN, shortDate, shortDay, signed } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';
import { median } from '@/lib/stats.ts';
import { downsample } from '@sleep-lab/core';
import { round10 } from '../charts/room/air.tsx';
import { co2PeakAt } from '../story/model.ts';
import { AchTracker, CalendarHeatmap, Co2ForecastChart, ComfortChart, EventLanes, Meter, NightBars, NowTrace, OutdoorIndoor, RadialClock, ResponseScatter, SETPOINT_DOMAIN, SetpointChart, ShowerMini } from '../charts/room.tsx';
import s from '../charts/room/room.module.css';
import { nightPlateauAch } from '../story/real.ts';
import { LazyMount, Reveal } from '../motion.tsx';
import { Button, Disclosure, EventList, Loading, MoreAnalysis, OnThisPage, PageHeader, Placeholder, Readout, Section, Segmented, Sheet, Skeleton, TableView } from '../ui.tsx';

type Drill = 'ventilation' | 'fresh' | 'comfort' | 'rhythm' | 'offcurve' | 'response' | 'duty' | 'events' | 'shower' | 'outdoor';

const STATUS: Record<'good' | 'warn' | 'serious' | 'critical', string> = {
  good: 'Fresh air.',
  warn: 'The air is getting stale.',
  serious: 'Stuffy.',
  critical: 'Poor air.',
};


/** A quiet label/value list (the facts column beside a chart). */
function Facts({ items }: { items: { label: ReactNode; value: ReactNode; sub?: ReactNode; alert?: boolean }[] }) {
  return (
    <dl className={s.facts}>
      {items.map((it, i) => (
        <div key={i}>
          <dt>{it.label}</dt>
          <dd className={it.alert ? s.alert : undefined}>
            {it.value}
            {it.sub && <small>{it.sub}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ───────────── Forecast model (shared by the hero's advice and section 1) ─────────────
function useCo2Forecast() {
  const { source, dataset } = useData();
  const sel = useSelectedNight();
  const [now] = useState(() => Date.now());
  const [live, setLive] = useState<RoomReading[]>([]);
  const today = ictDate(now);
  const wakeDate = ictHour(now) >= 12 ? addDays(today, 1) : today;
  const startTs = ictMidnight(wakeDate) - 6 * HOUR; // 18:00 the evening before
  const untilTs = ictMidnight(wakeDate) + 6.5 * HOUR;
  useEffect(() => {
    let alive = true;
    source
      .liveWindow(Math.min(startTs, now - 2 * HOUR), now)
      .then((r) => alive && setLive(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [source, startTs, now]);

  // Two sleepers at the rate learned from the last 14 nights, at the median fresh-air rate, from the usual lights-out.
  const learned = useMemo(() => {
    if (!dataset) return null;
    const nights = dataset.nights.slice(-14);
    const rooms = dataset.room.slice(-14);
    // The morning decay when it was measured, else where CO₂ levelled off overnight (real nights without a clean morning).
    const achs = rooms.flatMap((r, i) => {
      const n = nights[i];
      if (!n || n.tags.includes('door_ajar')) return [];
      const a = r.achMorning ?? nightPlateauAch(n);
      return a !== null ? [a] : [];
    });
    const ach = achs.length ? median(achs) : 0.2;
    const gens = nights.flatMap((n) => {
      const f = fitBuildup(n.room.filter((r) => r.ts >= n.lightsOut + 30 * MIN && r.ts <= n.lightsOut + 3 * HOUR), { ach });
      return f && f.generationLps > 0.002 && f.generationLps < 0.02 ? [f.generationLps] : [];
    });
    const loMin = median(nights.map((n) => (n.lightsOut - ictMidnight(n.date)) / MIN));
    return { ach, gen: gens.length ? median(gens) : FALLBACK_GEN_LPS, loOffsetMin: Number.isFinite(loMin) ? loMin : -90 };
  }, [dataset]);
  const lightsOutTonight = ictMidnight(wakeDate) + (learned?.loOffsetMin ?? -90) * MIN;

  const tonight = useMemo(() => {
    if (live.length < 30) return null;
    const last = live.at(-1)!.ts;
    // Until ~90 min of tonight's build-up exist, fitting the recent (empty-room) window would predict a flat line.
    if (learned && last < lightsOutTonight + 90 * MIN) {
      const fc = forecastCo2Occupied(live, untilTs, { occupiedFrom: Math.max(lightsOutTonight, last), generationLps: learned.gen, ach: learned.ach });
      return { actual: live, forecast: fc, known: last, until: untilTs, basis: 'learned' as const };
    }
    const fc = forecastCo2(live.filter((r) => r.ts >= lightsOutTonight), untilTs);
    return { actual: live, forecast: fc, known: last, until: untilTs, basis: 'fit' as const };
  }, [live, untilTs, learned, lightsOutTonight]);

  const check = useMemo(() => {
    if (!sel) return null;
    const n = sel.night;
    const known = n.lightsOut + 2 * HOUR;
    const actual = n.room.filter((r) => r.ts <= n.wake);
    const fc = forecastCo2(actual.filter((r) => r.ts >= n.lightsOut && r.ts <= known), n.wake);
    return { actual, forecast: fc, known, until: n.wake, basis: 'fit' as const };
  }, [sel]);

  const evening = ictHour(now) >= 18 || ictHour(now) < 7;
  return { tonight, check, learned, lightsOutTonight, evening };
}
type Forecast = ReturnType<typeof useCo2Forecast>;

// ───────────── Hero: right now ─────────────
/** A live reading older than this (minutes) is stale: the hub is probably unplugged or offline. */
const STALE_MIN = 10;
function Hero({ fc }: { fc: Forecast }) {
  const { now, reading, history } = useLive(6);
  const hourAgo = history.find((r) => r.ts >= now - HOUR);
  if (!reading)
    return (
      <section className={s.hero} aria-label="Right now">
        <div className={s.heroTop}>
          <div className={s.now}>
            <Skeleton w={160} h={20} />
            <Skeleton w={320} h={120} />
            <Skeleton w={280} h={24} />
          </div>
          <Skeleton h={160} />
        </div>
        <Skeleton h={120} />
      </section>
    );
  // Freshness: readings arrive every minute; older than 10 min means the hub or the cloud has gone quiet.
  const ageMin = Math.max(0, (now - reading.ts) / MIN);
  const stale = ageMin > STALE_MIN;
  const ago = ageMin < 1.5 ? 'just now' : ageMin < 90 ? `${Math.round(ageMin)} min ago` : `${dur(ageMin)} ago`;
  const co2Ok = reading.co2 >= 300;
  const band = co2Band(reading.co2);
  const alert = !stale && reading.co2 >= 1000;
  const d = hourAgo ? reading.co2 - hourAgo.co2 : NaN;
  const trend = !Number.isFinite(d) ? '' : Math.abs(d) < 15 ? 'Steady over the last hour.' : `${d > 0 ? 'Up' : 'Down'} ${fmt(Math.abs(d))} ppm in the last hour.`;
  const end = fc.tonight?.forecast.at(-1);
  const advice = alert
    ? 'Open the door for ten minutes to bring it back under 1,000 ppm.'
    : end && end.co2 >= 1000
      ? `Tonight is on course for about ${fmt(round10(end.co2))} ppm by ${hm(end.ts)}. Leave the door ajar 2 cm.`
      : end
        ? 'Nothing to do. Tonight should stay under 1,000 ppm.'
        : 'Nothing to do right now.';
  const dt = hourAgo ? reading.tempC - hourAgo.tempC : NaN;
  const tTrend = !Number.isFinite(dt) ? 'Room at bed height' : Math.abs(dt) < 0.1 ? 'Steady over the last hour' : `${dt > 0 ? 'Up' : 'Down'} ${fmt(Math.abs(dt), 1)}° in the last hour`;
  return (
    <section className={s.hero} aria-label="Right now">
      <div className={s.heroTop}>
        <Reveal className={s.now} y={12}>
          <span className={`label ${s.nowLabel}`}>
            <i className={alert ? s.alert : stale ? s.staleDot : s.liveDot} aria-hidden />
            {stale ? `Last reading · ${hm(reading.ts)}` : 'CO₂ right now'} · <span className="num">updated {ago}</span>
          </span>
          <div className={`display ${s.co2} ${alert ? s.alert : ''} ${stale ? s.stale : ''}`} aria-label={`CO₂ ${co2Ok ? fmt(reading.co2) : 'unknown'} ppm${stale ? `, ${ago}` : ''}`}>
            {co2Ok ? fmt(reading.co2) : '–'}
            <span className="unit">ppm</span>
          </div>
          {stale ? (
            <div className={s.status} role="status">
              <p className="head">The meter has gone quiet.</p>
              <p className="sec">
                No reading for {dur(ageMin)}. Check that the SwitchBot hub is plugged in and online; the numbers here are from {hm(reading.ts)}.
              </p>
            </div>
          ) : (
            <>
              <div className={s.status}>
                <p className="head">{co2Ok ? STATUS[band.key] : 'The meter is warming up.'}</p>
                {trend && co2Ok && <p className="sec">{trend}</p>}
              </div>
              <p className={`${s.advice} ${alert || (end && end.co2 >= 1000) ? s.alert : ''}`}>{advice}</p>
            </>
          )}
        </Reveal>
        <Reveal className={`${s.side} ${stale ? s.staleKids : ''}`} y={12} delay={80}>
          <Readout label="Temperature" value={`${fmt(reading.tempC, 1)}°`} large sub={tTrend} />
          <Readout label="Humidity" value={fmt(reading.rh)} unit="%" large sub={`Dew point ${fmt(dewPointC(reading.tempC, reading.rh), 1)}°`} />
        </Reveal>
      </div>
      <div>
        <p className="cap">CO₂, last 6 hours. Touch the line for temperature and humidity.</p>
        <NowTrace history={history} current={reading} />
      </div>
    </section>
  );
}

// ───────────── Section 1: CO₂ ramp and forecast ─────────────
function ForecastSection({ fc }: { fc: Forecast }) {
  const sel = useSelectedNight();
  const { latest } = useData();
  const isLast = !!sel && !!latest && sel.index === latest.nights.length - 1;
  const [mode, setMode] = useState<'tonight' | 'check'>(fc.tonight ? 'tonight' : 'check');
  const peak = sel && Number.isFinite(sel.room.co2Max) ? { v: sel.room.co2Max, at: co2PeakAt(sel.night, sel.room.co2Max) } : null;
  const view = mode === 'tonight' ? fc.tonight : fc.check;
  const end = view?.forecast.at(-1);
  const cross = view?.forecast.find((p) => p.co2 >= 1000 && p.ts > view.known);
  const nowV = view?.actual.filter((r) => r.ts <= view.known).at(-1)?.co2;
  const actualEnd = mode === 'check' && view ? view.actual.filter((r) => r.ts <= view.until).at(-1)?.co2 : undefined;
  const title = !view || !end
    ? 'CO₂ ramp and forecast'
    : mode === 'tonight'
      ? cross
        ? `Tonight, CO₂ should cross 1,000 ppm around ${hm(cross.ts)}`
        : 'Tonight should stay under 1,000 ppm'
      : `Forecast ≈${fmt(round10(end.co2))} ppm at wake. Measured ${fmt(actualEnd ?? NaN)}.`;
  const facts =
    view && end
      ? mode === 'tonight'
        ? [
            { label: 'Now', value: `${fmt(nowV ?? NaN)} ppm`, alert: (nowV ?? 0) >= 1000 },
            { label: `By ${hm(end.ts)}`, value: `≈${fmt(round10(end.co2))} ppm`, alert: end.co2 >= 1000 },
            { label: 'Crosses 1,000', value: cross ? hm(cross.ts) : 'Not expected', alert: !!cross },
            { label: 'Based on', value: view.basis === 'learned' ? 'Recent nights' : "Tonight's build-up" },
          ]
        : [
            { label: 'Forecast made', value: hm(view.known), sub: '2 h after lights out' },
            { label: `Forecast at wake, ${hm(end.ts)}`, value: `≈${fmt(round10(end.co2))} ppm` },
            { label: `Measured at wake, ${hm(end.ts)}`, value: `${fmt(actualEnd ?? NaN)} ppm`, alert: (actualEnd ?? 0) >= 1000 },
            ...(peak ? [{ label: 'Peak in the night', value: `${fmt(peak.v)} ppm`, sub: `at ${hm(peak.at)}`, alert: peak.v >= 1000 }] : []),
            { label: 'Off by', value: `${signed((actualEnd ?? NaN) - round10(end.co2))} ppm` },
          ]
      : [];
  const learned = fc.learned;
  return (
    <Section
      id="forecast"
      nav="CO₂ forecast"
      title={title}
      cap="CO₂ in ppm. Solid is measured, dashed is the forecast with its ±(50 ppm + 5%) range."
      actions={
        <Segmented
          value={mode}
          onChange={setMode}
          label="Forecast"
          options={[
            { value: 'tonight', label: 'Tonight' },
            { value: 'check', label: !sel || isLast ? 'Last night' : shortDate(sel.night.date) },
          ]}
        />
      }
    >
      <div className={s.body}>
        <div className={s.main}>
          <LazyMount minHeight={220}>{view ? <Co2ForecastChart actual={view.actual} forecast={view.forecast} known={view.known} until={view.until} nowLabel={mode === 'tonight' ? 'Now' : 'Forecast made'} /> : <Placeholder height={280} />}</LazyMount>
        </div>
        <div className={s.aside}>
          {facts.length > 0 && <Facts items={facts} />}
          <p className={s.note}>
            {view?.basis === 'learned' && learned
              ? `Assumes two sleepers from about ${hm(fc.lightsOutTonight)}, your usual lights out, breathing out ${fmt(learned.gen * 1000, 1)} mL of CO₂ a second, with ${fmt(learned.ach, 2)} air changes an hour. After 90 minutes of sleep it switches to tonight's own build-up.`
              : 'A build-up model fitted on the sleeping hours so far: a 120 m³ room and 425 ppm outdoors.'}{' '}
            Bands: under 800 fresh, 800–1,000 fine, 1,000–1,500 stuffy, over 1,500 poor.
          </p>
        </div>
      </div>
    </Section>
  );
}

// ───────────── Screen ─────────────
export function RoomScreen() {
  const { dataset, progress, date, setDate } = useData();
  const sel = useSelectedNight();
  const { detail } = useNightDetail(date);
  const [filterDate, setFilterDate] = usePref<string | null>('filterCleaned', null);
  const fc = useCo2Forecast();
  const [open, setOpen] = useState<Drill | null>(null);

  const derived = useMemo(() => {
    if (!dataset) return null;
    const { nights, room } = dataset;
    // Morning decay when measured; real nights without a clean morning fall back to the overnight CO₂ plateau.
    const ach = nights.map((n, i) => ({ date: n.date, ts: Date.parse(`${n.date}T00:00:00Z`), ach: room[i]!.achMorning ?? (dataset.source === 'supabase' ? nightPlateauAch(n) : null), ajar: n.tags.includes('door_ajar'), truth: n.truth?.ach }));
    const last30 = room.slice(-30);
    const medCo2 = median(last30.map((r) => r.co2Mean));
    const medAch = median(ach.slice(-30).filter((a) => a.ach !== null && !a.ajar).map((a) => a.ach!));
    const runtime = nights.map(acRuntimeMin);
    const response = nights.flatMap((n) => {
      const r = coolingResponse(n);
      return r && Number.isFinite(r.outdoor) ? [{ ...r, ajar: n.tags.includes('door_ajar'), date: n.date }] : [];
    });
    return {
      ach,
      medCo2,
      medAch,
      morningCo2: median(nights.slice(-30).map((n) => n.room.filter((r) => r.ts <= n.wake).at(-1)?.co2 ?? NaN)),
      co2Cells: nights.map((n, i) => ({ date: n.date, value: room[i]!.minutesCo2Over1000 })),
      tempCells: nights.map((n, i) => ({ date: n.date, value: Math.max(0, (n.wake - n.lightsOut) / MIN - room[i]!.minutesTempInTarget) })),
      runtime,
      response,
    };
  }, [dataset]);

  const comfort = useMemo(() => {
    if (!sel) return [];
    const n = sel.night;
    const span = n.wake - n.lightsOut;
    return downsample(n.room.filter((r) => r.ts >= n.lightsOut && r.ts <= n.wake), 5 * MIN, 'mean').map((r) => ({ tempC: r.tempC, rh: r.rh, ts: r.ts, f: (r.ts - n.lightsOut) / span }));
  }, [sel]);

  const shower = useMemo(() => {
    if (!sel) return null;
    const n = sel.night;
    const pd = pulldownWindow(n);
    const inPulldown = (ts: number) => pd !== null && ts >= pd.start && ts <= pd.end;
    const detected = detail?.events.filter((e) => e.kind === 'shower') ?? [];
    const truth = n.truth?.events.filter((e) => e.kind === 'shower') ?? [];
    // Prefer a detection outside the pre-cool pull-down, where the AC's own RH swing can look like a shower.
    const clean = detected.find((e) => !inPulldown(e.start));
    const ev = clean ?? detected[0] ?? truth[0];
    if (!ev) return null;
    const imp = showerImpact(n, ev);
    if (!imp) return null;
    const win = n.room.filter((r) => r.ts >= ev.start - 30 * MIN && r.ts <= ev.start + 150 * MIN);
    return {
      imp,
      detected: detected.length > 0,
      suspect: !clean && detected.length > 0 && inPulldown(ev.start),
      rh: win.map((r) => ({ ts: r.ts, v: r.rh })),
      temp: win.map((r) => ({ ts: r.ts, v: r.tempC })),
    };
  }, [sel, detail]);

  if (!sel) return <Loading text={progress || 'Loading…'} />;
  const n = sel.night;
  const nightLabel = `${shortDay(n.date)} ${shortDate(n.date)}`;
  const nightMin = Math.max(1, (n.wake - n.lightsOut) / MIN);
  const rhPct = (sel.room.minutesRhInBand / nightMin) * 100;
  const onCurvePct = (sel.room.minutesTempInTarget / nightMin) * 100;
  const verdict = derived ? (derived.medCo2 > 1000 ? 'Ventilation recommended' : derived.medCo2 > 800 ? 'Borderline, try the door ajar' : 'No ventilation needed') : null;
  const verdictShort = derived ? (derived.medCo2 > 1000 ? 'Recommended' : derived.medCo2 > 800 ? 'Borderline' : 'Not needed') : null;
  const ervAch = derived && Number.isFinite(derived.medAch) ? derived.medAch + 65 / 120 : NaN;
  const ervPpm = Number.isFinite(ervAch) ? round10(steadyCo2(ervAch)) : NaN;
  const filterDays = filterDate ? Math.floor((Date.now() - Date.parse(`${filterDate}T00:00:00Z`)) / 86_400_000) : null;
  const runtime = derived ? (derived.runtime[sel.index] ?? NaN) : acRuntimeMin(n);
  const rt7 = derived ? median(derived.runtime.slice(Math.max(0, sel.index - 6), sel.index + 1)) : NaN;
  const missed = n.ac.filter((c) => c.landed === false).length;
  const pending = <Placeholder height={240} text={progress || 'Reading 90 nights…'} />;
  const preTemps = n.room.filter((r) => r.ts >= n.lightsOut - 100 * MIN && r.ts <= n.lightsOut);
  const preMax = preTemps.length ? Math.max(...preTemps.map((r) => r.tempC)) : NaN;
  const offScale = Number.isFinite(preMax) && preMax > SETPOINT_DOMAIN[1];
  const history = dataset ? dataset.room.slice(Math.max(0, sel.index - 29), sel.index + 1) : null;
  const nOver = history ? history.filter((r) => r.co2Mean > 1000).length : 0;
  const medResponse = derived ? median(derived.response.map((r) => r.minutes)) : NaN;
  const outdoorMean = n.outdoor.length ? n.outdoor.reduce((a, o) => a + o.tempC, 0) / n.outdoor.length : NaN;

  const drills: { key: Drill; label: string; value?: ReactNode; title: string; wide?: boolean }[] = [
    { key: 'ventilation', label: 'Ventilation verdict', value: verdictShort ?? '…', title: 'Ventilation verdict' },
    { key: 'fresh', label: 'Fresh-air tracker', value: derived ? `${fmt(derived.medAch, 2)} an hour, median` : '…', title: 'Fresh air, night by night', wide: true },
    { key: 'comfort', label: 'Temperature × humidity', value: `${fmt(rhPct)}% in band`, title: 'Temperature × humidity' },
    { key: 'rhythm', label: '24-hour rhythm', value: 'Last 14 nights', title: 'When the room breathes' },
    { key: 'offcurve', label: 'Nights off the temperature curve', value: `${fmt(nightMin - sel.room.minutesTempInTarget)} min off`, title: 'Nights off the temperature curve' },
    { key: 'response', label: 'Room response', value: Number.isFinite(medResponse) ? `${fmt(medResponse)} min to cool 1°` : '…', title: 'How fast the room cools' },
    { key: 'duty', label: 'Aircon duty and filter', value: filterDays === null ? 'Filter not logged' : `Filter ${filterDays} ${filterDays === 1 ? 'day' : 'days'}`, title: 'Aircon duty and filter' },
    { key: 'events', label: 'Events', value: detail ? `${detail.events.length} detected` : '…', title: `Events, ${nightLabel}`, wide: true },
    { key: 'shower', label: 'Shower impact', value: shower ? hm(shower.imp.start) : 'None this night', title: 'Shower impact' },
    { key: 'outdoor', label: 'Outdoor vs bedroom', value: Number.isFinite(outdoorMean) ? `${fmt(outdoorMean)}° outside` : '–', title: 'Outdoor vs bedroom', wide: true },
  ];
  const active = drills.find((d) => d.key === open);

  return (
    <div>
      <PageHeader title="Room" lede={`The bedroom's air right now, then the night of ${nightLabel} and the weeks around it.`} />
      <Hero fc={fc} />

      <ForecastSection fc={fc} />

      <Section
        id="setpoint"
        nav="Setpoint vs actual"
        title={n.manual ? `In the comfort band ${fmt(onCurvePct)}% of the night` : `On the temperature curve ${fmt(onCurvePct)}% of the night`}
        cap={`Room temperature at bed height, ${nightLabel}. ${n.manual ? `The aircon was run by hand, so dashed is the steady ${MANUAL_COMFORT_TARGET_C}° comfort target it is scored against.` : 'Dashed is the plan; the thin line is what the aircon was set to.'}${offScale ? ` The room started at ${fmt(preMax, 1)}° before the pre-cool, above this scale.` : ''}`}
      >
        <div className={s.body}>
          <div className={s.main}>
            <LazyMount minHeight={220}>
              <SetpointChart night={n} curve={n.manual ? manualComfortCurve() : DEFAULT_CURVE} />
            </LazyMount>
            <Disclosure title="Aircon log" count={`${n.ac.length} commands`}>
              <EventList
                items={[...n.ac]
                  .sort((a, b) => a.ts - b.ts)
                  .map((c) => ({
                    time: hm(c.ts),
                    title: c.state.power ? `${c.state.mode[0]!.toUpperCase()}${c.state.mode.slice(1)} ${c.state.setpointC}°, fan ${c.state.fan}` : 'Off',
                    detail: `${c.reason}${c.landed === false ? ' · may not have landed' : c.landed ? ' · landed' : ''}`,
                  }))}
              />
            </Disclosure>
          </div>
          <div className={s.aside}>
            <Facts
              items={[
                { label: 'Commands sent', value: n.ac.length ? fmt(n.ac.length) : dataset?.source === 'supabase' ? 'None (by hand)' : '0' },
                { label: 'Missed', value: missed ? fmt(missed) : 'None', alert: missed > 0 },
                n.ac.length || dataset?.source !== 'supabase'
                  ? { label: 'Aircon ran', value: dur(runtime), sub: Number.isFinite(rt7) ? `7-night median ${dur(rt7)}` : undefined }
                  : { label: 'Aircon ran', value: 'Not logged', sub: 'run by hand, so Sleep Lab has no record' },
                n.manual
                  ? { label: 'Outside the band', value: dur(nightMin - sel.room.minutesTempInTarget), sub: `more than 0.75° from ${MANUAL_COMFORT_TARGET_C}°` }
                  : { label: 'Off the curve', value: dur(nightMin - sel.room.minutesTempInTarget), sub: 'more than 0.75° from the plan' },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section
        id="nights"
        nav="Nights over 1,000"
        title={history ? (nOver ? `${nOver} of the last ${history.length} nights averaged over 1,000\u00a0ppm` : `None of the last ${history.length} nights averaged over 1,000\u00a0ppm`) : 'Nights over 1,000 ppm'}
        cap="Each bar is one night's average CO₂. Tap a night to open it."
      >
        <div className={s.body}>
          <div className={s.main}>{history ? <NightBars nights={history} selected={n.date} onPick={setDate} /> : pending}</div>
          <div className={s.aside}>
            {derived ? (
              <Facts
                items={[
                  { label: 'Morning CO₂', value: `${fmt(derived.morningCo2)} ppm`, sub: 'median at wake, 30 nights', alert: derived.morningCo2 >= 1000 },
                  { label: 'Fresh air, 30-night median', value: `${fmt(derived.medAch, 2)} an hour`, sub: `${fmt(ACH_FOR_1000, 2)} needed, door shut`, alert: derived.medAch < ACH_FOR_1000 },
                  { label: 'With an ERV', value: `≈${fmt(ervPpm)} ppm`, sub: 'a 65 m³/h unit' },
                  { label: 'Ventilation', value: verdictShort ?? '…', sub: verdict === 'Borderline, try the door ajar' ? 'try the door ajar' : undefined },
                ]}
              />
            ) : (
              <Skeleton h={200} />
            )}
          </div>
        </div>
      </Section>

      <div className={s.more}>
        <MoreAnalysis items={drills.map((d) => ({ label: d.label, value: d.value, onClick: () => setOpen(d.key) }))} />
      </div>
      <OnThisPage />

      <Sheet open={open !== null} onClose={() => setOpen(null)} title={active?.title} wide>
        <div className={s.sheetBody}>
          {open === 'ventilation' &&
            (derived ? (
              <>
                <p className={s.sheetLede}>
                  <b>{verdict}.</b> Over the last 30 nights the median night averaged {fmt(derived.medCo2)} ppm, against a decision line of 1,000.
                </p>
                <div>
                  <h3 className="label">Median nightly CO₂</h3>
                  <Meter min={400} max={1600} step={200} value={derived.medCo2} valueLabel={`${fmt(derived.medCo2)} median`} limit={1000} limitLabel="1,000 decision" extra={Number.isFinite(ervPpm) ? { v: ervPpm, label: 'With an ERV' } : undefined} fmtTick={fmt} unitLabel="ppm" label={`Median nightly CO₂ ${fmt(derived.medCo2)} ppm against the 1,000 ppm decision line`} />
                </div>
                <div>
                  <h3 className="label">Fresh air</h3>
                  <Meter min={0} max={0.8} step={0.1} value={derived.medAch} valueLabel={`${fmt(derived.medAch, 2)} median`} limit={ACH_FOR_1000} limitLabel={`${fmt(ACH_FOR_1000, 2)} needed`} extra={Number.isFinite(ervAch) ? { v: Math.min(0.8, ervAch), label: 'With an ERV' } : undefined} fmtTick={(v) => fmt(v, 1)} unitLabel="air changes an hour" label={`Fresh air ${fmt(derived.medAch, 2)} air changes per hour; ${fmt(ACH_FOR_1000, 2)} needed`} />
                </div>
                <Facts
                  items={[
                    { label: 'Morning CO₂', value: `${fmt(derived.morningCo2)} ppm`, sub: 'median at wake' },
                    { label: 'Fresh air, 30-night median', value: `${fmt(derived.medAch, 2)} an hour`, sub: 'door shut' },
                    { label: 'With an ERV', value: `≈${fmt(ervPpm)} ppm`, sub: 'a 65 m³/h unit' },
                  ]}
                />
                <div>
                  <h3 className="label">Minutes above 1,000 ppm, every night</h3>
                  <CalendarHeatmap cells={derived.co2Cells} color="var(--signal)" max={300} unit="min above 1,000 ppm" onPick={(d) => { setDate(d); setOpen(null); }} selected={date} label="Minutes above 1,000 ppm per night" />
                </div>
                <p className={s.note}>
                  The rule: buy one if the median night averages over 1,000 ppm, or mornings are regularly over 1,200. An ERV rather than an HRV, because Phuket air is a humidity load: about 0.4–0.9 kW of extra cooling at 50–80 m³/h.
                </p>
              </>
            ) : (
              pending
            ))}

          {open === 'fresh' &&
            (derived ? (
              <>
                <p className={s.sheetLede}>
                  Air changes per hour, measured from how fast CO₂ falls each morning. Two sleepers need about <b>{fmt(ACH_FOR_1000, 2)}</b> to stay under 1,000 ppm.
                </p>
                <AchTracker points={derived.ach} needed={ACH_FOR_1000} />
                <p className={s.note}>Dots are nights with the door shut; rings are nights with the door ajar. The line is the 7-night median.</p>
                <TableView columns={['Night', 'Air changes', 'Door']} rows={derived.ach.filter((a) => a.ach !== null).slice(-30).reverse().map((a) => [shortDate(a.date), fmt(a.ach, 2), a.ajar ? 'ajar' : 'closed'])} />
              </>
            ) : (
              pending
            ))}

          {open === 'comfort' && (
            <>
              <p className={s.sheetLede}>
                <b>{fmt(rhPct)}%</b> of the night of {nightLabel} was inside 45–55% humidity.
              </p>
              <ComfortChart points={comfort} />
              <p className={s.note}>One dot every 5 minutes, darker is later. Drifting up and to the left means cold and clammy: try DRY mode before bed.</p>
            </>
          )}

          {open === 'rhythm' && (dataset ? <RadialClock nights={dataset.nights.slice(-14)} /> : <Placeholder height={360} />)}

          {open === 'offcurve' &&
            (derived ? (
              <>
                <p className={s.sheetLede}>Minutes each night more than 0.75° from the plan. Tap a night to open it.</p>
                <CalendarHeatmap cells={derived.tempCells} color="var(--text)" max={180} unit="min off the curve" onPick={(d) => { setDate(d); setOpen(null); }} selected={date} label="Minutes off the temperature curve per night" />
              </>
            ) : (
              pending
            ))}

          {open === 'response' &&
            (derived ? (
              <>
                <p className={s.sheetLede}>
                  After the pre-cool command, the room takes a median <b>{fmt(medResponse)} minutes</b> to cool by 1°. The controller uses this to start pre-cooling early enough.
                </p>
                <ResponseScatter points={derived.response} />
                <p className={s.note}>One dot per night against the outdoor temperature. Rings are nights with the door ajar.</p>
              </>
            ) : (
              pending
            ))}

          {open === 'duty' && (
            <>
              <Facts
                items={[
                  { label: `Aircon ran, ${nightLabel}`, value: dur(runtime) },
                  { label: '7-night median', value: dur(rt7) },
                  { label: 'Filter last cleaned', value: filterDays === null ? 'Not logged yet' : `${filterDays} ${filterDays === 1 ? 'day' : 'days'} ago`, alert: filterDays !== null && filterDays > 30, sub: filterDays !== null && filterDays > 30 ? 'clean it soon' : undefined },
                ]}
              />
              <div className={s.duty}>
                <p className={s.note}>Runtime is worked out from the IR commands, so it is an estimate.</p>
                <Button variant="secondary" icon="check" onClick={() => setFilterDate(ictDate(Date.now()))}>
                  Cleaned today
                </Button>
              </div>
            </>
          )}

          {open === 'events' &&
            (detail ? (
              <>
                <p className={s.sheetLede}>
                  {detail.events.length} events detected from CO₂ and humidity on {nightLabel}.
                </p>
                <EventLanes
                  from={n.room[0]?.ts ?? n.lightsOut}
                  to={n.room.at(-1)?.ts ?? n.wake}
                  lanes={[{ label: 'Detected', items: detail.events }, ...(n.truth ? [{ label: 'Simulator truth', items: n.truth.events }] : [])]}
                />
                {n.truth && <p className={s.note}>The solid bar is what the app detected; the faded bar under it is the simulator&apos;s truth.</p>}
              </>
            ) : (
              <Placeholder height={300} />
            ))}

          {open === 'shower' &&
            (shower ? (
              <>
                <p className={s.sheetLede}>
                  Shower at <b>{hm(shower.imp.start)}</b>{shower.suspect ? ', detected during the pre-cool, so it may be the aircon' : shower.detected ? '' : ', from the simulator (not detected)'}. Humidity went from {fmt(shower.imp.rhBefore)}% to {fmt(shower.imp.rhPeak)}%.
                </p>
                <div className={s.pair}>
                  <div>
                    <h3 className="label">Humidity</h3>
                    <ShowerMini series={shower.rh} start={shower.imp.start} end={shower.imp.end} metric="rh" />
                  </div>
                  <div>
                    <h3 className="label">Temperature</h3>
                    <ShowerMini series={shower.temp} start={shower.imp.start} end={shower.imp.end} metric="temp" />
                  </div>
                </div>
                <Facts
                  items={[
                    { label: 'Humidity, before → peak', value: `${fmt(shower.imp.rhBefore)} → ${fmt(shower.imp.rhPeak)}%` },
                    shower.imp.tempPeak > shower.imp.tempBefore + 0.1
                      ? { label: 'Temperature, before → peak', value: `${fmt(shower.imp.tempBefore, 1)} → ${fmt(shower.imp.tempPeak, 1)}°` }
                      : { label: 'Temperature, before → after', value: `${fmt(shower.imp.tempBefore, 1)} → ${fmt(shower.imp.tempAfter, 1)}°`, sub: 'the aircon was cooling' },
                    { label: 'Back to normal humidity', value: shower.imp.recoverMin !== null ? dur(shower.imp.recoverMin) : 'Not within 2.5 h' },
                    { label: 'Extra aircon time', value: `≈${dur(shower.imp.extraCoolMin)}` },
                  ]}
                />
              </>
            ) : (
              <div className={s.empty}>No shower on {nightLabel}. Pick another night in the sidebar or on the nightly bars.</div>
            ))}

          {open === 'outdoor' && (
            <>
              <p className={s.sheetLede}>{nightLabel}, with simulated Phuket weather. Real weather from Open-Meteo comes later.</p>
              <OutdoorIndoor night={n} />
            </>
          )}
        </div>
      </Sheet>
    </div>
  );
}
