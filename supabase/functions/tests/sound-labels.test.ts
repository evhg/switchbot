import { clipCounts, loadCalibration, loadSoundSettings } from '../_shared/sound.ts';
import type { Db } from '../_shared/supabase.ts';
import { clipAllowance, clipAllowed, parseSoundPayload } from '../../../packages/core/src/sound/payload.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

type Row = Record<string, unknown>;

/** A tiny read-only PostgREST stand-in: select / eq / in / not / order / limit / maybeSingle. */
function fakeDb(tables: Record<string, Row[]>): Db {
  const from = (t: string) => {
    const preds: ((r: Row) => boolean)[] = [];
    let order: { c: string; asc: boolean } | null = null;
    let limit = Infinity;
    const run = () => {
      let rows = (tables[t] ?? []).filter((r) => preds.every((p) => p(r)));
      if (order) {
        const { c, asc } = order;
        rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
      }
      return { data: rows.slice(0, limit), error: null };
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
      in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), q),
      not: (c: string) => (preds.push((r) => r[c] != null), q),
      order: (c: string, o?: { ascending?: boolean }) => ((order = { c, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limit = n), q),
      maybeSingle: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return q;
  };
  return { from } as unknown as Db;
}

const missing = { from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'relation "public.sound_labels" does not exist' } }) }) }) }) } as unknown as Db;

Deno.test('settings: borderline clips need migration 0030', async () => {
  const before = await loadSoundSettings(fakeDb({ household_settings: [{ id: 1, sound_mode: 'auto', sound_clips: true, sound_sleeptalk: true }] }));
  eq([before.uncertainClips, before.labels], [0, false], 'before 0030');
  const after = await loadSoundSettings(fakeDb({ household_settings: [{ id: 1, sound_mode: 'auto', sound_clips: true, sound_sleeptalk: true, sound_uncertain_clips: 8 }] }));
  eq([after.uncertainClips, after.labels], [8, true], 'after 0030');
  const off = await loadSoundSettings(fakeDb({ household_settings: [{ id: 1, sound_uncertain_clips: 0 }] }));
  eq(off.uncertainClips, 0, '0 = off');
});

Deno.test('clip allowances: speech, uncertain, other', async () => {
  const db = fakeDb({
    sound_events: [
      { night_date: '2026-11-05', kind: 'snore', label: 'Snoring', clip_path: 'a' },
      { night_date: '2026-11-05', kind: 'other', label: 'Whale vocalization', uncertain: true, clip_path: 'b' },
      { night_date: '2026-11-05', kind: 'other', label: 'Music', uncertain: true, clip_path: 'c' },
      { night_date: '2026-11-05', kind: 'other', label: 'Speech', uncertain: true, clip_path: 'd' },
      { night_date: '2026-11-05', kind: 'other', label: 'Dog', uncertain: true, clip_path: null },
      { night_date: '2026-11-04', kind: 'other', label: 'Music', uncertain: true, clip_path: 'e' },
    ],
  });
  eq(await clipCounts(db, '2026-11-05'), { other: 1, speech: 1, uncertain: 2 }, 'counts');
  const now = Date.parse('2026-11-05T04:20:00+07:00');
  const p = parseSoundPayload({ events: [{ ts: now - 60_000, kind: 'other', label: 'Whale vocalization', uncertain: true, wantClip: true }] }, now);
  const e = p.events[0]!;
  assert(clipAllowed(e, now), 'uncertain non-speech may get a clip');
  eq(clipAllowance(e), 'uncertain', 'its own allowance');
  const sp = parseSoundPayload({ events: [{ ts: now - 60_000, kind: 'other', label: 'Speech', uncertain: true, wantClip: true }] }, now).events[0]!;
  assert(!clipAllowed(sp, now), 'quiet speech marked uncertain still follows the speech rules (sleep talk off)');
  assert(clipAllowed(sp, now, { speech: true }), '… and with sleep talk on');
  eq(clipAllowance(sp), 'speech', 'speech allowance');
});

Deno.test('calibration: labels joined with events and minute floors', async () => {
  const db = fakeDb({
    sound_labels: [
      { event_id: 1, label: 'snore', who: 'a', labelled_at: '2026-11-05T02:00:00+00:00' },
      { event_id: 2, label: 'snore', who: null, labelled_at: '2026-11-05T02:01:00+00:00' },
      { event_id: 3, label: 'snore', who: 'a', labelled_at: '2026-11-05T02:02:00+00:00' },
      { event_id: 4, label: 'not_snore', who: null, labelled_at: '2026-11-05T02:03:00+00:00' },
      { event_id: 99, label: 'snore', who: null, labelled_at: '2026-11-05T02:04:00+00:00' }, // no such event
    ],
    sound_events: [
      { id: 1, ts: '2026-11-04T21:12:03+00:00', camera: 'bedroom', kind: 'other', label: 'Whale vocalization', peak_db: -61, duration_s: 6, score: 0.2, uncertain: true },
      { id: 2, ts: '2026-11-04T21:13:10+00:00', camera: 'bedroom', kind: 'other', label: 'Whale vocalization', peak_db: -60, duration_s: 5, score: 0.25, uncertain: true },
      { id: 3, ts: '2026-11-04T21:13:40+00:00', camera: 'bedroom', kind: 'other', label: 'Music', peak_db: -59, duration_s: 4, score: 0.3, uncertain: true },
      { id: 4, ts: '2026-11-04T21:20:00+00:00', camera: 'bedroom', kind: 'loud', label: 'Door', peak_db: -40, duration_s: 1, score: 0.6, uncertain: false },
    ],
    sound_minutes: [
      { camera: 'bedroom', ts: '2026-11-04T21:12:00.000Z', db_floor: -71 },
      { camera: 'bedroom', ts: '2026-11-04T21:13:00.000Z', db_floor: -70 },
    ],
  });
  const c = await loadCalibration(db);
  eq(c.labels.map((l) => l.eventId), [4, 3, 2, 1], 'newest label first, unknown event skipped');
  eq(c.labels.map((l) => l.floorDb), [null, -70, -70, -71], 'minute floors');
  eq(c.labels[3], {
    eventId: 1,
    ts: '2026-11-04T21:12:03.000Z',
    label: 'snore',
    who: 'a',
    kind: 'other',
    yamnet: 'Whale vocalization',
    peakDb: -61,
    floorDb: -71,
    durationS: 6,
    score: 0.2,
    uncertain: true,
    labelledAt: '2026-11-05T02:00:00.000Z',
  }, 'one label');
  eq(c.summary.counts, { snore: 3, not_snore: 1, speech: 0, other: 0 }, 'counts');
  eq(c.summary.peakAboveFloor, { n: 3, median: 10 }, 'gaps 10, 10, 11');
  eq(c.summary.suggestedPeakAboveFloorDb, 8, 'median − 2');
  eq(c.summary.snoreClasses, [], 'no class has 3 labels yet');

  let threw = false;
  await loadCalibration(missing).catch(() => (threw = true));
  assert(threw, 'before 0030 the read throws (night-sound answers calibration: null)');
  eq((await loadCalibration(fakeDb({ sound_labels: [] }))).summary.suggestedPeakAboveFloorDb, 10, 'no labels: default 10');
});
