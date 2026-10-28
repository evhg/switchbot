'use client';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_CURVE, dewPointC, downsample, FALLBACK_GEN_LPS, fitBuildup, forecastCo2, forecastCo2Occupied, type RoomReading } from '@sleep-lab/core';
import { useData, useLive, useNightDetail, useSelectedNight } from '@/lib/data/context.tsx';
import { ACH_FOR_1000, acRuntimeMin, coolingResponse, pulldownWindow, showerImpact, steadyCo2 } from '@/lib/analysis.ts';
import { addDays, co2Band, dur, fmt, hm, ictDate, ictHour, ictMidnight, HOUR, MIN, shortDate, signed } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';
import { median } from '@/lib/stats.ts';
import { AchTracker, CalendarHeatmap, Co2ForecastChart, ComfortChart, EventLanes, OutdoorIndoor, RadialClock, ResponseScatter, SetpointChart, ShowerMini, VentGauge } from '../charts/room.tsx';
import { Sparkline } from '../charts/Sparkline.tsx';
import { DateNav } from '../DateNav.tsx';
import { Card, Legend, Loading, Placeholder, Segmented, StatusDot, TableView } from '../ui.tsx';

function LiveTiles() {
  const { now, reading, history } = useLive(6);
  const hourAgo = history.find((r) => r.ts >= now - HOUR);
  const tiles = [
    { key: 'temp', label: 'Temperature', unit: '°C', digits: 1, color: 'var(--temp)', get: (r: RoomReading) => r.tempC },
    { key: 'rh', label: 'Humidity', unit: '%', digits: 0, color: 'var(--rh)', get: (r: RoomReading) => r.rh },
    { key: 'co2', label: 'CO₂', unit: 'ppm', digits: 0, color: 'var(--text-2)', get: (r: RoomReading) => r.co2 },
    { key: 'dew', label: 'Dew point', unit: '°C', digits: 1, color: 'var(--dew)', get: (r: RoomReading) => dewPointC(r.tempC, r.rh) },
  ];
  const spark = useMemo(() => downsample(history, 5 * MIN, 'mean'), [history]);
  return (
    <section>
      <div className="row between" style={{ margin: '0 2px 8px' }}>
        <span className="small t2">
          Live · updated {reading ? hm(reading.ts) : '–'} · last 6 h
        </span>
        <span className="small muted">refreshes every 60 s</span>
      </div>
      <div className="tiles">
        {tiles.map((t) => {
          const v = reading ? t.get(reading) : NaN;
          const d = reading && hourAgo ? v - t.get(hourAgo) : NaN;
          const band = t.key === 'co2' && reading ? co2Band(reading.co2) : null;
          return (
            <div className="tile" key={t.key}>
              <div className="tile-label">{t.label}</div>
              <div className="tile-value">
                {fmt(v, t.digits)}
                <span className="tile-unit">{t.unit}</span>
              </div>
              <div className="tile-delta">
                {band ? (
                  <span className="status-pill">
                    <StatusDot status={band.key} /> {band.label} · {signed(d, 0)} /h
                  </span>
                ) : (
                  `${signed(d, t.digits)} vs 1 h ago`
                )}
              </div>
              <Sparkline values={spark.map((r) => ({ ts: r.ts, v: t.get(r) }))} color={t.color} format={(v, ts) => `${hm(ts)} · ${fmt(v, t.digits)}`} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

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
  const actualEnd = mode === 'check' ? view?.actual.at(-1) : undefined;
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
      className="span-2"
    >
      <div className="row between" style={{ marginBottom: 6 }}>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'tonight', label: 'Tonight' },
            { value: 'check', label: dataset && sel ? `Check ${shortDate(sel.night.date)}` : 'Check' },
          ]}
        />
        <Legend items={[{ label: 'Measured', color: 'var(--text-2)' }, { label: 'Forecast', color: 'var(--text-2)', shape: 'dash' }]} />
      </div>
      {view ? <Co2ForecastChart actual={view.actual} forecast={view.forecast} known={view.known} until={view.until} /> : <Placeholder height={200} />}
      <p className="card-note">
        {view?.basis === 'learned' && learned
          ? `Assumes two sleepers from ≈${hm(lightsOutTonight)} (usual lights-out) at the rate learned from recent nights (${fmt(learned.gen * 1000, 1)} mL/s CO₂, ${fmt(learned.ach, 2)} ACH). After 90 min of sleep it switches to tonight's own build-up.`
          : 'Build-up model fitted on the sleeping hours so far (120 m³, outdoor 425 ppm).'}{' '}
        Bands: &lt;800 · 800–1,000 · 1,000–1,500 · &gt;1,500.
      </p>
    </Card>
  );
}

export function RoomScreen() {
  const { status, dataset, progress, date, setDate } = useData();
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

  if (status !== 'ready' || !dataset || !sel || !derived) return <Loading text={progress || 'Loading…'} />;
  const n = sel.night;
  const verdict = derived.medCo2 > 1000 ? 'Ventilation recommended' : derived.medCo2 > 800 ? 'Borderline: try the door ajar' : 'No ventilation needed';
  const ervAch = Number.isFinite(derived.medAch) ? derived.medAch + 65 / 120 : NaN;
  const filterDays = filterDate ? Math.floor((Date.now() - Date.parse(`${filterDate}T00:00:00Z`)) / 86_400_000) : null;
  const rt7 = median(derived.runtime.slice(-7));

  return (
    <>
      <DateNav title="Room" />
      <div className="stack two">
        <div className="span-2">
          <LiveTiles />
        </div>
        <Co2ForecastCard />

        <Card title="Ventilation verdict" sub={verdict}>
          <VentGauge value={derived.medCo2} />
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Morning CO₂ (median)</dt>
            <dd>{fmt(derived.morningCo2)} ppm</dd>
            <dt>Fresh air now (median)</dt>
            <dd>{fmt(derived.medAch, 2)} ACH</dd>
            <dt>With a 65 m³/h ERV</dt>
            <dd>≈{fmt(Math.round(steadyCo2(ervAch) / 10) * 10)} ppm</dd>
          </dl>
          <p className="card-note">
            Rule: buy if the median nightly mean is above 1,000 ppm or mornings are regularly above 1,200. An ERV (not HRV) because Phuket air is a humidity load:
            ≈0.4–0.9 kW of extra cooling at 50–80 m³/h.
          </p>
        </Card>

        <Card title="Fresh-air tracker" sub="Air changes per hour from each morning's CO₂ decay">
          <AchTracker points={derived.ach} needed={ACH_FOR_1000} />
          <TableView columns={['Night', 'ACH', 'Door']} rows={derived.ach.filter((a) => a.ach !== null).slice(-30).reverse().map((a) => [shortDate(a.date), fmt(a.ach, 2), a.ajar ? 'ajar' : 'closed'])} />
        </Card>

        <Card title="Comfort" sub={`${shortDate(n.date)}: temp × humidity, one dot per 5 min`}>
          <ComfortChart points={comfort} />
          <p className="card-note">
            {fmt((sel.room.minutesRhInBand / Math.max(1, (n.wake - n.lightsOut) / MIN)) * 100)}% of the night inside 45–55 % RH. Drifting up and left = &quot;cold and clammy&quot;: try DRY
            mode before bed.
          </p>
        </Card>

        <Card title="24-hour rhythm" sub="When the room breathes: last 14 nights">
          <RadialClock nights={dataset.nights.slice(-14)} />
        </Card>

        <Card title="Nights over 1,000 ppm" sub="Minutes per night">
          <CalendarHeatmap cells={derived.co2Cells} color="var(--seq-2)" max={300} unit="min" onPick={setDate} selected={date} />
        </Card>
        <Card title="Nights off the temperature curve" sub="Minutes more than 0.75 °C from target">
          <CalendarHeatmap cells={derived.tempCells} color="var(--seq)" max={180} unit="min" onPick={setDate} selected={date} />
        </Card>

        <Card title="Setpoint vs actual" sub={`${n.ac.length} IR commands · ${n.ac.filter((c) => c.landed === false).length} flagged as missed`} className="span-2">
          <SetpointChart night={n} curve={DEFAULT_CURVE} />
          <TableView
            columns={['Time', 'Command', 'Landed', 'Reason']}
            rows={n.ac.map((c) => [hm(c.ts), c.state.power ? `${c.state.mode} ${c.state.setpointC}° ${c.state.fan}` : 'OFF', c.landed === false ? 'missed?' : c.landed ? 'yes' : '–', c.reason])}
          />
        </Card>

        <Card title="Events" sub={detail ? `${detail.events.length} detected from CO₂ and RH` : 'Detecting…'} className="span-2">
          {detail ? (
            <EventLanes
              from={n.room[0]?.ts ?? n.lightsOut}
              to={n.room.at(-1)?.ts ?? n.wake}
              lanes={[
                { label: 'Detected', items: detail.events },
                ...(n.truth ? [{ label: 'Simulator truth', items: n.truth.events }] : []),
              ]}
            />
          ) : (
            <Placeholder height={180} />
          )}
        </Card>

        <Card title="Shower impact" sub={
            shower
              ? `${hm(shower.imp.start)} · ${shower.suspect ? 'detected during pre-cool (may be the AC)' : shower.detected ? 'detected' : 'from sim truth (not detected)'}`
              : 'No shower this night'
          }>
          {shower ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 8 }}>
                <div>
                  <div className="small t2">Humidity</div>
                  <ShowerMini series={shower.rh} start={shower.imp.start} end={shower.imp.end} metric="rh" />
                </div>
                <div>
                  <div className="small t2">Temperature</div>
                  <ShowerMini series={shower.temp} start={shower.imp.start} end={shower.imp.end} metric="temp" />
                </div>
              </div>
              <dl className="kv" style={{ marginTop: 8 }}>
                <dt>RH before → peak</dt>
                <dd>
                  {fmt(shower.imp.rhBefore)} → {fmt(shower.imp.rhPeak)} %
                </dd>
                {shower.imp.tempPeak > shower.imp.tempBefore + 0.1 ? (
                  <>
                    <dt>Temp before → peak</dt>
                    <dd>
                      {fmt(shower.imp.tempBefore, 1)} → {fmt(shower.imp.tempPeak, 1)} °C
                    </dd>
                  </>
                ) : (
                  <>
                    <dt>Temp before → after</dt>
                    <dd>
                      {fmt(shower.imp.tempBefore, 1)} → {fmt(shower.imp.tempAfter, 1)} °C <span className="muted">(aircon cooling)</span>
                    </dd>
                  </>
                )}
                <dt>Back to normal RH</dt>
                <dd>{shower.imp.recoverMin !== null ? dur(shower.imp.recoverMin) : 'not within window'}</dd>
                <dt>Extra aircon time</dt>
                <dd>≈{dur(shower.imp.extraCoolMin)}</dd>
              </dl>
            </>
          ) : (
            <Placeholder height={120} text="Pick a night with a shower (calendar above)." />
          )}
        </Card>

        <Card title="Outdoor vs bedroom" sub={`${shortDate(n.date)} · simulated Phuket weather (Open-Meteo later)`}>
          <OutdoorIndoor night={n} />
        </Card>

        <Card title="Room response" sub="Minutes to cool 1 °C after the pre-cool command">
          <ResponseScatter points={derived.response} />
          <p className="card-note">Median {fmt(median(derived.response.map((r) => r.minutes)))} min. This is the learned model the controller uses to start pre-cooling early enough.</p>
        </Card>

        <Card title="Aircon duty & filter">
          <div className="tiles" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
            <div className="tile" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="tile-label">Runtime, this night</div>
              <div className="tile-value">{dur(derived.runtime[sel.index] ?? NaN)}</div>
              <div className="tile-delta">7-night median {dur(rt7)}</div>
            </div>
            <div className="tile" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="tile-label">Filter clock</div>
              <div className="tile-value">
                {filterDays === null ? '–' : filterDays}
                <span className="tile-unit">days</span>
              </div>
              <div className="tile-delta">{filterDays === null ? 'not logged yet' : filterDays > 30 ? 'clean it soon' : 'since last clean'}</div>
            </div>
          </div>
          <div className="row between" style={{ marginTop: 10 }}>
            <span className="small muted">Runtime from IR commands (open loop, estimate).</span>
            <button className="btn" type="button" onClick={() => setFilterDate(ictDate(Date.now()))}>
              Cleaned today
            </button>
          </div>
        </Card>
      </div>
    </>
  );
}
