// _shared/sleeptalk.ts against a small in-memory PostgREST stand-in: paging past busy nights, the "Save sleep talk"
// switch and the counting rule of the summary, and the two-step removal of a conversation's clip.
import { judgeSleepTalkNights, sleepTalkSummary, UPLOAD_GRACE_MS } from '../_shared/sleeptalk.ts';
import type { Db } from '../_shared/supabase.ts';

function eq<T>(a: T, b: T, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;

/** Only the operators sleeptalk.ts uses; `or` understands '<col>.not.is.null' / '<col>.is.null' / '<col>.eq.<v>'. */
function orPred(expr: string): Pred {
  const parts = expr.split(',').map((p) => {
    const [col, ...rest] = p.split('.');
    const op = rest.join('.');
    if (op === 'not.is.null') return (r: Row) => r[col!] != null;
    if (op === 'is.null') return (r: Row) => r[col!] == null;
    if (op.startsWith('eq.')) return (r: Row) => String(r[col!]) === op.slice(3);
    throw new Error(`or: ${p}`);
  });
  return (r) => parts.some((f) => f(r));
}

function fakeDb(tables: Record<string, Row[]>, removed: string[], maxRows = 1000) {
  const from = (table: string) => {
    const preds: Pred[] = [];
    let patch: Row | null = null;
    let range: [number, number] | null = null;
    let limit = Infinity;
    const orders: string[] = [];
    const run = () => {
      const rows = (tables[table] ??= []).filter((r) => preds.every((p) => p(r)));
      if (patch) {
        for (const r of rows) Object.assign(r, patch);
        return { data: rows, error: null };
      }
      const sorted = [...rows].sort((a, b) => {
        for (const c of orders) if (a[c] !== b[c]) return String(a[c]) < String(b[c]) ? -1 : 1;
        return 0;
      });
      const lo = range ? range[0] : 0;
      const hi = Math.min(range ? range[1] + 1 : Infinity, lo + Math.min(limit, maxRows));
      return { data: sorted.slice(lo, hi), error: null };
    };
    const q = {
      select: () => q,
      update: (p: Row) => ((patch = p), q),
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
      in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), q),
      is: (c: string, v: null) => (preds.push((r) => r[c] === v || (v === null && r[c] === undefined)), q),
      not: (c: string, _op: 'is', _v: null) => (preds.push((r) => r[c] != null), q),
      lt: (c: string, v: string) => (preds.push((r) => String(r[c]) < v), q),
      gte: (c: string, v: string) => (preds.push((r) => String(r[c]) >= v), q),
      or: (e: string) => (preds.push(orPred(e)), q),
      order: (c: string) => (orders.push(c), q),
      range: (a: number, b: number) => ((range = [a, b]), q),
      limit: (n: number) => ((limit = n), q),
      maybeSingle: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return q;
  };
  const storage = { from: () => ({ remove: (paths: string[]) => (removed.push(...paths), Promise.resolve({ data: [], error: null })) }) };
  return { from, storage } as unknown as Db;
}

const t = (s: string) => Date.parse(`${s}+07:00`);
const isoT = (s: string) => new Date(t(s)).toISOString();
const NIGHT = '2026-11-05';
const PEOPLE = ['a', 'b'];
const NAMES = { a: 'Cath', b: 'Erik' };

function session(person: string) {
  // Asleep (light) 23:00 → 07:00 ICT.
  return { person_id: person, start_ts: isoT('2026-11-04T23:00:00'), end_ts: isoT(`${NIGHT}T07:00:00`), stages: [{ start: t('2026-11-04T23:00:00'), end: t(`${NIGHT}T07:00:00`), stage: 'light' }] };
}

function setup(sleeptalk = true) {
  let id = 0;
  const ev = (ts: string, kind: string, extra: Row = {}): Row => ({
    id: ++id, camera: 'mac', ts: isoT(ts), night_date: NIGHT, duration_s: 5, kind, label: null, clip_path: null, transcript: null,
    transcript_lang: null, sleep_talk: null, talker_hint: null, hidden: false, created_at: isoT(ts), ...extra,
  });
  const events: Row[] = [];
  // A heavy snoring night: 1200 unclipped snore events before the talking (never judged, sleep_talk stays null).
  for (let i = 0; i < 1200; i++) {
    const ts = new Date(t('2026-11-04T23:30:00') + i * 5000).toISOString();
    events.push({ ...ev('2026-11-04T23:30:00', 'snore'), ts, created_at: ts });
  }
  events.push(ev(`${NIGHT}T03:00:00`, 'speech', { clip_path: `${NIGHT}/a_speech.m4a`, transcript: 'the cat is in the garden' }));
  events.push(ev(`${NIGHT}T04:00:00`, 'loud', { label: 'Sigh' })); // speech-class label, no clip / transcript: not sleep talk to tell
  events.push(ev(`${NIGHT}T07:40:00`, 'speech', { clip_path: `${NIGHT}/b_speech.m4a`, transcript: 'coffee?', transcript_lang: 'en' }));
  const tables = {
    sound_events: events,
    sleep_sessions: [session('a'), session('b')],
    household_settings: [{ id: 1, sound_mode: 'auto', sound_clips: true, sound_sleeptalk: sleeptalk }],
  };
  return { tables, events };
}

Deno.test('sleep talk judge: a busy night never hides speech; conversation clip removed only after the upload grace', async () => {
  const { tables, events } = setup();
  const removed: string[] = [];
  const db = fakeDb(tables, removed);
  const talk = events.find((e) => e.clip_path === `${NIGHT}/a_speech.m4a`)!;
  const chat = events.find((e) => e.clip_path === `${NIGHT}/b_speech.m4a`)!;

  // 07:50: the conversation at 07:40 is judged, its words go, but its clip waits (an upload may still land).
  const r1 = await judgeSleepTalkNights(db, NIGHT, t(`${NIGHT}T07:50:00`), PEOPLE);
  eq([r1.sleepTalk, r1.conversations, r1.removed, r1.errors.length], [1, 1, 0, 0], 'first run');
  eq([talk.sleep_talk, talk.talker_hint], [true, null], 'both asleep → sleep talk, no single talker');
  eq([chat.sleep_talk, chat.transcript, chat.transcript_lang, chat.clip_path], [false, null, null, `${NIGHT}/b_speech.m4a`], 'conversation: words cleared, clip kept for now');
  eq(removed, [], 'nothing removed inside the grace');

  // The summary never counts the conversation, nor the unclipped sigh.
  const s = await sleepTalkSummary(db, NIGHT, NAMES);
  eq([s.items.length, s.pending], [1, 0], 'summary counts what Today lists');
  eq(s.line?.startsWith('Sleep talk: 1 clip'), true, `line: ${s.line}`);

  // After the grace the clip object goes, then clip_path.
  const r2 = await judgeSleepTalkNights(db, NIGHT, t(`${NIGHT}T07:40:00`) + UPLOAD_GRACE_MS + 60_000, PEOPLE);
  eq([r2.judged, r2.removed], [0, 1], 'second run');
  eq(removed, [`${NIGHT}/b_speech.m4a`], 'conversation clip removed');
  eq(chat.clip_path, null, 'clip_path cleared');
  eq(talk.clip_path, `${NIGHT}/a_speech.m4a`, 'sleep talk kept');
});

Deno.test('sleep talk summary: nothing while "Save sleep talk" is off', async () => {
  const { tables } = setup(false);
  const db = fakeDb(tables, []);
  await judgeSleepTalkNights(db, NIGHT, t(`${NIGHT}T09:00:00`), PEOPLE);
  const s = await sleepTalkSummary(db, NIGHT, NAMES);
  eq([s.items.length, s.pending, s.line], [0, 0, null], 'off → no line');
});

Deno.test('sleep talk summary: an unjudged clip counts as pending', async () => {
  const { tables } = setup();
  const db = fakeDb(tables, []);
  const s = await sleepTalkSummary(db, NIGHT, NAMES);
  eq([s.items.length, s.pending, s.line], [0, 2, null], 'pending before the judge');
});
