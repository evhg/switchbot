'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DEFAULT_CURVE, SLEEP_AIR_WEIGHTS, SLEEP_SCORE_WEIGHTS, type ScoreDriver } from '@sleep-lab/core';
import { personColor, personName, useData, useNightDetail, useSelectedNight, withNames } from '@/lib/data/context.tsx';
import { usePlannedCurve } from '@/lib/curve-store.ts';
import { co2Band, dayLabel, fmt, hm } from '@/lib/format.ts';
import { useTheme } from '@/lib/theme.tsx';
import { EVENT_LABEL, EventGlyph, NightStrip, STAGE_LABEL, STAGE_ORDER, stageColor } from '../charts/NightStrip.tsx';
import { PlanChart } from '../charts/PlanChart.tsx';
import { ScoreRing } from '../charts/ScoreRing.tsx';
import { Waterfall } from '../charts/Waterfall.tsx';
import { DateNav } from '../DateNav.tsx';
import { Card, Legend, Loading, Placeholder, StatusDot } from '../ui.tsx';
import { VitalsSection } from '../Vitals.tsx';

type Focus = 'room' | string;

function SubScores({ items }: { items: { label: string; value: number; weight: number; note?: string }[] }) {
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
      {items.map((it) => (
        <div key={it.label} style={{ display: 'grid', gridTemplateColumns: '108px minmax(0,1fr) 34px', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
          <span className="t2">
            {it.label} <span className="muted">×{it.weight}</span>
          </span>
          <svg height={8} width="100%" aria-hidden preserveAspectRatio="none" viewBox="0 0 100 8">
            <rect x={0} y={0} width={100} height={8} rx={4} fill="var(--ring-track)" />
            <rect x={0} y={0} width={Math.max(2, Math.min(100, it.value))} height={8} rx={4} fill="var(--accent)" />
          </svg>
          <b className="num" style={{ textAlign: 'right' }}>{fmt(it.value)}</b>
        </div>
      ))}
    </div>
  );
}

export function TodayScreen() {
  const { status, dataset, progress, date, setDate } = useData();
  const sel = useSelectedNight();
  const { detail } = useNightDetail(date);
  const [plan] = usePlannedCurve();
  const [focus, setFocus] = useState<Focus | null>(null);
  const { resolved: resolvedTheme } = useTheme();

  const isPerson = (label: string) => dataset?.people.some((p) => label.startsWith(`${p.id}:`)) ?? false;
  const drivers = useMemo(() => {
    const d = detail?.report.drivers ?? [];
    return { room: d.filter((x) => !isPerson(x.label)), body: d.filter((x) => isPerson(x.label)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, dataset]);

  if (status !== 'ready' || !dataset || !sel) return <Loading text={progress || 'Loading…'} />;
  const { night, room } = sel;
  const people = dataset.people.filter((p) => night.people.some((x) => x.personId === p.id));
  const personM = (id: string) => detail?.people.find((p) => p.personId === id) ?? sel.person[id] ?? null;
  const band = co2Band(room.co2Mean);
  const focusPerson = focus && focus !== 'room' ? focus : null;
  const roomDrivers: ScoreDriver[] = drivers.room;
  // Night.wake is the scheduled wake (alarm, drives the AC); a partner may sleep on past it.
  const lastUp = Math.max(night.wake, ...night.people.map((p) => p.sleep.end));

  return (
    <>
      <DateNav />
      <div className="stack two">
        <Card title="Scores" sub="Tap a ring to see what drove it" className="span-2">
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${1 + people.length}, minmax(0,1fr))`, gap: 6, alignItems: 'start' }}>
            <div style={{ textAlign: 'center' }}>
              <ScoreRing value={room.sleepAirScore} color="var(--temp)" label="Sleep Air" size={92} selected={focus ? focus === 'room' : undefined} onClick={() => setFocus(focus === 'room' ? null : 'room')} />
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>Sleep Air</div>
              <div className="small muted">room</div>
            </div>
            {people.map((p) => {
              const m = personM(p.id);
              const color = personColor(dataset.people, p.id);
              return (
                <div key={p.id} style={{ textAlign: 'center' }}>
                  <ScoreRing
                    value={m?.sleepScore ?? NaN}
                    inner={detail ? (m?.recoveryScore ?? NaN) : undefined}
                    color={color}
                    label={`${p.name} sleep`}
                    size={92}
                    centerSub={detail && m ? `rec ${fmt(m.recoveryScore)}` : undefined}
                    selected={focus ? focus === p.id : undefined}
                    onClick={() => setFocus(focus === p.id ? null : p.id)}
                  />
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{p.name}</div>
                  <div className="small muted">sleep · recovery</div>
                </div>
              );
            })}
          </div>
          {focus === 'room' && detail && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <SubScores
                items={[
                  { label: 'CO₂', value: detail.roomParts.co2 * 100, weight: SLEEP_AIR_WEIGHTS.co2 },
                  { label: 'On curve', value: detail.roomParts.temp * 100, weight: SLEEP_AIR_WEIGHTS.temp },
                  { label: 'Humidity', value: detail.roomParts.rh * 100, weight: SLEEP_AIR_WEIGHTS.rh },
                  { label: 'Stability', value: detail.roomParts.stability * 100, weight: SLEEP_AIR_WEIGHTS.stability },
                ]}
              />
            </div>
          )}
          {focusPerson && detail?.personParts[focusPerson] && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <SubScores
                items={[
                  { label: 'Duration', value: detail.personParts[focusPerson].sleep.duration * 100, weight: SLEEP_SCORE_WEIGHTS.duration },
                  { label: 'Efficiency', value: detail.personParts[focusPerson].sleep.efficiency * 100, weight: SLEEP_SCORE_WEIGHTS.efficiency },
                  { label: 'Deep + REM', value: detail.personParts[focusPerson].sleep.restorative * 100, weight: SLEEP_SCORE_WEIGHTS.restorative },
                  { label: 'Awakenings', value: detail.personParts[focusPerson].sleep.awakenings * 100, weight: SLEEP_SCORE_WEIGHTS.awakenings },
                ]}
              />
              <p className="card-note">
                Recovery compares HRV, HR nadir and breathing rate with {personName(dataset, focusPerson)}&apos;s last{' '}
                {detail.personParts[focusPerson].recovery.baselineNights} nights.
              </p>
            </div>
          )}
          <div className="tiles" style={{ marginTop: 12 }}>
            {/* Per-person sleep lives in Vitals below; these two tiles are the room. */}
            <div className="tile" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="tile-label">CO₂ mean</div>
              <div className="tile-value">
                {fmt(room.co2Mean)}
                <span className="tile-unit">ppm</span>
              </div>
              <div className="status-pill">
                <StatusDot status={band.key} /> {band.label} · peak {fmt(room.co2Max)}
              </div>
            </div>
            <div className="tile" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="tile-label">First 4 h</div>
              <div className="tile-value">
                {fmt(room.tempEarlyMean, 1)}
                <span className="tile-unit">°C</span>
              </div>
              <div className="tile-delta">RH {fmt(room.rhMean)}% · {room.acCommands} AC cmds</div>
            </div>
          </div>
        </Card>

        <VitalsSection dataset={dataset} index={sel.index} />

        <Card title="Insight" sub={detail ? withNames(detail.report.headline, dataset) : 'Reading the night…'} className="span-2">
          {detail ? (
            <ul className="list" style={{ fontSize: 13.5 }}>
              {detail.report.insights.map((s, i) => (
                <li key={i}>
                  <span style={{ color: 'var(--muted)' }}>•</span>
                  <span style={{ flex: 1 }}>{withNames(s, dataset)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Placeholder height={80} />
          )}
          <div className="row between" style={{ marginTop: 6 }}>
            <span className="small muted">Rule-based report · Claude summary arrives with the nightly job</span>
            <a href="#strip" className="small">Why →</a>
          </div>
        </Card>

        <Card id="strip" title="Night strip" sub={`Lights out ${hm(night.lightsOut)} · alarm ${hm(night.wake)}${lastUp > night.wake + 5 * 60_000 ? ` · last up ${hm(lastUp)}` : ''}`} className="span-2">
          <Legend
            items={[
              ...STAGE_ORDER.map((s) => ({ label: STAGE_LABEL[s], color: stageColor(s), shape: 'rect' as const })),
              { label: 'Room °C', color: 'var(--temp)' },
              { label: 'Target', color: 'var(--text-2)', shape: 'dash' as const },
              { label: 'RH', color: 'var(--rh)' },
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
            {resolvedTheme === 'night'
              ? 'CO₂ bands, darkest to brightest: <800 · 800–1,000 · 1,000–1,500 · >1,500 ppm.'
              : 'CO₂ bands: green <800 · amber 800–1,000 · orange 1,000–1,500 · red >1,500 ppm.'}
          </p>
        </Card>

        <Card title="What drove Sleep Air" sub="Points vs a typical night (70)">
          {detail ? <Waterfall drivers={roomDrivers} total={room.sleepAirScore} totalLabel="Sleep Air" /> : <Placeholder height={200} />}
        </Card>

        <Card title="Body drivers" sub="Recovery inputs vs each person's 30-night baseline">
          {detail ? (
            drivers.body.length ? (
              <Waterfall
                drivers={drivers.body.map((d) => ({ ...d, label: withNames(d.label, dataset) }))}
                total={Math.round(detail.people.reduce((a, p) => a + p.recoveryScore, 0) / Math.max(1, detail.people.length))}
                totalLabel="Mean recovery"
              />
            ) : (
              <p className="small muted">Needs 7+ nights of history.</p>
            )
          ) : (
            <Placeholder height={200} />
          )}
        </Card>

        <Card
          title="Tonight's plan"
          sub={`${plan.name} vs ${dayLabel(night.date)}`}
          meta={<Link href="/settings#curve">Edit curve</Link>}
          className="span-2"
        >
          <PlanChart plan={plan} last={night} />
          <p className="card-note">
            Deep window {fmt(plan.phases.find((p) => p.name === 'deep')?.targetC ?? NaN, 1)} °C from +{plan.phases.find((p) => p.name === 'deep')?.startMin} min. The
            controller rounds to whole degrees and applies a learned bias for the ducted unit&apos;s return-air sensor.
          </p>
        </Card>
      </div>
      {dataset.nights.length > 1 && night.date !== dataset.nights.at(-1)!.date && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button className="btn ghost small" type="button" onClick={() => setDate(dataset.nights.at(-1)!.date)}>
            Jump to latest night
          </button>
        </div>
      )}
    </>
  );
}
