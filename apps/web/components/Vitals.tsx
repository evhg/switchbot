'use client';
// Today → Vitals: one card per person with last night's daily values vs that person's own 30-night baseline.
import Link from 'next/link';
import { baselineBand, type Person, type PersonNightMetrics } from '@sleep-lab/core';
import { personColor } from '@/lib/data/context.tsx';
import type { Dataset } from '@/lib/data/types.ts';
import { addDays, dur, fmt, shortDate, shortDay } from '@/lib/format.ts';
import { writePref } from '@/lib/prefs.ts';
import { VitalSpark } from './charts/VitalSpark.tsx';
import { Card, TableView } from './ui.tsx';

const BASELINE_NIGHTS = 30;
const MIN_BASELINE = 7;
const SPARK_NIGHTS = 14;

/**
 * Which direction is good: 'up' (HRV, sleep), 'down' (resting HR), 'up-soft' (steps: more is good, fewer is just
 * a quieter day) and 'rise-bad' (breathing rate, skin temperature: a clear rise is the warning sign, a dip is not).
 */
type Better = 'up' | 'down' | 'up-soft' | 'rise-bad';
type Tone = 'good' | 'bad' | 'neutral';

interface MetricDef {
  key: string;
  label: string;
  /** Short context after the label, e.g. which day the steps are from. */
  context?: (date: string) => string;
  /** Column header in the table view, when the label alone would be ambiguous. */
  column?: string;
  unit: string;
  get: (m: PersonNightMetrics) => number | undefined;
  better: Better;
  /** Formats a value (no unit). */
  value: (v: number) => string;
  /** Formats a signed difference (no unit). */
  delta: (d: number) => string;
  /** Smallest SD used for z-scores, so a very steady baseline doesn't turn noise into a red arrow. */
  sdFloor: number;
  /** Secondary line under the label. */
  sub?: (m: PersonNightMetrics) => string | null;
}

const sign = (d: number) => (d > 0 ? '+' : d < 0 ? '−' : '±');
const signedFixed = (digits: number) => (d: number) => `${sign(d)}${fmt(Math.abs(d), digits)}`;
const compact = (v: number) => (Math.abs(v) >= 10_000 ? `${fmt(v / 1000, 1)}k` : fmt(v));
const durDelta = (d: number) => `${sign(Math.round(d))}${dur(Math.abs(d))}`;

const METRICS: MetricDef[] = [
  {
    key: 'steps',
    label: 'Steps',
    context: (date) => shortDay(addDays(date, -1)),
    column: 'Steps (day before)',
    unit: '',
    get: (m) => m.steps,
    better: 'up-soft',
    value: (v) => fmt(v),
    delta: (d) => `${sign(d)}${compact(Math.abs(Math.round(d / 10) * 10))}`,
    sdFloor: 600,
  },
  {
    key: 'hrv',
    label: 'HRV',
    unit: 'ms',
    get: (m) => m.rmssdMean,
    better: 'up',
    value: (v) => fmt(v),
    delta: signedFixed(0),
    sdFloor: 2,
    sub: (m) => (Number.isFinite(m.deepRmssd ?? NaN) ? `deep sleep ${fmt(m.deepRmssd)} ms` : null),
  },
  {
    key: 'rhr',
    label: 'Resting HR',
    unit: 'bpm',
    get: (m) => m.restingHr,
    better: 'down',
    value: (v) => fmt(v),
    delta: signedFixed(0),
    sdFloor: 1,
    sub: (m) => (Number.isFinite(m.hrNadir) ? `sleeping low ${fmt(m.hrNadir)} bpm` : null),
  },
  {
    key: 'sleep',
    label: 'Sleep',
    unit: '',
    get: (m) => m.totalSleepMin,
    better: 'up',
    value: (v) => dur(v),
    delta: durDelta,
    sdFloor: 15,
    sub: (m) => `deep ${dur(m.deepMin)} · REM ${dur(m.remMin)} · ${fmt(m.efficiencyPct)}% eff.`,
  },
  {
    key: 'spo2',
    label: 'SpO₂',
    unit: '%',
    get: (m) => m.spo2Mean,
    better: 'up',
    value: (v) => fmt(v, 1),
    delta: signedFixed(1),
    sdFloor: 0.3,
    sub: (m) => (Number.isFinite(m.spo2Mean) ? `${fmt(m.spo2DipsPerHour, 1)} dips/h` : null),
  },
  {
    key: 'resp',
    label: 'Breathing',
    unit: '/min',
    get: (m) => m.respRate,
    better: 'rise-bad',
    value: (v) => fmt(v, 1),
    delta: signedFixed(1),
    sdFloor: 0.3,
  },
  {
    key: 'temp',
    label: 'Skin temp',
    unit: '°C',
    get: (m) => m.tempDeviationC,
    better: 'rise-bad',
    value: (v) => `${sign(Math.round(v * 100))}${fmt(Math.abs(v), 2)}`,
    delta: signedFixed(2),
    sdFloor: 0.1,
    sub: () => 'deviation from Google’s 30-day baseline',
  },
];

function tone(better: Better, z: number): Tone {
  if (!Number.isFinite(z)) return 'neutral';
  switch (better) {
    case 'up':
      return z >= 0.5 ? 'good' : z <= -0.5 ? 'bad' : 'neutral';
    case 'down':
      return z <= -0.5 ? 'good' : z >= 0.5 ? 'bad' : 'neutral';
    case 'up-soft':
      return z >= 0.5 ? 'good' : 'neutral';
    case 'rise-bad':
      return z >= 1 ? 'bad' : 'neutral';
  }
}

const TONE_WORD: Record<Tone, string> = { good: 'better than usual', bad: 'worse than usual', neutral: 'about usual' };

function Arrow({ dir }: { dir: -1 | 0 | 1 }) {
  if (dir === 0) return <span aria-hidden>·</span>;
  return (
    <svg width={8} height={9} viewBox="0 0 8 9" aria-hidden style={{ flex: 'none' }}>
      <path d={dir > 0 ? 'M4 0.5 L7.5 5 H5.2 V8.5 H2.8 V5 H0.5 Z' : 'M4 8.5 L7.5 4 H5.2 V0.5 H2.8 V4 H0.5 Z'} fill="currentColor" />
    </svg>
  );
}

interface Row {
  def: MetricDef;
  v: number;
  base: { mean: number; sd: number; lo: number; hi: number; n: number } | null;
  spark: { date: string; v: number }[];
}

function rowsFor(dataset: Dataset, personId: string, index: number): Row[] {
  const series = dataset.person[personId] ?? [];
  const nights = dataset.nights;
  return METRICS.map((def) => {
    const at = (i: number) => {
      const m = series[i];
      const x = m ? def.get(m) : undefined;
      return x === undefined ? NaN : x;
    };
    const past: number[] = [];
    for (let i = Math.max(0, index - BASELINE_NIGHTS); i < index; i++) past.push(at(i));
    const finite = past.filter(Number.isFinite);
    const band = finite.length >= MIN_BASELINE ? baselineBand(finite) : null;
    const spark: { date: string; v: number }[] = [];
    for (let i = Math.max(0, index - SPARK_NIGHTS + 1); i <= index; i++) spark.push({ date: nights[i]!.date, v: at(i) });
    return { def, v: at(index), base: band ? { ...band, n: finite.length } : null, spark };
  });
}

function MetricRow({ row, m, date, color }: { row: Row; m: PersonNightMetrics; date: string; color: string }) {
  const { def, v, base } = row;
  const unit = def.unit ? <span className="vital-unit">{def.unit}</span> : null;
  const d = base && Number.isFinite(v) ? v - base.mean : NaN;
  const z = Number.isFinite(d) ? d / Math.max(base!.sd || 0, def.sdFloor) : NaN;
  const t = tone(def.better, z);
  const shown = Number.isFinite(d) ? def.delta(d) : '';
  const dir: -1 | 0 | 1 = !Number.isFinite(d) || /^±/.test(shown) ? 0 : d > 0 ? 1 : -1;
  const sub = def.sub?.(m) ?? null;
  const ctx = def.context?.(date);
  return (
    <li className="vital-row">
      <div className="vital-head">
        <span className="vital-label">
          {def.label}
          {ctx && <span className="muted"> · {ctx}</span>}
        </span>
        {sub && <span className="vital-sub">{sub}</span>}
      </div>
      <div className="vital-body">
        <span className="vital-value">
          {Number.isFinite(v) ? def.value(v) : '–'}
          {Number.isFinite(v) && unit}
        </span>
        <VitalSpark
          points={row.spark}
          band={base}
          color={color}
          label={def.label}
          format={(x, dt) => `${shortDay(dt)} ${shortDate(dt)} · ${def.value(x)}${def.unit ? ` ${def.unit}` : ''}`}
        />
        <span className={`vital-delta ${t}`} title={base ? `${base.n}-night baseline ${def.value(base.mean)}${def.unit ? ` ${def.unit}` : ''}` : undefined}>
          {Number.isFinite(d) ? (
            <>
              <span className="vital-delta-main" aria-label={`${shown} ${def.unit} vs baseline, ${TONE_WORD[t]}`}>
                <Arrow dir={dir} />
                {shown.replace(/^[+−±]/, '')}
              </span>
              <span className="vital-base">vs {def.value(base!.mean)}</span>
            </>
          ) : (
            <span className="vital-base">{Number.isFinite(v) ? 'baseline…' : 'no data'}</span>
          )}
        </span>
      </div>
    </li>
  );
}

function PersonVitals({ dataset, person, index, away }: { dataset: Dataset; person: Person; index: number; away: boolean }) {
  const night = dataset.nights[index]!;
  const m = away ? null : (dataset.person[person.id]?.[index] ?? null);
  const color = personColor(dataset.people, person.id);
  const openBody = () => writePref('bodyPerson', person.id);
  const title = (
    <span className="row" style={{ gap: 7, flexWrap: 'nowrap' }}>
      <i className="key-dot" style={{ background: color, width: 10, height: 10 }} aria-hidden />
      {person.name}
    </span>
  );
  if (!m) {
    // Last night before this one with this person's data, so an away card says how stale the picture is.
    let last = -1;
    for (let i = index - 1; i >= 0 && last < 0; i--) if (dataset.person[person.id]?.[i]) last = i;
    const lastDate = last >= 0 ? dataset.nights[last]!.date : null;
    return (
      <Card title={title} sub={away ? 'Away this night' : 'No body data this night'}>
        <p className="small muted">
          {away ? 'Not home, so no vitals for this night.' : 'The tracker didn’t sync for this night.'}
          {lastDate && ` Last data: ${shortDay(lastDate)} ${shortDate(lastDate)}.`}
        </p>
      </Card>
    );
  }
  const rows = rowsFor(dataset, person.id, index);
  const n = rows.find((r) => r.base)?.base?.n ?? 0;
  const tableNights = rows[0]!.spark.map((s) => s.date);
  return (
    <Card
      title={title}
      sub={n ? `Last night vs own ${n}-night baseline` : 'Last night · baseline builds over 7 nights'}
      meta={
        <Link href="/body" onClick={openBody} aria-label={`Open Body for ${person.name}`}>
          Body →
        </Link>
      }
    >
      <ul className="vital-list">
        {rows.map((r) => (
          <MetricRow key={r.def.key} row={r} m={m} date={night.date} color={color} />
        ))}
      </ul>
      <div className="vital-foot">
        <span className="small muted">
          <i className="vital-key-band" aria-hidden /> usual range (±1 SD) · 14 nights
        </span>
        <TableView
          caption={`${person.name}: vitals, last ${tableNights.length} nights`}
          columns={['Night', ...rows.map((r) => r.def.column ?? (r.def.unit ? `${r.def.label} (${r.def.unit})` : r.def.label))]}
          rows={tableNights
            .map((date, i) => [shortDate(date), ...rows.map((r) => (Number.isFinite(r.spark[i]!.v) ? r.def.value(r.spark[i]!.v) : '–'))])
            .reverse()}
        />
      </div>
    </Card>
  );
}

/** One card per person, always (an away card when they weren't home); side by side on wide screens, stacked on phones. */
export function VitalsSection({ dataset, index }: { dataset: Dataset; index: number }) {
  const night = dataset.nights[index];
  if (!night) return null;
  return (
    <>
      <h2 className="section-label span-2" id="vitals">
        Vitals
      </h2>
      {dataset.people.map((p) => (
        <PersonVitals key={p.id} dataset={dataset} person={p} index={index} away={!night.people.some((x) => x.personId === p.id)} />
      ))}
    </>
  );
}
