'use client';
/**
 * Body tab (docs/DESIGN.md §11 "Body"): a per-person deep dive. A large person switcher sets the page accent to that
 * person's colour; the "Last night" hero (score ring, time asleep, hypnogram wipe, stage mix, four vitals) is followed
 * by Heart, Breathing & O₂, Trends and Algorithm sections under a sticky jump bar. Renders from the newest-night
 * preview; anything that needs history shows a skeleton until enough nights have streamed in.
 * Deep links from Today's vitals (/body#hrv, #rhr, #steps, #sleep, #spo2, #resp, #temp) scroll to the matching block.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { personColor, useData, useNightDetail, useSelectedNight } from '@/lib/data/context.tsx';
import { hrSleepWake } from '@/lib/analysis.ts';
import { dur, fmt, hm, MIN, signed } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';
import { mean, sd } from '@/lib/stats.ts';
import { HrCurve, HrvNight, Hypnogram, Ridgeline, SleepWakeCompare, Spo2Strip, StageMix, TempDeviation, TrendBand } from '../charts/body.tsx';
import s from '../charts/body.module.css';
import { ScoreRing } from '../charts/ScoreRing.tsx';
import { DateNav } from '../DateNav.tsx';
import { CountUp, useMotionPrefs } from '../motion.tsx';
import { Card, JumpBar, Loading, MetricTile, Placeholder, SectionHeader, Segmented, type Tone } from '../ui.tsx';

type Range = '7' | '30' | '90';

const JUMP = [
  { id: 'last', label: 'Night' },
  { id: 'heart', label: 'Heart' },
  { id: 'breath', label: 'O₂' },
  { id: 'trends', label: 'Trends' },
  { id: 'algo', label: 'Algo' },
] as const;

function Section({ id, n, kicker, lines, lede, children }: { id: string; n: number; kicker: string; lines: ReactNode[]; lede?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} data-jump className={s.section} aria-label={kicker}>
      <div className={s.sectionHead}>
        <SectionHeader n={n} kicker={kicker} lines={lines} size="h2" />
        {lede && <p className={s.sectionLede}>{lede}</p>}
      </div>
      <div className="stack two">{children}</div>
    </section>
  );
}

function Stat({ label, value, unit, sub, id }: { label: ReactNode; value: ReactNode; unit?: string; sub?: ReactNode; id?: string }) {
  return (
    <div className={`${s.stat} ${id ? s.anchor : ''}`} id={id}>
      <span className={`${s.statLabel} t-micro`}>{label}</span>
      <span className={s.statValue}>
        {value}
        {unit && <span className="t-unit">{unit}</span>}
      </span>
      {sub && <span className={s.statSub}>{sub}</span>}
    </div>
  );
}

/** Signed delta vs baseline → chip props. `better` = which direction is good. */
function deltaOf(v: number, base: number, better: 'up' | 'down' | null, digits = 0, unit = ''): { text: string; tone: Tone; dir: 'up' | 'down' | 'flat' } | undefined {
  const d = v - base;
  if (!Number.isFinite(d)) return undefined;
  const text = signed(d, digits);
  const flat = /^±/.test(text);
  return {
    text: `${text.replace(/^[+−±]/, '')}${unit} vs base`,
    tone: flat || !better ? 'neutral' : (d > 0) === (better === 'up') ? 'good' : 'bad',
    dir: flat ? 'flat' : d > 0 ? 'up' : 'down',
  };
}

export function BodyScreen() {
  const { latest, progress, date, setDate } = useData();
  const sel = useSelectedNight();
  const { detail } = useNightDetail(date);
  const { night: nightMode } = useMotionPrefs();
  const [who, setWho] = usePref<string>('bodyPerson', 'a');
  const [range, setRange] = useState<Range>('30');

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
      sleep: mu((m) => m.totalSleepMin),
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

  // Deep links (#hrv, #rhr …) once the full page exists: scroll there and flash the block.
  const jumped = useRef(false);
  const full = !!sel && !sel.partial;
  useEffect(() => {
    if (jumped.current || !full) return;
    const h = decodeURIComponent(window.location.hash.slice(1));
    if (!h) return;
    jumped.current = true;
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
  const color = personColor(ds.people, personId);
  const dash = nightMode && pIndex === 1;
  const pn = sel.night.people.find((p) => p.personId === personId);
  const m = detail?.people.find((p) => p.personId === personId) ?? sel.person[personId] ?? null;
  const n = Number(range);
  const enoughForRidge = sel.index >= 6;
  const hasBaseline = baseline.n >= 5;

  const rows = (f: (x: NonNullable<(typeof series)[number]>) => number | undefined) => ds.nights.map((night, i) => ({ date: night.date, v: series[i] ? (f(series[i]!) ?? NaN) : NaN }));
  const spark = (f: (x: NonNullable<(typeof series)[number]>) => number | undefined) =>
    ds.nights
      .slice(Math.max(0, sel.index - 13), sel.index + 1)
      .map((night, k) => {
        const mm = series[Math.max(0, sel.index - 13) + k];
        return { ts: Date.parse(`${night.date}T00:00:00Z`), v: mm ? (f(mm) ?? NaN) : NaN };
      })
      .filter((p) => Number.isFinite(p.v));
  const trendRows = ds.nights.slice(-n).map((night, i) => {
    const idx = ds.nights.length - n + i;
    return { night, m: series[idx] ?? null, room: ds.room[idx]! };
  });

  const pageStyle = { ['--ch-accent' as string]: color, ['--accent' as string]: color } as CSSProperties;

  const switcher = (
    <div className={s.switchRow}>
      <Segmented
        size="lg"
        className={s.switcher}
        value={personId}
        onChange={setWho}
        label="Person"
        options={ds.people.map((p) => {
          const pm = sel.person[p.id];
          return {
            value: p.id,
            label: (
              <span className={s.who}>
                <i className={s.whoDot} style={{ ['--dot' as string]: personColor(ds.people, p.id) } as CSSProperties} aria-hidden />
                <span className={s.whoName}>{p.name}</span>
                {pm && <span className={s.whoScore}>{fmt(pm.sleepScore)}</span>}
              </span>
            ),
          };
        })}
      />
      <div className={`${s.source} t-micro`}>
        <span>Fitbit Air · Google Health</span>
        <span>{baseline.n >= 5 ? `${baseline.n}-night baseline` : 'Baseline loading'}</span>
      </div>
    </div>
  );

  if (!pn || !m)
    return (
      <div className={s.page} style={pageStyle}>
        <DateNav title="Body" kicker="Per person" />
        {switcher}
        <Card title={`No data for ${person.name} this night`} kicker="Away">
          <p className="card-sub">Pick another night, or switch person.</p>
        </Card>
      </div>
    );

  const nadirLate = m.hrNadirAtMin > 300;
  const asleepH = Math.floor(m.totalSleepMin / 60);
  const asleepM = Math.round(m.totalSleepMin - asleepH * 60);
  const nadirAt = pn.sleep.start + m.hrNadirAtMin * MIN;

  return (
    <div className={s.page} style={pageStyle}>
      <DateNav title="Body" kicker="Per person" />
      {switcher}
      <JumpBar key={`jb-${personId}`} items={JUMP} label="Body sections" />

      <div key={personId} className={s.swap}>
        {/* ───────── Last night (hero) ───────── */}
        <section id="last" data-jump aria-label="Last night">
          <div id="sleep" className={`${s.hero} ${s.anchor}`}>
            <div className={`${s.heroKicker} t-label`}>
              <span>Last night · {person.name}</span>
              <span>
                {hm(pn.sleep.start)} → {hm(pn.sleep.end)}
              </span>
            </div>
            <div className={s.heroTop}>
              <div className={s.heroRing}>
                <ScoreRing size={124} value={m.sleepScore} inner={detail ? m.recoveryScore : undefined} color={color} label={`${person.name} sleep score`} centerSub="Sleep" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div className={`${s.heroLabel} t-label`}>Asleep</div>
                <div className={s.heroNum} aria-label={dur(m.totalSleepMin)}>
                  <CountUp value={asleepH} duration={1100} />
                  <span className="t-unit">h</span>
                  <CountUp value={asleepM} duration={1300} format={(v) => String(Math.round(v)).padStart(2, '0')} />
                  <span className="t-unit">m</span>
                </div>
                <div className={`${s.heroFacts} t-small`}>
                  <span>
                    <b>{detail ? fmt(m.recoveryScore) : '–'}</b> recovery
                  </span>
                  <span>
                    <b>{fmt(m.efficiencyPct)}%</b> efficient
                  </span>
                  <span>
                    <b>{fmt(m.latencyMin)}</b> min to sleep
                  </span>
                  <span>
                    <b>{fmt(m.awakenings)}</b> wakes
                  </span>
                </div>
              </div>
            </div>
            <div className={s.heroChart}>
              <Hypnogram stages={pn.sleep.stages} start={pn.sleep.start} end={pn.sleep.end} label={`${person.name}'s sleep stages, ${hm(pn.sleep.start)} to ${hm(pn.sleep.end)}`} />
            </div>
            <div className={s.heroMix}>
              <StageMix m={m} />
            </div>
            <div className={s.heroTiles}>
              <MetricTile
                icon="heart"
                label="HR nadir"
                value={m.hrNadir}
                unit="bpm"
                delta={deltaOf(m.hrNadir, baseline.nadir, 'down')}
                sub={!hasBaseline ? `at +${dur(m.hrNadirAtMin)}` : undefined}
                spark={spark((x) => x.hrNadir)}
                sparkColor={color}
              />
              <MetricTile icon="pulse" label="HRV" value={m.rmssdMean} unit="ms" delta={deltaOf(m.rmssdMean, baseline.rmssd.mean, 'up')} spark={spark((x) => x.rmssdMean)} sparkColor={color} />
              <MetricTile icon="o2" label="SpO₂" value={m.spo2Mean} dp={1} unit="%" delta={deltaOf(m.spo2Mean, baseline.spo2, 'up', 1)} spark={spark((x) => x.spo2Mean)} sparkColor={color} />
              <MetricTile icon="lungs" label="Breathing" value={m.respRate ?? NaN} dp={1} unit="/ min" delta={deltaOf(m.respRate ?? NaN, baseline.resp, null, 1)} spark={spark((x) => x.respRate)} sparkColor={color} />
            </div>
          </div>
        </section>

        {/* ───────── Heart ───────── */}
        <Section
          id="heart"
          n={1}
          kicker="Heart"
          lines={[`Bottomed out at ${fmt(m.hrNadir)} bpm.`, nadirLate ? 'Late in the night.' : 'Early: well recovered.']}
          lede={hasBaseline ? `${hm(nadirAt)}, ${dur(m.hrNadirAtMin)} after falling asleep. Your 30-night nadir is ${fmt(baseline.nadir)} bpm.` : `${hm(nadirAt)}, ${dur(m.hrNadirAtMin)} after falling asleep.`}
        >
          <Card kicker="Tonight's curve" title="Sleeping heart rate" sub={nadirLate ? 'Late nadir: often a late meal, alcohol or a warm room' : 'Nadir in the first half: a well-recovered pattern'}>
            <HrCurve hr={pn.hr} start={pn.sleep.start} end={pn.sleep.end} nadir={m.hrNadir} nadirAt={nadirAt} baseline={baseline.nadir} color={color} dash={dash} />
          </Card>

          <Card id="hrv" className={s.anchor} kicker="Recovery signal" title="HRV through the night" sub={hasBaseline ? `Mean ${fmt(m.rmssdMean)} ms vs ${baseline.n}-night baseline ${fmt(baseline.rmssd.mean)} ms` : `Mean ${fmt(m.rmssdMean)} ms`}>
            <HrvNight hrv={pn.hrv} start={pn.sleep.start} end={pn.sleep.end} band={baseline.rmssd} color={color} dash={dash} />
          </Card>

          <Card kicker="Two weeks" className="span-2" title="Last 14 nights" sub="HR curves from sleep start; dot = nadir. Tap a ridge to open that night">
            {enoughForRidge ? (
              <Ridgeline nights={ds.nights.slice(Math.max(0, sel.index - 13), sel.index + 1)} personId={personId} color={color} selected={sel.night.date} onPick={setDate} dash={dash} />
            ) : (
              <Placeholder height={290} text="Loading earlier nights…" />
            )}
          </Card>
        </Section>

        {/* ───────── Breathing & O₂ ───────── */}
        <Section
          id="breath"
          n={2}
          kicker="Breathing & O₂"
          lines={[`Oxygen held at ${fmt(m.spo2Mean, 1)}%.`, `${fmt(m.spo2DipsPerHour, 1)} dips an hour.`]}
          lede="Blood oxygen from the wrist sensor, with dips of 3 % or more below the rolling baseline."
        >
          <Card id="spo2" className={`span-2 ${s.anchor}`} kicker="SpO₂" title="Blood oxygen" sub="Lowest reading per 2 minutes; red dots mark the dips">
            <Spo2Strip spo2={pn.spo2} start={pn.sleep.start} end={pn.sleep.end} color={color} dash={dash} />
            <div className={s.stats}>
              <Stat label="Mean SpO₂" value={fmt(m.spo2Mean, 1)} unit="%" />
              <Stat label="Dips / hour" value={fmt(m.spo2DipsPerHour, 1)} sub="ODI-style" />
              <Stat id="resp" label="Breathing" value={fmt(m.respRate ?? NaN, 1)} unit="/min" sub={Number.isFinite(baseline.resp) ? `base ${fmt(baseline.resp, 1)}` : undefined} />
            </div>
            <p className={s.note}>Not a medical test. Above ~5 dips/hour on many nights is worth mentioning to a doctor.</p>
          </Card>
        </Section>

        {/* ───────── Trends ───────── */}
        <Section id="trends" n={3} kicker="Trends" lines={[`${n} nights,`, 'against your own baseline.']} lede="Grey band = the previous 30 nights ±1 SD. The chip compares last night with that baseline.">
          <Card
            kicker="Recovery"
            title="Recovery trends"
            meta={<Segmented value={range} onChange={setRange} options={[{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }]} label="Range" />}
            className="span-2"
          >
            {sel.partial ? (
              <Placeholder height={620} text="Loading history…" />
            ) : (
              <div className={s.trends}>
                <TrendBand show={n} label="HR nadir" icon="heart" unit="bpm" better="down" color={color} dash={dash} rows={rows((x) => x.hrNadir)} />
                <TrendBand show={n} label="HRV (RMSSD)" icon="pulse" unit="ms" better="up" color={color} dash={dash} rows={rows((x) => x.rmssdMean)} />
                <TrendBand show={n} label="Deep sleep" icon="zzz" unit="min" better="up" color={color} dash={dash} rows={rows((x) => x.deepMin)} />
                <TrendBand show={n} label="Breathing rate" icon="lungs" unit="/min" digits={1} color={color} dash={dash} rows={rows((x) => x.respRate)} />
                <TrendBand id="rhr" className={s.anchor} show={n} label="Resting HR" icon="heart" unit="bpm" better="down" color={color} dash={dash} rows={rows((x) => x.restingHr)} />
                <TrendBand id="steps" className={s.anchor} show={n} label="Steps (day before)" icon="footprints" unit="" color={color} dash={dash} rows={rows((x) => x.steps)} />
              </div>
            )}
            <p className={s.note}>Breathing rate is a whole-night average; per-stage rates arrive once the respiratory-rate parser lands.</p>
          </Card>

          <Card id="temp" className={`span-2 ${s.anchor}`} kicker="Thermal" title="Skin temperature vs room" sub="Is a warm night showing up in the body?">
            {sel.partial ? <Placeholder height={290} text="Loading history…" /> : <TempDeviation rows={trendRows.map((r) => ({ date: r.night.date, dev: r.m?.tempDeviationC ?? null, room: r.room.tempMean }))} />}
          </Card>
        </Section>

        {/* ───────── Algorithm ───────── */}
        <Section
          id="algo"
          n={4}
          kicker="Algorithm"
          lines={['Our read vs Google’s.', ours && Number.isFinite(ours.agreement) ? `${fmt(ours.agreement * 100)}% agree.` : 'Comparing…']}
          lede="A simple heart-rate rule we control, checked minute by minute against Google's stages."
        >
          <Card kicker="Sleep / wake" title="Our sleep/wake vs Google's" sub={ours ? `${fmt(ours.agreement * 100)}% of minutes agree on awake vs asleep` : ''} className="span-2">
            {ours ? <SleepWakeCompare stages={pn.sleep.stages} ours={ours.est} start={pn.sleep.start} end={pn.sleep.end} /> : <Placeholder height={96} />}
            <p className={s.note}>When agreement suddenly shifts across many nights, Google has likely changed its algorithm.</p>
          </Card>
        </Section>
      </div>
    </div>
  );
}
