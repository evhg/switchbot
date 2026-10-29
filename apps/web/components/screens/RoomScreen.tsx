'use client';
/**
 * Room tab (docs/DESIGN.md §11 "Room"): live hero strip, then four sections — Air, Comfort, Aircon, Events — under a
 * sticky jump bar. Each section carries its own chapter accent. Sections render as soon as the newest-night preview
 * exists; cards that need history show skeletons until the full dataset arrives.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { DEFAULT_CURVE, dewPointC, downsample, FALLBACK_GEN_LPS, fitBuildup, forecastCo2, forecastCo2Occupied, type RoomReading } from '@sleep-lab/core';
import { useData, useLive, useNightDetail, useSelectedNight } from '@/lib/data/context.tsx';
import { ACH_FOR_1000, acRuntimeMin, coolingResponse, pulldownWindow, showerImpact, steadyCo2 } from '@/lib/analysis.ts';
import { addDays, co2Band, dur, fmt, hm, ictDate, ictHour, ictMidnight, HOUR, MIN, shortDate, signed } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';
import { median } from '@/lib/stats.ts';
import { AchTracker, CalendarHeatmap, Co2ForecastChart, ComfortChart, EventLanes, OutdoorIndoor, RadialClock, ResponseScatter, SetpointChart, ShowerMini, VentGauge } from '../charts/room.tsx';
import { LiveSpark, LiveTile } from '../charts/room/live.tsx';
import s from '../charts/room/room.module.css';
import { DateNav } from '../DateNav.tsx';
import { Icon } from '../icons.tsx';
import { LazyMount } from '../motion.tsx';
import { Button, Card, DeltaChip, JumpBar, Legend, Loading, Placeholder, SectionHeader, Segmented, StatusDot, TableView } from '../ui.tsx';

const accent = (a: string): CSSProperties => ({ ['--ch-accent' as string]: `var(--ac-${a})` });

const JUMP = [
  { id: 'air', label: 'Air' },
  { id: 'comfort', label: 'Comfort' },
  { id: 'aircon', label: 'Aircon' },
  { id: 'events', label: 'Events' },
] as const;

function Section({ id, n, kicker, lines, lede, accent: ac, children }: { id: string; n: number; kicker: string; lines: ReactNode[]; lede?: ReactNode; accent: string; children: ReactNode }) {
  return (
    <section id={id} data-jump className={s.section} style={accent(ac)} aria-label={kicker}>
      <div className={s.sectionHead}>
        <SectionHeader n={n} kicker={kicker} lines={lines} size="h2" />
        {lede && <p className={s.sectionLede}>{lede}</p>}
      </div>
      <div className="stack two">{children}</div>
    </section>
  );
}

/** One small stat in a hairline-separated row. */
function Stat({ label, value, unit, sub }: { label: ReactNode; value: ReactNode; unit?: string; sub?: ReactNode }) {
  return (
    <div className={s.stat}>
      <span className={`${s.statLabel} t-micro`}>{label}</span>
      <span className={s.statValue}>
        {value}
        {unit && <span className="t-unit">{unit}</span>}
      </span>
      {sub && <span className={s.statSub}>{sub}</span>}
    </div>
  );
}

// ───────────── Live strip ─────────────
function LiveTiles() {
  const { now, reading, history } = useLive(6);
  const hourAgo = history.find((r) => r.ts >= now - HOUR);
  const tiles = [
    { key: 'temp', label: 'Temperature', icon: 'thermometer' as const, unit: '°C', digits: 1, color: 'var(--temp)', get: (r: RoomReading) => r.tempC },
    { key: 'rh', label: 'Humidity', icon: 'droplet' as const, unit: '%', digits: 0, color: 'var(--rh)', get: (r: RoomReading) => r.rh },
    { key: 'co2', label: 'CO₂', icon: 'co2' as const, unit: 'ppm', digits: 0, color: 'var(--co2)', get: (r: RoomReading) => r.co2 },
    { key: 'dew', label: 'Dew point', icon: 'wind' as const, unit: '°C', digits: 1, color: 'var(--dew)', get: (r: RoomReading) => dewPointC(r.tempC, r.rh) },
  ];
  const spark = useMemo(() => downsample(history, 5 * MIN, 'mean'), [history]);
  return (
    <section className={s.live} aria-label="Live readings">
      <div className={s.liveHead}>
        <span className={`${s.liveTag} t-label`}>
          <i className={s.liveDot} aria-hidden />
          Live · {reading ? hm(reading.ts) : '–'}
        </span>
        <span className={`${s.liveMeta} t-micro muted`}>Last 6 h · every 60 s</span>
      </div>
      <div className={s.tiles}>
        {tiles.map((t) => {
          const v = reading ? t.get(reading) : NaN;
          const d = reading && hourAgo ? v - t.get(hourAgo) : NaN;
          const band = t.key === 'co2' && reading ? co2Band(reading.co2) : null;
          return (
            <LiveTile
              key={t.key}
              label={t.label}
              icon={t.icon}
              value={v}
              dp={t.digits}
              unit={t.unit}
              color={t.color}
              band={band ? `var(--${band.key})` : undefined}
              stamp={reading?.ts ?? null}
              delta={
                band ? (
                  <>
                    <span className="status-pill" style={{ marginTop: 0 }}>
                      <StatusDot status={band.key} /> {band.label}
                    </span>
                    <span className="mono">{Number.isFinite(d) ? `${signed(d, 0)}/h` : ''}</span>
                  </>
                ) : Number.isFinite(d) ? (
                  <>
                    <DeltaChip tone="neutral" dir={d > 0.05 ? 'up' : d < -0.05 ? 'down' : 'flat'}>
                      {signed(d, t.digits)}
                    </DeltaChip>
                    <span>vs 1 h ago</span>
                  </>
                ) : (
                  <span>&nbsp;</span>
                )
              }
              spark={<LiveSpark values={spark.map((r) => ({ ts: r.ts, v: t.get(r) }))} color={t.color} format={(v, ts) => `${hm(ts)} · ${fmt(v, t.digits)}`} />}
            />
          );
        })}
      </div>
    </section>
  );
}

// ───────────── CO₂ forecast ─────────────
function Co2ForecastCard() {
  const { source, dataset } = useData();
  const sel = useSelectedNight();
  const [now] = useState(() => Date.now());
  const evening = ictHour(now) >= 18 || ictHour(now) < 7;
  const [mode, setMode] = useState<'tonight' | 'check'>(evening ? 'tonight' : 'check');
  const [live, setLive] = useState<RoomReading[]>([]);
  const today = ictDate(now);
  const wakeDate = ictHour(now) >= 12 ? addDays(today, 1) : today;
  const startTs = ictMidnight(wakeDate) - 6 * HOUR; // 18:00 the evening before
  const untilTs = ictMidnight(wakeDate) + 6.5 * HOUR;
  useEffect(() => {
    if (mode !== 'tonight') return;
    let alive = true;
    source.liveWindow(Math.min(startTs, now - 2 * HOUR), now).then((r) => alive && setLive(r)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [mode, source, startTs, now]);

  // Two sleepers at the rate learned from the last 14 nights, at the median fresh-air rate, from the usual lights-out.
  const learned = useMemo(() => {
    if (!dataset) return null;
    const nights = dataset.nights.slice(-14);
    const rooms = dataset.room.slice(-14);
    const achs = rooms.flatMap((r, i) => (r.achMorning !== null && !nights[i]?.tags.includes('door_ajar') ? [r.achMorning] : []));
    const ach = achs.length ? median(achs) : 0.2;
    const gens = nights.flatMap((n) => {
      const f = fitBuildup(n.room.filter((r) => r.ts >= n.lightsOut + 30 * MIN && r.ts <= n.lightsOut + 3 * HOUR), { ach });
      return f && f.generationLps > 0.002 && f.generationLps < 0.02 ? [f.generationLps] : [];
    });
    const loMin = median(nights.map((n) => (n.lightsOut - ictMidnight(n.date)) / MIN));
    return { ach, gen: gens.length ? median(gens) : FALLBACK_GEN_LPS, loOffsetMin: Number.isFinite(loMin) ? loMin : -90 };
  }, [dataset]);
  const lightsOutTonight = ictMidnight(wakeDate) + (learned?.loOffsetMin ?? -90) * MIN;

  const view = useMemo(() => {
    if (mode === 'tonight') {
      if (live.length < 30) return null;
      const last = live.at(-1)!.ts;
      // Until ~90 min of tonight's build-up exist, fitting the recent (empty-room) window would predict a flat line.
      if (learned && last < lightsOutTonight + 90 * MIN) {
        const fc = forecastCo2Occupied(live, untilTs, { occupiedFrom: Math.max(lightsOutTonight, last), generationLps: learned.gen, ach: learned.ach });
        return { actual: live, forecast: fc, known: last, until: untilTs, basis: 'learned' as const };
      }
      const fc = forecastCo2(live.filter((r) => r.ts >= lightsOutTonight), untilTs);
      return { actual: live, forecast: fc, known: last, until: untilTs, basis: 'fit' as const };
    }
    if (!sel) return null;
    const n = sel.night;
    const known = n.lightsOut + 2 * HOUR;
    const actual = n.room.filter((r) => r.ts <= n.wake);
    const fc = forecastCo2(actual.filter((r) => r.ts >= n.lightsOut && r.ts <= known), n.wake);
    return { actual, forecast: fc, known, until: n.wake, basis: 'fit' as const };
  }, [mode, live, sel, untilTs, learned, lightsOutTonight]);

  const end = view?.forecast.at(-1);
  const actualEnd = mode === 'check' ? view?.actual.filter((r) => r.ts <= view.until).at(-1) : undefined;
  return (
    <Card
      title="CO₂ ramp & forecast"
      sub={
        end
          ? mode === 'tonight'
            ? `≈${fmt(Math.round(end.co2 / 10) * 10)} ppm by ${hm(end.ts)} if nothing changes`
            : `Forecast made at ${hm(view!.known)}: ${fmt(end.co2)} ppm at wake · actual ${fmt(actualEnd?.co2 ?? NaN)}`
          : 'Waiting for data…'
      }
    >
      <div className={s.cardTools}>
        <Segmented
          value={mode}
          onChange={setMode}
          label="Forecast mode"
          options={[
            { value: 'tonight', label: 'Tonight' },
            { value: 'check', label: sel ? `Check ${shortDate(sel.night.date)}` : 'Check' },
          ]}
        />
        <Legend items={[{ label: 'Measured', color: 'var(--co2)' }, { label: 'Forecast ±', color: 'var(--co2)', shape: 'dash' }]} />
      </div>
      <LazyMount minHeight={220}>{view ? <Co2ForecastChart actual={view.actual} forecast={view.forecast} known={view.known} until={view.until} /> : <Placeholder height={220} />}</LazyMount>
      <p className={s.note}>
        {view?.basis === 'learned' && learned
          ? `Assumes two sleepers from ≈${hm(lightsOutTonight)} (usual lights-out) at the rate learned from recent nights (${fmt(learned.gen * 1000, 1)} mL/s CO₂, ${fmt(learned.ach, 2)} ACH). After 90 min of sleep it switches to tonight's own build-up.`
          : 'Build-up model fitted on the sleeping hours so far (120 m³, outdoor 425 ppm). The ribbon is ±(50 ppm + 5 %).'}{' '}
        Bands: &lt;800 · 800–1,000 · 1,000–1,500 · &gt;1,500.
      </p>
    </Card>
  );
}

// ───────────── Screen ─────────────
export function RoomScreen() {
  const { dataset, progress, date, setDate } = useData();
  const sel = useSelectedNight();
  const { detail } = useNightDetail(date);
  const [filterDate, setFilterDate] = usePref<string | null>('filterCleaned', null);

  const derived = useMemo(() => {
    if (!dataset) return null;
    const { nights, room } = dataset;
    const ach = nights.map((n, i) => ({ date: n.date, ts: Date.parse(`${n.date}T00:00:00Z`), ach: room[i]!.achMorning, ajar: n.tags.includes('door_ajar'), truth: n.truth?.ach }));
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
  const nightMin = Math.max(1, (n.wake - n.lightsOut) / MIN);
  const rhPct = (sel.room.minutesRhInBand / nightMin) * 100;
  const verdict = derived ? (derived.medCo2 > 1000 ? 'Ventilation recommended' : derived.medCo2 > 800 ? 'Borderline: try the door ajar' : 'No ventilation needed') : null;
  const ventBand = derived ? co2Band(derived.medCo2).key : 'good';
  const ervAch = derived && Number.isFinite(derived.medAch) ? derived.medAch + 65 / 120 : NaN;
  const filterDays = filterDate ? Math.floor((Date.now() - Date.parse(`${filterDate}T00:00:00Z`)) / 86_400_000) : null;
  const rt7 = derived ? median(derived.runtime.slice(-7)) : NaN;
  const missed = n.ac.filter((c) => c.landed === false).length;
  const pending = <Placeholder height={200} text={progress || 'Reading 30 nights…'} />;

  return (
    <div className={s.page} style={accent('air')}>
      <DateNav title="Room" kicker="Bedroom air" />
      <LiveTiles />
      <JumpBar items={JUMP} label="Room sections" />

      <Section
        id="air"
        n={1}
        kicker="Air"
        accent="air"
        lines={['Fresh air.', verdict ? `${verdict}.` : 'Measuring…']}
        lede={derived ? <>The median night averaged {fmt(derived.medCo2)} ppm over the last 30 nights; {fmt(sel.room.minutesCo2Over1000)} min above 1,000 on {shortDate(n.date)}.</> : undefined}
      >
        <Co2ForecastCard />

        <Card title="Ventilation verdict" sub={verdict ? '30-night median vs the 1,000 ppm decision line' : 'Waiting for 30 nights…'}>
          {derived ? (
            <>
              <VentGauge value={derived.medCo2} />
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
                <span className={s.verdictPill} style={{ ['--band-c' as string]: `var(--${ventBand})` }}>
                  <StatusDot status={ventBand} /> {verdict}
                </span>
              </div>
              <div className={s.stats}>
                <Stat label="Morning CO₂" value={fmt(derived.morningCo2)} unit="ppm" sub="median at wake" />
                <Stat label="Fresh air" value={fmt(derived.medAch, 2)} unit="ACH" sub="median, door shut" />
                <Stat label="With ERV" value={`≈${fmt(Math.round(steadyCo2(ervAch) / 10) * 10)}`} unit="ppm" sub="65 m³/h unit" />
              </div>
              <p className={s.note}>
                Rule: buy if the median nightly mean is above 1,000 ppm or mornings are regularly above 1,200. An ERV (not HRV) because Phuket air is a humidity load: ≈0.4–0.9 kW of extra cooling at 50–80 m³/h.
              </p>
            </>
          ) : (
            pending
          )}
        </Card>

        <Card title="Fresh-air tracker" sub="Air changes per hour from each morning's CO₂ decay">
          {derived ? (
            <>
              <LazyMount minHeight={226}>
                <AchTracker points={derived.ach} needed={ACH_FOR_1000} />
              </LazyMount>
              <TableView columns={['Night', 'ACH', 'Door']} rows={derived.ach.filter((a) => a.ach !== null).slice(-30).reverse().map((a) => [shortDate(a.date), fmt(a.ach, 2), a.ajar ? 'ajar' : 'closed'])} />
            </>
          ) : (
            pending
          )}
        </Card>

        <Card title="Nights over 1,000 ppm" sub="Minutes per night · tap a day to open it">
          {derived ? <CalendarHeatmap cells={derived.co2Cells} color="var(--co2)" max={300} unit="min" onPick={setDate} selected={date} /> : pending}
        </Card>
      </Section>

      <Section id="comfort" n={2} kicker="Comfort" accent="lights" lines={['Comfort.', `${fmt(rhPct)}% of the night in the humidity band.`]}>
        <Card title="Temperature × humidity" sub={`${shortDate(n.date)} · one dot per 5 min, darker = later`} className="span-2">
          <LazyMount minHeight={256}>
            <ComfortChart points={comfort} />
          </LazyMount>
          <p className={s.note}>
            <b>{fmt(rhPct)}%</b> of the night inside 45–55 % RH. Drifting up and left = &quot;cold and clammy&quot;: try DRY mode before bed.
          </p>
        </Card>

        <Card title="24-hour rhythm" sub="When the room breathes · last 14 nights">
          {dataset ? (
            <LazyMount minHeight={340}>
              <RadialClock nights={dataset.nights.slice(-14)} />
            </LazyMount>
          ) : (
            <Placeholder height={320} />
          )}
        </Card>

        <Card title="Nights off the temperature curve" sub="Minutes more than 0.75 °C from target">
          {derived ? <CalendarHeatmap cells={derived.tempCells} color="var(--temp)" max={180} unit="min" onPick={setDate} selected={date} /> : pending}
        </Card>
      </Section>

      <Section id="aircon" n={3} kicker="Aircon" accent="night" lines={['The aircon.', `${n.ac.length} commands${missed ? `, ${missed} missed` : ''} on ${shortDate(n.date)}.`]}>
        <Card title="Setpoint vs actual" sub={`${n.ac.length} IR commands · ${missed} flagged as missed`} className="span-2">
          <LazyMount minHeight={236}>
            <SetpointChart night={n} curve={DEFAULT_CURVE} />
          </LazyMount>
          <TableView
            columns={['Time', 'Command', 'Landed', 'Reason']}
            rows={n.ac.map((c) => [hm(c.ts), c.state.power ? `${c.state.mode} ${c.state.setpointC}° ${c.state.fan}` : 'OFF', c.landed === false ? 'missed?' : c.landed ? 'yes' : '–', c.reason])}
          />
        </Card>

        <Card title="Room response" sub="Minutes to cool 1 °C after the pre-cool command">
          {derived ? (
            <>
              <LazyMount minHeight={216}>
                <ResponseScatter points={derived.response} />
              </LazyMount>
              <p className={s.note}>
                Median <b>{fmt(median(derived.response.map((r) => r.minutes)))} min</b>. This is the learned model the controller uses to start pre-cooling early enough.
              </p>
            </>
          ) : (
            pending
          )}
        </Card>

        <Card title="Aircon duty & filter">
          <div className={s.duty}>
            <div className={s.dutyTile}>
              <span className="t-micro muted">Runtime · night</span>
              <span className={s.dutyValue}>{derived ? dur(derived.runtime[sel.index] ?? NaN) : dur(acRuntimeMin(n))}</span>
              <span className={s.statSub}>7-night median {dur(rt7)}</span>
            </div>
            <div className={s.dutyTile}>
              <span className="t-micro muted">Filter clock</span>
              <span className={s.dutyValue}>
                {filterDays === null ? '–' : filterDays}
                {filterDays !== null && <span className="t-unit">{filterDays === 1 ? 'day' : 'days'}</span>}
              </span>
              <span className={s.statSub}>{filterDays === null ? 'not logged yet' : filterDays > 30 ? 'clean it soon' : 'since last clean'}</span>
            </div>
          </div>
          <div className={s.dutyRow}>
            <span className={s.statSub}>Runtime from IR commands (open loop, estimate).</span>
            <Button size="sm" variant="ghost" icon="check" onClick={() => setFilterDate(ictDate(Date.now()))}>
              Cleaned today
            </Button>
          </div>
        </Card>
      </Section>

      <Section
        id="events"
        n={4}
        kicker="Events"
        accent="verdict"
        lines={['What happened.', detail ? `${detail.events.length} events in the air.` : 'Reading the night…']}
      >
        <Card title="Events" sub={detail ? `${detail.events.length} detected from CO₂ and RH` : 'Detecting…'} className="span-2">
          {detail ? (
            <EventLanes
              from={n.room[0]?.ts ?? n.lightsOut}
              to={n.room.at(-1)?.ts ?? n.wake}
              lanes={[{ label: 'Detected', items: detail.events }, ...(n.truth ? [{ label: 'Simulator truth', items: n.truth.events }] : [])]}
            />
          ) : (
            <Placeholder height={200} />
          )}
        </Card>

        <Card
          title="Shower impact"
          sub={
            shower
              ? `${hm(shower.imp.start)} · ${shower.suspect ? 'detected during pre-cool (may be the AC)' : shower.detected ? 'detected' : 'from sim truth (not detected)'}`
              : 'No shower this night'
          }
        >
          {shower ? (
            <>
              <div className={s.showerGrid}>
                <div>
                  <div className={`${s.miniLabel} t-micro`}>
                    <Icon name="droplet" size={12} /> Humidity
                  </div>
                  <ShowerMini series={shower.rh} start={shower.imp.start} end={shower.imp.end} metric="rh" />
                </div>
                <div>
                  <div className={`${s.miniLabel} t-micro`}>
                    <Icon name="thermometer" size={12} /> Temperature
                  </div>
                  <ShowerMini series={shower.temp} start={shower.imp.start} end={shower.imp.end} metric="temp" />
                </div>
              </div>
              <dl className="kv" style={{ marginTop: 14 }}>
                <dt>RH before → peak</dt>
                <dd className="num">
                  {fmt(shower.imp.rhBefore)} → {fmt(shower.imp.rhPeak)} %
                </dd>
                {shower.imp.tempPeak > shower.imp.tempBefore + 0.1 ? (
                  <>
                    <dt>Temp before → peak</dt>
                    <dd className="num">
                      {fmt(shower.imp.tempBefore, 1)} → {fmt(shower.imp.tempPeak, 1)} °C
                    </dd>
                  </>
                ) : (
                  <>
                    <dt>Temp before → after</dt>
                    <dd className="num">
                      {fmt(shower.imp.tempBefore, 1)} → {fmt(shower.imp.tempAfter, 1)} °C <span className="muted">(aircon cooling)</span>
                    </dd>
                  </>
                )}
                <dt>Back to normal RH</dt>
                <dd className="num">{shower.imp.recoverMin !== null ? dur(shower.imp.recoverMin) : 'not within window'}</dd>
                <dt>Extra aircon time</dt>
                <dd className="num">≈{dur(shower.imp.extraCoolMin)}</dd>
              </dl>
            </>
          ) : (
            <div className={s.empty}>
              <Icon name="shower" size={22} />
              <span>No shower this night. Pick another night in the calendars above.</span>
            </div>
          )}
        </Card>

        <Card title="Outdoor vs bedroom" sub={`${shortDate(n.date)} · simulated Phuket weather (Open-Meteo later)`}>
          <LazyMount minHeight={330}>
            <OutdoorIndoor night={n} />
          </LazyMount>
        </Card>
      </Section>
    </div>
  );
}
