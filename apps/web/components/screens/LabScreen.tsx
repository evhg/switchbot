'use client';
import { useMemo, useState } from 'react';
import type { PersonNightMetrics, RoomNightMetrics, TagKey } from '@sleep-lab/core';
import { personColor, personName, useData, useNightDetail, useSelectedNight } from '@/lib/data/context.tsx';
import { synchrony } from '@/lib/analysis.ts';
import { usePlannedCurve } from '@/lib/curve-store.ts';
import { fmt, hm, shortDate } from '@/lib/format.ts';
import { finite, linearFit, loess, mean, meanCI, pearson, range, sd, welch } from '@/lib/stats.ts';
import { CompromiseAxis, CorrMatrix, IntervalPlot, MirroredHypnogram, TrendScatter, type IntervalRow } from '../charts/lab.tsx';
import { DateNav } from '../DateNav.tsx';
import { Card, Loading, Segmented } from '../ui.tsx';

type RoomKey = 'earlyTemp' | 'co2Mean' | 'rhMean' | 'ach';
type OutKey = 'deepMin' | 'remMin' | 'hrNadir' | 'rmssdMean' | 'sleepScore' | 'efficiencyPct';

const ROOM: Record<RoomKey, { label: string; unit: string; digits: number; get: (r: RoomNightMetrics) => number }> = {
  earlyTemp: { label: 'Early-night temp', unit: '°C', digits: 1, get: (r) => r.tempEarlyMean },
  co2Mean: { label: 'Mean CO₂', unit: 'ppm', digits: 0, get: (r) => r.co2Mean },
  rhMean: { label: 'Mean RH', unit: '%', digits: 0, get: (r) => r.rhMean },
  ach: { label: 'Morning ACH', unit: '/h', digits: 2, get: (r) => r.achMorning ?? NaN },
};
const OUT: Record<OutKey, { label: string; unit: string; digits: number; get: (m: PersonNightMetrics) => number }> = {
  deepMin: { label: 'Deep sleep', unit: 'min', digits: 0, get: (m) => m.deepMin },
  remMin: { label: 'REM sleep', unit: 'min', digits: 0, get: (m) => m.remMin },
  hrNadir: { label: 'HR nadir', unit: 'bpm', digits: 0, get: (m) => m.hrNadir },
  rmssdMean: { label: 'HRV', unit: 'ms', digits: 0, get: (m) => m.rmssdMean },
  sleepScore: { label: 'Sleep score', unit: '', digits: 0, get: (m) => m.sleepScore },
  efficiencyPct: { label: 'Efficiency', unit: '%', digits: 0, get: (m) => m.efficiencyPct },
};
const TAGS: { key: TagKey; label: string }[] = [
  { key: 'door_ajar', label: 'Door ajar' },
  { key: 'alcohol', label: 'Alcohol' },
  { key: 'late_meal', label: 'Late meal' },
  { key: 'late_exercise', label: 'Late exercise' },
  { key: 'late_caffeine', label: 'Caffeine after 14:00' },
  { key: 'heavy_duvet', label: 'Heavy duvet' },
];
const NEEDED_PER_ARM = 35;

const opts = <K extends string>(rec: Record<K, { label: string }>) => (Object.keys(rec) as K[]).map((k) => ({ value: k, label: rec[k].label }));

export function LabScreen() {
  const { status, dataset, progress, date } = useData();
  const sel = useSelectedNight();
  const { detail } = useNightDetail(date);
  const [plan] = usePlannedCurve();
  const [xKey, setX] = useState<RoomKey>('earlyTemp');
  const [yKey, setY] = useState<OutKey>('deepMin');
  const [lag, setLag] = useState<'same' | 'next'>('same');
  const [bucketMetric, setBucketMetric] = useState<OutKey>('rmssdMean');
  const [expMetric, setExpMetric] = useState<OutKey>('deepMin');

  // Person-night rows; sick/travel nights are excluded from every analysis.
  const rows = useMemo(() => {
    if (!dataset) return [];
    return dataset.people.flatMap((p) =>
      dataset.nights.flatMap((n, i) => {
        const m = dataset.person[p.id]?.[i];
        if (!m || n.tags.includes('sick') || n.tags.includes('travel')) return [];
        const next = dataset.person[p.id]?.[i + 1] ?? null;
        return [{ personId: p.id, date: n.date, tags: n.tags, room: dataset.room[i]!, m, next }];
      }),
    );
  }, [dataset]);

  const scatter = useMemo(() => {
    if (!dataset) return null;
    const series = dataset.people.map((p) => ({
      name: p.name,
      color: personColor(dataset.people, p.id),
      points: rows
        .filter((r) => r.personId === p.id)
        .map((r) => {
          const m = lag === 'same' ? r.m : r.next;
          return { x: ROOM[xKey].get(r.room), y: m ? OUT[yKey].get(m) : NaN, date: r.date };
        })
        .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y)),
    }));
    const xs = series.flatMap((s) => s.points.map((p) => p.x));
    const ys = series.flatMap((s) => s.points.map((p) => p.y));
    const grid = range(Math.min(...xs), Math.max(...xs), 30);
    const fit = linearFit(xs, ys);
    return { series, trend: loess(xs, ys, grid, 0.7), r: pearson(xs, ys), slope: fit.slope, n: xs.length };
  }, [dataset, rows, xKey, yKey, lag]);

  const buckets = useMemo<IntervalRow[]>(() => {
    if (!dataset) return [];
    const defs = [
      { label: '< 800 ppm', test: (c: number) => c < 800 },
      { label: '800–1,200', test: (c: number) => c >= 800 && c <= 1200 },
      { label: '> 1,200 ppm', test: (c: number) => c > 1200 },
    ];
    return defs.flatMap((d) =>
      dataset.people.map((p) => {
        const v = rows.filter((r) => r.personId === p.id && d.test(r.room.co2Mean)).map((r) => OUT[bucketMetric].get(r.m));
        const ci = meanCI(v);
        return { group: d.label, label: p.name, sub: `${ci.n} nights`, est: ci.mean, lo: ci.lo, hi: ci.hi, color: personColor(dataset.people, p.id) };
      }),
    );
  }, [dataset, rows, bucketMetric]);

  const forest = useMemo<IntervalRow[]>(() => {
    if (!dataset) return [];
    return TAGS.flatMap((t) =>
      dataset.people.map((p) => {
        const mine = rows.filter((r) => r.personId === p.id);
        const w = welch(
          mine.filter((r) => !r.tags.includes(t.key)).map((r) => OUT[expMetric].get(r.m)),
          mine.filter((r) => r.tags.includes(t.key)).map((r) => OUT[expMetric].get(r.m)),
        );
        return { group: t.label, label: p.name, sub: `${w.nB} vs ${w.nA} nights`, est: w.diff, lo: w.lo, hi: w.hi, color: personColor(dataset.people, p.id), progress: w.nB / NEEDED_PER_ARM };
      }),
    );
  }, [dataset, rows, expMetric]);

  const corr = useMemo(() => {
    if (!dataset) return null;
    // Body outcomes are z-scored within person so the two baselines don't create fake correlations.
    const z = (key: OutKey) => {
      const out = new Map<string, { mu: number; s: number }>();
      for (const p of dataset.people) {
        const v = rows.filter((r) => r.personId === p.id).map((r) => OUT[key].get(r.m));
        out.set(p.id, { mu: mean(v), s: sd(v) || 1 });
      }
      return (r: (typeof rows)[number]) => (OUT[key].get(r.m) - out.get(r.personId)!.mu) / out.get(r.personId)!.s;
    };
    const feats: { label: string; get: (r: (typeof rows)[number]) => number }[] = [
      { label: 'Early temp', get: (r) => r.room.tempEarlyMean },
      { label: 'Mean CO₂', get: (r) => r.room.co2Mean },
      { label: 'Mean RH', get: (r) => r.room.rhMean },
      { label: 'Morning ACH', get: (r) => r.room.achMorning ?? NaN },
      { label: 'AC commands', get: (r) => r.room.acCommands },
      { label: 'Door ajar', get: (r) => (r.tags.includes('door_ajar') ? 1 : 0) },
      { label: 'Alcohol', get: (r) => (r.tags.includes('alcohol') ? 1 : 0) },
      { label: 'Late meal', get: (r) => (r.tags.includes('late_meal') ? 1 : 0) },
      { label: 'Deep', get: z('deepMin') },
      { label: 'REM', get: z('remMin') },
      { label: 'HR nadir', get: z('hrNadir') },
      { label: 'HRV', get: z('rmssdMean') },
      { label: 'Sleep score', get: z('sleepScore') },
      { label: 'Efficiency', get: z('efficiencyPct') },
    ];
    const cols = feats.map((f) => rows.map(f.get));
    return { labels: feats.map((f) => f.label), matrix: cols.map((a) => cols.map((b) => pearson(a, b))) };
  }, [dataset, rows]);

  const couple = useMemo(() => {
    if (!dataset || !sel || dataset.people.length < 2) return null;
    const [pa, pb] = dataset.people;
    const sync = synchrony(sel.night, pa!.id, pb!.id, detail?.events ?? sel.night.truth?.events ?? []);
    const best = dataset.people.map((p) => {
      const mine = rows.filter((r) => r.personId === p.id);
      const bins = new Map<number, number[]>();
      for (const r of mine) {
        const b = Math.round(r.room.tempEarlyMean * 2) / 2;
        bins.set(b, [...(bins.get(b) ?? []), r.m.sleepScore]);
      }
      const ok = [...bins.entries()].filter(([, v]) => v.length >= 3).map(([t, v]) => ({ t, s: mean(v), n: v.length }));
      return { id: p.id, best: ok.reduce<{ t: number; s: number; n: number } | null>((a, b) => (!a || b.s > a.s ? b : a), null) };
    });
    return { sync, best };
  }, [dataset, sel, rows, detail]);

  if (status !== 'ready' || !dataset || !sel || !scatter || !corr) return <Loading text={progress || 'Loading…'} />;
  const deepTarget = plan.phases.find((p) => p.name === 'deep')?.targetC ?? NaN;
  const nights = finite(rows.map((r) => r.room.co2Mean)).length / Math.max(1, dataset.people.length);

  return (
    <>
      <DateNav title="Lab" />
      <p className="small t2" style={{ margin: '-6px 2px 12px' }}>
        What actually helps: {Math.round(nights)} nights × {dataset.people.length} people. Simulated effects are deliberately weak, as real ones will be.
      </p>
      <div className="stack two">
        <Card title="Room vs body" sub={`r = ${fmt(scatter.r, 2)} · slope ${fmt(scatter.slope, 2)} ${OUT[yKey].unit}/${ROOM[xKey].unit} · ${scatter.n} person-nights`} className="span-2">
          <div className="row" style={{ marginBottom: 6 }}>
            <select className="select" value={xKey} onChange={(e) => setX(e.target.value as RoomKey)} aria-label="Room factor">
              {opts(ROOM).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="muted small">vs</span>
            <select className="select" value={yKey} onChange={(e) => setY(e.target.value as OutKey)} aria-label="Body outcome">
              {opts(OUT).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <Segmented value={lag} onChange={setLag} options={[{ value: 'same', label: 'Same night' }, { value: 'next', label: 'Next night' }]} label="Lag" />
          </div>
          <TrendScatter series={scatter.series} trend={scatter.trend} xLabel={`${ROOM[xKey].label} (${ROOM[xKey].unit})`} yLabel={OUT[yKey].label} xDigits={ROOM[xKey].digits} yDigits={OUT[yKey].digits} />
          <p className="card-note">Correlation, not causation: run an A/B experiment below before changing the curve.</p>
        </Card>

        <Card title="CO₂ buckets" sub="Mean with 95 % interval, by nightly mean CO₂" meta={<Segmented value={bucketMetric} onChange={setBucketMetric} options={[{ value: 'rmssdMean', label: 'HRV' }, { value: 'deepMin', label: 'Deep' }]} />}>
          <IntervalPlot rows={buckets} unit={OUT[bucketMetric].unit} />
        </Card>

        <Card title="Experiment board" sub={`Effect on ${OUT[expMetric].label.toLowerCase()} (tag minus no tag) with 95 % interval`}>
          <select className="select" value={expMetric} onChange={(e) => setExpMetric(e.target.value as OutKey)} aria-label="Outcome" style={{ marginBottom: 6 }}>
            {opts(OUT).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <IntervalPlot rows={forest} zero={0} unit={OUT[expMetric].unit} labelW={92} />
          <p className="card-note">
            Bar beside each name: nights with the tag towards the ~{NEEDED_PER_ARM} per arm needed to detect a 10-minute change. These are observational splits; true A/B
            tests alternate nights at random.
          </p>
        </Card>

        <Card title="Correlation matrix" sub="Exploratory. With 14 features, ~5 of 91 pairs will look 'significant' by chance" className="span-2">
          <div className="scroll-x">
            <CorrMatrix labels={corr.labels} matrix={corr.matrix} />
          </div>
        </Card>

        {couple && (
          <>
            <Card title="Couple view" sub={`${shortDate(sel.night.date)} · awake/asleep in sync ${fmt(couple.sync ? couple.sync.agreement * 100 : NaN)}% of the night`} className="span-2">
              <MirroredHypnogram
                night={sel.night}
                people={dataset.people}
                colors={dataset.people.map((p) => personColor(dataset.people, p.id))}
                events={detail?.events ?? []}
                shared={couple.sync?.shared ?? []}
              />
              {couple.sync && (
                <ul className="list small" style={{ marginTop: 6 }}>
                  {couple.sync.shared.length === 0 && <li className="muted">No overlapping wake-ups this night.</li>}
                  {couple.sync.shared.map((s, i) => (
                    <li key={i}>
                      <b className="num">{hm(s.at)}</b>
                      <span style={{ flex: 1 }}>
                        {personName(dataset, s.first)} woke first, {personName(dataset, s.second)} {s.lagMin < 1 ? 'at the same minute' : `${fmt(s.lagMin)} min later`}
                      </span>
                      <span className="muted">{s.roomCause ?? 'no room cause'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Thermal compromise" sub="Early-night temperature with each person's best mean sleep score (≥3 nights per 0.5 °C bin)" className="span-2">
              <CompromiseAxis
                marks={[
                  ...couple.best.map((b, i) => ({ label: `${personName(dataset, b.id)} best`, value: b.best?.t ?? NaN, color: personColor(dataset.people, b.id), tier: (i === 0 ? 0 : 1) as 0 | 1 })),
                  { label: "Tonight's deep phase", value: deepTarget, color: 'var(--text)', tier: 2 as const },
                ]}
              />
              <p className="card-note">Bedding settles the rest: whoever runs warm takes the lighter duvet.</p>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
