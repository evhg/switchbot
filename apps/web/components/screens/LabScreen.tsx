'use client';
/**
 * Lab tab (docs/DESIGN.md §11 "Lab"): analytical but calm. Five sections behind a sticky jump bar, each with a
 * two-tone headline and at most one hero number: Experiments (forest plot leads), Room × body (scatter whose dots
 * glide when the variables change), CO₂ buckets, the correlation matrix, and the couple view.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { PersonNightMetrics, RoomNightMetrics, TagKey } from '@sleep-lab/core';
import { personColor, personName, useData, useNightDetail, useSelectedNight } from '@/lib/data/context.tsx';
import { synchrony } from '@/lib/analysis.ts';
import { usePlannedCurve } from '@/lib/curve-store.ts';
import { fmt, hm, shortDate } from '@/lib/format.ts';
import { finite, linearFit, loess, mean, meanCI, pearson, range, sd, welch } from '@/lib/stats.ts';
import { CompromiseAxis, CorrMatrix, IntervalPlot, MirroredHypnogram, TrendScatter, type IntervalRow } from '../charts/lab.tsx';
import s from '../charts/lab.module.css';
import { DateNav } from '../DateNav.tsx';
import { Icon, type IconName } from '../icons.tsx';
import { CountUp, Reveal } from '../motion.tsx';
import { Card, JumpBar, SectionHeader, Segmented, Skeleton, SkeletonText } from '../ui.tsx';

type RoomKey = 'earlyTemp' | 'co2Mean' | 'rhMean' | 'ach';
type OutKey = 'deepMin' | 'remMin' | 'hrNadir' | 'rmssdMean' | 'sleepScore' | 'efficiencyPct';

const ROOM: Record<RoomKey, { label: string; short: string; unit: string; digits: number; get: (r: RoomNightMetrics) => number }> = {
  earlyTemp: { label: 'Early-night temp', short: 'Temp', unit: '°C', digits: 1, get: (r) => r.tempEarlyMean },
  co2Mean: { label: 'Mean CO₂', short: 'CO₂', unit: 'ppm', digits: 0, get: (r) => r.co2Mean },
  rhMean: { label: 'Mean RH', short: 'RH', unit: '%', digits: 0, get: (r) => r.rhMean },
  ach: { label: 'Morning ACH', short: 'ACH', unit: '/h', digits: 2, get: (r) => r.achMorning ?? NaN },
};
const OUT: Record<OutKey, { label: string; short: string; unit: string; digits: number; get: (m: PersonNightMetrics) => number }> = {
  deepMin: { label: 'Deep sleep', short: 'Deep', unit: 'min', digits: 0, get: (m) => m.deepMin },
  remMin: { label: 'REM sleep', short: 'REM', unit: 'min', digits: 0, get: (m) => m.remMin },
  hrNadir: { label: 'HR nadir', short: 'HR nadir', unit: 'bpm', digits: 0, get: (m) => m.hrNadir },
  rmssdMean: { label: 'HRV', short: 'HRV', unit: 'ms', digits: 0, get: (m) => m.rmssdMean },
  sleepScore: { label: 'Sleep score', short: 'Score', unit: '', digits: 0, get: (m) => m.sleepScore },
  efficiencyPct: { label: 'Efficiency', short: 'Efficiency', unit: '%', digits: 0, get: (m) => m.efficiencyPct },
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

const JUMP = [
  { id: 'experiments', label: 'Tests' },
  { id: 'room-body', label: 'Room × body' },
  { id: 'co2', label: 'CO₂' },
  { id: 'matrix', label: 'Matrix' },
  { id: 'couple', label: 'Couple' },
] as const;

const shortOpts = <K extends string>(rec: Record<K, { short: string }>) => (Object.keys(rec) as K[]).map((k) => ({ value: k, label: rec[k].short }));
const accent = (a: string): CSSProperties => ({ ['--ch-accent' as string]: `var(--ac-${a})`, ['--accent' as string]: `var(--ac-${a})` });
const signedFmt = (v: number, dp = 0) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt(Math.abs(v), dp)}` : '–');

function Section({ id, n, kicker, lines, lede, ac, children }: { id: string; n: number; kicker: string; lines: ReactNode[]; lede?: ReactNode; ac: string; children: ReactNode }) {
  return (
    <section id={id} data-jump className={s.section} style={accent(ac)} aria-label={kicker}>
      <div className={s.sectionHead}>
        <SectionHeader n={n} kicker={kicker} lines={lines} size="h2" />
        {lede && <p className={s.sectionLede}>{lede}</p>}
      </div>
      {children}
    </section>
  );
}

function Hero({ value, caption, label }: { value: ReactNode; label: ReactNode; caption: ReactNode }) {
  return (
    <Reveal className={s.hero} y={16}>
      <div className={s.heroNum}>{value}</div>
      <div className={s.heroCap}>
        <span className="t-label">{label}</span>
        <span>{caption}</span>
      </div>
    </Reveal>
  );
}

function Callout({ icon = 'info', children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className={s.callout} role="note">
      <Icon name={icon} size={16} />
      <div>{children}</div>
    </div>
  );
}

function LabSkeleton({ text }: { text: string }) {
  return (
    <div className={s.skel} role="status" aria-live="polite">
      <Skeleton w="80%" h={14} r="text" />
      <div className={s.facts}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={s.fact}>
            <Skeleton w="60%" h={9} r="text" />
            <Skeleton w="50%" h={28} r="text" />
          </div>
        ))}
      </div>
      <Skeleton w="100%" h={44} r="pill" />
      <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
        <Skeleton w={120} h={10} r="text" />
        <SkeletonText lines={2} size={26} last={0.5} />
      </div>
      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <Skeleton w="45%" h={18} r="text" />
        <Skeleton h={320} />
      </div>
      <div className="sk-status t-label">{text}</div>
    </div>
  );
}

export function LabScreen() {
  const { dataset, progress, date } = useData();
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
    const xs = series.flatMap((ss) => ss.points.map((p) => p.x));
    const ys = series.flatMap((ss) => ss.points.map((p) => p.y));
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

  const forest = useMemo<(IntervalRow & { nTag: number })[]>(() => {
    if (!dataset) return [];
    return TAGS.flatMap((t) =>
      dataset.people.map((p) => {
        const mine = rows.filter((r) => r.personId === p.id);
        const w = welch(
          mine.filter((r) => !r.tags.includes(t.key)).map((r) => OUT[expMetric].get(r.m)),
          mine.filter((r) => r.tags.includes(t.key)).map((r) => OUT[expMetric].get(r.m)),
        );
        return { group: t.label, label: p.name, sub: `${w.nB} vs ${w.nA}`, est: w.diff, lo: w.lo, hi: w.hi, color: personColor(dataset.people, p.id), progress: w.nB / NEEDED_PER_ARM, nTag: w.nB };
      }),
    );
  }, [dataset, rows, expMetric]);

  /** The headline experiment: biggest effect whose interval excludes zero (else the biggest effect so far). */
  const strongest = useMemo(() => {
    const ok = forest.filter((r) => Number.isFinite(r.est) && Number.isFinite(r.lo) && Number.isFinite(r.hi));
    const sig = ok.filter((r) => r.lo > 0 || r.hi < 0);
    const pool = sig.length ? sig : ok;
    const best = pool.reduce<(typeof ok)[number] | null>((a, b) => (!a || Math.abs(b.est) > Math.abs(a.est) ? b : a), null);
    return best ? { row: best, significant: sig.length > 0 } : null;
  }, [forest]);

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
    const matrix = cols.map((a) => cols.map((b) => pearson(a, b)));
    let strong = 0;
    let pairs = 0;
    for (let i = 0; i < matrix.length; i++)
      for (let j = 0; j < i; j++) {
        pairs++;
        if (Math.abs(matrix[i]![j]!) >= 0.2) strong++;
      }
    return { labels: feats.map((f) => f.label), matrix, strong, pairs };
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

  if (!dataset || !sel || !scatter || !corr)
    return (
      <div className={s.page}>
        <DateNav title="Lab" kicker="What actually helps" />
        <LabSkeleton text={progress || 'Reading every night…'} />
      </div>
    );

  const deepTarget = plan.phases.find((p) => p.name === 'deep')?.targetC ?? NaN;
  const nights = finite(rows.map((r) => r.room.co2Mean)).length / Math.max(1, dataset.people.length);
  const yUnit = OUT[yKey].unit;
  const xUnit = ROOM[xKey].unit;
  const st = strongest?.row;

  return (
    <div className={s.page} style={accent('tonight')}>
      <DateNav title="Lab" kicker="What actually helps" />

      <Reveal className={s.intro} y={14}>
        <p className={s.lede}>
          Every night is a data point. <b>Simulated effects are deliberately weak</b>, as real ones will be, so the Lab shows uncertainty first.
        </p>
        <div className={s.facts}>
          <div className={s.fact}>
            <span className="t-micro">Nights</span>
            <CountUp className={s.factValue} value={Math.round(nights)} />
          </div>
          <div className={s.fact}>
            <span className="t-micro">People</span>
            <CountUp className={s.factValue} value={dataset.people.length} />
          </div>
          <div className={s.fact}>
            <span className="t-micro">Person-nights</span>
            <CountUp className={s.factValue} value={rows.length} />
          </div>
        </div>
      </Reveal>

      <JumpBar items={JUMP} label="Lab sections" />

      <Section
        id="experiments"
        n={1}
        kicker="Experiments"
        ac="tonight"
        lines={['Tag it.', 'Then test it.']}
        lede={<>Effect of each evening tag on {OUT[expMetric].label.toLowerCase()}: tagged nights minus untagged, with a 95 % interval. If the bar crosses the dashed line, it could be nothing.</>}
      >
        {st && (
          <Hero
            value={
              <>
                {signedFmt(st.est, OUT[expMetric].digits)}
                {OUT[expMetric].unit && <span className="t-unit">{OUT[expMetric].unit}</span>}
              </>
            }
            label={strongest.significant ? 'Strongest signal' : 'Biggest effect · not yet clear'}
            caption={
              <>
                {st.group} · {st.label}, {OUT[expMetric].label.toLowerCase()} ({signedFmt(st.lo, OUT[expMetric].digits)} to {signedFmt(st.hi, OUT[expMetric].digits)})
              </>
            }
          />
        )}
        <div className="stack two">
          <Card title="Experiment board" sub="Observational splits. True A/B tests alternate nights at random." className="span-2">
            <div className={s.chipRow} role="group" aria-label="Outcome">
              {shortOpts(OUT).map((o) => (
                <button key={o.value} type="button" className="chip" aria-pressed={o.value === expMetric} onClick={() => setExpMetric(o.value)}>
                  {o.label}
                </button>
              ))}
            </div>
            <IntervalPlot rows={forest} zero={0} unit={OUT[expMetric].unit} labelW={104} rowH={30} animKey={expMetric} progressLabel={(r) => `${Math.round((r.progress ?? 0) * NEEDED_PER_ARM)}/${NEEDED_PER_ARM}`} />
            <p className="card-note">
              Tagged vs untagged nights under each name; the small bar counts tagged nights towards the ~{NEEDED_PER_ARM} per arm needed to detect a 10-minute change.
            </p>
          </Card>
        </div>
      </Section>

      <Section
        id="room-body"
        n={2}
        kicker="Room × body"
        ac="lights"
        lines={['Room vs body.', 'Correlation, not cause.']}
        lede="Pick a room factor and a body outcome. Every dot is one person-night; the line is a LOESS trend through both of you."
      >
        <Hero
          value={
            <>
              <span className="tone-2" style={{ fontWeight: 500 }}>
                r{' '}
              </span>
              {signedFmt(scatter.r, 2)}
            </>
          }
          label={Math.abs(scatter.r) < 0.1 ? 'No real link' : Math.abs(scatter.r) < 0.3 ? 'Weak link' : 'Moderate link'}
          caption={
            <>
              Slope {signedFmt(scatter.slope, 2)} {yUnit || 'pts'} per {xUnit} · {scatter.n} person-nights
            </>
          }
        />
        <div className="stack two">
          <Card title={`${OUT[yKey].label} vs ${ROOM[xKey].label.toLowerCase()}`} className="span-2">
            <div className={s.controls}>
              <div className={s.ctlRow}>
                <span className="t-micro">Room</span>
                <Segmented value={xKey} onChange={setX} options={shortOpts(ROOM)} label="Room factor" />
              </div>
              <div className={`${s.ctlRow} ${s.ctlScroll}`} role="group" aria-label="Body outcome">
                <span className="t-micro">Body</span>
                {shortOpts(OUT).map((o) => (
                  <button key={o.value} type="button" className="chip" aria-pressed={o.value === yKey} onClick={() => setY(o.value)}>
                    {o.label}
                  </button>
                ))}
              </div>
              <div className={s.ctlRow}>
                <span className="t-micro">Lag</span>
                <Segmented value={lag} onChange={setLag} options={[{ value: 'same', label: 'Same night' }, { value: 'next', label: 'Next night' }]} label="Lag" />
              </div>
            </div>
            <TrendScatter
              series={scatter.series}
              trend={scatter.trend}
              xLabel={`${ROOM[xKey].label} (${xUnit})`}
              yLabel={OUT[yKey].label}
              xDigits={ROOM[xKey].digits}
              yDigits={OUT[yKey].digits}
              trendKey={`${xKey}-${yKey}-${lag}`}
            />
            <p className="card-note">Correlation, not causation: run an experiment above before changing the curve.</p>
          </Card>
        </div>
      </Section>

      <Section id="co2" n={3} kicker="CO₂ buckets" ac="air" lines={['Stale air.', 'Does it cost you?']} lede="Nights grouped by their mean CO₂. Mean with a 95 % interval per person.">
        <div className="stack two">
          <Card title="By nightly mean CO₂" meta={<Segmented value={bucketMetric} onChange={setBucketMetric} options={[{ value: 'rmssdMean', label: 'HRV' }, { value: 'deepMin', label: 'Deep' }]} label="Outcome" />} className="span-2">
            <IntervalPlot rows={buckets} unit={OUT[bucketMetric].unit} labelW={96} animKey={bucketMetric} />
          </Card>
        </div>
      </Section>

      <Section id="matrix" n={4} kicker="Correlation matrix" ac="night" lines={['Everything × everything.', 'Mostly noise.']} lede="Exploratory only. Body outcomes are z-scored within each person so two baselines don't fake a link.">
        <div className="stack two">
          <Card title="14 features" sub="Room, tags and body outcomes · tap a cell for its r value" className="span-2">
            <Callout>
              With 14 features there are 91 pairs, so <b>about 5 will look &lsquo;significant&rsquo; by chance</b>. Treat a bright cell as a question for the experiment board, not an answer.
            </Callout>
            <div className="scroll-x">
              <CorrMatrix labels={corr.labels} matrix={corr.matrix} />
            </div>
          </Card>
        </div>
      </Section>

      {couple && (
        <Section
          id="couple"
          n={5}
          kicker="Couple view"
          ac="verdict"
          lines={['Two sleepers.', 'One thermostat.']}
          lede={<>{shortDate(sel.night.date)}: {personName(dataset, dataset.people[0]!.id)} above, {personName(dataset, dataset.people[1]!.id)} below, around one room-temperature strip. Red bands are wake-ups you shared.</>}
        >
          <Hero
            value={
              <>
                {couple.sync ? <CountUp value={Math.round(couple.sync.agreement * 100)} /> : '–'}
                <span className="t-unit">%</span>
              </>
            }
            label="In sync"
            caption={<>Awake or asleep at the same time · {couple.sync?.shared.length ?? 0} shared wake-up{couple.sync?.shared.length === 1 ? '' : 's'}</>}
          />
          <div className="stack two">
            <Card title="Mirrored hypnograms" sub={`${shortDate(sel.night.date)} · awake/asleep in sync ${fmt(couple.sync ? couple.sync.agreement * 100 : NaN)}% of the night`} className="span-2">
              <MirroredHypnogram
                night={sel.night}
                people={dataset.people}
                colors={dataset.people.map((p) => personColor(dataset.people, p.id))}
                events={detail?.events ?? []}
                shared={couple.sync?.shared ?? []}
              />
              {couple.sync && (
                <ul className={s.wakes}>
                  {couple.sync.shared.length === 0 && <li className={s.none}>No overlapping wake-ups this night.</li>}
                  {couple.sync.shared.map((sh, i) => (
                    <li key={i}>
                      <b>{hm(sh.at)}</b>
                      <span>
                        {personName(dataset, sh.first)} woke first, {personName(dataset, sh.second)} {sh.lagMin < 1 ? 'at the same minute' : `${fmt(sh.lagMin)} min later`}
                      </span>
                      <span>{sh.roomCause ?? 'no room cause'}</span>
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
          </div>
        </Section>
      )}
    </div>
  );
}
