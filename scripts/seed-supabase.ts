// Seeds a Supabase project with simulated nights (Phase 0: charts and reports before the devices arrive).
// Usage:
//   node --experimental-strip-types scripts/seed-supabase.ts [--nights 60] [--seed 42] [--end YYYY-MM-DD]
//        [--device SIM-METER] [--ac-device SIM-AC] [--no-reports] [--dry-run]
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (not for --dry-run). Idempotent: re-running upserts.
// Point the functions at the same device (METER_DEVICE_ID=SIM-METER) so nightly-report reads the sim data.
import { createClient } from '@supabase/supabase-js';
// Imported per module rather than from src/index.ts: health/client.ts uses a TypeScript parameter
// property, which Node's strip-only mode rejects.
import { DEFAULT_CURVE } from '../packages/core/src/curve.ts';
import { buildRuleReport, detectEvents } from '../packages/core/src/metrics/index.ts';
import { DEFAULT_PEOPLE, simulateNights } from '../packages/core/src/sim/index.ts';
import type { Night } from '../packages/core/src/types.ts';
import {
  commandToRow,
  curveToRow,
  eventToRow,
  hrMinuteRows,
  hrvToRows,
  outdoorToRow,
  readingToRow,
  sleepToRow,
  spo2ToRows,
} from '../supabase/functions/_shared/rows.ts';
import { addDays } from '../supabase/functions/_shared/time.ts';

type Row = Record<string, unknown>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const nightsN = Number(arg('nights') ?? 60);
const seed = Number(arg('seed') ?? 42);
const endDate = arg('end');
const meterId = arg('device') ?? 'SIM-METER';
const acId = arg('ac-device') ?? 'SIM-AC';
const dryRun = flag('dry-run');
const withReports = !flag('no-reports');
const HISTORY = 14;

if (!Number.isFinite(nightsN) || nightsN < 1 || !Number.isFinite(seed)) {
  console.error('usage: seed-supabase.ts [--nights N] [--seed S] [--end YYYY-MM-DD] [--device ID] [--ac-device ID] [--no-reports] [--dry-run]');
  process.exit(2);
}

const t0 = performance.now();
const nights: Night[] = simulateNights({ nights: nightsN, seed, ...(endDate ? { endDate } : {}) });
const iso = (ms: number) => new Date(ms).toISOString();

const tables: Record<string, { rows: Row[]; onConflict: string }> = {
  people: { rows: DEFAULT_PEOPLE.map((p) => ({ id: p.id, name: p.name, color_key: p.colorKey })), onConflict: 'id' },
  curves: { rows: [curveToRow(DEFAULT_CURVE, true) as unknown as Row], onConflict: 'id' },
  devices: {
    rows: [
      { device_id: meterId, kind: 'sim', name: 'Simulated Meter Pro CO2' },
      { device_id: acId, kind: 'sim', name: 'Simulated aircon (IR)' },
    ],
    onConflict: 'device_id',
  },
  nights: { rows: [], onConflict: 'date' },
  readings: { rows: [], onConflict: 'device_id,ts' },
  outdoor_readings: { rows: [], onConflict: 'ts' },
  ac_commands: { rows: [], onConflict: 'device_id,ts' },
  sleep_sessions: { rows: [], onConflict: 'person_id,start_ts' },
  health_hr: { rows: [], onConflict: 'person_id,ts' },
  health_hrv: { rows: [], onConflict: 'person_id,ts' },
  health_spo2: { rows: [], onConflict: 'person_id,ts' },
  health_daily: { rows: [], onConflict: 'person_id,data_type,date' },
  health_vitals_daily: { rows: [], onConflict: 'person_id,date' },
  reports: { rows: [], onConflict: 'date' },
};
// health_vitals_daily (0003) is keyed by calendar date: a night's steps belong to the day before its wake date.
// Rows are merged per (person, date) so every row carries the same columns.
const vitals = new Map<string, Row>();
const vitalsRow = (personId: string, date: string): Row => {
  const k = `${personId}|${date}`;
  let r = vitals.get(k);
  if (!r) vitals.set(k, (r = { person_id: personId, date, steps: null, resting_hr: null, resting_hr_method: null, hrv_daily_ms: null, deep_rmssd_ms: null }));
  return r;
};
// Events have no natural key: replaced per night (sim_truth + detector) instead of upserted.
const events: Row[] = [];

for (const [i, n] of nights.entries()) {
  tables.nights!.rows.push({
    date: n.date,
    lights_out: iso(n.lightsOut),
    wake: iso(n.wake),
    curve_id: n.curveId,
    tags: n.tags,
    ac_enabled: true,
    is_sim: true,
  });
  for (const r of n.room) tables.readings!.rows.push(readingToRow(meterId, r) as unknown as Row);
  for (const o of n.outdoor) tables.outdoor_readings!.rows.push(outdoorToRow(o, 'sim'));
  for (const c of n.ac) tables.ac_commands!.rows.push({ ...commandToRow(acId, n.date, c), dry_run: true, sent_ok: true });
  for (const e of n.truth?.events ?? []) events.push(eventToRow(n.date, e, 'sim_truth') as unknown as Row);
  for (const e of detectEvents(n.room, { lightsOut: n.lightsOut, wake: n.wake })) events.push(eventToRow(n.date, e, 'detector') as unknown as Row);

  for (const p of n.people) {
    tables.sleep_sessions!.rows.push(sleepToRow(p.sleep, 'sim') as unknown as Row);
    tables.health_hr!.rows.push(...hrMinuteRows(p.personId, p.hr));
    tables.health_hrv!.rows.push(...hrvToRows(p.personId, p.hrv));
    tables.health_spo2!.rows.push(...spo2ToRows(p.personId, p.spo2));
    // Same shapes the sync stores for Google's daily types (see _shared/load.ts dailyExtras).
    if (p.respRate !== undefined) {
      tables.health_daily!.rows.push({ person_id: p.personId, data_type: 'daily-respiratory-rate', date: n.date, value: { breathsPerMinute: p.respRate, sim: true } });
    }
    if (p.tempDeviationC !== undefined) {
      tables.health_daily!.rows.push({
        person_id: p.personId,
        data_type: 'daily-sleep-temperature-derivations',
        date: n.date,
        value: { nightlyTemperatureCelsius: 34.5 + p.tempDeviationC, baselineTemperatureCelsius: 34.5, sim: true },
      });
    }
    if (p.steps !== undefined) vitalsRow(p.personId, addDays(n.date, -1)).steps = p.steps;
    if (p.restingHr !== undefined) Object.assign(vitalsRow(p.personId, n.date), { resting_hr: p.restingHr, resting_hr_method: 'WITH_SLEEP' });
  }

  if (withReports) {
    const history = nights.slice(Math.max(0, i - HISTORY), i);
    const report = buildRuleReport(n, history, DEFAULT_CURVE);
    tables.reports!.rows.push({ date: n.date, report, rule_report: report, generated_by: 'rules', model: null });
  }
}
tables.health_vitals_daily!.rows.push(...vitals.values());

const simMs = performance.now() - t0;
const counts = Object.fromEntries([...Object.entries(tables).map(([k, v]) => [k, v.rows.length]), ['events', events.length]]);
console.log(`simulated ${nights.length} nights (${nights[0]?.date} → ${nights.at(-1)?.date}) in ${(simMs / 1000).toFixed(1)} s`);
console.table(counts);

if (dryRun) process.exit(0);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or pass --dry-run)');
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function upsert(table: string, rows: Row[], onConflict: string, chunk = 1000) {
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + chunk), { onConflict });
    if (error) throw new Error(`${table} [${i}..]: ${error.message}`);
    process.stdout.write(`\r${table}: ${Math.min(rows.length, i + chunk)}/${rows.length}`);
  }
  if (rows.length) process.stdout.write('\n');
}

// Parents first (nights before ac_commands / reports; people before health tables).
for (const name of ['people', 'curves', 'devices', 'nights', 'readings', 'outdoor_readings', 'ac_commands', 'sleep_sessions', 'health_hr', 'health_hrv', 'health_spo2', 'health_daily', 'health_vitals_daily']) {
  const t = tables[name]!;
  await upsert(name, t.rows, t.onConflict);
}

const dates = nights.map((n) => n.date);
for (let i = 0; i < dates.length; i += 100) {
  const { error } = await db.from('events').delete().in('night_date', dates.slice(i, i + 100)).in('source', ['sim_truth', 'detector']);
  if (error) throw new Error(`events delete: ${error.message}`);
}
for (let i = 0; i < events.length; i += 1000) {
  const { error } = await db.from('events').insert(events.slice(i, i + 1000));
  if (error) throw new Error(`events insert: ${error.message}`);
}
console.log(`events: ${events.length}`);

if (withReports) await upsert('reports', tables.reports!.rows, 'date', 50);
console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
