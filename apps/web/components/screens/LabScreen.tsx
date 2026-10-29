'use client';
/**
 * Lab tab, v2 "Instrument" (docs/DESIGN.md §9.4): analytical but calm.
 *
 *   Header    "Lab" + one sentence: "80 of 90 nights" with the exclusions explained and linked to Data & devices.
 *   Hero      The strongest signal as a reading plus one sentence ("Door ajar: more deep sleep for Erik"), with its
 *             interval and an honest "could be noise".
 *   Sections  1 Experiment board — one forest plot; the outcome is picked in a sentence ("Effect of each tag on [Deep ▾]").
 *             2 Room × body — a sentence-builder ("Compare [Temp ▾] with [Deep ▾], [same night ▾]") over one scatter;
 *               the title states r and what it means.
 *             3 By nightly mean CO₂ — one interval plot, one segmented control.
 *             4 Couple — mirrored hypnograms, shared wake-ups, the thermal compromise.
 *   More      The 14-feature correlation matrix (wide sheet) · nights left out (→ System › Data & devices).
 *
 * Menus are popovers on desktop and bottom sheets on the phone. No jump bars; the "On this page" rail from 1760.
 */
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PersonNightMetrics, RoomNightMetrics, TagKey } from '@sleep-lab/core';
import { personColor, personName, useData, useNightDetail, useSelectedNight } from '@/lib/data/context.tsx';
import { synchrony } from '@/lib/analysis.ts';
import { usePlannedCurve } from '@/lib/curve-store.ts';
import { fmt, hm, shortDate, shortDay } from '@/lib/format.ts';
import { linearFit, loess, mean, meanCI, pearson, range, sd, welch } from '@/lib/stats.ts';
import { lowerYou } from '../story/model.ts';
import { CompromiseAxis, CorrMatrix, IntervalPlot, MirroredHypnogram, TrendScatter, type IntervalRow } from '../charts/lab.tsx';
import s from '../charts/lab.module.css';
import { Icon } from '../icons.tsx';
import { EventList, MoreAnalysis, OnThisPage, PageHeader, Section, Segmented, Sheet, Skeleton } from '../ui.tsx';

type RoomKey = 'earlyTemp' | 'co2Mean' | 'rhMean' | 'ach';
type OutKey = 'deepMin' | 'remMin' | 'hrNadir' | 'rmssdMean' | 'sleepScore' | 'efficiencyPct';
type Lag = 'same' | 'next';

const ROOM: Record<RoomKey, { label: string; noun: string; unit: string; digits: number; get: (r: RoomNightMetrics) => number }> = {
  earlyTemp: { label: 'Early-night temperature', noun: 'early-night temperature', unit: '°C', digits: 1, get: (r) => r.tempEarlyMean },
  co2Mean: { label: 'Average CO₂', noun: 'average CO₂', unit: 'ppm', digits: 0, get: (r) => r.co2Mean },
  rhMean: { label: 'Average humidity', noun: 'average humidity', unit: '%', digits: 0, get: (r) => r.rhMean },
  ach: { label: 'Morning fresh air', noun: 'morning fresh air', unit: 'air changes an hour', digits: 2, get: (r) => r.achMorning ?? NaN },
};
const OUT: Record<OutKey, { label: string; noun: string; unit: string; digits: number; get: (m: PersonNightMetrics) => number }> = {
  deepMin: { label: 'Deep sleep', noun: 'deep sleep', unit: 'min', digits: 0, get: (m) => m.deepMin },
  remMin: { label: 'REM sleep', noun: 'REM sleep', unit: 'min', digits: 0, get: (m) => m.remMin },
  hrNadir: { label: 'Lowest heart rate', noun: 'lowest heart rate', unit: 'bpm', digits: 0, get: (m) => m.hrNadir },
  rmssdMean: { label: 'HRV', noun: 'HRV', unit: 'ms', digits: 0, get: (m) => m.rmssdMean },
  sleepScore: { label: 'Sleep score', noun: 'sleep score', unit: 'points', digits: 0, get: (m) => m.sleepScore },
  efficiencyPct: { label: 'Sleep efficiency', noun: 'sleep efficiency', unit: '%', digits: 0, get: (m) => m.efficiencyPct },
};
const TAGS: { key: TagKey; label: string }[] = [
  { key: 'door_ajar', label: 'Door ajar' },
  { key: 'alcohol', label: 'Alcohol' },
  { key: 'late_meal', label: 'Late meal' },
  { key: 'late_exercise', label: 'Late exercise' },
  { key: 'late_caffeine', label: 'Caffeine after 14:00' },
  { key: 'heavy_duvet', label: 'Heavy duvet' },
];
const LAG: Record<Lag, { label: string }> = { same: { label: 'the same night' }, next: { label: 'the next night' } };
const NEEDED_PER_ARM = 35;

const opts = <K extends string>(rec: Record<K, { label: string }>) => (Object.keys(rec) as K[]).map((k) => ({ value: k, label: rec[k].label }));
const signedFmt = (v: number, dp = 0) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt(Math.abs(v), dp)}` : '–');
const lower = (t: string) => (/^[A-Z][a-z]/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t);

/** A word in a sentence that opens a menu: a popover on desktop, a bottom sheet on the phone. */
function Pick<K extends string>({ value, options, onChange, label }: { value: K; options: { value: K; label: string }[]; onChange: (v: K) => void; label: string }) {
  const [open, setOpen] = useState<'pop' | 'sheet' | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (open !== 'pop') return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const current = options.find((o) => o.value === value)?.label ?? value;
  const list = (cls?: string) => (
    <ul className={cls ?? s.pop} role="listbox" aria-label={label}>
      {options.map((o) => (
        <li key={o.value}>
          <button
            type="button"
            role="option"
            aria-selected={o.value === value}
            className={s.opt}
            onClick={() => {
              onChange(o.value);
              setOpen(null);
            }}
          >
            {o.label}
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <span className={s.pickWrap} ref={wrap}>
      <button
        type="button"
        className={s.pickBtn}
        aria-haspopup="listbox"
        aria-expanded={open !== null}
        aria-label={`${label}: ${current}`}
        onClick={() => setOpen((o) => (o ? null : window.matchMedia('(min-width: 1024px)').matches ? 'pop' : 'sheet'))}
      >
        {current}
        <Icon name="chevron-down" size={18} />
      </button>
      {open === 'pop' && list()}
      <Sheet open={open === 'sheet'} onClose={() => setOpen(null)} title={label}>
        {list(s.sheetOpts)}
      </Sheet>
    </span>
  );
}

function Facts({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className={s.facts}>
      {items.map((it, i) => (
        <div key={i}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PeopleKeys({ people, extra }: { people: { id: string; name: string }[]; extra?: ReactNode }) {
  return (
    <p className={s.keys}>
      {people.map((p, i) => (
        <span key={p.id}>
          <i className={i === 1 ? s.hollow : undefined} style={{ background: personColor(people, p.id) } as CSSProperties} aria-hidden />
          {p.name}
        </span>
      ))}
      {extra}
    </p>
  );
}

function LabSkeleton({ text }: { text: string }) {
  return (
    <div className={s.skel} role="status" aria-live="polite">
      <div style={{ display: 'grid', gap: 16 }}>
        <Skeleton w={220} h={16} r="text" />
        <Skeleton w="min(50%, 360px)" h="var(--t-display)" r="lg" />
        <Skeleton w="min(80%, 560px)" h={24} r="text" />
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <Skeleton w="45%" h={22} r="text" />
        <Skeleton h={320} />
      </div>
      <div className="sk-status">{text}</div>
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
  const [lag, setLag] = useState<Lag>('same');
  const [bucketMetric, setBucketMetric] = useState<OutKey>('rmssdMean');
  const [expMetric, setExpMetric] = useState<OutKey>('deepMin');
  const [matrixOpen, setMatrixOpen] = useState(false);

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
      { label: 'Under 800 ppm', test: (c: number) => c < 800 },
      { label: '800 to 1,200 ppm', test: (c: number) => c >= 800 && c <= 1200 },
      { label: 'Over 1,200 ppm', test: (c: number) => c > 1200 },
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

  /** The headline: biggest effect whose interval excludes zero (else the biggest effect so far). */
  const strongest = useMemo(() => {
    const ok = forest.filter((r) => Number.isFinite(r.est) && Number.isFinite(r.lo) && Number.isFinite(r.hi));
    const sig = ok.filter((r) => r.lo > 0 || r.hi < 0);
    const pool = sig.length ? sig : ok;
    const best = pool.reduce<(typeof ok)[number] | null>((a, b) => (!a || Math.abs(b.est) > Math.abs(a.est) ? b : a), null);
    return best ? { row: best, significant: sig.length > 0, nSig: sig.length } : null;
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

  const header = (lede: ReactNode) => <PageHeader title="Lab" lede={lede} />;
  if (!dataset || !sel || !scatter || !corr)
    return (
      <div>
        {header('What actually helps, tested on your own nights.')}
        <LabSkeleton text={progress || 'Reading every night…'} />
      </div>
    );

  const total = dataset.nights.length;
  const included = new Set(rows.map((r) => r.date)).size;
  const sickN = dataset.nights.filter((n) => n.tags.includes('sick')).length;
  const awayN = dataset.nights.filter((n) => n.tags.includes('travel') && !n.tags.includes('sick')).length;
  const gapN = Math.max(0, total - included - sickN - awayN);
  const leftOut = [sickN && `${sickN} sick`, awayN && `${awayN} away`, gapN && `${gapN} with sensor gaps`].filter(Boolean).join(', ');
  const deepTarget = plan.phases.find((p) => p.name === 'deep')?.targetC ?? NaN;
  const em = OUT[expMetric];
  const st = strongest?.row;
  const linkWord = Math.abs(scatter.r) < 0.1 ? 'No real link' : Math.abs(scatter.r) < 0.3 ? 'A weak link' : 'A moderate link';
  const bm = OUT[bucketMetric];
  const lowB = buckets.filter((b) => b.group === 'Under 800 ppm' && Number.isFinite(b.est));
  const highB = buckets.filter((b) => b.group === 'Over 1,200 ppm' && Number.isFinite(b.est));
  const co2Diff = lowB.length && highB.length ? mean(highB.map((b) => b.est)) - mean(lowB.map((b) => b.est)) : NaN;
  const co2Clear = buckets.some((b, i) => {
    const other = buckets.find((o, j) => j !== i && o.label === b.label && o.group !== b.group && b.group === 'Under 800 ppm' && o.group === 'Over 1,200 ppm');
    return !!other && (other.hi < b.lo || other.lo > b.hi);
  });
  const co2Title = !Number.isFinite(co2Diff)
    ? `Not enough stale nights yet to judge ${bm.noun}`
    : co2Clear
      ? `Stale air moved ${bm.noun} by ${signedFmt(co2Diff, bm.digits)} ${bm.unit}`
      : `Stale nights don’t clearly cost ${bm.noun} yet`;
  const pct = couple?.sync ? Math.round(couple.sync.agreement * 100) : NaN;

  return (
    <div>
      {header(
        <>
          What actually helps, tested on your own nights. {included} of {total} nights have complete data; {total - included} {total - included === 1 ? 'is' : 'are'} left out{leftOut ? `: ${leftOut}` : ''}.{' '}
          <Link className="link" href="/settings/data">
            Data & devices
          </Link>
        </>,
      )}

      {/* ───────── Hero: the strongest signal ───────── */}
      {st && strongest && (
        <section className={s.hero} aria-label="Strongest signal">
          <div className={s.heroMain}>
            <p className="label">{strongest.significant ? `Strongest signal so far, ${em.noun}` : `Biggest effect so far, ${em.noun}`}</p>
            <div className={`display ${s.heroNum}`}>
              {signedFmt(st.est, em.digits)}
              <span className="unit">{em.unit}</span>
            </div>
            <p className={s.heroSentence}>
              {st.group}: {st.est >= 0 ? 'more' : 'less'} {em.noun} for {st.label}.
            </p>
            <p className={`sec ${s.heroWhy}`}>
              95% interval {signedFmt(st.lo, em.digits)} to {signedFmt(st.hi, em.digits)} {em.unit}, from {st.nTag} tagged nights. {strongest.significant ? 'Clear of zero, but check it with a planned test.' : 'Could be noise.'}
            </p>
          </div>
          <Facts
            items={[
              { label: 'Nights analysed', value: `${included} of ${total}` },
              { label: 'Person-nights', value: fmt(rows.length) },
              { label: 'Tags tracked', value: fmt(TAGS.length) },
              { label: 'Splits clear of zero', value: `${strongest.nSig} of ${forest.length}` },
            ]}
          />
        </section>
      )}

      {/* ───────── 1 Experiment board ───────── */}
      <Section
        id="experiments"
        nav="Experiments"
        title={strongest?.significant ? `${strongest.nSig} of ${forest.length} tag splits clear the no-effect line` : `No tag has a clear effect on ${em.noun} yet`}
        cap="Tagged nights minus untagged nights, with a 95% interval. A bar that crosses the dashed line could be nothing."
      >
        <p className={s.sentence}>
          Effect of each evening tag on <Pick value={expMetric} onChange={setExpMetric} options={opts(OUT)} label="Outcome" />
        </p>
        <div className={s.body}>
          <div className={s.main}>
            <IntervalPlot rows={forest} zero={0} unit={em.unit} digits={em.digits} axisLabel={`Change in ${em.noun}, ${em.unit}`} animKey={expMetric} progressLabel={(r) => `${Math.round((r.progress ?? 0) * NEEDED_PER_ARM)} of ${NEEDED_PER_ARM} nights`} />
          </div>
          <div className={s.aside}>
            <p className={s.note}>These are observational splits. A true A/B test alternates nights at random.</p>
            <p className={s.note}>About {NEEDED_PER_ARM} tagged nights per tag are needed to detect a 10-minute change; the count beside each row shows how far along it is.</p>
            <p className={s.note}>Simulated effects are deliberately weak, as real ones will be, so the Lab shows uncertainty first.</p>
          </div>
        </div>
      </Section>

      {/* ───────── 2 Room × body ───────── */}
      <Section
        id="room-body"
        nav="Room × body"
        title={`${linkWord} between ${ROOM[xKey].noun} and ${lag === 'next' ? 'next-night ' : ''}${OUT[yKey].noun}`}
        cap="One dot per person-night; the line is a LOESS trend through both of you. Correlation, not causation."
      >
        <p className={s.sentence}>
          Compare <Pick value={xKey} onChange={setX} options={opts(ROOM)} label="Room factor" /> with{' '}
          <span className="nowrap">
            <Pick value={yKey} onChange={setY} options={opts(OUT)} label="Body outcome" />,
          </span>{' '}
          <span className="nowrap">
            <Pick value={lag} onChange={setLag} options={opts(LAG)} label="Which night" />
          </span>
        </p>
        <div className={s.body}>
          <div className={s.main}>
            <TrendScatter
              series={scatter.series}
              trend={scatter.trend}
              xLabel={`${ROOM[xKey].label}, ${ROOM[xKey].unit}`}
              yLabel={`${OUT[yKey].label}${OUT[yKey].unit === 'points' ? '' : `, ${OUT[yKey].unit}`}`}
              xDigits={ROOM[xKey].digits}
              yDigits={OUT[yKey].digits}
              trendKey={`${xKey}-${yKey}-${lag}`}
            />
            <PeopleKeys people={dataset.people} />
          </div>
          <div className={s.aside}>
            <Facts
              items={[
                { label: 'Correlation', value: `r ${signedFmt(scatter.r, 2)}` },
                { label: 'Slope', value: `${signedFmt(scatter.slope, 2)} ${lower(OUT[yKey].unit)} per ${ROOM[xKey].unit === 'air changes an hour' ? 'air change' : ROOM[xKey].unit}` },
                { label: 'Person-nights', value: fmt(scatter.n) },
              ]}
            />
            <p className={s.note}>Correlation, not causation: run an experiment above before changing the curve.</p>
          </div>
        </div>
      </Section>

      {/* ───────── 3 By nightly mean CO₂ ───────── */}
      <Section
        id="co2"
        nav="CO₂"
        title={co2Title}
        cap="Nights grouped by their average CO₂. Average with a 95% interval for each of you."
        actions={<Segmented value={bucketMetric} onChange={setBucketMetric} options={[{ value: 'rmssdMean', label: 'HRV' }, { value: 'deepMin', label: 'Deep sleep' }]} label="Outcome" />}
      >
        <div className={s.body}>
          <div className={s.main}>
            <IntervalPlot rows={buckets} unit={bm.unit} digits={bm.digits} axisLabel={`${bm.label}, ${bm.unit}`} animKey={bucketMetric} />
          </div>
          <div className={s.aside}>
            <Facts items={buckets.filter((b, i, a) => a.findIndex((o) => o.group === b.group) === i).map((b) => ({ label: b.group, value: buckets.filter((o) => o.group === b.group).map((o) => `${o.label} ${o.sub?.replace(' nights', '')}`).join(' · ') }))} />
            <p className={s.note}>Wide intervals mean too few nights in that group to say much.</p>
          </div>
        </div>
      </Section>

      {/* ───────── 4 Couple ───────── */}
      {couple && (
        <Section
          id="couple"
          nav="Couple"
          title={Number.isFinite(pct) ? `In sync ${pct}% of the night, with ${couple.sync?.shared.length ?? 0} shared wake-up${couple.sync?.shared.length === 1 ? '' : 's'}` : 'Two sleepers, one thermostat'}
          cap={`${shortDay(sel.night.date)} ${shortDate(sel.night.date)}: awake or asleep at the same time. ${personName(dataset, dataset.people[0]!.id)} above, ${personName(dataset, dataset.people[1]!.id)} below, the room's temperature along the middle; deeper sleep sits further from it.`}
        >
          <div className={s.main}>
            <MirroredHypnogram night={sel.night} people={dataset.people} events={detail?.events ?? []} shared={couple.sync?.shared ?? []} />
            <div className={s.duo}>
              <div>
                <h3 className="label">Shared wake-ups</h3>
                {couple.sync && couple.sync.shared.length > 0 ? (
                  <EventList
                    items={couple.sync.shared.map((sh) => ({
                      time: hm(sh.at),
                      title: `${personName(dataset, sh.first)} woke first, ${lowerYou(personName(dataset, sh.second))} ${sh.lagMin < 1 ? 'the same minute' : `${fmt(sh.lagMin)} min later`}`,
                      detail: sh.roomCause ? `Room: ${lower(sh.roomCause)}` : 'No room cause found',
                    }))}
                  />
                ) : (
                  <p className="sec">No overlapping wake-ups this night.</p>
                )}
              </div>
              <div>
                <h3 className="label">Thermal compromise</h3>
                <CompromiseAxis
                  marks={[
                    ...couple.best.map((b, i) => ({ label: `${personName(dataset, b.id)} best`, value: b.best?.t ?? NaN, color: personColor(dataset.people, b.id), tier: (i === 0 ? 0 : 1) as 0 | 1 })),
                    { label: 'Tonight’s deep phase', value: deepTarget, color: 'var(--signal)', tier: 2 as const },
                  ]}
                />
                <p className={s.note}>Each person&rsquo;s best average sleep score by early-night temperature (at least 3 nights per half degree). Bedding settles the rest: whoever runs warm takes the lighter duvet.</p>
              </div>
            </div>
          </div>
        </Section>
      )}

      <div className={s.more}>
        <MoreAnalysis
          items={[
            { label: 'Everything × everything', value: `${corr.strong} of ${corr.pairs} pairs look linked`, onClick: () => setMatrixOpen(true) },
            { label: 'Nights left out', value: `${total - included} of ${total}`, href: '/settings/data' },
          ]}
        />
      </div>
      <OnThisPage />

      <Sheet open={matrixOpen} onClose={() => setMatrixOpen(false)} title="Everything × everything. Mostly noise." wide>
        <div className={s.sheetBody}>
          <p className={s.sheetLede}>
            Room, tags and body outcomes, 14 features. Body outcomes are z-scored within each person so two baselines don&rsquo;t fake a link. With 91 pairs, <b>about 5 will look &lsquo;significant&rsquo; by chance</b>: treat a strong cell as a question for the experiment board, not an answer.
          </p>
          <CorrMatrix labels={corr.labels} matrix={corr.matrix} />
        </div>
      </Sheet>
    </div>
  );
}
