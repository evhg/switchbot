// Signed download links for night-sound clips (private 'night-sounds' bucket), for an owner/member or an internal
// call that is not the PWA (e.g. sending a clip to someone to label it).
//   POST {"id": 426}                 → {"id", "path", "url"}   (url valid 1 h)
//   POST {"paths": ["2026-11-05/…"]} → {"urls": [{"path", "url"}]}
// JWT verification is off (config.toml); requireCronOrMember checks the caller.
import { requireCronOrMember } from '../_shared/auth.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';

const BUCKET = 'night-sounds';
const TTL_S = 3600;
const PATH_RE = /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.m4a$/;

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  const db = serviceClient();
  await requireCronOrMember(req, db);
  const body = await readJson(req);

  if (typeof body.id === 'number') {
    const { data, error } = await db.from('sound_events').select('id,clip_path').eq('id', body.id).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!data?.clip_path) throw new HttpError(404, 'no clip for that event');
    const s = await db.storage.from(BUCKET).createSignedUrl(data.clip_path, TTL_S);
    if (s.error || !s.data) throw new HttpError(404, s.error?.message ?? 'clip not found');
    return json({ id: data.id, path: data.clip_path, url: s.data.signedUrl });
  }

  const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string' && PATH_RE.test(p)) : [];
  if (!paths.length || paths.length > 50) throw new HttpError(400, 'give {"id": n} or 1–50 clip paths');
  const s = await db.storage.from(BUCKET).createSignedUrls(paths, TTL_S);
  if (s.error || !s.data) throw new HttpError(500, s.error?.message ?? 'signing failed');
  return json({ urls: s.data.map((d) => ({ path: d.path, url: d.signedUrl, error: d.error })) });
});
