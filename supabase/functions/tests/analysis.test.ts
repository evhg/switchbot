// Night analysis helpers: morning decay after departure and the data-quality caveat.
import { cleanRoomReadings } from '../../../packages/core/src/metrics/quality.ts';
import type { RoomEvent, RoomReading } from '../../../packages/core/src/types.ts';
import { dataQualityFacts, morningDecay, qualityCaveat } from '../_shared/analysis.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const MIN = 60_000;
const LO = Date.parse('2026-10-29T22:00:00+07:00');
const WAKE = Date.parse('2026-10-30T08:30:00+07:00');
const TO = Date.parse('2026-10-30T12:00:00+07:00');
const row = { date: '2026-10-30', lights_out: new Date(LO).toISOString(), wake: new Date(WAKE).toISOString() } as never;

function night(f: (m: number) => Partial<RoomReading> = () => ({})): RoomReading[] {
  const out: RoomReading[] = [];
  for (let m = -120; m < 840; m++) {
    // occupied: CO2 climbs to ~930; both leave at 09:00 (m = 660): decay with ACH 0.5 to 425.
    const co2 = m < 660 ? 600 + (m > 0 ? Math.min(330, m * 0.6) : m * 1.5) : 425 + 505 * Math.exp((-0.5 * (m - 660)) / 60);
    out.push({ ts: LO + m * MIN, tempC: 18.5 + ((m >> 4) % 3) / 10, rh: 54 + ((m >> 5) % 2), co2: Math.round(co2), source: 'poll', ...f(m) });
  }
  return out;
}

Deno.test('morningDecay fits from the detected departure', () => {
  const room = night();
  const empty: RoomEvent = { kind: 'room_empty', start: LO + 660 * MIN, end: TO, confidence: 0.8 };
  const fit = morningDecay(room, [empty], WAKE, TO);
  assert(fit && fit.from === 'room_empty', `fit ${JSON.stringify(fit)}`);
  assert(Math.abs(fit.ach - 0.5) < 0.08, `ach ${fit.ach}`);
  const fromWake = morningDecay(room, [], WAKE, TO);
  assert(fromWake && fromWake.from === 'wake' && Math.abs(fromWake.ach - 0.5) < 0.08, 'fallback window');
});

Deno.test('qualityCaveat names frozen stretches, gaps and a missing morning decay', () => {
  const raw = night((m) => (m < 22 ? { tempC: 25.1, rh: 64 } : {})).filter((r) => r.ts < LO + 680 * MIN);
  const { quality } = cleanRoomReadings(raw, { from: LO - 120 * MIN, to: TO, lightsOut: LO, wake: WAKE });
  const a = { quality, flags: [...quality.flags, 'no_morning_decay'], decay: null, row };
  const c = qualityCaveat(a);
  assert(c && c.includes('frozen 20:00–22:22') && c.includes('no morning CO₂ decay') && c.includes('96.5%'), `caveat: ${c}`);
  const facts = dataQualityFacts(a);
  assert(facts.frozen[0]!.from === '20:00' && facts.gaps[0]!.from === '09:20', JSON.stringify(facts));
  const withPlateau = qualityCaveat({ ...a, metrics: { achPlateau: 0.36 } });
  assert(withPlateau && withPlateau.includes('estimated from the overnight CO₂ level'), `plateau caveat: ${withPlateau}`);
  const f2 = dataQualityFacts({ ...a, metrics: { achPlateau: 0.36, achPlateauKind: 'upper_bound', achPlateauPpm: 940 } });
  assert(f2.overnightAch?.kind === 'upper_bound' && f2.overnightAch.ach === 0.36, JSON.stringify(f2));
});

Deno.test('qualityCaveat is null for a clean night with a decay', () => {
  const { quality } = cleanRoomReadings(night(), { from: LO - 120 * MIN, to: TO, lightsOut: LO, wake: WAKE });
  assert(qualityCaveat({ quality, flags: quality.flags, decay: { ach: 0.5, r2: 0.99, baseline: 425, start: WAKE, end: TO, from: 'wake' }, row }) === null, 'clean');
});
