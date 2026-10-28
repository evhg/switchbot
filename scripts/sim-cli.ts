// Prints or writes simulated nights.
// Usage: node --experimental-strip-types scripts/sim-cli.ts [--nights N] [--seed S] [--end YYYY-MM-DD] [--format json|csv|summary] [--out file]
//   json    full Night[] (room, outdoor, AC log, people, truth)
//   csv     1-min room readings: date,ts,iso_ict,temp_c,rh,co2
//   summary one line per night
import { writeFileSync } from 'node:fs';
import { simulateNights, type Night } from '../packages/core/src/index.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const nights = Number(arg('nights') ?? 60);
const seed = Number(arg('seed') ?? 42);
const endDate = arg('end');
const format = arg('format') ?? 'json';
const out = arg('out');

if (!Number.isFinite(nights) || nights < 1 || !Number.isFinite(seed) || !['json', 'csv', 'summary'].includes(format)) {
  console.error('usage: sim-cli.ts [--nights N] [--seed S] [--end YYYY-MM-DD] [--format json|csv|summary] [--out file]');
  process.exit(2);
}

const t = performance.now();
const data = simulateNights({ nights, seed, ...(endDate ? { endDate } : {}) });
const ms = performance.now() - t;

const ict = (ts: number) => new Date(ts + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');

function summary(n: Night): string {
  const asleep = n.room.filter((r) => r.ts >= n.lightsOut && r.ts < n.wake);
  const co2Max = Math.max(...asleep.map((r) => r.co2));
  const tMean = asleep.reduce((a, r) => a + r.tempC, 0) / asleep.length;
  const rhMean = asleep.reduce((a, r) => a + r.rh, 0) / asleep.length;
  const deep = n.people
    .map((p) => `${p.personId}:deep ${Math.round(p.sleep.stages.filter((s) => s.stage === 'deep').reduce((a, s) => a + (s.end - s.start), 0) / 60_000)}m`)
    .join(' ');
  return [
    n.date,
    `lights-out ${ict(n.lightsOut).slice(11)}`,
    `wake ${ict(n.wake).slice(11)}`,
    `ACH ${n.truth?.ach.toFixed(2)}`,
    `CO2max ${co2Max}`,
    `T ${tMean.toFixed(1)}`,
    `RH ${rhMean.toFixed(0)}`,
    `AC ${n.ac.length}`,
    deep,
    n.tags.join(',') || '-',
  ].join('  ');
}

let text: string;
if (format === 'json') text = JSON.stringify(data);
else if (format === 'csv') {
  const rows = ['date,ts,iso_ict,temp_c,rh,co2'];
  for (const n of data) for (const r of n.room) rows.push(`${n.date},${r.ts},${ict(r.ts)},${r.tempC},${r.rh},${r.co2}`);
  text = rows.join('\n') + '\n';
} else text = data.map(summary).join('\n') + '\n';

if (out) {
  writeFileSync(out, text);
  console.error(`wrote ${data.length} nights (${format}) to ${out} in ${ms.toFixed(0)} ms`);
} else process.stdout.write(text);
