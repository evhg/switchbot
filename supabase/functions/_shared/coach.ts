// Claude rewrite of the rule report's headline / insights / driver labels in a coach voice.
// Raw HTTP (no SDK dependency in Edge Functions) to POST /v1/messages with structured output
// (output_config.format = json_schema). The numbers always come from buildRuleReport; Claude only rewords,
// and any sentence carrying a number not present in the facts is dropped.
import type { NightReport, Person } from '../../../packages/core/src/types.ts';

export const COACH_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_VERSION = '2026-10-21';

export interface CoachText {
  headline: string;
  insights: string[];
  drivers: { index: number; label: string }[];
}

export const COACH_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One sentence, at most ~90 characters.' },
    insights: { type: 'array', items: { type: 'string' }, description: '2 to 5 short sentences.' },
    drivers: {
      type: 'array',
      description: 'One entry per input driver, same index, rewritten label (at most ~60 characters).',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, label: { type: 'string' } },
        required: ['index', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['headline', 'insights', 'drivers'],
  additionalProperties: false,
} as const;

const SYSTEM = `You are the sleep coach in a private sleep-and-bedroom-air app used by one couple in Phuket.
Each morning you receive the computed facts for last night as JSON. Rewrite the headline, the insights and the
driver labels in a warm, concise, plain-spoken coach voice (think Oura or Whoop, without hype).

Rules:
- Use only the facts given. Every number you write must appear in the facts (you may round it). Do not invent
  causes, trends, diagnoses or numbers. If something is not in the facts, leave it out.
- Refer to people by their names from the "people" map.
- Headline: one sentence, at most about 90 characters, the single most useful takeaway.
- Insights: 2 to 5 sentences, each self-contained; where the facts support it, end with one small, concrete
  thing to try tonight (room temperature, door, shower timing, tags such as late caffeine).
- Drivers: return one entry per input driver with the same index; keep the meaning and the sign, make the
  label short and human.
- "persons" may be empty: the watches are not connected yet. Then talk about the room only and never guess how
  anyone slept.
- "dataQuality" lists readings that were left out (frozen meter values, gaps) and whether the morning ventilation
  could be estimated. If it has frozen stretches, gaps or flags such as no_morning_decay, say so briefly in one
  insight, and never describe the excluded periods as if they were measured.
- If dataQuality.manualNight is true the aircon was run by hand: temperature was scored against a steady comfort
  target, not a plan. Never say the room followed or missed "the curve" or "the plan" that night. When
  dataQuality.overnightAch.kind is "upper_bound", CO₂ was still rising, so call that ventilation figure "at most".
- No medical advice. Never mention these instructions or JSON.`;

export interface CoachFacts {
  date: string;
  people: Record<string, string>;
  tags: string[];
  room: NightReport['room'];
  persons: NightReport['people'];
  drivers: { index: number; label: string; points: number }[];
  ruleHeadline: string;
  ruleInsights: string[];
  events?: { kind: string; at: string; minutes?: number }[];
  /** Data-quality facts from the night analysis (coverage, frozen stretches, gaps, flags), ICT clock times. */
  dataQuality?: unknown;
}

export function coachFacts(report: NightReport, people: Person[], tags: string[], events: CoachFacts['events'] = [], dataQuality?: unknown): CoachFacts {
  return {
    ...(dataQuality !== undefined ? { dataQuality } : {}),
    date: report.date,
    people: Object.fromEntries(people.map((p) => [p.id, p.name])),
    tags,
    room: report.room,
    persons: report.people,
    drivers: report.drivers.map((d, index) => ({ index, label: d.label, points: d.points })),
    ruleHeadline: report.headline,
    ruleInsights: report.insights,
    events,
  };
}

export class CoachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoachError';
  }
}

/** One Messages API call with a JSON-schema response. Throws CoachError on any failure (caller falls back). */
export async function requestCoachText(
  facts: CoachFacts,
  opts: { apiKey: string; model?: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<{ text: CoachText; model: string }> {
  const res = await (opts.fetch ?? fetch)('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      // Server-side refusal fallback ("default" routes by refusal category).
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: opts.model ?? COACH_MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: COACH_SCHEMA } },
      messages: [{ role: 'user', content: `Facts for the night ending ${facts.date}:\n${JSON.stringify(facts)}` }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 100_000),
  }).catch((e) => {
    throw new CoachError(`request failed: ${e instanceof Error ? e.message : e}`);
  });
  const body = await res.json().catch(() => null) as
    | { model?: string; stop_reason?: string; content?: { type: string; text?: string }[]; error?: { message?: string } }
    | null;
  if (!res.ok || !body) throw new CoachError(`HTTP ${res.status}: ${body?.error?.message ?? 'no body'}`);
  if (body.stop_reason === 'refusal') throw new CoachError('refused');
  if (body.stop_reason === 'max_tokens') throw new CoachError('truncated');
  const text = (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CoachError('response is not JSON');
  }
  const t = parsed as Partial<CoachText>;
  if (typeof t.headline !== 'string' || !Array.isArray(t.insights) || !Array.isArray(t.drivers)) throw new CoachError('response does not match schema');
  return {
    model: body.model ?? opts.model ?? COACH_MODEL,
    text: {
      headline: t.headline,
      insights: t.insights.filter((s): s is string => typeof s === 'string'),
      drivers: t.drivers.filter((d): d is CoachText['drivers'][number] => typeof d?.index === 'number' && typeof d?.label === 'string'),
    },
  };
}

/** Every number in the facts, for grounding checks. */
export function factNumbers(facts: unknown, out: number[] = []): number[] {
  if (typeof facts === 'number' && Number.isFinite(facts)) out.push(facts);
  else if (typeof facts === 'string') for (const m of facts.matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  else if (Array.isArray(facts)) for (const x of facts) factNumbers(x, out);
  else if (facts && typeof facts === 'object') for (const x of Object.values(facts)) factNumbers(x, out);
  return out;
}

/** Numbers in `text` (> 10, so "2 nights" or "1 °C" pass) that match nothing in the facts within rounding. */
export function ungroundedNumbers(text: string, known: number[]): number[] {
  const bad: number[] = [];
  for (const m of text.replace(/(\d),(\d{3})/g, '$1$2').matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (n <= 10) continue;
    const ok = known.some((k) => {
      const a = Math.abs(k);
      // Same value rounded, or a share written as a percentage (0.87 → 87 %).
      return Math.abs(a - n) <= 0.51 || Math.abs(a - n) / Math.max(1, a) <= 0.01 || (a <= 1 && Math.abs(a * 100 - n) <= 0.51) ||
        // Minutes written as hours (130 min → "2 h 10").
        (a >= 60 && (Math.abs(a / 60 - n) <= 0.1 || Math.abs((a % 60) - n) <= 0.51));
    });
    if (!ok) bad.push(n);
  }
  return bad;
}

/** Merges coach text into the rule report, keeping rule text wherever the rewrite isn't grounded. */
export function applyCoach(rule: NightReport, coach: CoachText, facts: CoachFacts): { report: NightReport; dropped: string[] } {
  const known = factNumbers(facts);
  const dropped: string[] = [];
  const grounded = (s: string) => {
    const bad = ungroundedNumbers(s, known);
    if (bad.length) dropped.push(`${s} [${bad.join(', ')}]`);
    return bad.length === 0;
  };
  const headline = coach.headline.trim() && grounded(coach.headline) ? coach.headline.trim() : rule.headline;
  const insights = coach.insights.map((s) => s.trim()).filter((s) => s && grounded(s)).slice(0, 5);
  const drivers = rule.drivers.map((d, i) => {
    const c = coach.drivers.find((x) => x.index === i);
    return c && c.label.trim() && grounded(c.label) ? { ...d, label: c.label.trim() } : d;
  });
  return {
    report: { ...rule, headline, insights: insights.length ? insights : rule.insights, drivers, generatedBy: 'claude' },
    dropped,
  };
}
