'use client';
// Today → 05 · Your bodies: last night's daily vitals for everyone, side by side, each vs that person's own 30-night
// baseline (docs/DESIGN.md §10.05). Rows reveal with a stagger, values count up, sparklines draw in. Every cell
// opens the Body tab for that person at that metric; a per-person table keeps every value reachable.
import Link from 'next/link';
import { useState } from 'react';
import { baselineBand, type Person, type PersonNightMetrics } from '@sleep-lab/core';
import { personColor } from '@/lib/data/context.tsx';
import type { Dataset } from '@/lib/data/types.ts';
import { addDays, dur, fmt, shortDate, shortDay } from '@/lib/format.ts';
import { writePref } from '@/lib/prefs.ts';
import { VitalSpark } from './charts/VitalSpark.tsx';
import { CountUp, Reveal } from './motion.tsx';
import { Icon } from './icons.tsx';
import s from './story/story.module.css';

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
  /** Mono line under the label (unit / what it is). */
  hint: (date: string) => string;
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
  /** Short secondary fact for the cell. */
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
    hint: (date) => `${shortDay(addDays(date, -1))} · day before`,
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
    hint: () => 'RMSSD · ms',
    unit: 'ms',
    get: (m) => m.rmssdMean,
    better: 'up',
    value: (v) => fmt(v),
    delta: signedFixed(0),
    sdFloor: 2,
    sub: (m) => (Number.isFinite(m.deepRmssd ?? NaN) ? `deep ${fmt(m.deepRmssd)} ms` : null),
  },
  {
    key: 'rhr',
    label: 'Resting HR',
    hint: () => 'bpm',
    unit: 'bpm',
    get: (m) => m.restingHr,
    better: 'down',
    value: (v) => fmt(v),
    delta: signedFixed(0),
    sdFloor: 1,
    sub: (m) => (Number.isFinite(m.hrNadir) ? `asleep low ${fmt(m.hrNadir)}` : null),
  },
  {
    key: 'sleep',
    label: 'Sleep',
    hint: () => 'asleep',
    unit: '',
    get: (m) => m.totalSleepMin,
    better: 'up',
    value: (v) => dur(v),
    delta: durDelta,
    sdFloor: 15,
    sub: (m) => `deep ${dur(m.deepMin)} · ${fmt(m.efficiencyPct)}%`,
  },
  {
    key: 'spo2',
    label: 'SpO₂',
    hint: () => 'mean · %',
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
    hint: () => 'breaths / min',
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
    hint: () => 'vs Google baseline',
    unit: '°C',
    get: (m) => m.tempDeviationC,
    better: 'rise-bad',
    value: (v) => `${sign(Math.round(v * 100))}${fmt(Math.abs(v), 2)}`,
    delta: signedFixed(2),
    sdFloor: 0.1,
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

interface Col {
  person: Person;
  color: string;
  m: PersonNightMetrics | null;
  away: boolean;
  rows: Row[] | null;
  lastDate: string | null;
}

function Cell({ col, row, date }: { col: Col; row: Row; date: string }) {
  const { def, v, base } = row;
  const d = base && Number.isFinite(v) ? v - base.mean : NaN;
  const z = Number.isFinite(d) ? d / Math.max(base!.sd || 0, def.sdFloor) : NaN;
  const t = tone(def.better, z);
  const shown = Number.isFinite(d) ? def.delta(d) : '';
  const dir = !Number.isFinite(d) || /^±/.test(shown) ? 0 : d > 0 ? 1 : -1;
  const sub = col.m ? def.sub?.(col.m) ?? null : null;
  return (
    <Link
      prefetch={false}
      href={`/body#${def.key}`}
      className={`${s.vc} tap`}
      onClick={() => writePref('bodyPerson', col.person.id)}
      aria-label={`${col.person.name} ${def.label}: ${Number.isFinite(v) ? `${def.value(v)} ${def.unit}` : 'no data'}${Number.isFinite(d) ? `, ${shown} vs baseline, ${TONE_WORD[t]}` : ''}. Open in Body`}
    >
      <div style={{ minWidth: 0 }}>
        <div className={`${s.vv} num`}>
          {Number.isFinite(v) ? <CountUp value={v} format={def.value} duration={1100} /> : '–'}
          {Number.isFinite(v) && def.unit && <small>{def.unit}</small>}
        </div>
        <div className={`${s.vd} ${s[t]}`}>
          {Number.isFinite(d) ? (
            <>
              <i aria-hidden>{dir > 0 ? '▲' : dir < 0 ? '▼' : '·'}</i>
              {shown.replace(/^[+−±]/, '')}
              <span className={s.vbase}>vs {def.value(base!.mean)}</span>
            </>
          ) : (
            <span className={s.vbase}>{Number.isFinite(v) ? 'baseline…' : 'no data'}</span>
          )}
        </div>
        {sub && <div className={s.vsub}>{sub}</div>}
      </div>
      <div className={s.vspark}>
        <VitalSpark
          points={row.spark}
          band={base}
          color={col.color}
          height={26}
          label={`${col.person.name} ${def.label}`}
          format={(x, dt) => `${shortDay(dt)} ${shortDate(dt)} · ${def.value(x)}${def.unit ? ` ${def.unit}` : ''}`}
        />
      </div>
    </Link>
  );
}

/**
 * The comparison table: one column per person (an "away" column when they weren't home), one row per metric.
 * `index` points into `dataset.nights`.
 */
export function VitalsTable({ dataset, index }: { dataset: Dataset; index: number }) {
  const [table, setTable] = useState(false);
  const night = dataset.nights[index];
  if (!night) return null;
  const cols: Col[] = dataset.people.map((p) => {
    const away = !night.people.some((x) => x.personId === p.id);
    const m = away ? null : (dataset.person[p.id]?.[index] ?? null);
    let lastDate: string | null = null;
    if (!m) for (let i = index - 1; i >= 0 && !lastDate; i--) if (dataset.person[p.id]?.[i]) lastDate = dataset.nights[i]!.date;
    return { person: p, color: personColor(dataset.people, p.id), m, away, rows: m ? rowsFor(dataset, p.id, index) : null, lastDate };
  });
  const n = cols.find((c) => c.rows)?.rows?.find((r) => r.base)?.base?.n ?? 0;
  const grid = { gridTemplateColumns: `minmax(74px, 0.62fr) repeat(${cols.length}, minmax(0, 1fr))` };
  return (
    <div className={s.vt}>
      <div className={`${s.vr} ${s.vhead}`} style={grid}>
        <span aria-hidden />
        {cols.map((c) => (
          <span key={c.person.id} className={s.vname}>
            <i style={{ background: c.color }} />
            {c.person.name}
          </span>
        ))}
      </div>
      {METRICS.map((def, ri) => (
        <Reveal key={def.key} className={s.vr} style={{ ...grid, ['--i' as string]: ri % 4 }}>
          <div className={s.vk}>
            {def.label}
            <span>{def.hint(night.date)}</span>
          </div>
          {cols.map((c) =>
            c.rows ? (
              <Cell key={c.person.id} col={c} row={c.rows[ri]!} date={night.date} />
            ) : (
              <div key={c.person.id} className={s.vaway}>
                {ri === 0 ? (
                  <>
                    <b>{c.away ? 'Away' : 'No data'}</b>
                    <span>
                      {c.away ? 'Not home this night.' : 'The tracker didn’t sync.'}
                      {c.lastDate && ` Last data ${shortDay(c.lastDate)} ${shortDate(c.lastDate)}.`}
                    </span>
                  </>
                ) : (
                  <span>–</span>
                )}
              </div>
            ),
          )}
        </Reveal>
      ))}
      <div className={s.vfoot}>
        <span className="t-micro muted">
          {n ? `vs own ${n}-night baseline` : 'Baseline builds over 7 nights'} · <i className="vital-key-band" aria-hidden /> usual range
        </span>
        <button type="button" className={`btn quiet ${s.vtBtn}`} onClick={() => setTable((o) => !o)} aria-expanded={table}>
          <Icon name="table" size={14} /> {table ? 'Hide table' : 'View as table'}
        </button>
      </div>
      {table &&
        cols
          .filter((c) => c.rows)
          .map((c) => {
            const rows = c.rows!;
            const tableNights = rows[0]!.spark.map((x) => x.date);
            const columns = ['Night', ...rows.map((r) => r.def.column ?? (r.def.unit ? `${r.def.label} (${r.def.unit})` : r.def.label))];
            return (
              <div key={c.person.id} className={s.vtable}>
                <div className={s.vname} style={{ margin: '14px 0 6px' }}>
                  <i style={{ background: c.color }} />
                  {c.person.name} · last {tableNights.length} nights
                </div>
                <div className="scroll-x" style={{ maxHeight: 260, overflowY: 'auto' }}>
                  <table className="data-table">
                    <caption className="hidden">{`${c.person.name}: vitals, last ${tableNights.length} nights`}</caption>
                    <thead>
                      <tr>{columns.map((h) => <th key={h}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {tableNights
                        .map((date, i) => [shortDate(date), ...rows.map((r) => (Number.isFinite(r.spark[i]!.v) ? r.def.value(r.spark[i]!.v) : '–'))])
                        .reverse()
                        .map((r, i) => (
                          <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
    </div>
  );
}
