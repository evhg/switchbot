// Heavy lifting shared by the web worker and the main-thread fallback: simulate, then compute metrics.
// Progressive: after simulating, the newest night's metrics are computed first and streamed as a partial
// dataset (first paint ≈ simulation time), then history is computed newest → oldest in small chunks that yield
// to the event loop (with a second preview once the newest night has its 30-night baseline), so 'detail' requests for the newest night are answered in between instead of after.
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
  type Person,
  type PersonNightMetrics,
  type PersonScoreParts,
  type RoomNightMetrics,
  type TemperatureCurve,
} from '@sleep-lab/core';
import { cacheGet, cachePut } from './engine-cache.ts';
import type { Dataset, EngineEmit, EngineRequest, NightDetail, SimParams, SourceKind } from './types.ts';

let nights: Night[] = [];
/** Detail answers for the current `nights` (cleared whenever the dataset is rebuilt). */
const detailMemo = new Map<string, NightDetail>();

const curveFor = (_id: string): TemperatureCurve => DEFAULT_CURVE;

function clip(n: Night, clipTs: number): Night {
  if (!n.room.length || n.room[n.room.length - 1]!.ts <= clipTs) return n;
  return { ...n, room: n.room.filter((r) => r.ts <= clipTs), outdoor: n.outdoor.filter((o) => o.ts <= clipTs) };
}

function peopleOf(ns: readonly Night[]): Person[] {
  const ids = new Set<string>();
  for (const n of ns) for (const p of n.people) ids.add(p.personId);
  const people = DEFAULT_PEOPLE.filter((p) => ids.has(p.id));
  for (const id of ids) if (!people.some((p) => p.id === id)) people.push({ id, name: id, colorKey: 'personA' });
  return people;
}

function personMetric(n: Night, id: string): PersonNightMetrics | null {
  if (!n.people.some((x) => x.personId === id)) return null;
  try {
    return personNightMetrics(n, id, []);
  } catch {
    return null;
  }
}

/** Synchronous full compute (Supabase path and fallback). */
function compute(input: Night[], source: SourceKind, clipTs: number): Dataset {
  const t0 = performance.now();
  nights = input.map((n) => clip(n, clipTs));
  detailMemo.clear();
  const people = peopleOf(nights);
  const room = nights.map((n) => roomNightMetrics(n, curveFor(n.curveId)));
  const person: Record<string, (PersonNightMetrics | null)[]> = {};
  for (const p of people) person[p.id] = nights.map((n) => personMetric(n, p.id));
  return { source, people, nights, room, person, generatedAt: Date.now(), computeMs: Math.round(performance.now() - t0), clipTs };
}

const yieldToEvents = () => new Promise<void>((r) => setTimeout(r, 0));
const CHUNK = 3;
/** Nights of history in the second preview (the 30-night baseline). */
const HISTORY_PREVIEW = 30;

async function computeProgressive(input: Night[], source: SourceKind, clipTs: number, emit: EngineEmit | undefined, t0: number): Promise<Dataset> {
  nights = input.map((n) => clip(n, clipTs));
  detailMemo.clear();
  const people = peopleOf(nights);
  const N = nights.length;
  const room = new Array<RoomNightMetrics>(N);
  const person: Record<string, (PersonNightMetrics | null)[]> = {};
  for (const p of people) person[p.id] = new Array<PersonNightMetrics | null>(N).fill(null);
  const one = (i: number) => {
    const n = nights[i]!;
    room[i] = roomNightMetrics(n, curveFor(n.curveId));
    for (const p of people) person[p.id]![i] = personMetric(n, p.id);
  };
  if (N && emit) {
    one(N - 1);
    const last = nights[N - 1]!;
    const partial: Dataset = {
      source,
      people,
      nights: [last],
      room: [room[N - 1]!],
      person: Object.fromEntries(people.map((p) => [p.id, [person[p.id]![N - 1] ?? null]])),
      generatedAt: Date.now(),
      computeMs: Math.round(performance.now() - t0),
      clipTs,
      partial: true,
    };
    emit({ partial, progress: `Analysing night 1 of ${N}` });
    // The Today verdict needs this night's report: compute it before the history, so the request the page sends
    // on first paint is answered at once instead of after a chunk of history.
    try {
      detail(last.date);
    } catch {
      /* answered (with the error) when requested */
    }
    await yieldToEvents();
  }
  const slice = (from: number): Dataset => ({
    source,
    people,
    nights: nights.slice(from),
    room: room.slice(from),
    person: Object.fromEntries(people.map((p) => [p.id, person[p.id]!.slice(from)])),
    generatedAt: Date.now(),
    computeMs: Math.round(performance.now() - t0),
    clipTs,
    partial: true,
  });
  for (let i = N - (emit ? 2 : 1), k = 0; i >= 0; i--, k++) {
    one(i);
    // Second preview once a 30-night baseline exists for the newest night (Vitals, drivers): newest 31 nights.
    if (emit && i === N - 1 - HISTORY_PREVIEW && i > 0) {
      emit({ partial: slice(i), progress: `Analysing night ${N - i} of ${N}` });
      await yieldToEvents();
    }
    if (k % CHUNK === CHUNK - 1) {
      emit?.({ progress: `Analysing night ${N - i} of ${N}` });
      await yieldToEvents();
    }
  }
  return { source, people, nights, room, person, generatedAt: Date.now(), computeMs: Math.round(performance.now() - t0), clipTs };
}

function detail(date: string): NightDetail {
  const memo = detailMemo.get(date);
  if (memo) return memo;
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
  const out: NightDetail = { date, events, report, roomParts, personParts, people: report.people };
  detailMemo.set(date, out);
  return out;
}

const MIN = 60_000;

/** Cache key: data only changes with the build, the parameters and (until the last night's 12:00 end) the clip time. */
function simKey(p: SimParams): string {
  const endOfData = Date.parse(`${p.endDate}T12:00:00+07:00`);
  const clip = p.clipTs >= endOfData ? 'full' : String(Math.floor(p.clipTs / (15 * MIN)));
  return ['sim', process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev', p.seed, p.nights, p.endDate, clip].join('|');
}

async function simulate(p: SimParams, emit?: EngineEmit): Promise<Dataset> {
  const key = simKey(p);
  const hit = await cacheGet(key);
  if (hit && hit.nights.length === p.nights) {
    nights = hit.nights;
    detailMemo.clear();
    return { ...hit, cached: true };
  }
  const t0 = performance.now();
  emit?.({ progress: `Simulating ${p.nights} nights` });
  const sim = simulateNights({ seed: p.seed, nights: p.nights, endDate: p.endDate });
  const ds = await computeProgressive(sim, 'sim', p.clipTs, emit, t0);
  void cachePut(key, ds);
  return ds;
}

export function handle(req: EngineRequest, emit?: EngineEmit): unknown {
  switch (req.type) {
    case 'simulate':
      return simulate(req.params, emit);
    case 'compute':
      return compute(req.nights, req.source, req.clipTs);
    case 'detail':
      return detail(req.date);
  }
}
