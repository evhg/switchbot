// Heavy lifting shared by the web worker and the main-thread fallback: simulate, then compute metrics.
import {
  DEFAULT_CURVE,
  DEFAULT_PEOPLE,
  buildRuleReport,
  detectEvents,
  personNightBreakdown,
  personNightMetrics,
  roomNightBreakdown,
  roomNightMetrics,
  simulateNights,
  type Night,
  type PersonNightMetrics,
  type PersonScoreParts,
  type TemperatureCurve,
} from '@sleep-lab/core';
import { cacheGet, cachePut } from './engine-cache.ts';
import type { Dataset, EngineRequest, NightDetail, SimParams, SourceKind } from './types.ts';

let nights: Night[] = [];

const curveFor = (_id: string): TemperatureCurve => DEFAULT_CURVE;

function clip(n: Night, clipTs: number): Night {
  if (!n.room.length || n.room[n.room.length - 1]!.ts <= clipTs) return n;
  return { ...n, room: n.room.filter((r) => r.ts <= clipTs), outdoor: n.outdoor.filter((o) => o.ts <= clipTs) };
}

function compute(input: Night[], source: SourceKind, clipTs: number): Dataset {
  const t0 = performance.now();
  nights = input.map((n) => clip(n, clipTs));
  const ids = new Set<string>();
  for (const n of nights) for (const p of n.people) ids.add(p.personId);
  const people = DEFAULT_PEOPLE.filter((p) => ids.has(p.id));
  for (const id of ids) if (!people.some((p) => p.id === id)) people.push({ id, name: id, colorKey: 'personA' });
  const room = nights.map((n) => roomNightMetrics(n, curveFor(n.curveId)));
  const person: Record<string, (PersonNightMetrics | null)[]> = {};
  for (const p of people) {
    person[p.id] = nights.map((n) => {
      if (!n.people.some((x) => x.personId === p.id)) return null;
      try {
        return personNightMetrics(n, p.id, []);
      } catch {
        return null;
      }
    });
  }
  return { source, people, nights, room, person, generatedAt: Date.now(), computeMs: Math.round(performance.now() - t0), clipTs };
}

function detail(date: string): NightDetail {
  const i = nights.findIndex((n) => n.date === date);
  const night = nights[i];
  if (!night) throw new Error(`No night ${date}`);
  const history = nights.slice(Math.max(0, i - 30), i);
  const curve = curveFor(night.curveId);
  const events = detectEvents(night.room, { lightsOut: night.lightsOut, wake: night.wake });
  const withEvents: Night = { ...night, events };
  const report = buildRuleReport(withEvents, history, curve);
  const { parts: roomParts } = roomNightBreakdown(withEvents, curve);
  const personParts: Record<string, PersonScoreParts> = {};
  for (const p of night.people) personParts[p.personId] = personNightBreakdown(withEvents, p.personId, history).parts;
  return { date, events, report, roomParts, personParts, people: report.people };
}

const MIN = 60_000;

/** Cache key: data only changes with the build, the parameters and (until the last night's 12:00 end) the clip time. */
function simKey(p: SimParams): string {
  const endOfData = Date.parse(`${p.endDate}T12:00:00+07:00`);
  const clip = p.clipTs >= endOfData ? 'full' : String(Math.floor(p.clipTs / (15 * MIN)));
  return ['sim', process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev', p.seed, p.nights, p.endDate, clip].join('|');
}

async function simulate(p: SimParams): Promise<Dataset> {
  const key = simKey(p);
  const hit = await cacheGet(key);
  if (hit && hit.nights.length === p.nights) {
    nights = hit.nights;
    return { ...hit, cached: true };
  }
  const sim = simulateNights({ seed: p.seed, nights: p.nights, endDate: p.endDate });
  const ds = compute(sim, 'sim', p.clipTs);
  await cachePut(key, ds);
  return ds;
}

export function handle(req: EngineRequest): unknown {
  switch (req.type) {
    case 'simulate':
      return simulate(req.params);
    case 'compute':
      return compute(req.nights, req.source, req.clipTs);
    case 'detail':
      return detail(req.date);
  }
}
