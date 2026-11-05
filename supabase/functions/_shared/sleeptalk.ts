// Sleep talk, the morning side (migration 0029; run by nightly-report on its 15-min cron, 06:00–18:45 ICT, which is
// after the morning health syncs at 07:20 / 08:20 / 09:20, 10:30, 14:00 ICT and hourly):
//
//   judgeSleepTalkNights(db, date, now)
//     For each speech event (kind 'speech' or a speech-class label) WITH a clip or a transcript of the night `date` and
//     the night before with sleep_talk null (a speech event with neither has nothing to keep or show and is never
//     judged): once every person's sleep sessions for that night are in (or from 13:00 ICT with whatever exists), core
//     judgeSleepTalk decides. Sleep talk → sleep_talk true, talker_hint. A conversation (both awake or outside their
//     sessions) → sleep_talk false, transcript / transcript_lang / talker_hint null at once (the app never plays a
//     sleep_talk false clip). Its clip object is removed in a second step, once the row is older than
//     UPLOAD_GRACE_MS: night-sound may have handed the Mac a signed upload URL (valid 2 h, re-issued for a re-sent batch
//     up to 10 min after the event) that is not used yet, and removing the object before that PUT would leave the
//     audio orphaned. After that point no upload can land any more: the object is removed, then clip_path null (a failed
//     removal keeps clip_path and retries on the next run).
//     Rows are read in pages (selectAll, PAGE) with the clip-or-transcript filter in SQL, so a busy night never hides
//     speech events.
//   sleepTalkSummary(db, date, names)
//     The night's judged sleep talk (sleep_talk true, with a clip or transcript, not hidden: the same events Today ›
//     Sleep talk lists) → the push line, and how many such events are still unjudged. Nothing (no line, no push) while
//     "Save sleep talk" (household_settings.sound_sleeptalk) is off.
//   sleepTalkFollowUp(db, date, names, now)
//     The separate "Sleep talk from last night" push, once per night (alert_state key 'sleeptalk', data.night): only
//     when the morning report push already went out (reports.pushed_at) without the line, nothing is pending any more
//     and there is sleep talk to tell.
import { isSpeechEvent } from '../../../packages/core/src/sound/payload.ts';
import { judgeSleepTalk, type SleepSessionLite, sleepTalkFinal, type SleepTalkItem, sleepTalkLine } from '../../../packages/core/src/sound/sleeptalk.ts';
import type { SleepStage } from '../../../packages/core/src/types.ts';
import { appUrl, pushToAll, type PushSummary } from './push.ts';
import { loadSoundSettings } from './sound.ts';
import { type Db, must, selectAll } from './supabase.ts';
import { addDays, HOUR, iso, MIN, nightWindow } from './time.ts';

const BUCKET = 'night-sounds';
export const SLEEPTALK_ALERT_KEY = 'sleeptalk';
/** Rows read per request for the paged reads (selectAll). */
const PAGE = 500;
/**
 * A conversation's clip object is removed only once the row is this old: the signed upload URL night-sound hands out
 * lasts 2 h and is re-issued for a re-sent batch up to 10 min (CLIP_MAX_AGE_MS) after the event; plus a margin.
 */
export const UPLOAD_GRACE_MS = 2 * HOUR + 30 * MIN;
/** Rows with something to keep or show: a clip (reserved) or a transcript. */
const HAS_CLIP_OR_TEXT = 'clip_path.not.is.null,transcript.not.is.null';

interface SpeechRow {
  id: number;
  ts: string;
  night_date: string;
  duration_s: number | null;
  kind: string;
  label: string | null;
  clip_path: string | null;
}

export interface JudgeResult {
  judged: number;
  sleepTalk: number;
  conversations: number;
  pending: number;
  removed: number;
  errors: string[];
}

/** Every person's sleep sessions for a night (null = none synced yet), keyed by person id. */
async function sessionsFor(db: Db, date: string, personIds: readonly string[]): Promise<Map<string, SleepSessionLite[] | null>> {
  const { from, to } = nightWindow(date);
  const rows = must(
    await db.from('sleep_sessions').select('person_id,start_ts,end_ts,stages').gte('end_ts', iso(from)).lt('end_ts', iso(to + 2 * HOUR)),
    'sleep_sessions',
  ) as { person_id: string; start_ts: string; end_ts: string; stages: unknown }[];
  const out = new Map<string, SleepSessionLite[] | null>(personIds.map((id) => [id, null]));
  for (const r of rows) {
    if (!out.has(r.person_id)) continue;
    const stages = (Array.isArray(r.stages) ? r.stages : []) as { start: number; end: number; stage: SleepStage }[];
    const list = out.get(r.person_id) ?? [];
    list.push({
      start: Date.parse(r.start_ts),
      end: Date.parse(r.end_ts),
      stages: stages.filter((g) => Number.isFinite(g?.start) && Number.isFinite(g?.end) && typeof g?.stage === 'string'),
    });
    out.set(r.person_id, list);
  }
  return out;
}

/** Judges the unjudged speech events of `date` and the night before (see the header). */
export async function judgeSleepTalkNights(db: Db, date: string, now: number, personIds: readonly string[]): Promise<JudgeResult> {
  const res: JudgeResult = { judged: 0, sleepTalk: 0, conversations: 0, pending: 0, removed: 0, errors: [] };
  const nights = [addDays(date, -1), date];
  // Step 2 first: conversations judged earlier whose clip object can go now (see UPLOAD_GRACE_MS).
  await removeConversationClips(db, nights, now, res);

  // Speech or not is decided in JS (isSpeechLabel is case- and space-insensitive); the clip/transcript filter keeps
  // the read small (≤ 60 clips a night), and paging keeps it complete.
  const rows = (await selectAll<SpeechRow>(
    (from, to) => db.from('sound_events').select('id,ts,night_date,duration_s,kind,label,clip_path')
      .in('night_date', nights).is('sleep_talk', null).or(HAS_CLIP_OR_TEXT).order('ts').order('id').range(from, to),
    'sound_events unjudged',
    { pageSize: PAGE },
  )).filter((r) => isSpeechEvent(r));
  if (!rows.length) return res;

  const byNight = new Map<string, SpeechRow[]>();
  for (const r of rows) byNight.set(r.night_date, [...(byNight.get(r.night_date) ?? []), r]);

  for (const [night, list] of byNight) {
    const sessions = await sessionsFor(db, night, personIds);
    const people = personIds.map((id) => ({ id, sessions: sessions.get(id) ?? null }));
    const final = sleepTalkFinal(night, now);
    const talk: { id: number; hint: string | null }[] = [];
    const chat: SpeechRow[] = [];
    for (const r of list) {
      const v = judgeSleepTalk({ ts: Date.parse(r.ts), durationS: r.duration_s, people, final });
      if (v.status === 'pending') res.pending++;
      else if (v.status === 'sleep_talk') talk.push({ id: r.id, hint: v.talkerHint === 'a' || v.talkerHint === 'b' ? v.talkerHint : null });
      else chat.push(r);
    }
    const judgedAt = new Date().toISOString();
    for (const t of talk) {
      const upd = await db.from('sound_events').update({ sleep_talk: true, talker_hint: t.hint, judged_at: judgedAt }).eq('id', t.id).is('sleep_talk', null);
      if (upd.error) res.errors.push(`sleep talk ${t.id}: ${upd.error.message}`);
      else {
        res.judged++;
        res.sleepTalk++;
      }
    }
    if (chat.length) {
      // Conversations are not kept: the words go now; the clip object once no upload can land any more (step 2).
      const upd = await db.from('sound_events')
        .update({ sleep_talk: false, talker_hint: null, transcript: null, transcript_lang: null, judged_at: judgedAt })
        .in('id', chat.map((r) => r.id)).is('sleep_talk', null);
      if (upd.error) res.errors.push(`conversation rows: ${upd.error.message}`);
      else {
        res.judged += chat.length;
        res.conversations += chat.length;
      }
    }
  }
  // Conversations judged just now that are already old enough lose their clip in this same run.
  if (res.conversations) await removeConversationClips(db, nights, now, res);
  if (res.errors.length) console.error('sleep talk judge', res.errors.join(' | '));
  return res;
}

/**
 * Step 2: conversations (sleep_talk false) that still have a clip_path and are older than UPLOAD_GRACE_MS → the
 * object is removed from the bucket, then clip_path null. A failed removal keeps clip_path (retried next run).
 */
async function removeConversationClips(db: Db, nights: readonly string[], now: number, res: JudgeResult): Promise<void> {
  const { data, error } = await db.from('sound_events').select('id,clip_path')
    .in('night_date', nights).eq('sleep_talk', false).not('clip_path', 'is', null).lt('created_at', iso(now - UPLOAD_GRACE_MS))
    .order('id').limit(PAGE);
  if (error) {
    res.errors.push(`conversation clips: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as { id: number; clip_path: string }[];
  if (!rows.length) return;
  const rm = await db.storage.from(BUCKET).remove(rows.map((r) => r.clip_path));
  if (rm.error) {
    res.errors.push(`storage remove: ${rm.error.message}`);
    return;
  }
  const upd = await db.from('sound_events').update({ clip_path: null }).in('id', rows.map((r) => r.id)).eq('sleep_talk', false);
  if (upd.error) res.errors.push(`conversation clip_path: ${upd.error.message}`);
  else res.removed += rows.length;
}

export interface SleepTalkSummary {
  items: SleepTalkItem[];
  /** Speech events of the night still waiting for the judge. */
  pending: number;
  line: string | null;
}

/**
 * The night's judged sleep talk and the push line (null when there is none). Counts the same events Today › Sleep talk
 * lists (speech with a clip or a transcript, not a conversation); nothing at all while "Save sleep talk" is off.
 */
export async function sleepTalkSummary(db: Db, date: string, names: Readonly<Record<string, string>>): Promise<SleepTalkSummary> {
  if (!(await loadSoundSettings(db)).sleepTalk) return { items: [], pending: 0, line: null };
  const rows = await selectAll<{ ts: string; kind: string; label: string | null; talker_hint: string | null; transcript: string | null; sleep_talk: boolean | null; hidden: boolean }>(
    (from, to) => db.from('sound_events').select('ts,kind,label,talker_hint,transcript,sleep_talk,hidden')
      .eq('night_date', date).or(HAS_CLIP_OR_TEXT).order('ts').order('id').range(from, to),
    'sound_events sleep talk',
    { pageSize: PAGE },
  );
  // sleep_talk false = a conversation (its clip may still wait for removal): never counted.
  const speech = rows.filter((r) => r.sleep_talk !== false && isSpeechEvent(r));
  const pending = speech.filter((r) => r.sleep_talk === null).length;
  const items = speech
    .filter((r) => r.sleep_talk === true && !r.hidden)
    .map((r) => ({ ts: Date.parse(r.ts), talkerHint: r.talker_hint, transcript: r.transcript }));
  return { items, pending, line: sleepTalkLine(items, names) };
}

/** Today › Snoring & noise of that night. */
export const sleepTalkUrl = (date: string) => `${appUrl()}/?date=${date}#sounds`;

/** Records that this night's sleep talk was told (in the morning report push or the separate one). */
export async function markSleepTalkSent(db: Db, date: string, title: string, body: string): Promise<void> {
  const now = new Date().toISOString();
  const up = await db.from('alert_state').upsert({ key: SLEEPTALK_ALERT_KEY, last_sent_at: now, data: { night: date, title, body }, updated_at: now }, { onConflict: 'key' });
  if (up.error) console.error('alert_state sleeptalk', up.error.message);
}

async function alreadySent(db: Db, date: string): Promise<boolean> {
  const { data, error } = await db.from('alert_state').select('data').eq('key', SLEEPTALK_ALERT_KEY).maybeSingle();
  if (error) throw new Error(`alert_state: ${error.message}`);
  return (data as { data?: { night?: string } } | null)?.data?.night === date;
}

/** The separate "Sleep talk from last night" push (see the header). */
export async function sleepTalkFollowUp(db: Db, date: string, names: Readonly<Record<string, string>>): Promise<{ sent: boolean; reason: string; push?: PushSummary }> {
  const report = must(await db.from('reports').select('pushed_at').eq('date', date).maybeSingle(), 'reports') as { pushed_at: string | null } | null;
  if (!report?.pushed_at) return { sent: false, reason: 'morning report not pushed yet' };
  const s = await sleepTalkSummary(db, date, names);
  if (s.pending) return { sent: false, reason: `${s.pending} speech moment(s) not judged yet` };
  if (!s.line) return { sent: false, reason: 'no sleep talk' };
  if (await alreadySent(db, date)) return { sent: false, reason: 'already sent' };
  const title = 'Sleep talk from last night';
  const push = await pushToAll(db, { title, body: s.line, navigate: sleepTalkUrl(date), tag: `sleeptalk-${date}` }, 'sleeptalk', { urgency: 'normal' })
    .catch((e) => ({ skipped: `push failed: ${e instanceof Error ? e.message : e}` }));
  // Marked even when the push failed, like reports.pushed_at: never a second attempt the same night.
  await markSleepTalkSent(db, date, title, s.line);
  return { sent: true, reason: 'sent', push };
}

/** For the report push: the line to add, when the night is fully judged and not yet told. */
export async function sleepTalkForReport(db: Db, date: string, names: Readonly<Record<string, string>>): Promise<string | null> {
  const s = await sleepTalkSummary(db, date, names);
  if (s.pending || !s.line) return null;
  if (await alreadySent(db, date)) return null;
  return s.line;
}
