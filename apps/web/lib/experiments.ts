'use client';
/**
 * Lab › Experiments: planned A/B tests over nights (migration 0025, the experiments Edge Function).
 *
 *   public.experiments         one row per experiment: kind 'auto' (aircon curves Jarvis runs itself) or 'manual'
 *                              (something the household does: door, earplugs …), 2–3 arms (the first is the control),
 *                              the primary outcome, status, seed, autopilot
 *   public.experiment_nights   one row per experiment and night (night_date = the morning's date): the arm, how it was
 *                              chosen ('random' in blocks, or 'pinned'), followed (one tap "Didn't follow") and the
 *                              night's outcomes (computed by the backend after the morning sleep sync, from 10:00 ICT)
 *   public.experiment_log      every decision the engine and Autopilot took
 *   household_settings.autopilot
 *
 * Writers (owner / member) go through RPCs: create_experiment, pin_experiment_arm, mark_experiment_night,
 * finish_experiment, set_autopilot. Signed out or in the simulator, a sample experiment lives on this device so the page
 * can be tried; a member whose server lacks migration 0025 sees the sample read-only with a note.
 *
 * All statistics come from @sleep-lab/core (analyzeExperiment: Welch-t posterior, 90 % intervals, P(better), the
 * composite sleep score, the stop rule), the same code the backend runs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  analyzeExperiment,
  EXPERIMENT_TEMPLATES,
  experimentLine as coreExperimentLine,
  type Experiment as CoreExperiment,
  type ExperimentAnalysis,
  type ExperimentArm,
  type ExperimentNight as CoreNight,
  type NightOutcomes,
  type PersonOutcomes,
} from '@sleep-lab/core';
import { useAuth } from './auth.tsx';
import { useData } from './data/context.tsx';
import { supabaseClient } from './data/supabase.ts';
import { addDays, DAY, ictDate } from './format.ts';

type Row = Record<string, unknown>;

export type { ExperimentAnalysis, ExperimentArm, NightOutcomes };

/** core's Experiment with the row's id as text (bigint or uuid on the server). */
export interface Experiment extends Omit<CoreExperiment, 'id'> {
  id: string;
  createdAt: number;
}

/** core's ExperimentNight plus the experiment it belongs to. */
export interface ExpNight extends CoreNight {
  experimentId: string;
}

export interface ExpLog {
  id: string;
  experimentId: string | null;
  at: number;
  kind: string;
  message: string;
  /** 'adopted' rows: the new default curve and the one before it. */
  curveId?: string | null;
  previous?: string | null;
}

export interface Template {
  slug: string;
  title: string;
  kind: 'auto' | 'manual';
  arms: ExperimentArm[];
  primaryOutcome: string;
  description: string;
}

export const TEMPLATES: readonly Template[] = EXPERIMENT_TEMPLATES;

/** How the composite sleep score is built, in plain words (core: sleepScores). */
export const SLEEP_SCORE_EXPLAINED =
  'Sleep score: the average of four z-scores over this experiment’s nights, per person — deep sleep and REM count up, time awake and awakenings count down. 0 is an average night of the experiment; +0.5 is clearly better. The household score is the mean of both of you.';

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

// ───────────────────────────── analysis helpers ─────────────────────────────

export const toCore = (e: Experiment): CoreExperiment => ({ ...e, id: Number.isFinite(Number(e.id)) ? Number(e.id) : undefined });
export const nightsOf = (e: Pick<Experiment, 'id'>, nights: readonly ExpNight[]) => nights.filter((n) => n.experimentId === e.id);

export function analyze(e: Experiment, nights: readonly ExpNight[], names?: Record<string, string>): ExperimentAnalysis {
  return analyzeExperiment(toCore(e), nightsOf(e, nights), names && Object.keys(names).length ? { names } : {});
}

export const STATUS_WORDS: Record<ExperimentAnalysis['status'] | 'finished', string> = {
  running: 'Running',
  leaning: 'Leaning',
  clear_winner: 'Clear winner',
  no_difference: 'No difference yet',
  finished: 'Finished',
};

/** One-sided 95 % t quantiles (a two-sided 90 % interval), df 1..30. */
const T95 = [6.314, 2.92, 2.353, 2.132, 2.015, 1.943, 1.895, 1.86, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.74, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697];
/** 90 % interval of one arm's mean from analyzeExperiment's { n, mean, sd }. */
export function armInterval(a: { n: number; mean: number | null; sd: number | null }): { lo: number; hi: number } {
  if (a.mean === null) return { lo: NaN, hi: NaN };
  if (a.sd === null || a.n < 2) return { lo: a.mean, hi: a.mean };
  const t = a.n - 1 <= 30 ? T95[a.n - 2]! : 1.645;
  const h = (t * a.sd) / Math.sqrt(a.n);
  return { lo: a.mean - h, hi: a.mean + h };
}

// ───────────────────────────── rows ─────────────────────────────

function toArm(v: unknown, i: number): ExperimentArm | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Row;
  const key = str(r.key) ?? `arm${i + 1}`;
  const arm: ExperimentArm = { key, label: str(r.label) ?? key };
  const curve = str(r.curve_id) ?? str(r.curveId);
  if (curve) arm.curve_id = curve;
  if (str(r.instruction)) arm.instruction = str(r.instruction)!;
  if (str(r.tag)) arm.tag = str(r.tag) as ExperimentArm['tag'];
  return arm;
}

function toExperiment(r: Row): Experiment {
  const arms = (Array.isArray(r.arms) ? r.arms : []).map(toArm).filter((a): a is ExperimentArm => !!a);
  const status = str(r.status);
  return {
    id: String(r.id),
    slug: str(r.slug) ?? String(r.id),
    title: str(r.title) ?? 'Experiment',
    kind: r.kind === 'auto' ? 'auto' : 'manual',
    arms: arms.length >= 2 ? arms : [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
    primaryOutcome: str(r.primary_outcome) ?? 'sleep_score',
    status: status === 'finished' || status === 'stopped' ? status : 'running',
    startedOn: str(r.started_on) ?? ictDate(Date.now()),
    endedOn: str(r.ended_on),
    winnerArm: str(r.winner_arm),
    seed: Number.isFinite(num(r.seed)) ? num(r.seed) : 0,
    autopilot: r.autopilot === true,
    notes: str(r.notes),
    ...(Number.isFinite(num(r.min_per_arm)) ? { minPerArm: num(r.min_per_arm) } : {}),
    ...(Number.isFinite(num(r.max_nights)) ? { maxNights: num(r.max_nights) } : {}),
    createdAt: Date.parse(String(r.created_at ?? '')) || 0,
  };
}

function toOutcomes(v: unknown): NightOutcomes | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Row;
  const people: Record<string, PersonOutcomes> = {};
  if (r.people && typeof r.people === 'object')
    for (const [id, p] of Object.entries(r.people as Row)) {
      const q = (p ?? {}) as Row;
      const f = (k: string) => (Number.isFinite(num(q[k])) ? num(q[k]) : 0);
      people[id] = { onsetMin: f('onsetMin'), deepMin: f('deepMin'), remMin: f('remMin'), lightMin: f('lightMin'), awakeMin: f('awakeMin'), awakenings: f('awakenings') };
    }
  const n = (k: string) => (Number.isFinite(num(r[k])) ? num(r[k]) : null);
  return { people, co2Mean: n('co2Mean'), co2Over1000Min: n('co2Over1000Min'), tempMean: n('tempMean'), snoreMin: n('snoreMin'), missing: Array.isArray(r.missing) ? r.missing.map(String) : [] };
}

function toNight(r: Row): ExpNight {
  return {
    experimentId: String(r.experiment_id),
    nightDate: String(r.night_date),
    armKey: String(r.arm_key),
    source: r.source === 'pinned' ? 'pinned' : 'random',
    followed: r.followed !== false,
    outcomes: toOutcomes(r.outcomes),
  };
}

function toLog(r: Row): ExpLog {
  const data = r.data && typeof r.data === 'object' ? (r.data as Row) : {};
  return {
    id: String(r.id),
    experimentId: r.experiment_id === null || r.experiment_id === undefined ? null : String(r.experiment_id),
    at: Date.parse(String(r.at ?? r.created_at ?? '')) || 0,
    kind: str(r.kind) ?? 'note',
    message: str(r.message) ?? str(data.message) ?? '',
    curveId: str(data.curve_id) ?? null,
    previous: str(data.previous) ?? null,
  };
}

/** A server message that means "migration 0025 isn't applied yet". */
export const missingExperiments = (m: string) => /does not exist|schema cache|could not find/i.test(m);
export const NOT_YET = 'Experiments aren’t on the server yet (migration 0025). The sample below shows how it will look.';
const errText = (m: string) =>
  missingExperiments(m)
    ? 'Experiments aren’t on the server yet (migration 0025).'
    : /already running|one running|unique|duplicate/i.test(m)
      ? 'Another experiment of this kind is already running. Finish it first.'
      : /not allowed|42501|permission/i.test(m)
        ? 'Only the household’s owner or members can change experiments.'
        : m;

// ───────────────────────────── sample (simulator) ─────────────────────────────

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());

/** Balanced blocks: every block of nights gets each arm once, in a random order (deterministic per seed). */
function blockArms(arms: readonly ExperimentArm[], count: number, seed: string): string[] {
  const r = rng(seed);
  const out: string[] = [];
  while (out.length < count) {
    const block = arms.map((a) => a.key);
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [block[i], block[j]] = [block[j]!, block[i]!];
    }
    out.push(...block);
  }
  return out.slice(0, count);
}

function sampleOutcomes(r: () => number, fx: { co2: number; deep: number; awak: number; temp: number }): NightOutcomes {
  const person = (b: { deep: number; rem: number; awake: number; awak: number; onset: number }): PersonOutcomes => ({
    onsetMin: Math.round(Math.max(3, b.onset + gauss(r) * 7)),
    deepMin: Math.round(b.deep + fx.deep + gauss(r) * 9),
    remMin: Math.round(b.rem + gauss(r) * 12),
    lightMin: Math.round(250 + gauss(r) * 20),
    awakeMin: Math.round(Math.max(0, b.awake + gauss(r) * 9 + fx.awak * 6)),
    awakenings: Math.max(0, Math.round(b.awak + fx.awak + gauss(r) * 1.1)),
  });
  const co2Mean = Math.round(1080 + fx.co2 + gauss(r) * 70);
  return {
    people: { a: person({ deep: 62, rem: 88, awake: 34, awak: 4, onset: 18 }), b: person({ deep: 74, rem: 96, awake: 22, awak: 3, onset: 14 }) },
    co2Mean,
    co2Over1000Min: Math.round(Math.max(0, (co2Mean - 900) * 1.6 + gauss(r) * 30)),
    tempMean: Math.round((18.7 + fx.temp + gauss(r) * 0.2) * 10) / 10,
    snoreMin: Math.round(Math.max(0, 48 + gauss(r) * 18)),
    missing: [],
  };
}

interface Store {
  experiments: Experiment[];
  nights: ExpNight[];
  log: ExpLog[];
  autopilot: boolean;
}

/** The sample shown in the simulator (also used by checks). */
export function sampleStore(): Store {
  const tonight = addDays(ictDate(Date.now()), 1);
  const doorT = TEMPLATES.find((t) => /door/i.test(t.slug)) ?? TEMPLATES[0]!;
  const airT = TEMPLATES.find((t) => t.kind === 'auto') ?? TEMPLATES[2]!;
  const door: Experiment = { id: 'sample-door', slug: doorT.slug, title: doorT.title, kind: 'manual', arms: doorT.arms, primaryOutcome: doorT.primaryOutcome, status: 'running', startedOn: addDays(tonight, -10), endedOn: null, winnerArm: null, seed: 4242, autopilot: false, notes: null, createdAt: Date.now() - 10 * DAY };
  const air: Experiment = {
    id: 'sample-air',
    slug: airT.slug,
    title: airT.title,
    kind: 'auto',
    arms: airT.arms,
    primaryOutcome: airT.primaryOutcome,
    status: 'finished',
    startedOn: addDays(tonight, -36),
    endedOn: addDays(tonight, -15),
    winnerArm: null,
    seed: 777,
    autopilot: true,
    notes: `No clear difference after 21 nights: kept ${airT.arms[0]!.label} as the default.`,
    createdAt: Date.now() - 36 * DAY,
  };
  const r = rng('sample-experiments');
  const nights: ExpNight[] = [];
  const doorArms = blockArms(door.arms, 10, 'door');
  for (let i = 0; i < 10; i++) {
    const open = doorArms[i] === door.arms[1]!.key;
    nights.push({ experimentId: door.id, nightDate: addDays(tonight, -10 + i), armKey: doorArms[i]!, source: 'random', followed: i !== 3, outcomes: sampleOutcomes(r, { co2: open ? -170 : 0, deep: open ? 3 : 0, awak: open ? -0.4 : 0, temp: open ? 0.3 : 0 }) });
  }
  // Tonight: pinned to the second arm ("Door open a crack").
  nights.push({ experimentId: door.id, nightDate: tonight, armKey: door.arms[1]!.key, source: 'pinned', followed: true, outcomes: null });
  const airArms = blockArms(air.arms, 21, 'air');
  for (let i = 0; i < 21; i++) {
    const warm = airArms[i] === air.arms[1]!.key;
    nights.push({ experimentId: air.id, nightDate: addDays(tonight, -36 + i), armKey: airArms[i]!, source: 'random', followed: true, outcomes: sampleOutcomes(r, { co2: 0, deep: warm ? -1 : 0, awak: warm ? 0.1 : 0, temp: warm ? 0.5 : 0 }) });
  }
  const at = (d: string, h: number) => Date.parse(`${d}T00:00:00Z`) - 7 * 3_600_000 + h * 3_600_000;
  const log: ExpLog[] = [
    { id: 'l6', experimentId: door.id, at: at(addDays(tonight, -1), 20.4), kind: 'pin', message: `Tonight pinned to “${door.arms[1]!.label}” by hand.` },
    { id: 'l5', experimentId: door.id, at: at(addDays(tonight, -10), 20.25), kind: 'start', message: `Started “${door.title}”. Nights alternate in random pairs.` },
    { id: 'l4', experimentId: null, at: at(addDays(tonight, -15), 10.5), kind: 'autopilot', message: 'Autopilot: next aircon candidate starts when the household test ends (one test at a time keeps results clean).' },
    { id: 'l3', experimentId: air.id, at: at(addDays(tonight, -15), 10.4), kind: 'finish', message: `Finished after 21 nights. ${air.arms[1]!.label} was not clearly better; kept ${air.arms[0]!.label}.` },
    { id: 'l2', experimentId: air.id, at: at(addDays(tonight, -36), 20.25), kind: 'autopilot', message: `Autopilot started “${air.title}”, the first candidate on its list.` },
    { id: 'l1', experimentId: null, at: at(addDays(tonight, -36), 20.2), kind: 'autopilot', message: 'Autopilot switched on.' },
  ];
  return { experiments: [door, air], nights, log, autopilot: true };
}

let sim: Store | null = null;
const simListeners = new Set<() => void>();
const simStore = () => (sim ??= sampleStore());
function simUpdate(f: (s: Store) => Store) {
  sim = f(simStore());
  simListeners.forEach((l) => l());
}
const logRow = (experimentId: string | null, kind: string, message: string): ExpLog => ({ id: `l${Date.now()}${Math.random()}`, experimentId, at: Date.now(), kind, message });

// ───────────────────────────── the hook ─────────────────────────────

export interface ExperimentsState {
  /** Real rows for a signed-in member; false = the sample on this device. */
  real: boolean;
  canWrite: boolean;
  loading: boolean;
  /** Set when the tables can't be read (e.g. migration not applied yet); the sample is shown instead. */
  error: string | null;
  experiments: Experiment[];
  nights: ExpNight[];
  log: ExpLog[];
  autopilot: boolean;
  /** The coming evening's night_date (the next morning's date, ICT today + 1). */
  tonight: string;
  refresh: () => void;
  create: (t: Template, tonightArm: string | null) => Promise<string | null>;
  pin: (exp: Experiment, night: string, arm: string) => Promise<string | null>;
  mark: (exp: Experiment, night: string, followed: boolean) => Promise<string | null>;
  finish: (exp: Experiment, adopt: boolean) => Promise<string | null>;
  setAutopilot: (on: boolean) => Promise<string | null>;
  /** The last adoption that can still be undone (newest 'adopted' entry with no 'undo' after it), else null. */
  lastAdoption: { curveId: string; previous: string; at: number } | null;
  /** Back to the curve before the last adoption (undo_adoption, owner / member). */
  undoAdoption: () => Promise<string | null>;
}

/** The newest adoption that can be undone: the newest of 'adopted' / 'undo' (log newest first) when it is 'adopted'. */
export function undoableAdoption(log: readonly ExpLog[]): ExperimentsState['lastAdoption'] {
  const last = [...log].filter((l) => l.kind === 'adopted' || l.kind === 'undo').sort((a, b) => b.at - a.at || (Number(b.id) || 0) - (Number(a.id) || 0))[0];
  if (!last || last.kind !== 'adopted' || !last.previous || !last.curveId) return null;
  return { curveId: last.curveId, previous: last.previous, at: last.at };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<string | null> {
  const { error } = await supabaseClient().rpc(name, args);
  return error ? errText(error.message) : null;
}

const armJson = (a: ExperimentArm) => ({ key: a.key, label: a.label, ...(a.curve_id ? { curve_id: a.curve_id } : {}), ...(a.instruction ? { instruction: a.instruction } : {}), ...(a.tag ? { tag: a.tag } : {}) });

export function useExperiments(): ExperimentsState {
  const auth = useAuth();
  const { sourceKind } = useData();
  const member = sourceKind === 'supabase' && auth.status === 'signed-in' && !!auth.probe?.member;
  const writer = member && (auth.probe?.role === 'owner' || auth.probe?.role === 'member');
  const [nonce, setNonce] = useState(0);
  const [simTick, setSimTick] = useState(0);
  const [res, setRes] = useState<{ key: string; store: Store | null; error: string | null } | null>(null);
  // The coming evening's night, as the server counts it (private.next_night_date: ICT date + 1), so a pin made after
  // midnight lands on the next evening, which is what "tonight" means for an experiment.
  const tonight = addDays(ictDate(Date.now()), 1);
  const key = `${member ? 'r' : 's'}:${nonce}`;

  useEffect(() => {
    const l = () => setSimTick((x) => x + 1);
    simListeners.add(l);
    return () => {
      simListeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (!member) return;
    let alive = true;
    const db = supabaseClient();
    const since = addDays(ictDate(Date.now()), -400);
    Promise.all([
      db.from('experiments').select('*').order('created_at', { ascending: false }).limit(50),
      db.from('experiment_nights').select('*').gte('night_date', since).order('night_date', { ascending: true }).limit(1000),
      db.from('experiment_log').select('*').order('at', { ascending: false }).limit(60),
      db.from('household_settings').select('autopilot').eq('id', 1).maybeSingle(),
    ]).then(([e, n, l, h]) => {
      if (!alive) return;
      const err = e.error ?? n.error;
      if (err) return setRes({ key, store: null, error: errText(err.message) });
      setRes({
        key,
        store: {
          experiments: ((e.data ?? []) as Row[]).map(toExperiment),
          nights: ((n.data ?? []) as Row[]).map(toNight),
          log: l.error ? [] : ((l.data ?? []) as Row[]).map(toLog),
          autopilot: !h.error && (h.data as Row | null)?.autopilot === true,
        },
        error: null,
      });
    });
    return () => {
      alive = false;
    };
  }, [member, key]);

  const refresh = useCallback(() => setNonce((x) => x + 1), []);
  const fresh = !!res && res.key === key;
  const real = member && fresh && !!res!.store;
  const loading = member && !fresh;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => (real ? res!.store! : simStore()), [real, res, simTick]);
  const error = member && fresh ? res!.error : null;

  const after = useCallback(async (p: Promise<string | null>) => {
    const e = await p;
    setNonce((x) => x + 1);
    return e;
  }, []);

  const create = useCallback(
    async (t: Template, tonightArm: string | null): Promise<string | null> => {
      if (!real) {
        if (simStore().experiments.some((e) => e.kind === t.kind && !isEnded(e))) return 'Another experiment of this kind is already running. Finish it first.';
        const id = `sample-${t.slug}-${Date.now()}`;
        const exp: Experiment = { id, slug: t.slug, title: t.title, kind: t.kind, arms: [...t.arms], primaryOutcome: t.primaryOutcome, status: 'running', startedOn: tonight, endedOn: null, winnerArm: null, seed: Math.floor(Math.random() * 1e6), autopilot: false, notes: null, createdAt: Date.now() };
        simUpdate((s) => ({
          ...s,
          experiments: [exp, ...s.experiments],
          nights: [...s.nights, { experimentId: id, nightDate: tonight, armKey: tonightArm ?? blockArms(t.arms, 1, id)[0]!, source: tonightArm ? 'pinned' : 'random', followed: true, outcomes: null }],
          log: [logRow(id, 'start', `Started “${t.title}”.`), ...s.log],
        }));
        return null;
      }
      // create_experiment(p_title, p_kind, p_arms, p_primary, p_slug, p_notes, p_started_on, p_pin_tonight) (0025):
      // starts from the server's next night and pins that night in the same call.
      return after(
        rpc('create_experiment', {
          p_title: t.title,
          p_kind: t.kind,
          p_arms: t.arms.map(armJson),
          p_primary: t.primaryOutcome,
          p_slug: t.slug,
          p_pin_tonight: tonightArm,
        }),
      );
    },
    [real, tonight, after],
  );

  const pin = useCallback(
    async (exp: Experiment, night: string, arm: string) => {
      if (!real) {
        const label = exp.arms.find((a) => a.key === arm)?.label ?? arm;
        simUpdate((s) => ({
          ...s,
          nights: [...s.nights.filter((n) => !(n.experimentId === exp.id && n.nightDate === night)), { experimentId: exp.id, nightDate: night, armKey: arm, source: 'pinned', followed: true, outcomes: null }],
          log: [logRow(exp.id, 'pin', `Tonight pinned to “${label}” by hand.`), ...s.log],
        }));
        return null;
      }
      return after(rpc('pin_experiment_arm', { p_experiment: exp.id, p_night: night, p_arm: arm }));
    },
    [real, after],
  );

  const mark = useCallback(
    async (exp: Experiment, night: string, followed: boolean) => {
      if (!real) {
        simUpdate((s) => ({ ...s, nights: s.nights.map((n) => (n.experimentId === exp.id && n.nightDate === night ? { ...n, followed } : n)) }));
        return null;
      }
      return after(rpc('mark_experiment_night', { p_experiment: exp.id, p_night: night, p_followed: followed }));
    },
    [real, after],
  );

  const finish = useCallback(
    async (exp: Experiment, adopt: boolean) => {
      if (!real) {
        simUpdate((s) => {
          const winner = adopt ? analyze(exp, s.nights).winner : null;
          return {
            ...s,
            experiments: s.experiments.map((e) => (e.id === exp.id ? { ...e, status: 'finished', endedOn: ictDate(Date.now()), winnerArm: winner } : e)),
            log: [logRow(exp.id, 'finish', adopt ? `Finished “${exp.title}” and made the winner the default.` : `Finished “${exp.title}”.`), ...s.log],
          };
        });
        return null;
      }
      // p_arm null = the winner stored by the engine's last analysis.
      return after(rpc('finish_experiment', { p_experiment: exp.id, p_adopt: adopt, p_arm: adopt ? analyze(exp, store.nights).winner : null }));
    },
    [real, after, store.nights],
  );

  const setAutopilot = useCallback(
    async (on: boolean) => {
      if (!real) {
        simUpdate((s) => ({ ...s, autopilot: on, log: [logRow(null, 'autopilot', on ? 'Autopilot switched on.' : 'Autopilot switched off.'), ...s.log] }));
        return null;
      }
      return after(rpc('set_autopilot', { p_on: on }));
    },
    [real, after],
  );

  const undoAdoption = useCallback(async () => {
    if (!real) {
      simUpdate((s) => ({ ...s, log: [logRow(null, 'undo', 'Undo: default aircon curve back to the one before.'), ...s.log] }));
      return null;
    }
    return after(rpc('undo_adoption', {}));
  }, [real, after]);
  const lastAdoption = useMemo(() => undoableAdoption(store.log), [store.log]);

  return {
    real,
    lastAdoption,
    undoAdoption,
    // The sample is interactive only where there is no real household to confuse it with (simulator, signed out).
    canWrite: real ? writer : !member,
    loading,
    error,
    experiments: store.experiments,
    nights: store.nights,
    log: store.log,
    autopilot: store.autopilot,
    tonight,
    refresh,
    create,
    pin,
    mark,
    finish,
    setAutopilot,
  };
}

export const isEnded = (e: Pick<Experiment, 'status' | 'endedOn'>) => !!e.endedOn || e.status !== 'running';

/**
 * The one line under Today's night header (core's experimentLine): the selected night's arm, or for the newest night
 * tonight's arm ("Tonight · Experiment: door OPEN a crack (night 1 of ≥8)"). null when no experiment touches it.
 */
export function experimentLine(st: Pick<ExperimentsState, 'experiments' | 'nights'>, nightDate: string, tonight: string, isLatest: boolean): string | null {
  const relevant = st.experiments.filter((e) => !isEnded(e) || (e.endedOn ?? '') >= nightDate);
  for (const e of relevant) {
    const line = coreExperimentLine(toCore(e), nightsOf(e, st.nights), nightDate);
    if (line) return line;
  }
  if (isLatest)
    for (const e of relevant.filter((x) => !isEnded(x))) {
      const line = coreExperimentLine(toCore(e), nightsOf(e, st.nights), tonight);
      if (line) return `Tonight · ${line}`;
    }
  return null;
}
