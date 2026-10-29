import { DEFAULT_CURVE } from '../../../packages/core/src/curve.ts';
import { buildRuleReport } from '../../../packages/core/src/metrics/report.ts';
import { DEFAULT_PEOPLE } from '../../../packages/core/src/sim/people.ts';
import { simulateNights } from '../../../packages/core/src/sim/simulate.ts';
import { ANTHROPIC_VERSION, applyCoach, COACH_MODEL, coachFacts, requestCoachText, ungroundedNumbers } from '../_shared/coach.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const nights = simulateNights({ nights: 9, seed: 7, endDate: '2026-10-20' });
const night = nights[nights.length - 1]!;
const rule = buildRuleReport(night, nights.slice(0, -1), DEFAULT_CURVE);
const facts = coachFacts(rule, DEFAULT_PEOPLE, night.tags);

Deno.test('ungroundedNumbers accepts rounding, percentages and h/min, rejects invented values', () => {
  assert(ungroundedNumbers('CO2 peaked at 1,234 ppm', [1233.6]).length === 0, 'rounded ppm');
  assert(ungroundedNumbers('on target 87% of the night', [0.871]).length === 0, 'share as %');
  assert(ungroundedNumbers('2 h 10 min above 1000', [130, 1000]).length === 0, 'minutes as h/min');
  assert(ungroundedNumbers('deep sleep was 95 minutes', [61, 1000]).join() === '95', 'invented number');
});

Deno.test('requestCoachText sends a structured-output request and parses the JSON text', async () => {
  let sent: { headers: Record<string, string>; body: Record<string, unknown> } | null = null;
  const fake = ((_url: string, init?: RequestInit) => {
    sent = { headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) };
    const text = JSON.stringify({ headline: 'A cool, steady night.', insights: ['Nice and calm.'], drivers: [{ index: 0, label: 'Fresh air' }] });
    return Promise.resolve(Response.json({ model: COACH_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text }] }));
  }) as typeof fetch;
  const out = await requestCoachText(facts, { apiKey: 'k', fetch: fake });
  assert(out.text.headline === 'A cool, steady night.' && out.text.drivers[0]?.label === 'Fresh air', 'parsed');
  const s = sent!;
  assert(s.headers['x-api-key'] === 'k' && s.headers['anthropic-version'] === ANTHROPIC_VERSION, 'headers');
  assert(s.body.model === 'claude-opus-5-5', 'model');
  const oc = s.body.output_config as { format: { type: string; schema: { required: string[] } } };
  assert(oc.format.type === 'json_schema' && oc.format.schema.required.includes('insights'), 'output_config.format');
});

Deno.test('requestCoachText throws on refusal and HTTP errors', async () => {
  for (const res of [
    Response.json({ stop_reason: 'refusal', content: [] }),
    Response.json({ error: { message: 'overloaded' } }, { status: 529 }),
    Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }),
  ]) {
    let threw = false;
    try {
      await requestCoachText(facts, { apiKey: 'k', fetch: (() => Promise.resolve(res)) as typeof fetch });
    } catch {
      threw = true;
    }
    assert(threw, 'expected CoachError');
  }
});

Deno.test('applyCoach keeps numbers from the rules and drops ungrounded sentences', () => {
  const co2 = Math.round(rule.room.co2Max);
  const { report, dropped } = applyCoach(rule, {
    headline: `CO₂ reached ${co2} ppm last night.`,
    insights: ['Your deep sleep was 777 minutes.', 'The room held the curve well.'],
    drivers: [{ index: 0, label: 'Air quality' }, { index: 99, label: 'ignored' }],
  }, facts);
  assert(report.generatedBy === 'claude', 'generatedBy');
  assert(report.headline.includes(String(co2)), 'grounded headline kept');
  assert(report.insights.length === 1 && dropped.length === 1, 'ungrounded insight dropped');
  assert(report.drivers[0]!.label === 'Air quality' && report.drivers[0]!.points === rule.drivers[0]!.points, 'driver relabelled, points kept');
  assert(report.drivers.length === rule.drivers.length, 'driver count');
});
