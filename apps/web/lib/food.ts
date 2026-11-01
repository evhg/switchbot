'use client';
/**
 * Food camera (Body › Food): meals from public.meals (migration 0020) and the food-photo Edge Function.
 *
 *   useMeals()          the last 14 days of meals (hidden ones left out), today's totals per person, add / act
 *   shrinkPhoto(file)   ≤1280 px JPEG, done in the browser before upload (a phone photo is 3–8 MB; this is ~200 KB)
 *
 * Real when signed in as a household member and the data source isn't forced to Simulated; otherwise sample meals
 * (SAMPLE_MEALS), and "Add meal" returns a canned analysis after a short pause so the flow can be tried.
 * Flow: photo → Storage bucket 'meals' at <person_id>/<uuid>.jpg → POST food-photo {photoPath, takenAt} → the row.
 * The Google Health write happens server-side and never fails the save; its outcome is google_status.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { mealTypeAt, type FoodItem, type MealType, type Nutrition } from '@sleep-lab/core';
import { useAuth } from './auth.tsx';
import { useData } from './data/context.tsx';
import { functionsUrl, supabaseClient } from './data/supabase.ts';
import { DAY, HOUR, MIN, addDays, ictDate, ictMidnight } from './format.ts';

export type GoogleStatus = 'ok' | 'pending' | 'error' | 'no_token' | 'removed' | null;

export interface Meal extends Nutrition {
  id: string;
  personId: string;
  takenAt: number;
  mealType: MealType;
  title: string;
  items: FoodItem[];
  /** 0..1, the model's own estimate. */
  confidence: number | null;
  googleStatus: GoogleStatus;
  googleError: string | null;
  photoPath: string | null;
  /** Signed URL of the photo (1 h), or a local object URL for samples / the photo just taken. */
  photoUrl: string | null;
  note: string | null;
  sample?: boolean;
}

export type MealAction = 'hide' | 'regenerate' | 'resync';

/** What the "Add meal" card shows while a photo is on its way. */
export interface PendingMeal {
  personId: string;
  previewUrl: string;
  stage: 'shrinking' | 'uploading' | 'reading';
  error: string | null;
}

const BUCKET = 'meals';
const DAYS = 14;
const LONG_EDGE = 1280;

type Row = Record<string, unknown>;
const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN);
const n0 = (v: unknown) => (Number.isFinite(n(v)) ? n(v) : 0);
const s = (v: unknown) => (typeof v === 'string' ? v : null);
const MEAL_TYPES: readonly MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const GOOGLE: readonly NonNullable<GoogleStatus>[] = ['ok', 'pending', 'error', 'no_token', 'removed'];

function toItem(r: Row): FoodItem {
  return { name: s(r.name) ?? 'Item', grams: n0(r.grams), kcal: n0(r.kcal), protein_g: n0(r.protein_g), carbs_g: n0(r.carbs_g), fat_g: n0(r.fat_g), fiber_g: n0(r.fiber_g), sugar_g: n0(r.sugar_g) };
}

export function toMeal(r: Row): Meal {
  const takenAt = Date.parse(s(r.taken_at) ?? '');
  const mt = s(r.meal_type) as MealType | null;
  const g = s(r.google_status) as GoogleStatus;
  const conf = n(r.confidence);
  return {
    id: s(r.id) ?? '',
    personId: s(r.person_id) ?? '',
    takenAt,
    mealType: mt && MEAL_TYPES.includes(mt) ? mt : mealTypeAt(takenAt),
    title: s(r.title) ?? 'Meal',
    kcal: n0(r.kcal),
    protein_g: n0(r.protein_g),
    carbs_g: n0(r.carbs_g),
    fat_g: n0(r.fat_g),
    fiber_g: n0(r.fiber_g),
    sugar_g: n0(r.sugar_g),
    items: Array.isArray(r.items) ? (r.items as Row[]).map(toItem) : [],
    confidence: Number.isFinite(conf) ? conf : null,
    googleStatus: g && GOOGLE.includes(g) ? g : null,
    googleError: s(r.google_error),
    photoPath: s(r.photo_path),
    photoUrl: null,
    note: s(r.note),
  };
}

/** Sum of a person's meals on one ICT date. */
export function dayTotals(meals: readonly Meal[], personId: string, date: string): Nutrition & { count: number } {
  const out = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, count: 0 };
  for (const m of meals) {
    if (m.personId !== personId || ictDate(m.takenAt) !== date) continue;
    out.kcal += m.kcal;
    out.protein_g += m.protein_g;
    out.carbs_g += m.carbs_g;
    out.fat_g += m.fat_g;
    out.fiber_g += m.fiber_g;
    out.sugar_g += m.sugar_g;
    out.count++;
  }
  return out;
}

// ───────────────────────── photo → ≤1280 px JPEG ─────────────────────────

async function decode(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; close: () => void }> {
  // <img> first: every current browser (Safari 13.1+, Chrome 81+, Firefox 77+) draws it with the EXIF rotation applied,
  // so a portrait iPhone photo stays upright; createImageBitmap's 'from-image' is not honoured everywhere.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
  }
  if (typeof createImageBitmap === 'function') {
    try {
      const bm = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { img: bm, w: bm.width, h: bm.height, close: () => bm.close() };
    } catch {
      /* fall through */
    }
  }
  // HEIC outside Safari, or a file that isn't an image.
  throw new Error('This browser can’t open that photo. Take it with the camera, or pick a JPEG.');
}

/** Downscales to at most LONG_EDGE px on the long side and re-encodes as JPEG (q 0.85). */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  const { img, w, h, close } = await decode(file);
  try {
    const k = Math.min(1, LONG_EDGE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k));
    const ch = Math.max(1, Math.round(h * k));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser can’t prepare the photo.');
    ctx.drawImage(img, 0, 0, cw, ch);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('This browser can’t prepare the photo.'))), 'image/jpeg', 0.85));
  } finally {
    close();
  }
}

// ───────────────────────── samples ─────────────────────────

const item = (name: string, grams: number, kcal: number, protein_g: number, carbs_g: number, fat_g: number, fiber_g: number, sugar_g: number): FoodItem => ({ name, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g });

function sampleMeal(id: string, personId: string, takenAt: number, title: string, items: FoodItem[], confidence: number, googleStatus: GoogleStatus): Meal {
  const t = items.reduce(
    (a, x) => ({ kcal: a.kcal + x.kcal, protein_g: a.protein_g + x.protein_g, carbs_g: a.carbs_g + x.carbs_g, fat_g: a.fat_g + x.fat_g, fiber_g: a.fiber_g + x.fiber_g, sugar_g: a.sugar_g + x.sugar_g }),
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0 },
  );
  return { id, personId, takenAt, mealType: mealTypeAt(takenAt), title, ...t, items, confidence, googleStatus, googleError: googleStatus === 'no_token' ? 'Google Health is not connected for this person.' : null, photoPath: null, photoUrl: null, note: null, sample: true };
}

const PAD_KRA_PAO = [
  item('Stir-fried pork with holy basil', 180, 390, 27, 9, 27, 1.5, 4),
  item('Jasmine rice', 200, 260, 5, 57, 0.6, 0.8, 0),
  item('Fried egg', 50, 110, 6.5, 0.5, 9, 0, 0),
];

/** Plausible meals for the simulator: yesterday and today (up to now), both people. */
export function sampleMeals(now = Date.now()): Meal[] {
  const today = ictDate(now);
  const at = (date: string, h: number, m = 0) => ictMidnight(date) + h * HOUR + m * MIN;
  const y = addDays(today, -1);
  const all = [
    sampleMeal('s1', 'a', at(y, 8, 10), 'Rice porridge with pork', [item('Jok (rice porridge)', 350, 210, 8, 40, 2, 0.8, 0.5), item('Minced pork balls', 60, 140, 11, 2, 10, 0, 0.5), item('Soft-boiled egg', 50, 72, 6, 0.4, 5, 0, 0)], 0.8, 'ok'),
    sampleMeal('s2', 'b', at(y, 8, 25), 'Toast, eggs and coffee', [item('Wholegrain toast', 80, 200, 8, 34, 3, 5, 3), item('Scrambled eggs', 120, 190, 13, 2, 14, 0, 1), item('Iced latte', 300, 130, 7, 11, 6, 0, 11)], 0.85, 'ok'),
    sampleMeal('s3', 'a', at(y, 12, 40), 'Som tam with grilled chicken', [item('Green papaya salad', 200, 110, 3, 22, 1.5, 4, 14), item('Grilled chicken thigh', 150, 300, 30, 2, 19, 0, 1), item('Sticky rice', 100, 230, 4.5, 50, 0.4, 1, 0)], 0.7, 'ok'),
    sampleMeal('s4', 'b', at(y, 13, 5), 'Pad kra pao with fried egg', PAD_KRA_PAO, 0.75, 'ok'),
    sampleMeal('s5', 'a', at(y, 19, 30), 'Tom yum goong and rice', [item('Tom yum goong', 400, 210, 22, 12, 9, 2, 6), item('Jasmine rice', 180, 235, 4.5, 51, 0.5, 0.7, 0)], 0.65, 'ok'),
    sampleMeal('s6', 'b', at(y, 19, 45), 'Massaman curry with rice', [item('Massaman beef curry', 300, 520, 28, 24, 34, 4, 12), item('Jasmine rice', 200, 260, 5, 57, 0.6, 0.8, 0)], 0.6, 'ok'),
    sampleMeal('s7', 'a', at(today, 7, 50), 'Greek yoghurt with mango', [item('Greek yoghurt', 170, 160, 17, 7, 7, 0, 7), item('Mango', 120, 72, 1, 18, 0.5, 1.9, 16), item('Granola', 30, 135, 3, 19, 5, 2, 6)], 0.85, 'ok'),
    sampleMeal('s8', 'b', at(today, 8, 15), 'Khao man gai', [item('Poached chicken', 120, 230, 30, 0, 12, 0, 0), item('Chicken-fat rice', 200, 360, 6, 60, 10, 1, 0), item('Ginger-soy sauce', 30, 35, 1, 6, 0.5, 0.3, 4)], 0.75, 'no_token'),
    sampleMeal('s9', 'a', at(today, 12, 30), 'Pad kra pao with fried egg', PAD_KRA_PAO, 0.8, 'ok'),
    sampleMeal('s10', 'b', at(today, 15, 40), 'Banana and iced coffee', [item('Banana', 120, 105, 1.3, 27, 0.4, 3, 14), item('Iced Thai coffee', 300, 180, 3, 30, 5, 0, 28)], 0.9, 'pending'),
  ];
  return all.filter((m) => m.takenAt <= now).sort((a, b) => b.takenAt - a.takenAt);
}

// ───────────────────────── the hook ─────────────────────────

const OFFLINE = 'Couldn’t reach the server. Check the connection and try again.';

async function callFoodPhoto(body: Record<string, unknown>): Promise<Meal> {
  const { data } = await supabaseClient().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Signed out. Sign in again to log meals.');
  let res: Response;
  try {
    res = await fetch(`${functionsUrl()}/food-photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(OFFLINE);
  }
  let json: Row = {};
  try {
    json = (await res.json()) as Row;
  } catch {
    /* keep {} */
  }
  if (res.ok && json.meal && typeof json.meal === 'object') return toMeal(json.meal as Row);
  const err = typeof json.error === 'string' ? json.error : '';
  if (res.status === 422) throw new Error('No food found in that photo. Try again with the plate in frame.');
  if (res.status === 429) throw new Error('The food model is busy. Try again in a minute.');
  if (res.status === 404 && !err) throw new Error('The food-photo function isn’t deployed yet.');
  throw new Error(err || `Couldn’t read the photo (HTTP ${res.status}).`);
}

async function signPhotos(meals: Meal[]): Promise<Meal[]> {
  const paths = [...new Set(meals.map((m) => m.photoPath).filter((p): p is string => !!p))];
  if (!paths.length) return meals;
  const { data } = await supabaseClient().storage.from(BUCKET).createSignedUrls(paths, 3600);
  const urls = new Map((data ?? []).flatMap((d) => (d.path && d.signedUrl ? [[d.path, d.signedUrl] as const] : [])));
  return meals.map((m) => (m.photoPath && urls.has(m.photoPath) ? { ...m, photoUrl: urls.get(m.photoPath)! } : m));
}

export function useMeals() {
  const auth = useAuth();
  const { mode } = useData();
  const member = auth.status === 'signed-in' && !!auth.probe?.member;
  const real = member && mode !== 'sim';
  const role = auth.probe?.role ?? null;
  const canWrite = real && (role === 'owner' || role === 'member');
  const owner = real && role === 'owner';
  const myPerson = auth.probe?.personId ?? null;

  const [meals, setMeals] = useState<Meal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMeal | null>(null);
  /** The meal just added: the page shows it as the result card. */
  const [latestId, setLatestId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    if (!real) {
      setMeals(sampleMeals());
      setError(null);
      return;
    }
    setError(null);
    const since = new Date(ictMidnight(addDays(ictDate(Date.now()), -(DAYS - 1)))).toISOString();
    supabaseClient()
      .from('meals')
      .select('id,person_id,taken_at,meal_type,photo_path,note,title,kcal,protein_g,carbs_g,fat_g,fiber_g,sugar_g,items,confidence,google_status,google_error')
      .eq('hidden', false)
      .gte('taken_at', since)
      .order('taken_at', { ascending: false })
      .limit(200)
      .then(async ({ data, error: e }) => {
        if (!alive) return;
        if (e) {
          // Before migration 0020 the table doesn't exist: show an empty log with the reason.
          setError(/does not exist|schema cache/i.test(e.message) ? 'The meals table isn’t on the server yet (migration 0020).' : e.message);
          setMeals([]);
          return;
        }
        const list = await signPhotos(((data ?? []) as Row[]).map(toMeal)).catch(() => ((data ?? []) as Row[]).map(toMeal));
        if (alive) setMeals(list);
      });
    return () => {
      alive = false;
    };
  }, [real, nonce]);

  const upsert = useCallback((m: Meal) => setMeals((prev) => [m, ...(prev ?? []).filter((x) => x.id !== m.id)].sort((a, b) => b.takenAt - a.takenAt)), []);

  /** Photo from the camera input → analysed meal. Resolves with an error message, or null. */
  const addPhoto = useCallback(
    async (file: File, personId: string): Promise<string | null> => {
      const previewUrl = URL.createObjectURL(file);
      const fail = (msg: string) => {
        setPending((p) => (p ? { ...p, error: msg } : p));
        return msg;
      };
      setLatestId(null);
      setPending((p) => {
        if (p) URL.revokeObjectURL(p.previewUrl);
        return { personId, previewUrl, stage: 'shrinking', error: null };
      });
      // A photo picked from the library keeps its own time when it's recent; a fresh capture is "now".
      const now = Date.now();
      const takenAt = file.lastModified && file.lastModified <= now && now - file.lastModified < 2 * DAY ? file.lastModified : now;
      let jpeg: Blob;
      try {
        jpeg = await shrinkPhoto(file);
      } catch (e) {
        return fail(e instanceof Error ? e.message : 'Couldn’t open that photo.');
      }
      if (!real) {
        setPending((p) => (p ? { ...p, stage: 'reading' } : p));
        await new Promise((r) => setTimeout(r, 1600));
        const m = { ...sampleMeal(`s-${now}`, personId, takenAt, 'Pad kra pao with fried egg', PAD_KRA_PAO, 0.75, null), photoUrl: URL.createObjectURL(jpeg), note: 'Sample analysis' };
        upsert(m);
        setLatestId(m.id);
        setPending(null);
        URL.revokeObjectURL(previewUrl);
        return null;
      }
      if (!canWrite) return fail('Your household role is read-only.');
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return fail(OFFLINE);
      const path = `${personId}/${crypto.randomUUID()}.jpg`;
      setPending((p) => (p ? { ...p, stage: 'uploading' } : p));
      const up = await supabaseClient()
        .storage.from(BUCKET)
        .upload(path, jpeg, { contentType: 'image/jpeg', upsert: false })
        .catch((e: unknown) => ({ error: { message: e instanceof Error ? e.message : String(e) } }));
      if (up.error) {
        const m = up.error.message;
        // Safari says "Load failed", Chrome "Failed to fetch" when the network drops mid-upload.
        if (/load failed|failed to fetch|network/i.test(m)) return fail(OFFLINE);
        return fail(/bucket not found/i.test(m) ? 'The meals photo bucket isn’t on the server yet (migration 0020).' : `Upload failed: ${m}`);
      }
      setPending((p) => (p ? { ...p, stage: 'reading' } : p));
      try {
        const meal = await callFoodPhoto({ photoPath: path, takenAt: new Date(takenAt).toISOString(), personId });
        const [signed] = await signPhotos([meal]).catch(() => [meal]);
        upsert(signed ?? meal);
        setLatestId(meal.id);
        setPending(null);
        URL.revokeObjectURL(previewUrl);
        return null;
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
    [real, canWrite, upsert],
  );

  const dismissPending = useCallback(() => {
    setPending((p) => {
      if (p) URL.revokeObjectURL(p.previewUrl);
      return null;
    });
  }, []);

  /** hide / regenerate / resync. Resolves with an error message, or null. */
  const act = useCallback(
    async (meal: Meal, action: MealAction): Promise<string | null> => {
      if (!real || meal.sample) {
        if (action === 'hide') setMeals((prev) => (prev ?? []).filter((x) => x.id !== meal.id));
        return action === 'hide' ? null : 'Sample meal: sign in to analyse real photos.';
      }
      if (!canWrite) return 'Your household role is read-only.';
      try {
        const m = await callFoodPhoto({ mealId: meal.id, action });
        if (action === 'hide') {
          setMeals((prev) => (prev ?? []).filter((x) => x.id !== meal.id));
          setLatestId((id) => (id === meal.id ? null : id));
        } else upsert({ ...m, photoUrl: meal.photoUrl });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [real, canWrite, upsert],
  );

  const latest = useMemo(() => (latestId ? (meals ?? []).find((m) => m.id === latestId) ?? null : null), [meals, latestId]);

  return { real, canWrite: real ? canWrite : true, owner, myPerson, meals, error, pending, latest, addPhoto, dismissPending, act, refresh, clearLatest: () => setLatestId(null) };
}
