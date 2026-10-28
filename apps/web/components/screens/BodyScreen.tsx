'use client';
import { useMemo, useState } from 'react';
import { personColor, useData, useNightDetail, useSelectedNight } from '@/lib/data/context.tsx';
import { hrSleepWake } from '@/lib/analysis.ts';
import { dur, fmt, hm, MIN } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';
import { mean, sd } from '@/lib/stats.ts';
import { HrCurve, HrvNight, Ridgeline, SleepWakeCompare, Spo2Strip, TempDeviation, TrendBand } from '../charts/body.tsx';
import { STAGE_LABEL, STAGE_ORDER, stageColor } from '../charts/NightStrip.tsx';
import { DateNav } from '../DateNav.tsx';
import { Card, Legend, Loading, Placeholder, Segmented } from '../ui.tsx';

type Range = '7' | '30' | '90';

export function BodyScreen() {
  const { status, dataset, progress, date, setDate } = useData();
  const sel = useSelectedNight();
  const { detail } = useNightDetail(date);
  const [who, setWho] = usePref<string>('bodyPerson', 'a');
  const [range, setRange] = useState<Range>('30');

  const personId = dataset?.people.some((p) => p.id === who) ? who : (dataset?.people[0]?.id ?? 'a');
  const series = dataset?.person[personId] ?? [];

  const baseline = useMemo(() => {
    if (!sel) return null;
    const past = series.slice(Math.max(0, sel.index - 30), sel.index).filter((m): m is NonNullable<typeof m> => m !== null);
    const rm = past.map((m) => m.rmssdMean);
    return { nadir: mean(past.map((m) => m.hrNadir)), rmssd: { mean: mean(rm), lo: mean(rm) - sd(rm), hi: mean(rm) + sd(rm) }, n: past.length };
  }, [series, sel]);

  const ours = useMemo(() => {
    const pn = sel?.night.people.find((p) => p.personId === personId);
    if (!pn) return null;
    const est = hrSleepWake(pn.hr.filter((h) => h.ts >= pn.sleep.start && h.ts <= pn.sleep.end));
    let agree = 0;
    let n = 0;
    for (let t = pn.sleep.start; t < pn.sleep.end; t += MIN) {
      const g = pn.sleep.stages.find((s) => t >= s.start && t < s.end);
      const o = est.find((s) => t >= s.start && t < s.end);
      if (!g || !o) continue;
      n++;
      if ((g.stage === 'awake') === o.awake) agree++;
    }
    return { est, agreement: n ? agree / n : NaN };
  }, [sel, personId]);

  if (status !== 'ready' || !dataset || !sel || !baseline) return <Loading text={progress || 'Loading…'} />;
  const person = dataset.people.find((p) => p.id === personId)!;
  const color = personColor(dataset.people, personId);
  const pn = sel.night.people.find((p) => p.personId === personId);
  const m = detail?.people.find((p) => p.personId === personId) ?? sel.person[personId] ?? null;
  const n = Number(range);
  const trendRows = dataset.nights.slice(-n).map((night, i) => {
    const idx = dataset.nights.length - n + i;
    return { night, m: series[idx] ?? null, room: dataset.room[idx]! };
  });
  const rows = (f: (x: NonNullable<(typeof series)[number]>) => number | undefined) => dataset.nights.map((night, i) => ({ date: night.date, v: series[i] ? (f(series[i]!) ?? NaN) : NaN }));

  return (
    <>
      <DateNav title="Body" />
      <div className="row between" style={{ marginBottom: 12 }}>
        <Segmented value={personId} onChange={setWho} options={dataset.people.map((p) => ({ value: p.id, label: p.name }))} label="Person" />
        <span className="small muted">Fitbit Air · Google Health (simulated)</span>
      </div>
      {!pn || !m ? (
        <Card title={`No data for ${person.name} this night`}>
          <p className="small muted">Pick another night.</p>
        </Card>
      ) : (
        <div className="stack two">
          <Card title="Last night" sub={`${hm(pn.sleep.start)} → ${hm(pn.sleep.end)}`} className="span-2">
            <div className="tiles">
              <div className="tile" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
                <div className="tile-label">Asleep</div>
                <div className="tile-value">{dur(m.totalSleepMin)}</div>
                <div className="tile-delta">eff. {fmt(m.efficiencyPct)}% · latency {fmt(m.latencyMin)}m</div>
              </div>
              <div className="tile" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
                <div className="tile-label">HR nadir</div>
                <div className="tile-value">
                  {fmt(m.hrNadir)}
                  <span className="tile-unit">bpm</span>
                </div>
                <div className="tile-delta">at +{dur(m.hrNadirAtMin)} · base {fmt(baseline.nadir)}</div>
              </div>
              <div className="tile" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
                <div className="tile-label">HRV (RMSSD)</div>
                <div className="tile-value">
                  {fmt(m.rmssdMean)}
                  <span className="tile-unit">ms</span>
                </div>
                <div className="tile-delta">base {fmt(baseline.rmssd.mean)} ms</div>
              </div>
              <div className="tile" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
                <div className="tile-label">Recovery</div>
                <div className="tile-value">{detail ? fmt(m.recoveryScore) : '…'}</div>
                <div className="tile-delta">breathing {fmt(m.respRate ?? NaN, 1)}/min</div>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <svg width="100%" height={14} viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden>
                {(() => {
                  const tot = m.deepMin + m.remMin + m.lightMin + m.awakeMin;
                  let x = 0;
                  return STAGE_ORDER.map((s) => {
                    const v = s === 'deep' ? m.deepMin : s === 'rem' ? m.remMin : s === 'light' ? m.lightMin : m.awakeMin;
                    const wpx = (v / Math.max(1, tot)) * 100;
                    const r = <rect key={s} x={x} y={0} width={Math.max(0, wpx - 0.6)} height={14} fill={stageColor(s)} rx={1} />;
                    x += wpx;
                    return r;
                  });
                })()}
              </svg>
              <Legend
                items={STAGE_ORDER.map((s) => ({
                  label: `${STAGE_LABEL[s]} ${dur(s === 'deep' ? m.deepMin : s === 'rem' ? m.remMin : s === 'light' ? m.lightMin : m.awakeMin)}`,
                  color: stageColor(s),
                  shape: 'rect' as const,
                }))}
              />
            </div>
          </Card>

          <Card title="Sleeping heart rate" sub={m.hrNadirAtMin > 300 ? 'Late nadir: often a late meal, alcohol or a warm room' : 'Nadir in the first half: a well-recovered pattern'}>
            <HrCurve hr={pn.hr} start={pn.sleep.start} end={pn.sleep.end} nadir={m.hrNadir} nadirAt={pn.sleep.start + m.hrNadirAtMin * MIN} baseline={baseline.nadir} color={color} />
          </Card>

          <Card title="Last 14 nights" sub="HR curves from sleep start; dot = nadir. Tap to open a night">
            <Ridgeline nights={dataset.nights.slice(Math.max(0, sel.index - 13), sel.index + 1)} personId={personId} color={color} selected={sel.night.date} onPick={setDate} />
          </Card>

          <Card title="HRV through the night" sub={`Mean ${fmt(m.rmssdMean)} ms vs ${baseline.n}-night baseline ${fmt(baseline.rmssd.mean)} ms`}>
            <HrvNight hrv={pn.hrv} start={pn.sleep.start} end={pn.sleep.end} band={baseline.rmssd} color={color} />
          </Card>

          <Card title="Blood oxygen" sub={`${fmt(m.spo2Mean, 1)} % mean · ${fmt(m.spo2DipsPerHour, 1)} dips/hour (ODI-style)`}>
            <Spo2Strip spo2={pn.spo2} start={pn.sleep.start} end={pn.sleep.end} color={color} />
            <p className="card-note">Not a medical test. Above ~5 dips/hour on many nights is worth mentioning to a doctor.</p>
          </Card>

          <Card title="Our sleep/wake vs Google's" sub={ours ? `${fmt(ours.agreement * 100)}% of minutes agree on awake vs asleep` : ''}>
            {ours ? <SleepWakeCompare stages={pn.sleep.stages} ours={ours.est} start={pn.sleep.start} end={pn.sleep.end} /> : <Placeholder height={70} />}
            <p className="card-note">A simple heart-rate rule we control. When agreement suddenly shifts across many nights, Google has likely changed its algorithm.</p>
          </Card>

          <Card
            title="Recovery trends"
            sub="Grey band = previous 30 nights ±1 SD"
            meta={<Segmented value={range} onChange={setRange} options={[{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }]} label="Range" />}
            className="span-2"
          >
            <div className="stack two" style={{ gap: 10 }}>
              <TrendBand show={n} label="HR nadir" unit="bpm" color={color} rows={rows((x) => x.hrNadir)} />
              <TrendBand show={n} label="HRV (RMSSD)" unit="ms" color={color} rows={rows((x) => x.rmssdMean)} />
              <TrendBand show={n} label="Deep sleep" unit="min" color={color} rows={rows((x) => x.deepMin)} />
              <TrendBand show={n} label="Breathing rate" unit="/min" digits={1} color={color} rows={rows((x) => x.respRate)} />
              <TrendBand show={n} label="Resting HR" unit="bpm" color={color} rows={rows((x) => x.restingHr)} />
              <TrendBand show={n} label="Steps (day before)" unit="" color={color} rows={rows((x) => x.steps)} />
            </div>
            <p className="card-note">Breathing rate is a whole-night average; per-stage rates arrive once the respiratory-rate parser lands.</p>
          </Card>

          <Card title="Skin temperature vs room" sub="Is a warm night showing up in the body?" className="span-2">
            <TempDeviation rows={trendRows.map((r) => ({ date: r.night.date, dev: r.m?.tempDeviationC ?? null, room: r.room.tempMean }))} />
          </Card>
        </div>
      )}
    </>
  );
}
