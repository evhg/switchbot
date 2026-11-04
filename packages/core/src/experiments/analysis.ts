// Experiment analysis: outcome definitions, the composite sleep score, balanced randomisation and the verdict (pure).
import { addDays } from '../sim/time.ts';
import { mean, sd, seededRandom, shuffled, welchPosterior } from './stats.ts';
import type { Experiment, ExperimentArm, ExperimentNight, NightOutcomes, PersonOutcomes } from './types.ts';

/** Counted nights each arm needs before a verdict. */
export const MIN_NIGHTS_PER_ARM = 4;
/** Counted nights after which an experiment finishes on its own. */
export const MAX_EXPERIMENT_NIGHTS = 21;
/** P(better) on the primary outcome for "clear winner". */
export const CLEAR_P = 0.9;
/** P(better) for "leaning". */
export const LEANING_P = 0.75;
/** People in the household: a = Cath, b = Erik (people.name in the app). */
export const EXPERIMENT_PEOPLE: Record<string, string> = { a: 'Cath', b: 'Erik' };

export interface OutcomeDef {
  key: string;
  label: string;
  unit: string;
  better: 'higher' | 'lower';
  /** Shown, never used for the verdict (room temperature is what an aircon arm sets, not a result). */
  info?: boolean;
  /** Words for a positive / negative difference: ['more', 'fewer']. */
  words: [string, string];
  decimals: number;
  /** Person id for per-person outcomes. */
  person?: string;
}

type PersonMetric = 'score' | 'onset' | 'deep' | 'rem' | 'awake' | 'awakenings';
const PERSON_METRICS: { m: PersonMetric; label: string; unit: string; better: 'higher' | 'lower'; words: [string, string]; decimals: number }[] = [
  { m: 'score', label: 'sleep score', unit: '', better: 'higher', words: ['higher', 'lower'], decimals: 2 },
  { m: 'onset', label: 'time to fall asleep', unit: 'min', better: 'lower', words: ['longer', 'shorter'], decimals: 0 },
  { m: 'deep', label: 'deep sleep', unit: 'min', better: 'higher', words: ['more', 'less'], decimals: 0 },
  { m: 'rem', label: 'REM sleep', unit: 'min', better: 'higher', words: ['more', 'less'], decimals: 0 },
  { m: 'awake', label: 'time awake', unit: 'min', better: 'lower', words: ['more', 'less'], decimals: 0 },
  { m: 'awakenings', label: 'awakenings', unit: '', better: 'lower', words: ['more', 'fewer'], decimals: 1 },
];

/**
 * Every outcome an experiment reports, in display order. Keys: sleep_score, co2_mean, co2_over_1000, snore_min,
 * temp_mean, and per person `<id>_score | _onset | _deep | _rem | _awake | _awakenings` (a = Cath, b = Erik).
 */
export function outcomeDefs(names: Record<string, string> = EXPERIMENT_PEOPLE): OutcomeDef[] {
  const out: OutcomeDef[] = [
    { key: 'sleep_score', label: 'Sleep score', unit: '', better: 'higher', words: ['higher', 'lower'], decimals: 2 },
    { key: 'co2_mean', label: 'CO₂', unit: 'ppm', better: 'lower', words: ['higher', 'lower'], decimals: 0 },
    { key: 'co2_over_1000', label: 'Time over 1000 ppm', unit: 'min', better: 'lower', words: ['more', 'less'], decimals: 0 },
  ];
  for (const [id, name] of Object.entries(names)) {
    for (const p of PERSON_METRICS) out.push({ key: `${id}_${p.m}`, label: `${name}'s ${p.label}`, unit: p.unit, better: p.better, words: p.words, decimals: p.decimals, person: id });
  }
  out.push(
    { key: 'snore_min', label: 'Snoring', unit: 'min', better: 'lower', words: ['more', 'less'], decimals: 0 },
    { key: 'temp_mean', label: 'Room temp', unit: '°C', better: 'lower', info: true, words: ['warmer', 'cooler'], decimals: 1 },
  );
  return out;
}

const PERSON_FIELD: Record<Exclude<PersonMetric, 'score'>, keyof PersonOutcomes> = {
  onset: 'onsetMin',
  deep: 'deepMin',
  rem: 'remMin',
  awake: 'awakeMin',
  awakenings: 'awakenings',
};

/** Does a night have the raw data for an outcome? (sleep_score / <id>_score need the person's stages.) */
export function hasOutcome(o: NightOutcomes | null, key: string): boolean {
  if (!o) return false;
  if (key === 'sleep_score') return Object.keys(o.people).length > 0;
  const m = /^([a-z0-9]+)_(score|onset|deep|rem|awake|awakenings)$/.exec(key);
  if (m) return !!o.people[m[1]!];
  return outcomeValue(o, key) !== null;
}

/**
 * One outcome's value for a night. `scores` (from sleepScores) is needed for sleep_score and <id>_score; the household
 * sleep_score is the mean of the people's scores that night.
 */
export function outcomeValue(o: NightOutcomes | null, key: string, scores?: Record<string, number>): number | null {
  if (!o) return null;
  switch (key) {
    case 'co2_mean':
      return o.co2Mean;
    case 'co2_over_1000':
      return o.co2Over1000Min;
    case 'temp_mean':
      return o.tempMean;
    case 'snore_min':
      return o.snoreMin;
    case 'sleep_score': {
      const xs = Object.keys(o.people).map((id) => scores?.[id]).filter((x): x is number => typeof x === 'number');
      return xs.length ? mean(xs) : null;
    }
  }
  const m = /^([a-z0-9]+)_(score|onset|deep|rem|awake|awakenings)$/.exec(key);
  if (!m) return null;
  const p = o.people[m[1]!];
  if (!p) return null;
  if (m[2] === 'score') return scores?.[m[1]!] ?? null;
  return p[PERSON_FIELD[m[2] as Exclude<PersonMetric, 'score'>]];
}

/**
 * The composite "Sleep score" per person and night: the mean of four z-scores against the experiment's own nights
 * (all counted nights of both arms pooled, per person):  (z(deep) + z(REM) − z(awake min) − z(awakenings)) / 4.
 * 0 = an average night of this experiment; +0.5 = half a standard deviation better on those four on average. A
 * component without spread counts 0. Comparing arms on it weighs deep, REM, wakefulness and awakenings equally.
 */
export function sleepScores(nights: readonly Pick<ExperimentNight, 'nightDate' | 'outcomes'>[]): Map<string, Record<string, number>> {
  const ids = new Set<string>();
  for (const n of nights) for (const id of Object.keys(n.outcomes?.people ?? {})) ids.add(id);
  const out = new Map<string, Record<string, number>>(nights.map((n) => [n.nightDate, {}]));
  for (const id of ids) {
    const rows = nights.filter((n) => n.outcomes?.people[id]);
    const stat = (f: (p: PersonOutcomes) => number) => {
      const xs = rows.map((n) => f(n.outcomes!.people[id]!));
      return { m: mean(xs), s: sd(xs) };
    };
    const deep = stat((p) => p.deepMin), rem = stat((p) => p.remMin), awake = stat((p) => p.awakeMin), aw = stat((p) => p.awakenings);
    const z = (x: number, st: { m: number; s: number }) => (st.s > 0 ? (x - st.m) / st.s : 0);
    for (const n of rows) {
      const p = n.outcomes!.people[id]!;
      const score = (z(p.deepMin, deep) + z(p.remMin, rem) - z(p.awakeMin, awake) - z(p.awakenings, aw)) / 4;
      out.get(n.nightDate)![id] = Math.round(score * 1000) / 1000;
    }
  }
  return out;
}

/**
 * Days after a night during which its outcomes are still recomputed for late syncs (the experiments function's
 * RECOMPUTE_DAYS): a night computed without data inside this period may still fill in.
 */
export const OUTCOMES_PENDING_DAYS = 2;

/** Does this night count? Followed, an arm of the experiment, and (once computed) data for the primary outcome. */
export function nightCounts(exp: Pick<Experiment, 'arms' | 'primaryOutcome'>, n: ExperimentNight, pendingCounts = false): boolean {
  if (!n.followed || !exp.arms.some((a) => a.key === n.armKey)) return false;
  if (n.outcomes === null) return pendingCounts;
  return hasOutcome(n.outcomes, exp.primaryOutcome);
}

/**
 * Tonight's arm by balanced randomisation in blocks of (number of arms): each block of counted nights gets every arm
 * once, in an order shuffled with the experiment's seed and the block number, so the sequence is reproducible. Nights
 * that don't count (didn't follow, data missing) do not advance the sequence: the next night repeats the slot. Pinned
 * nights take their place in the block; when pins already used every arm of the block, the arm with the fewest counted
 * nights is chosen. Nights not yet computed count as planned, and so do nights computed without data that may still
 * fill in (the last OUTCOMES_PENDING_DAYS days before tonight's evening).
 */
export function assignArm(exp: Pick<Experiment, 'arms' | 'primaryOutcome' | 'seed'>, nights: readonly ExperimentNight[], nightDate: string): string {
  const keys = exp.arms.map((a) => a.key);
  // A night computed without the primary outcome but still inside the recompute period (sleep not synced yet) is
  // pending: it keeps its slot, so a late sync can't leave two nights of one block with the same arm.
  const stillPending = (n: ExperimentNight) => n.outcomes !== null && n.nightDate >= addDays(nightDate, -(OUTCOMES_PENDING_DAYS + 1));
  const counted = nights
    .filter((n) => n.nightDate < nightDate && (nightCounts(exp, n, true) || (n.followed && exp.arms.some((a) => a.key === n.armKey) && stillPending(n))))
    .sort((a, b) => a.nightDate.localeCompare(b.nightDate));
  const k = keys.length;
  const block = Math.floor(counted.length / k);
  const pos = counted.length % k;
  const used = counted.slice(counted.length - pos).map((n) => n.armKey);
  const order = shuffled(keys, seededRandom((exp.seed >>> 0) ^ Math.imul(block + 1, 0x9e3779b1)));
  const free = order.find((key) => !used.includes(key));
  if (free) return free;
  const totals = new Map(keys.map((key) => [key, counted.filter((n) => n.armKey === key).length]));
  return [...order].sort((a, b) => totals.get(a)! - totals.get(b)!)[0]!;
}

export interface ArmStats {
  n: number;
  mean: number | null;
  sd: number | null;
}

export interface OutcomeResult extends Omit<OutcomeDef, 'words' | 'decimals'> {
  arms: Record<string, ArmStats>;
  /** The challenger compared with the control (the first arm). */
  versus: string;
  /** mean(versus) − mean(control); null with fewer than 2 nights in either arm. */
  diff: number | null;
  /** 90 % interval of diff. */
  lo: number | null;
  hi: number | null;
  /** P(the challenger is better than the control) for this outcome. */
  pBetter: number | null;
  /** Plain text: "CO₂ 180 ppm lower (90 %: 120–240)". */
  text: string | null;
}

export type AnalysisStatus = 'running' | 'leaning' | 'clear_winner' | 'no_difference';

export interface ExperimentAnalysis {
  status: AnalysisStatus;
  /** The experiment reached maxNights counted nights: it finishes on its own. */
  done: boolean;
  primary: OutcomeResult | null;
  perOutcome: OutcomeResult[];
  /** One or two plain sentences. */
  verdict: string;
  control: string;
  /** Challenger with the best primary result (the only challenger with 2 arms). */
  leader: string;
  /** The winning arm when status is clear_winner, else null. */
  winner: string | null;
  /** Counted nights per arm. */
  counts: Record<string, number>;
  counted: number;
  /** Nights assigned but not counted (didn't follow / data missing). */
  excluded: number;
  minPerArm: number;
  maxNights: number;
  /** Per primary, every challenger vs the control (3 arms). */
  comparisons: { arm: string; pBetter: number | null; diff: number | null }[];
}

function fmt(x: number, decimals: number): string {
  return decimals === 0 ? String(Math.round(x)) : String(Math.round(x * 10 ** decimals) / 10 ** decimals);
}

function outcomeText(d: OutcomeDef, diff: number, lo: number | null, hi: number | null, withInterval: boolean): string {
  const word = diff >= 0 ? d.words[0] : d.words[1];
  const mag = Math.abs(diff);
  const unit = d.unit ? ` ${d.unit}` : '';
  let s = `${d.label} ${fmt(mag, d.decimals)}${unit} ${word}`;
  if (withInterval && lo !== null && hi !== null) {
    const [a, b] = diff >= 0 ? [lo, hi] : [-hi, -lo];
    // An interval that crosses zero: signed bounds with a true minus and "to" ("−0.27 to 0.43"), never "-0.27–0.43".
    const num = (x: number) => {
      const t = fmt(Math.abs(x), d.decimals);
      return x < 0 && Number(t) !== 0 ? `−${t}` : t;
    };
    s += a < 0 || b < 0 ? ` (90 %: ${num(a)} to ${num(b)})` : ` (90 %: ${num(a)}–${num(b)})`;
  }
  return s;
}

const judge = (p: number) =>
  p >= CLEAR_P ? 'clearly better' : p >= LEANING_P ? 'likely better' : p <= 1 - CLEAR_P ? 'clearly worse' : p <= 1 - LEANING_P ? 'likely worse' : 'no clear difference';

/**
 * Compare the arms of an experiment. Per outcome: arm means, the difference challenger − control, its 90 % interval
 * and P(challenger better), from the Welch t posterior (flat priors, unequal variances). Status on the primary
 * outcome: 'running' until every arm has minPerArm counted nights, then 'clear_winner' (P ≥ 0.9 either way),
 * 'leaning' (P ≥ 0.75 either way) or 'no_difference'. done after maxNights counted nights.
 */
export function analyzeExperiment(exp: Experiment, nights: readonly ExperimentNight[], opts: { names?: Record<string, string> } = {}): ExperimentAnalysis {
  const names = opts.names ?? EXPERIMENT_PEOPLE;
  const defs = outcomeDefs(names);
  const minPerArm = exp.minPerArm ?? MIN_NIGHTS_PER_ARM;
  const maxNights = exp.maxNights ?? MAX_EXPERIMENT_NIGHTS;
  const keys = exp.arms.map((a) => a.key);
  const control = keys[0]!;
  const usable = nights.filter((n) => n.followed && n.outcomes !== null && keys.includes(n.armKey));
  const counted = usable.filter((n) => hasOutcome(n.outcomes, exp.primaryOutcome));
  const excluded = nights.filter((n) => keys.includes(n.armKey) && (!n.followed || (n.outcomes !== null && !hasOutcome(n.outcomes, exp.primaryOutcome)))).length;
  const scores = sleepScores(usable);
  const counts = Object.fromEntries(keys.map((k) => [k, counted.filter((n) => n.armKey === k).length]));

  const values = (key: string, arm: string) =>
    usable.filter((n) => n.armKey === arm).map((n) => outcomeValue(n.outcomes, key, scores.get(n.nightDate))).filter((x): x is number => x !== null && Number.isFinite(x));
  const compare = (d: OutcomeDef, arm: string) => {
    const post = welchPosterior(values(d.key, control), values(d.key, arm));
    if (!post) return { diff: null, lo: null, hi: null, pBetter: null };
    return { diff: post.diff, lo: post.lo, hi: post.hi, pBetter: d.better === 'higher' ? post.pPositive : 1 - post.pPositive };
  };

  const primaryDef = defs.find((d) => d.key === exp.primaryOutcome) ?? defs[0]!;
  const comparisons = keys.slice(1).map((arm) => ({ arm, ...compare(primaryDef, arm) }));
  const leader = comparisons.reduce((best, c) => ((c.pBetter ?? -1) > (best.pBetter ?? -1) ? c : best), comparisons[0]!).arm;

  const perOutcome: OutcomeResult[] = defs.map((d) => {
    const arms = Object.fromEntries(keys.map((k) => {
      const xs = values(d.key, k);
      return [k, { n: xs.length, mean: xs.length ? mean(xs) : null, sd: xs.length >= 2 ? sd(xs) : null }];
    }));
    const c = compare(d, leader);
    const { words: _w, decimals: _d, ...rest } = d;
    return { ...rest, arms, versus: leader, ...c, text: c.diff === null ? null : outcomeText(d, c.diff, c.lo, c.hi, true) };
  });
  const primary = perOutcome.find((o) => o.key === primaryDef.key) ?? null;

  const enough = keys.every((k) => counts[k]! >= minPerArm);
  const pLead = primary?.pBetter ?? null;
  const pMax = Math.max(...comparisons.map((c) => c.pBetter ?? 0.5));
  let status: AnalysisStatus = 'running';
  let winner: string | null = null;
  if (enough && pLead !== null) {
    if (pLead >= CLEAR_P) {
      status = 'clear_winner';
      winner = leader;
    } else if (pMax <= 1 - CLEAR_P) {
      status = 'clear_winner';
      winner = control;
    } else if (pLead >= LEANING_P || pMax <= 1 - LEANING_P) status = 'leaning';
    else status = 'no_difference';
  }

  const label = (k: string) => exp.arms.find((a) => a.key === k)?.label ?? k;
  const nightsText = keys.length === 2 ? `${counts[control]} vs ${counts[leader]} nights.` : `${keys.map((k) => counts[k]).join(' / ')} nights.`;
  // Highlights: the primary first (with its interval), then up to two other outcomes with a clear direction.
  const defOf = (key: string) => defs.find((d) => d.key === key)!;
  const others = perOutcome
    .filter((o) => o.key !== primaryDef.key && !o.info && o.pBetter !== null && o.diff !== null && Math.abs(o.pBetter - 0.5) >= 0.3)
    .sort((a, b) => Math.abs(b.pBetter! - 0.5) - Math.abs(a.pBetter! - 0.5))
    .slice(0, 2);
  const parts: string[] = [];
  if (primary?.diff !== null && primary?.diff !== undefined) parts.push(outcomeText(primaryDef, primary.diff, primary.lo, primary.hi, true));
  for (const o of others) parts.push(outcomeText(defOf(o.key), o.diff!, o.lo, o.hi, parts.length === 0));
  const highlights = parts.join(', ');

  let verdict: string;
  if (!enough) {
    verdict = `Too early: ${nightsText.replace(/\.$/, '')} so far, ${minPerArm} each needed.` + (highlights ? ` So far ${label(leader)}: ${highlights}.` : '');
  } else if (status === 'clear_winner' && winner === control) {
    verdict = `${label(control)} wins${highlights ? ` — ${label(leader)}: ${highlights}` : ''} (P=${fmt(1 - pMax, 2)}). ${nightsText}`;
  } else {
    verdict = `${label(leader)}: ${highlights || 'no difference in the numbers yet'} — ${judge(pLead ?? 0.5)} (P=${fmt(pLead ?? 0.5, 2)}). ${nightsText}`;
  }
  return {
    status,
    done: counted.length >= maxNights,
    primary,
    perOutcome,
    verdict,
    control,
    leader,
    winner,
    counts,
    counted: counted.length,
    excluded,
    minPerArm,
    maxNights,
    comparisons: comparisons.map(({ arm, pBetter, diff }) => ({ arm, pBetter, diff })),
  };
}

/** Arm of `key` (or undefined). */
export const armOf = (exp: Pick<Experiment, 'arms'>, key: string | null | undefined): ExperimentArm | undefined => exp.arms.find((a) => a.key === key);

/**
 * The one line under the night header (Today) and in the morning: "Experiment: door OPEN a crack (night 1 of ≥8)";
 * Autopilot: "Autopilot is testing 18.5 °C, 19.5 °C from 03:00: tonight Steady … (night 3 of ≥12)". null when the
 * experiment has no arm for that night.
 */
export function experimentLine(exp: Experiment, nights: readonly ExperimentNight[], nightDate: string): string | null {
  const n = nights.find((x) => x.nightDate === nightDate);
  const arm = armOf(exp, n?.armKey);
  if (!n || !arm) return null;
  const index = nights.filter((x) => x.nightDate <= nightDate && x.followed).length || 1;
  const total = exp.arms.length * (exp.minPerArm ?? MIN_NIGHTS_PER_ARM);
  const what = exp.kind === 'manual' ? lowerFirst(arm.instruction ?? arm.label) : arm.label;
  const head = exp.autopilot ? `Autopilot is testing ${armOf(exp, exp.arms[1]?.key)?.label ?? exp.title}: tonight ${arm.label}` : `Experiment: ${what}`;
  return `${head} (night ${index} of ≥${total})`;
}

function lowerFirst(s: string): string {
  // "Door OPEN a crack" → "door OPEN a crack" (keeps the shouted word).
  return s.length > 1 && s[1] === s[1]!.toLowerCase() ? s[0]!.toLowerCase() + s.slice(1) : s;
}
