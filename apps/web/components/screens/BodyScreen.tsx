'use client';
/**
 * Body tab, v2 "Instrument" (docs/DESIGN.md §9.3).
 *
 *   Header    "Body" + one sentence, with the You / Erik segmented control in the header row.
 *   Hero      The sleep score at display size; "6h 41m asleep · recovery 79"; a quiet facts column.
 *   Sections  1 Last night: the hypnogram + stage mix (ⓘ opens "Our sleep/wake vs Google's").
 *             2 Vitals: a calm list (lowest HR, HRV, SpO₂, breathing) with a neutral delta vs typical; each row
 *               opens its drill-in.
 *             3 Recovery trends: one chart, range from one segmented control, metric picked from the list beside it.
 *   More      Sleeping heart rate · HRV through the night · Last 14 nights · Blood oxygen · Breathing · Resting HR ·
 *             Steps · Skin temperature vs room · Our sleep/wake vs Google's — each a sheet / right panel.
 *
 * The page sits in a .p-you / .p-erik scope, so `var(--person)` and the stage tokens follow the selected person.
 * Deep links from Today (/body#sleep, #recovery, #rhr, #hrv, #spo2, #resp, #temp, #steps) scroll to the matching
 * block or open the matching drill-in.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PersonNightMetrics } from '@sleep-lab/core';
import { useData, useNightDetail, useSelectedNight } from '@/lib/data/context.tsx';
import { hrSleepWake } from '@/lib/analysis.ts';
import { dur, fmt, hm, MIN, shortDate, shortDay, signed } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';
import { mean, sd } from '@/lib/stats.ts';
import { HrCurve, HrvNight, Hypnogram, Ridgeline, SleepWakeCompare, spo2Dips, Spo2Strip, StageMix, TempDeviation, TrendBand, trendSummary } from '../charts/body.tsx';
import s from '../charts/body.module.css';
import { Sparkline } from '../charts/Sparkline.tsx';
import { Icon } from '../icons.tsx';
import { useMotionPrefs } from '../motion.tsx';
import { Delta, IconButton, Loading, MoreAnalysis, OnThisPage, PageHeader, Placeholder, Section, Segmented, Sheet } from '../ui.tsx';

type Range = '7' | '30' | '90';
type TrendKey = 'rmssdMean' | 'hrNadir' | 'deepMin' | 'respRate';
type Drill = 'hr' | 'hrv' | 'ridge' | 'spo2' | 'resp' | 'rhr' | 'steps' | 'temp' | 'algo';
type M = PersonNightMetrics;

const TRENDS: Record<TrendKey, { label: string; noun: string; unit: string; digits: number; get: (m: M) => number | undefined }> = {
  rmssdMean: { label: 'HRV', noun: 'HRV', unit: 'ms', digits: 0, get: (m) => m.rmssdMean },
  hrNadir: { label: 'Lowest heart rate', noun: 'lowest heart rate', unit: 'bpm', digits: 0, get: (m) => m.hrNadir },
  deepMin: { label: 'Deep sleep', noun: 'deep sleep', unit: 'min', digits: 0, get: (m) => m.deepMin },
  respRate: { label: 'Breathing', noun: 'breathing rate', unit: '/min', digits: 1, get: (m) => m.respRate },
};

/** Neutral delta vs a person's own typical: "↓ 4 bpm · typical 53". */
function vsTypical(v: number, typical: number, digits: number, unit: string): ReactNode {
  if (!Number.isFinite(v) || !Number.isFinite(typical)) return <span className="delta-text">Building your typical range</span>;
  const d = v - typical;
  const txt = signed(d, digits);
  const flat = txt.startsWith('±');
  return (
    <Delta dir={flat ? 'flat' : d > 0 ? 'up' : 'down'} typical={`${fmt(typical, digits)}`}>
      {flat ? 'as usual' : `${txt.slice(1)}${unit ? ` ${unit}` : ''}`}
    </Delta>
  );
}

function Facts({ items }: { items: { label: ReactNode; value: ReactNode; sub?: ReactNode }[] }) {
  return (
    <dl className={s.facts}>
      {items.map((it, i) => (
        <div key={i}>
          <dt>{it.label}</dt>
          <dd>
            {it.value}
            {it.sub && <span className={s.ddSub}>{it.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function BodyScreen() {
  const { latest, progress, date, setDate } = useData();
  const sel = useSelectedNight();
  const { detail } = useNightDetail(date);
  const { night: nightMode } = useMotionPrefs();
  const [who, setWho] = usePref<string>('bodyPerson', 'a');
  const [range, setRange] = useState<Range>('30');
  const [trendKey, setTrendKey] = useState<TrendKey>('rmssdMean');
  const [open, setOpen] = useState<Drill | null>(null);

  const ds = latest;
  const personId = ds?.people.some((p) => p.id === who) ? who : (ds?.people[0]?.id ?? 'a');
  const series = useMemo(() => ds?.person[personId] ?? [], [ds, personId]);

  const baseline = useMemo(() => {
    if (!sel) return null;
    const past = series.slice(Math.max(0, sel.index - 30), sel.index).filter((m): m is NonNullable<typeof m> => m !== null);
    const ok = past.length >= 5;
    const rm = past.map((m) => m.rmssdMean);
    const mu = (f: (m: (typeof past)[number]) => number | undefined) => (ok ? mean(past.map((m) => f(m) ?? NaN)) : NaN);
    return {
      nadir: mu((m) => m.hrNadir),
      rmssd: { mean: mu((m) => m.rmssdMean), lo: ok ? mean(rm) - sd(rm) : NaN, hi: ok ? mean(rm) + sd(rm) : NaN },
      spo2: mu((m) => m.spo2Mean),
      resp: mu((m) => m.respRate),
      n: past.length,
    };
  }, [series, sel]);

  const ours = useMemo(() => {
    const pn = sel?.night.people.find((p) => p.personId === personId);
    if (!pn) return null;
    const est = hrSleepWake(pn.hr.filter((h) => h.ts >= pn.sleep.start && h.ts <= pn.sleep.end));
    let agree = 0;
    let n = 0;
    for (let t = pn.sleep.start; t < pn.sleep.end; t += MIN) {
      const g = pn.sleep.stages.find((x) => t >= x.start && t < x.end);
      const o = est.find((x) => t >= x.start && t < x.end);
      if (!g || !o) continue;
      n++;
      if ((g.stage === 'awake') === o.awake) agree++;
    }
    return { est, agreement: n ? agree / n : NaN };
  }, [sel, personId]);

  // Deep links once the full page exists: scroll to a block (and flash it) or open its drill-in.
  const jumped = useRef(false);
  const full = !!sel && !sel.partial;
  useEffect(() => {
    if (jumped.current || !full) return;
    const h = decodeURIComponent(window.location.hash.slice(1));
    if (!h) return;
    jumped.current = true;
    if (h === 'temp' || h === 'steps') {
      setOpen(h);
      return;
    }
    const t = window.setTimeout(() => {
      const el = document.getElementById(h);
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'auto' });
      el.classList.add(s.flash!);
      window.setTimeout(() => el.classList.remove(s.flash!), 1900);
    }, 120);
    return () => window.clearTimeout(t);
  }, [full]);

  if (!ds || !sel || !baseline) return <Loading text={progress || 'Reading the night…'} />;

  const pIndex = ds.people.findIndex((p) => p.id === personId);
  const person = ds.people[pIndex]!;
  const scope = pIndex === 1 ? 'p-erik' : 'p-you';
  const dash = nightMode && pIndex === 1;
  const pn = sel.night.people.find((p) => p.personId === personId);
  const m = detail?.people.find((p) => p.personId === personId) ?? sel.person[personId] ?? null;
  const n = Number(range);
  const nightLabel = `${shortDay(sel.night.date)} ${shortDate(sel.night.date)}`;

  const switcher = (
    <Segmented
      value={personId}
      onChange={setWho}
      label="Person"
      options={ds.people.map((p, i) => ({
        value: p.id,
        label: (
          <span className={s.who}>
            <i className={i === 1 ? s.hollow : undefined} style={{ ['--dot' as string]: i === 1 ? 'var(--person-b)' : 'var(--person-a)' } as CSSProperties} aria-hidden />
            {p.name}
          </span>
        ),
      }))}
    />
  );
  const header = <PageHeader title="Body" lede={`How ${person.name === 'You' ? 'your' : `${person.name}'s`} body slept on the night of ${nightLabel}, against ${person.name === 'You' ? 'your' : 'their'} own typical.`} actions={switcher} />;

  if (!pn || !m)
    return (
      <div className={scope}>
        {header}
        <Section title={`No data for ${person.name} this night`} cap="Away or not wearing the band. Pick another night, or switch person." />
      </div>
    );

  const rows = (f: (x: M) => number | undefined) => ds.nights.map((night, i) => ({ date: night.date, v: series[i] ? (f(series[i]!) ?? NaN) : NaN }));
  const spark = (f: (x: M) => number | undefined) =>
    ds.nights
      .slice(Math.max(0, sel.index - 13), sel.index + 1)
      .map((night, k) => {
        const mm = series[Math.max(0, sel.index - 13) + k];
        return { ts: Date.parse(`${night.date}T00:00:00Z`), v: mm ? (f(mm) ?? NaN) : NaN };
      })
      .filter((p) => Number.isFinite(p.v));

  const asleep = dur(m.totalSleepMin);
  const nadirAt = pn.sleep.start + m.hrNadirAtMin * MIN;
  // Where the low fell in this person's own sleep window: first, middle or last third.
  const sleepMin = Math.max(1, (pn.sleep.end - pn.sleep.start) / MIN);
  const nadirFrac = m.hrNadirAtMin / sleepMin;
  const nadirWhen = nadirFrac < 1 / 3 ? 'early in the night' : nadirFrac < 2 / 3 ? 'in the middle of the night' : 'late in the night';
  const nadirNote =
    nadirFrac < 1 / 3
      ? 'A low in the first third of the night is a well-recovered pattern.'
      : nadirFrac < 2 / 3
        ? 'A mid-night low is common. An earlier low usually means better recovery.'
        : 'A late low is often a late meal, alcohol or a warm room.';
  const stageTot = Math.max(1, m.deepMin + m.lightMin + m.remMin + m.awakeMin);
  const dips = spo2Dips(pn.spo2.filter((x) => x.ts >= pn.sleep.start && x.ts <= pn.sleep.end)).length;
  const youOr = person.name === 'You' ? 'your' : `${person.name}'s`;
  const loadingHistory = <Placeholder height={240} text={progress || 'Loading earlier nights…'} />;

  // ── Vitals ──
  const vitals = [
    { id: 'rhr', drill: 'hr' as Drill, name: 'Lowest heart rate', value: fmt(m.hrNadir), unit: 'bpm', delta: vsTypical(m.hrNadir, baseline.nadir, 0, 'bpm'), spark: spark((x) => x.hrNadir) },
    { id: 'hrv', drill: 'hrv' as Drill, name: 'Heart rate variability', value: fmt(m.rmssdMean), unit: 'ms', delta: vsTypical(m.rmssdMean, baseline.rmssd.mean, 0, 'ms'), spark: spark((x) => x.rmssdMean) },
    { id: 'spo2', drill: 'spo2' as Drill, name: 'Blood oxygen', value: fmt(m.spo2Mean, 1), unit: '%', delta: vsTypical(m.spo2Mean, baseline.spo2, 1, '%'), spark: spark((x) => x.spo2Mean) },
    { id: 'resp', drill: 'resp' as Drill, name: 'Breathing rate', value: fmt(m.respRate ?? NaN, 1), unit: '/min', delta: vsTypical(m.respRate ?? NaN, baseline.resp, 1, ''), spark: spark((x) => x.respRate) },
  ];

  // ── Trends ──
  const tdef = TRENDS[trendKey];
  const tRows = rows(tdef.get);
  const tSum = trendSummary(tRows);
  const above = Number.isFinite(tSum.hi) && tSum.last > tSum.hi;
  const below = Number.isFinite(tSum.lo) && tSum.last < tSum.lo;
  const trendTitle = !Number.isFinite(tSum.typical)
    ? `${tdef.label} over the last ${n} nights`
    : above
      ? `${tdef.label} ended above ${youOr} typical range`
      : below
        ? `${tdef.label} ended below ${youOr} typical range`
        : `${tdef.label} is inside ${youOr} typical range`;

  // ── More analysis ──
  const rhrSum = trendSummary(rows((x) => x.restingHr));
  const stepSum = trendSummary(rows((x) => x.steps));
  const respSum = trendSummary(rows((x) => x.respRate));
  const drills: { key: Drill; label: string; value: ReactNode; title: string; wide?: boolean }[] = [
    { key: 'hr', label: 'Sleeping heart rate', value: `${fmt(m.hrNadir)} bpm low at ${hm(nadirAt)}`, title: `Heart rate bottomed out at ${fmt(m.hrNadir)} bpm` },
    { key: 'hrv', label: 'HRV through the night', value: `${fmt(m.rmssdMean)} ms average`, title: 'HRV through the night' },
    { key: 'ridge', label: 'Last 14 nights', value: 'Heart-rate curves', title: 'Heart rate, the last 14 nights', wide: true },
    { key: 'spo2', label: 'Blood oxygen', value: `${fmt(m.spo2Mean, 1)}% · ${fmt(m.spo2DipsPerHour, 1)} dips an hour`, title: `Oxygen held at ${fmt(m.spo2Mean, 1)}%` },
    { key: 'resp', label: 'Breathing', value: `${fmt(m.respRate ?? NaN, 1)} a minute`, title: 'Breathing rate' },
    { key: 'rhr', label: 'Resting heart rate', value: `${fmt(m.restingHr ?? NaN)} bpm`, title: 'Resting heart rate' },
    { key: 'steps', label: 'Steps, the day before', value: fmt(m.steps ?? NaN), title: 'Steps on the day before each night' },
    { key: 'temp', label: 'Skin temperature vs room', value: Number.isFinite(m.tempDeviationC ?? NaN) ? `${signed(m.tempDeviationC!, 1)}° vs typical` : '–', title: 'Is a warm night showing up in the body?', wide: true },
    { key: 'algo', label: "Our sleep/wake vs Google's", value: ours && Number.isFinite(ours.agreement) ? `${fmt(ours.agreement * 100)}% agree` : '…', title: "Our sleep/wake vs Google's" },
  ];
  const active = drills.find((d) => d.key === open);
  const trendSheet = (rowsT: { date: string; v: number }[], label: string, unit: string, digits = 0) =>
    sel.partial ? (
      loadingHistory
    ) : (
      <>
        <Segmented value={range} onChange={setRange} options={[{ value: '7', label: '7 nights' }, { value: '30', label: '30 nights' }, { value: '90', label: '90 nights' }]} label="Range" />
        <TrendBand show={n} rows={rowsT} unit={unit} digits={digits} label={label} dash={dash} />
      </>
    );

  return (
    <div className={scope}>
      {header}

      <div key={personId} className={s.swap}>
        {/* ───────── Hero: the sleep score ───────── */}
        <section className={`${s.hero} ${s.anchor}`} id="sleep" aria-label={`${person.name}, last night`}>
          <div className={s.heroMain} id="recovery">
            <p className="label">Sleep score, {nightLabel}</p>
            <div className={`display ${s.score}`}>
              {fmt(m.sleepScore)}
              <span className="unit">/ 100</span>
            </div>
            <p className={s.heroLine}>
              <b>{asleep}</b> asleep · recovery <b>{detail ? fmt(m.recoveryScore) : '–'}</b>
            </p>
          </div>
          <div className={s.heroSide}>
            <Facts
              items={[
                { label: 'In bed', value: `${hm(pn.sleep.start)} – ${hm(pn.sleep.end)}` },
                { label: 'Efficiency', value: `${fmt(m.efficiencyPct)}%` },
                { label: 'Fell asleep in', value: `${fmt(m.latencyMin)} min` },
                { label: 'Woke up', value: `${fmt(m.awakenings)} ${m.awakenings === 1 ? 'time' : 'times'}` },
              ]}
            />
            <p className="cap" style={{ marginTop: 'var(--sp-3)' }}>
              Fitbit Air via Google Health · {baseline.n >= 5 ? `typical = the previous ${baseline.n} nights` : 'typical range still building'}
            </p>
          </div>
        </section>

        {/* ───────── 1 Last night ───────── */}
        <Section
          id="last"
          nav="Last night"
          title={`${dur(m.deepMin)} of deep sleep, ${fmt((m.deepMin / stageTot) * 100)}% of the night`}
          cap={`Sleep stages from Google Health, ${hm(pn.sleep.start)} to ${hm(pn.sleep.end)}. Point at a block for its times.`}
          actions={<IconButton icon="info" label="How these stages are measured" onClick={() => setOpen('algo')} outline />}
        >
          <div className={s.body}>
            <div className={s.main}>
              <Hypnogram stages={pn.sleep.stages} start={pn.sleep.start} end={pn.sleep.end} label={`${person.name}'s sleep stages, ${hm(pn.sleep.start)} to ${hm(pn.sleep.end)}`} />
            </div>
            <div className={s.aside}>
              <StageMix m={m} />
            </div>
          </div>
        </Section>

        {/* ───────── 2 Vitals ───────── */}
        <Section
          id="vitals"
          nav="Vitals"
          title={`Heart rate bottomed out at ${fmt(m.hrNadir)}\u00a0bpm, ${nadirWhen}`}
          cap={`${hm(nadirAt)}, ${dur(m.hrNadirAtMin)} after falling asleep. Each vital against ${youOr} typical; open one for the night's curve.`}
        >
          <div className={s.body}>
            <ul className={s.vitals}>
              {vitals.map((v) => (
                <li key={v.id} id={v.id} className={`${s.vital} ${s.anchor}`}>
                  <button type="button" className={s.vitalBtn} onClick={() => setOpen(v.drill)}>
                    <span className={s.vitalT}>
                      <span className={s.vitalName}>{v.name}</span>
                      {v.delta}
                    </span>
                    <span className={s.spark} aria-hidden>
                      {v.spark.length > 1 && <Sparkline values={v.spark} color="var(--person)" lineColor="var(--muted)" height={32} />}
                    </span>
                    <span className={s.vitalV}>
                      {v.value}
                      <span className="unit">{v.unit}</span>
                    </span>
                    <Icon name="chevron-right" size={18} />
                  </button>
                </li>
              ))}
            </ul>
            <div className={s.aside}>
              <p className={s.note}>Typical is {youOr} own average over the previous 30 nights. Arrows show direction only: a lower or higher number is not good or bad by itself. The small line is the last 14 nights.</p>
              <p className={s.note}>{nadirNote}</p>
            </div>
          </div>
        </Section>

        {/* ───────── 3 Recovery trends ───────── */}
        <Section
          id="trends"
          nav="Recovery trends"
          title={trendTitle}
          cap={`Last ${n} nights. The band is the previous 30 nights ±1 SD; the dot is the latest night.`}
          actions={<Segmented value={range} onChange={setRange} options={[{ value: '7', label: '7 nights' }, { value: '30', label: '30 nights' }, { value: '90', label: '90 nights' }]} label="Range" />}
        >
          <div className={s.body}>
            <div className={s.main}>{sel.partial ? loadingHistory : <TrendBand key={trendKey} show={n} rows={tRows} unit={tdef.unit} digits={tdef.digits} label={tdef.label} dash={dash} height={260} />}</div>
            <div className={s.aside}>
              <ul className={s.pick} role="radiogroup" aria-label="Trend">
                {(Object.keys(TRENDS) as TrendKey[]).map((k) => {
                  const d = TRENDS[k];
                  const sum = trendSummary(rows(d.get));
                  return (
                    <li key={k}>
                      <button type="button" role="radio" aria-checked={k === trendKey} className={s.pickBtn} onClick={() => setTrendKey(k)}>
                        <span className={s.pickName}>{d.label}</span>
                        <span className={s.pickV}>
                          <span>
                            {fmt(sum.last, d.digits)} <span className="unit sm">{d.unit}</span>
                          </span>
                          <small>typical {fmt(sum.typical, d.digits)}</small>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </Section>

        <div className={s.more}>
          <MoreAnalysis items={drills.map((d) => ({ label: d.label, value: d.value, onClick: () => setOpen(d.key) }))} />
        </div>
      </div>
      <OnThisPage />

      <Sheet open={open !== null} onClose={() => setOpen(null)} title={active?.title} wide={active?.wide}>
        <div className={`${s.sheetBody} ${scope}`}>
          {open === 'hr' && (
            <>
              <p className={s.sheetLede}>
                Lowest at <b>{hm(nadirAt)}</b>, {dur(m.hrNadirAtMin)} after falling asleep.{' '}
                {Number.isFinite(baseline.nadir) ? <>{person.name === 'You' ? 'Your' : `${person.name}'s`} typical low is {fmt(baseline.nadir)} bpm.</> : null}
              </p>
              <HrCurve hr={pn.hr} start={pn.sleep.start} end={pn.sleep.end} nadir={m.hrNadir} nadirAt={nadirAt} baseline={baseline.nadir} dash={dash} />
              <p className={s.note}>5-minute median heart rate. Dashed is the typical low. {nadirNote}</p>
            </>
          )}
          {open === 'hrv' && (
            <>
              <p className={s.sheetLede}>
                Average <b>{fmt(m.rmssdMean)} ms</b>
                {Number.isFinite(baseline.rmssd.mean) ? <> against a typical {fmt(baseline.rmssd.mean)} ms over {baseline.n} nights.</> : '.'}
              </p>
              <HrvNight hrv={pn.hrv} start={pn.sleep.start} end={pn.sleep.end} band={baseline.rmssd} dash={dash} />
              <p className={s.note}>RMSSD in 5-minute windows. The band is the typical range, ±1 SD.</p>
            </>
          )}
          {open === 'ridge' &&
            (sel.index >= 6 ? (
              <>
                <p className={s.sheetLede}>Each line is one night&rsquo;s heart rate from falling asleep. Tap a night to open it.</p>
                <Ridgeline nights={ds.nights.slice(Math.max(0, sel.index - 13), sel.index + 1)} personId={personId} selected={sel.night.date} onPick={(d) => { setDate(d); setOpen(null); }} dash={dash} />
              </>
            ) : (
              loadingHistory
            ))}
          {open === 'spo2' && (
            <>
              <p className={s.sheetLede}>
                Blood oxygen averaged <b>{fmt(m.spo2Mean, 1)}%</b>, with <b>{dips}</b> {dips === 1 ? 'dip' : 'dips'} of 3% or more ({fmt(m.spo2DipsPerHour, 1)} an hour).
              </p>
              <Spo2Strip spo2={pn.spo2} start={pn.sleep.start} end={pn.sleep.end} dash={dash} />
              <Facts
                items={[
                  { label: 'Average', value: `${fmt(m.spo2Mean, 1)}%`, sub: Number.isFinite(baseline.spo2) ? `typical ${fmt(baseline.spo2, 1)}` : undefined },
                  { label: 'Dips an hour', value: fmt(m.spo2DipsPerHour, 1), sub: 'ODI-style' },
                  { label: 'Breathing', value: `${fmt(m.respRate ?? NaN, 1)} a minute`, sub: Number.isFinite(baseline.resp) ? `typical ${fmt(baseline.resp, 1)}` : undefined },
                ]}
              />
              <p className={s.note}>Lowest reading per 2 minutes; marked dots are dips. Not a medical test: more than about 5 dips an hour on many nights is worth mentioning to a doctor.</p>
            </>
          )}
          {open === 'resp' && (
            <>
              <p className={s.sheetLede}>
                <b>{fmt(m.respRate ?? NaN, 1)} breaths a minute</b> last night{Number.isFinite(respSum.typical) ? `, typical ${fmt(respSum.typical, 1)}` : ''}.
              </p>
              {trendSheet(rows((x) => x.respRate), 'Breathing', '/min', 1)}
              <p className={s.note}>A whole-night average. Rates per sleep stage arrive once the respiratory-rate parser lands.</p>
            </>
          )}
          {open === 'rhr' && (
            <>
              <p className={s.sheetLede}>
                <b>{fmt(m.restingHr ?? NaN)} bpm</b> resting{Number.isFinite(rhrSum.typical) ? `, typical ${fmt(rhrSum.typical)}` : ''}. Daily resting heart rate from Google Health.
              </p>
              {trendSheet(rows((x) => x.restingHr), 'Resting HR', 'bpm')}
            </>
          )}
          {open === 'steps' && (
            <>
              <p className={s.sheetLede}>
                <b>{fmt(m.steps ?? NaN)} steps</b> the day before{Number.isFinite(stepSum.typical) ? `, typical ${fmt(stepSum.typical)}` : ''}.
              </p>
              {trendSheet(rows((x) => x.steps), 'Steps', '')}
            </>
          )}
          {open === 'temp' &&
            (sel.partial ? (
              loadingHistory
            ) : (
              <>
                <p className={s.sheetLede}>Skin temperature against {youOr} typical, night by night, above the room&rsquo;s average for the same nights.</p>
                <TempDeviation
                  rows={ds.nights.slice(-n).map((night, i) => {
                    const idx = ds.nights.length - n + i;
                    return { date: night.date, dev: series[idx]?.tempDeviationC ?? null, room: ds.room[idx]!.tempMean };
                  })}
                />
                <Segmented value={range} onChange={setRange} options={[{ value: '7', label: '7 nights' }, { value: '30', label: '30 nights' }, { value: '90', label: '90 nights' }]} label="Range" />
              </>
            ))}
          {open === 'algo' && (
            <>
              <p className={s.sheetLede}>
                A simple heart-rate rule we control, checked minute by minute against Google&rsquo;s stages.{' '}
                {ours && Number.isFinite(ours.agreement) ? (
                  <>
                    <b>{fmt(ours.agreement * 100)}%</b> of minutes agree on awake versus asleep.
                  </>
                ) : null}
              </p>
              {ours ? <SleepWakeCompare stages={pn.sleep.stages} ours={ours.est} start={pn.sleep.start} end={pn.sleep.end} /> : <Placeholder height={128} />}
              <p className={s.note}>Marked stretches on the bottom row are where the two disagree. If agreement suddenly shifts across many nights, Google has likely changed its algorithm.</p>
            </>
          )}
        </div>
      </Sheet>
    </div>
  );
}
