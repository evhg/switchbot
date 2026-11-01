// Food photo → public.meals (migration 0020) → Google Health nutrition log.
// The app uploads the photo to the private Storage bucket 'meals' at <person_id>/<file> (household RLS), then POSTs:
//   {photoPath, takenAt?, mealType?, personId? (owner only), note?}   analyse a new photo
//   {mealId, action: 'regenerate' | 'hide' | 'resync'}               ask Gemini again / take out of the app / retry Google
// Caller: a household owner/member's JWT (or cron / the service key, which must name personId). Members act on their own
// person's meals; the owner on anyone's.
// Analysis: the photo (service-role download) goes inline to Gemini generateContent (gemini-3.8-flash, JSON output with
// core FOOD_RESPONSE_SCHEMA); core parseFoodAnalysis validates and clamps it, totals = sums of the items. The row is
// saved first; the Google Health write (token narrowed to nutrition.writeonly) is best effort and never fails the
// request: its outcome lands in google_status / google_point / google_error.
import { foodRequestBody, isMealType, mealTypeAt, parseFoodAnalysis, geminiResponseText, FOOD_MODEL, type FoodAnalysis, type MealType } from '../../../packages/core/src/food/meal.ts';
import { createNutritionLog, deleteNutritionLogs, nutritionLogDataPoint, nutritionPointId, nutritionPointName, NutritionLogError } from '../../../packages/core/src/food/nutrition.ts';
import { SCOPE_NUTRITION_WRITE } from '../../../packages/core/src/health/oauth.ts';
import { requireCronOrMember } from '../_shared/auth.ts';
import { optEnv } from '../_shared/env.ts';
import { GeminiError, generateContent, geminiApiKey } from '../_shared/gemini.ts';
import { GoogleTokenError, googleAccessToken } from '../_shared/google.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { type Db, must, serviceClient } from '../_shared/supabase.ts';
import { DAY, iso, MIN } from '../_shared/time.ts';

const BUCKET = 'meals';
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

interface MealRow {
  id: string;
  person_id: string;
  taken_at: string;
  meal_type: MealType;
  photo_path: string | null;
  note: string | null;
  title: string | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  google_status: string | null;
  google_point: string | null;
  hidden: boolean;
}

interface Caller {
  userId: string | null;
  /** Person the caller may act for by default (null for cron). */
  personId: string | null;
  /** Owner or cron: may act for any person. */
  any: boolean;
}

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  const db = serviceClient();
  const auth = await requireCronOrMember(req, db);
  const caller = await callerOf(db, auth);
  const body = await readJson(req);

  if (typeof body.mealId === 'string') {
    const meal = await loadMeal(db, body.mealId);
    if (!caller.any && meal.person_id !== caller.personId) throw new HttpError(403, 'not your meal');
    if (body.action === 'hide') return json(await hide(db, meal));
    if (body.action === 'resync') return json(await syncAndStore(db, meal));
    if (body.action === 'regenerate') return json(await regenerate(db, meal));
    throw new HttpError(400, "action must be 'regenerate', 'hide' or 'resync'");
  }

  const photoPath = normalisePath(body.photoPath);
  const personId = typeof body.personId === 'string' && body.personId ? body.personId : caller.personId;
  if (!personId) throw new HttpError(400, 'personId required');
  if (personId !== caller.personId && !caller.any) throw new HttpError(403, "only the owner can log another person's meal");
  if (photoPath.split('/')[0] !== personId) throw new HttpError(400, `photoPath must be under ${personId}/`);
  const takenAt = parseTakenAt(body.takenAt);
  const mealType: MealType = isMealType(body.mealType) ? body.mealType : mealTypeAt(takenAt);
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null;

  // The same photo posted twice (a retried request) returns the existing meal.
  const dup = must(await db.from('meals').select('*').eq('photo_path', photoPath).eq('hidden', false).limit(1), 'meals') as MealRow[];
  if (dup[0]) return json({ ok: true, duplicate: true, meal: dup[0] });

  const { analysis, model, raw } = await analysePhoto(db, photoPath, { takenAt, mealType, note });
  if (!analysis.isFood) throw new HttpError(422, `no food recognised${analysis.notes ? `: ${analysis.notes}` : ''}`);

  const ins = await db.from('meals').insert({
    person_id: personId,
    taken_at: iso(takenAt),
    meal_type: mealType,
    photo_path: photoPath,
    note,
    ...analysisColumns(analysis, model, raw),
    created_by: caller.userId,
  }).select('*').single();
  const meal = must(ins, 'insert meal') as MealRow;
  return json(await syncAndStore(db, meal), 201);
});

async function callerOf(db: Db, auth: string): Promise<Caller> {
  if (auth === 'cron') return { userId: null, personId: null, any: true };
  const m = must(await db.from('household_members').select('person_id,role').eq('user_id', auth).maybeSingle(), 'household_members') as
    | { person_id: string | null; role: string }
    | null;
  return { userId: auth, personId: m?.person_id ?? null, any: m?.role === 'owner' };
}

async function loadMeal(db: Db, id: string): Promise<MealRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'mealId is not a uuid');
  const row = must(await db.from('meals').select('*').eq('id', id).maybeSingle(), 'meals') as MealRow | null;
  if (!row) throw new HttpError(404, 'meal not found');
  return row;
}

/** "<person>/<file>" (a leading "meals/" bucket prefix is accepted); no other folders, no "..". */
function normalisePath(v: unknown): string {
  const p = typeof v === 'string' ? v.trim().replace(/^\/+/, '').replace(/^meals\//, '') : '';
  if (!/^[a-z0-9_-]{1,32}\/[A-Za-z0-9._-]{1,200}$/.test(p) || p.includes('..')) throw new HttpError(400, 'photoPath must be <person_id>/<file>');
  return p;
}

/** ISO string or epoch ms; default now. At most 5 min in the future and 30 days back. */
function parseTakenAt(v: unknown): number {
  const now = Date.now();
  if (v === undefined || v === null || v === '') return now;
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t) || t > now + 5 * MIN || t < now - 30 * DAY) throw new HttpError(400, 'takenAt must be within the last 30 days');
  return t;
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function analysePhoto(
  db: Db,
  photoPath: string,
  ctx: { takenAt: number; mealType: MealType; note: string | null },
): Promise<{ analysis: FoodAnalysis; model: string; raw: unknown }> {
  const dl = await db.storage.from(BUCKET).download(photoPath);
  if (dl.error || !dl.data) throw new HttpError(404, `photo not found in Storage: ${photoPath}`);
  if (dl.data.size > MAX_PHOTO_BYTES) throw new HttpError(413, 'photo larger than 15 MB');
  const ext = photoPath.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = dl.data.type?.startsWith('image/') ? dl.data.type : MIME_BY_EXT[ext];
  if (!mimeType) throw new HttpError(415, 'photo must be JPEG, PNG, WebP or HEIC');

  const apiKey = await geminiApiKey(db);
  const model = optEnv('GEMINI_FOOD_MODEL') ?? FOOD_MODEL;
  const imageBase64 = base64(new Uint8Array(await dl.data.arrayBuffer()));
  let res: unknown;
  try {
    res = await generateContent(apiKey, model, foodRequestBody({ ...ctx, imageBase64, mimeType }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logCall(db, 'error', msg.slice(0, 1000));
    throw new HttpError(e instanceof GeminiError && e.status === 429 ? 429 : 502, msg);
  }
  await logCall(db, 'ok');
  let raw: unknown;
  try {
    raw = JSON.parse(geminiResponseText(res));
  } catch (e) {
    throw new HttpError(502, `Gemini answer unusable: ${e instanceof Error ? e.message : e}`);
  }
  const analysis = parseFoodAnalysis(raw);
  if (!analysis) throw new HttpError(502, 'Gemini answer is not an object');
  const version = (res as { modelVersion?: unknown }).modelVersion;
  return { analysis, model: typeof version === 'string' && version ? version : model, raw };
}

async function logCall(db: Db, status: string, note: string | null = null) {
  const r = await db.from('api_quota_log').insert({ api: 'gemini', fn: 'food-photo', calls: 1, status, note });
  if (r.error) console.error('api_quota_log', r.error.message);
}

function analysisColumns(a: FoodAnalysis, model: string, raw: unknown): Record<string, unknown> {
  return {
    title: a.title || null,
    kcal: a.totals.kcal,
    protein_g: a.totals.protein_g,
    carbs_g: a.totals.carbs_g,
    fat_g: a.totals.fat_g,
    fiber_g: a.totals.fiber_g,
    sugar_g: a.totals.sugar_g,
    items: a.items,
    confidence: a.confidence,
    model,
    raw: { answer: raw, ...(a.modelTotals ? { modelTotals: a.modelTotals } : {}) },
  };
}

async function regenerate(db: Db, meal: MealRow) {
  if (!meal.photo_path) throw new HttpError(409, 'meal has no photo');
  const { analysis, model, raw } = await analysePhoto(db, meal.photo_path, {
    takenAt: Date.parse(meal.taken_at),
    mealType: meal.meal_type,
    note: meal.note,
  });
  if (!analysis.isFood) throw new HttpError(422, `no food recognised${analysis.notes ? `: ${analysis.notes}` : ''}; the meal is unchanged`);
  const up = await db.from('meals').update({ ...analysisColumns(analysis, model, raw), updated_at: iso(Date.now()) }).eq('id', meal.id).select('*').single();
  const row = must(up, 'update meal') as MealRow;
  // Hidden meals stay out of Google Health.
  return row.hidden ? { ok: true, meal: row, google: { status: row.google_status } } : await syncAndStore(db, row);
}

async function hide(db: Db, meal: MealRow) {
  const patch: Record<string, unknown> = { hidden: true, updated_at: iso(Date.now()) };
  if (meal.google_point && (meal.google_status === 'ok' || meal.google_status === 'pending')) {
    const r = await removeFromGoogle(db, meal);
    Object.assign(patch, r.ok ? { google_status: 'removed', google_error: null } : { google_error: `remove: ${r.error}`.slice(0, 1000) });
  }
  const row = must(await db.from('meals').update(patch).eq('id', meal.id).select('*').single(), 'hide meal') as MealRow;
  return { ok: true, meal: row };
}

async function token(db: Db, personId: string): Promise<string> {
  return (await googleAccessToken(db, personId, [SCOPE_NUTRITION_WRITE])).accessToken;
}

async function removeFromGoogle(db: Db, meal: MealRow): Promise<{ ok: boolean; error?: string }> {
  try {
    await deleteNutritionLogs(await token(db, meal.person_id), [meal.google_point!]);
    return { ok: true };
  } catch (e) {
    // Already gone counts as removed.
    if (e instanceof NutritionLogError && e.status === 404) return { ok: true };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Writes the meal to Google Health and stores the outcome. A meal already there is removed first (anonymous food logs
 * can't be edited) and written under the next point id; if removing fails nothing new is written (no duplicates).
 */
async function syncAndStore(db: Db, meal: MealRow) {
  const out = await syncToGoogle(db, meal);
  const patch: Record<string, unknown> = { google_status: out.status, google_error: out.error ?? null };
  if (out.point) {
    patch.google_point = out.point;
    patch.google_synced_at = iso(Date.now());
  }
  const r = await db.from('meals').update(patch).eq('id', meal.id).select('*').single();
  if (r.error) console.error('meals google status', r.error.message);
  return { ok: true, meal: (r.data as MealRow | null) ?? { ...meal, ...patch }, google: { status: out.status, ...(out.error ? { error: out.error } : {}) } };
}

async function syncToGoogle(db: Db, meal: MealRow): Promise<{ status: string; point?: string; error?: string }> {
  if (meal.hidden) return { status: meal.google_status ?? 'skipped', error: 'meal is hidden' };
  let accessToken: string;
  try {
    accessToken = await token(db, meal.person_id);
  } catch (e) {
    if (e instanceof GoogleTokenError) return { status: 'no_token', error: e.message.slice(0, 1000) };
    return { status: 'error', error: String(e instanceof Error ? e.message : e).slice(0, 1000) };
  }
  if (meal.google_point && (meal.google_status === 'ok' || meal.google_status === 'pending')) {
    try {
      await deleteNutritionLogs(accessToken, [meal.google_point]);
    } catch (e) {
      // Keep the status: the old point is still in Google Health, so the next resync must try removing it again.
      if (!(e instanceof NutritionLogError && e.status === 404)) {
        return { status: meal.google_status, error: `remove: ${e instanceof Error ? e.message : e}`.slice(0, 1000) };
      }
    }
  }
  try {
    const pointId = nutritionPointId(meal.id, meal.google_point);
    const point = nutritionLogDataPoint(
      {
        id: meal.id,
        title: meal.title ?? 'Meal',
        mealType: meal.meal_type,
        takenAt: Date.parse(meal.taken_at),
        kcal: Number(meal.kcal ?? 0),
        protein_g: Number(meal.protein_g ?? 0),
        carbs_g: Number(meal.carbs_g ?? 0),
        fat_g: Number(meal.fat_g ?? 0),
        fiber_g: Number(meal.fiber_g ?? 0),
        sugar_g: Number(meal.sugar_g ?? 0),
      },
      pointId,
    );
    try {
      const r = await createNutritionLog(accessToken, point);
      return { status: r.status, point: r.name || nutritionPointName(pointId) };
    } catch (e) {
      // A retried write whose first attempt reached Google: the point exists under our id.
      if (e instanceof NutritionLogError && e.status === 409) return { status: 'ok', point: nutritionPointName(pointId) };
      throw e;
    }
  } catch (e) {
    return { status: 'error', error: String(e instanceof Error ? e.message : e).slice(0, 1000) };
  }
}
