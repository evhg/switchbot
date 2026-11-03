// Night sounds from the Mac listener (the bedroom camera's audio, classified locally on Erik's Mac; migration 0024):
//   GET  /functions/v1/night-sound                       should the Mac listen now?
//        → {"listen","reason","from","until","clips","clipsLeft","night","now"}
//   POST {"ping":true}                                   → {"ok":true,"person"} (token check, stores nothing)
//   POST {"camera":"bedroom","minutes":[…],"events":[…]} (≤ 120 minutes, ≤ 100 events)
//        → {"ok","person","stored":{"minutes","events"},"dropped":{"outsideWindow","notListening"},"rejected":[…],
//           "uploads":[{"index","path","signedUrl","token"}],"listen"}
//   X-Presence-Token: slp_…  (or Authorization: Bearer slp_…): any household person's presence token; else 401.
// The Mac asks GET every 60 s and runs its audio pipeline only while listen is true. The server enforces "only while
// we sleep" too: rows whose ts is outside their night's listen window (± 5 min) are dropped and counted, and nothing
// is stored while listening is turned off or paused. Clips: for events with wantClip (never speech), with
// household_settings.sound_clips on and fewer than 40 clips this night (never a speech-class label, never an event older
// than 10 min: a re-sent outbox batch has no audio left), clip_path is reserved and a signed upload URL
// returned; the Mac PUTs the ~10 s m4a (audio/mp4, ≤ 1 MB) there. Clips older than 14 days are removed from Storage
// (checked on every authorised GET/POST, at most once an hour per worker) and their clip_path set to null; rows stay. JWT verification is off.
import {
  clipAllowed,
  inWindow,
  LISTEN_GRACE_MS,
  parseSoundPayload,
  soundClipPath,
  soundEventRow,
  soundMinuteRow,
  soundNightDate,
  SOUND_CLIPS_PER_NIGHT,
} from '../../../packages/core/src/sound/payload.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { PRESENCE_TOKEN, presenceToken } from '../_shared/presence.ts';
import { clipsStored, currentListen, isoOrNull, loadSoundNights, loadSoundSettings, notListening, soundWindow } from '../_shared/sound.ts';
import { type Db, serviceClient } from '../_shared/supabase.ts';
import { iso } from '../_shared/time.ts';

const BUCKET = 'night-sounds';
const CLIP_RETENTION_MS = 14 * 24 * 60 * 60_000;
const RETENTION_EVERY_MS = 60 * 60_000;
let lastRetention = 0;

serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'GET (listen?) or POST {"minutes":[…],"events":[…]} / {"ping":true}' }, 405);
  const body = await readJson(req);
  const token = presenceToken(req, body)?.toLowerCase() ?? null;
  if (!token || !PRESENCE_TOKEN.test(token)) throw new HttpError(401, 'unauthorized');

  const db = serviceClient();
  const who = await db.rpc('presence_token_person', { p_token: token });
  if (who.error) {
    console.error('presence_token_person', who.error.message);
    return json({ error: 'internal' }, 500);
  }
  const person = typeof who.data === 'string' ? who.data : null;
  if (!person) throw new HttpError(401, 'unauthorized');

  const now = Date.now();
  // Clip retention runs on every authorised call (the Mac GETs every 60 s even while not listening), at most hourly.
  if (now - lastRetention >= RETENTION_EVERY_MS) {
    lastRetention = now;
    await pruneClips(db, now).catch((e) => console.error('clip retention', e instanceof Error ? e.message : String(e)));
  }
  if (req.method === 'GET') {
    const c = await currentListen(db, now);
    return json({ listen: c.listen, reason: c.reason, from: isoOrNull(c.from), until: isoOrNull(c.until), clips: c.clips, clipsLeft: c.clipsLeft, night: c.night, now: iso(now) });
  }

  const parsed = parseSoundPayload(body, now);
  if (parsed.fatal) return json({ error: parsed.fatal }, 400);
  if (parsed.ping) return json({ ok: true, person });
  const { camera } = parsed;
  const rejected = parsed.errors.map(({ kind, index, reason }) => ({ kind, index, reason }));

  const settings = await loadSoundSettings(db);
  let minutes = parsed.minutes;
  let events = parsed.events;
  let droppedOff = 0;
  if (notListening(settings, now)) {
    droppedOff = minutes.length + events.length;
    minutes = [];
    events = [];
  }

  // Keep only rows inside their own night's listen window (± grace). A night without a nights row keeps nothing.
  const nightOf = (ts: number) => soundNightDate(ts);
  const nights = await loadSoundNights(db, [...new Set([...minutes, ...events].map((r) => nightOf(r.ts)))]);
  const inside = (ts: number) => {
    const n = nights.get(nightOf(ts));
    return !!n && inWindow(ts, soundWindow(n), LISTEN_GRACE_MS);
  };
  const keptMinutes = minutes.filter((m) => inside(m.ts));
  const keptEvents = events.filter((e) => inside(e.ts));
  const outsideWindow = minutes.length - keptMinutes.length + events.length - keptEvents.length;

  let storedMinutes = 0;
  if (keptMinutes.length) {
    const res = await db.from('sound_minutes')
      .upsert(keptMinutes.map((m) => soundMinuteRow(m, camera, nightOf(m.ts))), { onConflict: 'camera,ts', ignoreDuplicates: true })
      .select('ts');
    if (res.error) {
      console.error('sound_minutes', res.error.message);
      return json({ error: 'internal' }, 500);
    }
    storedMinutes = (res.data ?? []).length;
  }
  let storedEvents = 0;
  if (keptEvents.length) {
    const res = await db.from('sound_events')
      .upsert(keptEvents.map((e) => soundEventRow(e, camera, nightOf(e.ts))), { onConflict: 'camera,ts,kind', ignoreDuplicates: true })
      .select('id');
    if (res.error) {
      console.error('sound_events', res.error.message);
      return json({ error: 'internal' }, 500);
    }
    storedEvents = (res.data ?? []).length;
  }

  let uploads: Upload[] = [];
  const wanted = keptEvents.filter((e) => clipAllowed(e, now));
  if (wanted.length && settings.clips) {
    uploads = await reserveClips(db, camera, wanted, nightOf).catch((e) => {
      console.error('clips', e instanceof Error ? e.message : String(e));
      return [];
    });
  }

  const listen = await currentListen(db, now).then((c) => c.listen).catch(() => !notListening(settings, now));
  return json({
    ok: true,
    person,
    received: { minutes: parsed.minutes.length, events: parsed.events.length },
    stored: { minutes: storedMinutes, events: storedEvents },
    duplicates: { minutes: keptMinutes.length - storedMinutes, events: keptEvents.length - storedEvents },
    dropped: { outsideWindow, notListening: droppedOff },
    rejected,
    uploads,
    listen,
  });
});

interface Upload {
  index: number;
  path: string;
  signedUrl: string;
  token: string;
}

/**
 * Signed upload URLs for the wanted clips: an event that already has a clip_path (a retried batch) gets a fresh URL for
 * the same object; otherwise a path is reserved while the night has fewer than SOUND_CLIPS_PER_NIGHT clips.
 */
async function reserveClips(
  db: Db,
  camera: string,
  wanted: readonly { index: number; ts: number; kind: 'snore' | 'loud' | 'cough' | 'speech' | 'other' }[],
  nightOf: (ts: number) => string,
): Promise<Upload[]> {
  const tss = wanted.map((e) => e.ts);
  const { data, error } = await db.from('sound_events').select('id,ts,kind,clip_path,night_date')
    .eq('camera', camera).gte('ts', iso(Math.min(...tss))).lte('ts', iso(Math.max(...tss)));
  if (error) throw new Error(`sound_events: ${error.message}`);
  const rows = (data ?? []) as { id: number; ts: string; kind: string; clip_path: string | null; night_date: string }[];
  const left = new Map<string, number>();
  const out: Upload[] = [];
  for (const e of wanted) {
    const row = rows.find((r) => Date.parse(r.ts) === e.ts && r.kind === e.kind);
    if (!row) continue;
    let path = row.clip_path;
    if (!path) {
      const night = nightOf(e.ts);
      if (!left.has(night)) left.set(night, SOUND_CLIPS_PER_NIGHT - await clipsStored(db, night));
      if ((left.get(night) ?? 0) <= 0) continue;
      const candidate = soundClipPath(night, e);
      const upd = await db.from('sound_events').update({ clip_path: candidate }).eq('id', row.id).is('clip_path', null).select('clip_path');
      if (upd.error) throw new Error(`sound_events clip_path: ${upd.error.message}`);
      const set = ((upd.data ?? []) as { clip_path: string | null }[])[0]?.clip_path;
      if (!set) continue; // a concurrent request reserved it
      path = set;
      left.set(night, (left.get(night) ?? 0) - 1);
    }
    const signed = await db.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
    if (signed.error || !signed.data) {
      console.error('createSignedUploadUrl', signed.error?.message);
      continue;
    }
    out.push({ index: e.index, path, signedUrl: signed.data.signedUrl, token: signed.data.token });
  }
  return out;
}

/** Clips older than 14 days: remove the objects, then clear clip_path (rows stay). At most 100 per run. */
async function pruneClips(db: Db, now: number): Promise<void> {
  const { data, error } = await db.from('sound_events').select('id,clip_path')
    .not('clip_path', 'is', null).lt('ts', iso(now - CLIP_RETENTION_MS)).order('ts').limit(100);
  if (error) throw new Error(`sound_events old clips: ${error.message}`);
  const rows = (data ?? []) as { id: number; clip_path: string }[];
  if (!rows.length) return;
  const rm = await db.storage.from(BUCKET).remove(rows.map((r) => r.clip_path));
  if (rm.error) throw new Error(`storage remove: ${rm.error.message}`);
  const upd = await db.from('sound_events').update({ clip_path: null }).in('id', rows.map((r) => r.id));
  if (upd.error) throw new Error(`sound_events clear clip_path: ${upd.error.message}`);
  console.log('clip retention', rows.length);
}
