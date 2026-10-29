'use client';
// Today → Your bodies (docs/DESIGN.md §9.1 scene 5): last night's vitals for both people side by side, each against
// that person's own typical night (median-free mean of the previous 30 nights) with a neutral arrow, never red or
// green (§3.3). Six primary rows; the rest sit behind "More vitals"; the last 14 nights (sparklines over the usual
// range, plus a table) open in a sheet. Every value links to the Body tab for that person and metric.
import Link from 'next/link';
import { Fragment } from 'react';
import { baselineBand, type Person, type PersonNightMetrics } from '@sleep-lab/core';
import { personColor } from '@/lib/data/context.tsx';
import type { Dataset, NightDetail } from '@/lib/data/types.ts';
import { addDays, dur, fmt, shortDate, shortDay } from '@/lib/format.ts';
import { writePref } from '@/lib/prefs.ts';
import { VitalSpark } from './charts/VitalSpark.tsx';
import { Delta, Disclosure, TableView } from './ui.tsx';
import s from './story/story.module.css';

const BASELINE_NIGHTS = 30;
const MIN_BASELINE = 7;
const SPARK_NIGHTS = 14;

interface MetricDef {
  key: string;
  /** Row label (sentence case). */
  label: string;
  /** Body tab anchor. */
  anchor: string;
  unit: string;
  get: (m: PersonNightMetrics) => number | undefined;
  /** Formats a value (no unit). */
  value: (v: number) => string;
  /** Formats an absolute difference (no sign, no unit). */
  diff: (d: number) => string;
  /** Differences smaller than this read as "typical". */
  same: number;
  /** Extra fact under the value. */
  sub?: (m: PersonNightMetrics) => string | null;
  /** Column header in the table view. */
  column?: string;
}

const abs = (digits: number) => (d: number) => fmt(Math.abs(d), digits);
const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '±');

/** The six rows the scene shows (§9.1). Recovery comes from the night detail (it needs history). */
export const PRIMARY: MetricDef[] = [
  { key: 'sleep', label: 'Sleep score', anchor: 'sleep', unit: '', get: (m) => m.sleepScore, value: (v) => fmt(v), diff: abs(0), same: 1 },
  { key: 'recovery', label: 'Recovery', anchor: 'recovery', unit: '', get: (m) => m.recoveryScore, value: (v) => fmt(v), diff: abs(0), same: 1 },
  { key: 'nadir', label: 'Lowest heart rate', anchor: 'rhr', unit: 'bpm', get: (m) => m.hrNadir, value: (v) => fmt(v), diff: abs(0), same: 1, column: 'Lowest HR (bpm)' },
  { key: 'hrv', label: 'Heart rate variability', anchor: 'hrv', unit: 'ms', get: (m) => m.rmssdMean, value: (v) => fmt(v), diff: abs(0), same: 1, column: 'HRV (ms)' },
  { key: 'spo2', label: 'Blood oxygen', anchor: 'spo2', unit: '%', get: (m) => m.spo2Mean, value: (v) => fmt(v, 1), diff: abs(1), same: 0.1, column: 'SpO₂ (%)' },
  { key: 'resp', label: 'Breathing rate', anchor: 'resp', unit: '/min', get: (m) => m.respRate, value: (v) => fmt(v, 1), diff: abs(1), same: 0.1, column: 'Breathing (/min)' },
];

/** Behind "More vitals". */
export const MORE: MetricDef[] = [
  { key: 'asleep', label: 'Time asleep', anchor: 'sleep', unit: '', get: (m) => m.totalSleepMin, value: (v) => dur(v), diff: (d) => dur(Math.abs(d)), same: 1, sub: (m) => `deep ${dur(m.deepMin)} · ${fmt(m.efficiencyPct)}% efficient`, column: 'Asleep' },
  { key: 'rhr', label: 'Resting heart rate', anchor: 'rhr', unit: 'bpm', get: (m) => m.restingHr, value: (v) => fmt(v), diff: abs(0), same: 1, column: 'Resting HR (bpm)' },
  { key: 'deephrv', label: 'HRV in deep sleep', anchor: 'hrv', unit: 'ms', get: (m) => m.deepRmssd, value: (v) => fmt(v), diff: abs(0), same: 1, column: 'Deep HRV (ms)' },
  { key: 'dips', label: 'Oxygen dips', anchor: 'spo2', unit: '/h', get: (m) => (Number.isFinite(m.spo2Mean) ? m.spo2DipsPerHour : undefined), value: (v) => fmt(v, 1), diff: abs(1), same: 0.1, column: 'SpO₂ dips (/h)' },
  { key: 'temp', label: 'Skin temperature', anchor: 'temp', unit: '°', get: (m) => m.tempDeviationC, value: (v) => `${sign(Math.round(v * 100))}${fmt(Math.abs(v), 2)}`, diff: abs(2), same: 0.01, sub: () => 'vs Google baseline', column: 'Skin temp (Δ °C)' },
  { key: 'steps', label: 'Steps, day before', anchor: 'steps', unit: '', get: (m) => m.steps, value: (v) => fmt(v), diff: (d) => fmt(Math.abs(Math.round(d / 10) * 10)), same: 50, column: 'Steps (day before)' },
];

interface Col {
  person: Person;
  index: number;
  color: string;
  m: PersonNightMetrics | null;
  away: boolean;
  lastDate: string | null;
}

function columns(dataset: Dataset, index: number, detail: NightDetail | null): Col[] {
  const night = dataset.nights[index];
  return dataset.people.map((p, i) => {
    const away = !night?.people.some((x) => x.personId === p.id);
    const base = away ? null : (dataset.person[p.id]?.[index] ?? null);
    // Recovery needs history: take this person's metrics from the night detail when it has arrived.
    const fromDetail = detail && detail.date === night?.date ? detail.people.find((x) => x.personId === p.id) : undefined;
    const m = base ? { ...base, recoveryScore: fromDetail ? fromDetail.recoveryScore : NaN } : null;
    let lastDate: string | null = null;
    if (!m) for (let k = index - 1; k >= 0 && !lastDate; k--) if (dataset.person[p.id]?.[k]) lastDate = dataset.nights[k]!.date;
    return { person: p, index: i, color: personColor(dataset.people, p.id), m, away, lastDate };
  });
}

/** Mean of the previous 30 nights (≥ 7 needed), or null. Recovery has no per-night history here. */
function typical(dataset: Dataset, personId: string, index: number, def: MetricDef): number | null {
  if (def.key === 'recovery') return null;
  const series = dataset.person[personId] ?? [];
  const xs: number[] = [];
  for (let i = Math.max(0, index - BASELINE_NIGHTS); i < index; i++) {
    const m = series[i];
    const v = m ? def.get(m) : undefined;
    if (v !== undefined && Number.isFinite(v)) xs.push(v);
  }
  return xs.length >= MIN_BASELINE ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function Cell({ dataset, index, col, def }: { dataset: Dataset; index: number; col: Col; def: MetricDef }) {
  const v = col.m ? def.get(col.m) : undefined;
  const ok = v !== undefined && Number.isFinite(v);
  const t = typical(dataset, col.person.id, index, def);
  const d = ok && t !== null ? v - t : NaN;
  const sub = col.m ? def.sub?.(col.m) ?? null : null;
  const unit = def.unit === '°' ? '°' : def.unit;
  return (
    <Link
      prefetch={false}
      href={`/body#${def.anchor}`}
      className={s.vCell}
      onClick={() => writePref('bodyPerson', col.person.id)}
      aria-label={`${col.person.name}, ${def.label}: ${ok ? `${def.value(v)} ${def.unit}` : 'no data'}${t !== null ? `, typical ${def.value(t)}` : ''}. Open in Body`}
    >
      <b className="num">
        {ok ? def.value(v) : def.key === 'recovery' && col.m ? '…' : '–'}
        {ok && unit && <span className="unit">{unit}</span>}
      </b>
      {ok && t !== null ? (
        Math.abs(d) < def.same ? (
          <span className="delta-text">typical {def.value(t)}</span>
        ) : (
          <Delta dir={d > 0 ? 'up' : 'down'} typical={def.value(t)}>
            {def.diff(d)}
            {def.unit ? (def.unit === '%' || def.unit === '°' ? def.unit : ` ${def.unit}`) : ''}
          </Delta>
        )
      ) : sub ? null : (
        <span className="delta-text">{def.key === 'recovery' ? 'vs own baseline' : ok ? 'baseline building' : ''}</span>
      )}
      {sub && <span className="delta-text">{sub}</span>}
    </Link>
  );
}

function Table({ dataset, index, cols, defs }: { dataset: Dataset; index: number; cols: Col[]; defs: MetricDef[] }) {
  const grid = { gridTemplateColumns: `minmax(0, 1.1fr) repeat(${cols.length}, minmax(0, 1fr))` };
  return (
    <div className={s.vTable} role="table">
      <div className={`${s.vRow} ${s.vHead}`} style={grid} role="row">
        <span role="columnheader" />
        {cols.map((c) => (
          <span key={c.person.id} role="columnheader" className={`${s.vName} ${c.index === 1 ? 'p-erik' : 'p-you'}`}>
            <i aria-hidden />
            {c.person.name}
          </span>
        ))}
      </div>
      {defs.map((def) => (
        <div key={def.key} className={s.vRow} style={grid} role="row">
          <span role="rowheader" className={s.vLabel}>
            {def.label}
          </span>
          {cols.map((c) =>
            c.m ? (
              <span key={c.person.id} role="cell">
                <Cell dataset={dataset} index={index} col={c} def={def} />
              </span>
            ) : (
              <span key={c.person.id} role="cell" className={s.vAway}>
                {def === defs[0] ? (
                  <>
                    <b>{c.away ? 'Away' : 'No data'}</b>
                    <span className="delta-text">
                      {c.away ? 'Not home this night.' : 'The tracker didn’t sync.'}
                      {c.lastDate && ` Last data ${shortDay(c.lastDate)} ${shortDate(c.lastDate)}.`}
                    </span>
                  </>
                ) : (
                  '–'
                )}
              </span>
            ),
          )}
        </div>
      ))}
    </div>
  );
}

/** The scene's table: six rows, "More vitals" in a disclosure underneath. */
export function VitalsTable({ dataset, index, detail }: { dataset: Dataset; index: number; detail: NightDetail | null }) {
  if (!dataset.nights[index]) return null;
  const cols = columns(dataset, index, detail);
  return (
    <>
      <Table dataset={dataset} index={index} cols={cols} defs={PRIMARY} />
      <Disclosure title="More vitals" count={`${MORE.length}`} className={s.vMore}>
        <Table dataset={dataset} index={index} cols={cols} defs={MORE} />
      </Disclosure>
    </>
  );
}

/** Sheet: the last 14 nights per metric (sparkline over the person's usual range) and as a table. */
export function VitalsHistory({ dataset, index }: { dataset: Dataset; index: number }) {
  const night = dataset.nights[index];
  if (!night) return null;
  const defs = [...PRIMARY.filter((d) => d.key !== 'recovery'), ...MORE];
  const nights: string[] = [];
  for (let i = Math.max(0, index - SPARK_NIGHTS + 1); i <= index; i++) nights.push(dataset.nights[i]!.date);
  const start = index - nights.length + 1;
  return (
    <div className={s.hist}>
      <p className="sec">
        Each line is the last {nights.length} nights, {shortDate(nights[0]!)} to {shortDate(night.date)}. The band is that person’s usual range (their mean ± 1 SD over the previous{' '}
        {BASELINE_NIGHTS} nights). Steps are for {shortDay(addDays(night.date, -1))}, the day before.
      </p>
      {defs.map((def) => (
        <div key={def.key} className={s.histRow}>
          <h3 className="label">{def.label}</h3>
          {dataset.people.map((p, pi) => {
            const series = dataset.person[p.id] ?? [];
            const pts = nights.map((date, k) => {
              const m = series[start + k];
              const v = m ? def.get(m) : undefined;
              return { date, v: v === undefined ? NaN : v };
            });
            const past: number[] = [];
            for (let i = Math.max(0, index - BASELINE_NIGHTS); i < index; i++) {
              const m = series[i];
              const v = m ? def.get(m) : undefined;
              if (v !== undefined && Number.isFinite(v)) past.push(v);
            }
            const band = past.length >= MIN_BASELINE ? baselineBand(past) : null;
            const lastV = pts.at(-1)!.v;
            return (
              <Fragment key={p.id}>
                <div className={`${s.histCell} ${pi === 1 ? 'p-erik' : 'p-you'}`}>
                  <span className={s.vName}>
                    <i aria-hidden />
                    {p.name}
                  </span>
                  <VitalSpark
                    points={pts}
                    band={band}
                    color="var(--person)"
                    height={36}
                    label={`${p.name} ${def.label}`}
                    format={(x, dt) => `${shortDay(dt)} ${shortDate(dt)} · ${def.value(x)}${def.unit ? ` ${def.unit}` : ''}`}
                  />
                  <b className="num">
                    {Number.isFinite(lastV) ? def.value(lastV) : '–'}
                    {Number.isFinite(lastV) && def.unit && <span className="unit">{def.unit}</span>}
                  </b>
                </div>
              </Fragment>
            );
          })}
        </div>
      ))}
      {dataset.people.map((p) => {
        const series = dataset.person[p.id] ?? [];
        const rows = nights
          .map((date, k) => {
            const m = series[start + k];
            return [shortDate(date), ...defs.map((d) => {
              const v = m ? d.get(m) : undefined;
              return v !== undefined && Number.isFinite(v) ? d.value(v) : '–';
            })];
          })
          .reverse();
        return (
          <div key={p.id} className={s.histTable}>
            <h3 className="label">{p.name}, as a table</h3>
            <TableView caption={`${p.name}: vitals, last ${nights.length} nights`} columns={['Night', ...defs.map((d) => d.column ?? d.label)]} rows={rows} />
          </div>
        );
      })}
    </div>
  );
}
