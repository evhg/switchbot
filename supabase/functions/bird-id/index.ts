// Bird ID for night-sound clips (migration 0036). The Mac runs BirdNET on the clips and reports what it heard.
//   GET  ?days=3                → {"location": {lat, lon}, "clips": [{id, ts, label, url}]}  clips not checked yet
//                                  (newest first, at most 50, signed URLs valid 1 h)
//   POST {"results": [{"id": 426, "species": "Eudynamys scolopaceus", "common": "Asian Koel", "confidence": 0.87}
//                     | {"id": 427, "none": true}]}   → {"ok": true, "stored": n}
// Auth: the Mac's device token (X-Presence-Token: slp_…, as for night-sound). JWT verification is off (config.toml).
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';

const BUCKET = 'night-sounds';
const TOKEN_RE = /^slp_[0-9a-f]{64}$/;
// The villa in Phuket: BirdNET's species filter uses it with the week of the year.
const LOCATION = { lat: 7.89, lon: 98.3 };

function token(req: Request, body: Record<string, unknown>): string | null {
  const h = req.headers.get('x-presence-token')?.trim();
  if (h) return h;
  const m = req.headers.get('authorization')?.match(/^Bearer\s+(slp_\S+)$/i);
  if (m) return m[1]!.trim();
  return typeof body.token === 'string' ? body.token.trim() : null;
}

serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'GET or POST');
  const body = await readJson(req);
  const t = token(req, body)?.toLowerCase() ?? null;
  if (!t || !TOKEN_RE.test(t)) throw new HttpError(401, 'unauthorized');
  const db = serviceClient();
  const who = await db.rpc('presence_token_person', { p_token: t });
  if (who.error || typeof who.data !== 'string') throw new HttpError(401, 'unauthorized');

  if (req.method === 'GET') {
    const days = Math.min(14, Math.max(1, Number(new URL(req.url).searchParams.get('days') ?? 3) || 3));
    const { data, error } = await db
      .from('sound_events')
      .select('id,ts,label,clip_path')
      .is('bird_checked_at', null)
      .not('clip_path', 'is', null)
      .gte('ts', new Date(Date.now() - days * 86_400_000).toISOString())
      .order('ts', { ascending: false })
      .limit(50);
    if (error) throw new HttpError(500, error.message);
    const rows = (data ?? []) as { id: number; ts: string; label: string | null; clip_path: string }[];
    if (!rows.length) return json({ location: LOCATION, clips: [] });
    const signed = await db.storage.from(BUCKET).createSignedUrls(rows.map((r) => r.clip_path), 3600);
    if (signed.error) throw new HttpError(500, signed.error.message);
    const urls = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]));
    return json({
      location: LOCATION,
      clips: rows.filter((r) => urls.get(r.clip_path)).map((r) => ({ id: r.id, ts: r.ts, label: r.label, url: urls.get(r.clip_path) })),
    });
  }

  const results = Array.isArray(body.results) ? body.results.slice(0, 200) : [];
  if (!results.length) throw new HttpError(400, 'give {"results": [...]}');
  let stored = 0;
  for (const raw of results) {
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'number' && Number.isInteger(r.id) ? r.id : null;
    if (id === null) continue;
    const none = r.none === true || typeof r.species !== 'string' || !r.species.trim();
    const conf = typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : null;
    const row = none
      ? { bird_species: null, bird_common: null, bird_conf: null, bird_checked_at: new Date().toISOString() }
      : {
        bird_species: String(r.species).trim().slice(0, 120),
        bird_common: typeof r.common === 'string' ? r.common.trim().slice(0, 120) : null,
        bird_conf: conf,
        bird_checked_at: new Date().toISOString(),
      };
    const { error } = await db.from('sound_events').update(row).eq('id', id);
    if (!error) stored++;
  }
  return json({ ok: true, stored });
});
