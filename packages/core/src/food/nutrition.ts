// Meal → Google Health API v4 nutrition-log data point, and the two calls food-photo makes with it. Field shapes are
// from the v4 discovery document (schemas DataPoint, NutritionLog, SessionTimeInterval, EnergyQuantity,
// WeightQuantity, NutrientQuantity; methods dataPoints.create / dataPoints.batchDelete), checked 2026-11-01. Both need
// a token narrowed to googlehealth.nutrition.writeonly. A log of an "anonymous" food (foodDisplayName + values) can't
// be edited, so a changed meal is written as a new point and the previous one removed.
import type { Ms } from '../types.ts';
import type { FetchLike } from '../switchbot/sign.ts';
import type { MealType, Nutrition } from './meal.ts';

export const NUTRITION_LOG_URL = 'https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints';

const GOOGLE_MEAL_TYPE: Record<MealType, string> = { breakfast: 'BREAKFAST', lunch: 'LUNCH', dinner: 'DINNER', snack: 'SNACK' };

export interface MealForLog extends Nutrition {
  id: string;
  title: string;
  mealType: MealType;
  takenAt: Ms;
}

/**
 * Data point id for a meal: `meal-<uuid>` the first time, then `meal-<uuid>-2`, `-3` … for each rewrite (ids are
 * 4–63 lowercase letters, digits and hyphens). A retried first write reuses the id, so Google can refuse the duplicate.
 */
export function nutritionPointId(mealId: string, previous?: string | null): string {
  const base = `meal-${mealId.toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 58);
  const prevId = previous?.split('/').pop() ?? '';
  if (!prevId.startsWith(base)) return base;
  const n = Number(prevId.slice(base.length).replace(/^-/, '') || '1');
  return `${base}-${Number.isFinite(n) ? n + 1 : 2}`;
}

export const nutritionPointName = (id: string) => `users/me/dataTypes/nutrition-log/dataPoints/${id}`;

const offset = (min: number) => `${min * 60}s`;
const grams = (g: number) => ({ grams: Math.round(g * 10) / 10 });

/**
 * DataPoint body for dataPoints.create. The interval is the photo time (start) to + 15 min (end), at the local UTC
 * offset (ICT "25200s"). Zero nutrients are left out; energy, carbs and fat are always sent.
 */
export function nutritionLogDataPoint(meal: MealForLog, pointId: string, utcOffsetMin = 420): Record<string, unknown> {
  const nutrients: { nutrient: string; quantity: { grams: number } }[] = [];
  const add = (nutrient: string, g: number) => {
    if (g > 0) nutrients.push({ nutrient, quantity: grams(g) });
  };
  add('PROTEIN', meal.protein_g);
  add('DIETARY_FIBER', meal.fiber_g);
  add('SUGAR', meal.sugar_g);
  return {
    name: nutritionPointName(pointId),
    nutritionLog: {
      foodDisplayName: (meal.title || 'Meal').slice(0, 100),
      mealType: GOOGLE_MEAL_TYPE[meal.mealType],
      energy: { kcal: Math.min(100_000, Math.max(0, Math.round(meal.kcal))) },
      totalCarbohydrate: grams(meal.carbs_g),
      totalFat: grams(meal.fat_g),
      ...(nutrients.length ? { nutrients } : {}),
      interval: {
        startTime: new Date(meal.takenAt).toISOString(),
        endTime: new Date(meal.takenAt + 15 * 60_000).toISOString(),
        startUtcOffset: offset(utcOffsetMin),
        endUtcOffset: offset(utcOffsetMin),
      },
    },
  };
}

export class NutritionLogError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'NutritionLogError';
    this.status = status;
    this.body = body;
  }
}

export interface NutritionWriteResult {
  /** 'ok' = the operation is done without error; 'pending' = long-running operation not finished yet. */
  status: 'ok' | 'pending';
  /** Data point name from the operation's response, else the one we sent. */
  name: string;
  operation: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

async function call(fetchImpl: FetchLike, url: string, accessToken: string, body: unknown): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* keep null */ }
  if (!res.ok) {
    const err = isObj(json) && isObj(json.error) ? json.error : null;
    const msg = typeof err?.message === 'string' ? err.message : text.slice(0, 300);
    throw new NutritionLogError(`HTTP ${res.status}${err?.status ? ` ${err.status}` : ''}: ${msg}`, res.status, json ?? text);
  }
  return json;
}

/** dataPoints.create. Returns an Operation; a finished one with `error` is thrown as NutritionLogError. */
export async function createNutritionLog(
  accessToken: string,
  dataPoint: Record<string, unknown>,
  opts: { fetch?: FetchLike; url?: string } = {},
): Promise<NutritionWriteResult> {
  const fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
  const op = await call(fetchImpl, opts.url ?? NUTRITION_LOG_URL, accessToken, dataPoint);
  const o = isObj(op) ? op : {};
  if (isObj(o.error)) {
    throw new NutritionLogError(`operation failed: ${typeof o.error.message === 'string' ? o.error.message : JSON.stringify(o.error)}`, 200, op);
  }
  const resp = isObj(o.response) ? o.response : null;
  // A create may also answer with the DataPoint itself.
  const name = typeof resp?.name === 'string' ? resp.name : typeof o.name === 'string' && o.name.includes('/dataPoints/') ? o.name : String(dataPoint.name ?? '');
  const done = o.done === true || (!('done' in o) && !(typeof o.name === 'string' && o.name.includes('operations/')));
  return { status: done ? 'ok' : 'pending', name, operation: typeof o.name === 'string' && !o.name.includes('/dataPoints/') ? o.name : null };
}

/** dataPoints.batchDelete for the given point names. Returns an Operation; a finished one with `error` is thrown. */
export async function deleteNutritionLogs(accessToken: string, names: string[], opts: { fetch?: FetchLike; url?: string } = {}): Promise<void> {
  if (!names.length) return;
  const fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
  const op = await call(fetchImpl, `${opts.url ?? NUTRITION_LOG_URL}:batchDelete`, accessToken, { names });
  if (isObj(op) && isObj(op.error)) {
    throw new NutritionLogError(`operation failed: ${typeof op.error.message === 'string' ? op.error.message : JSON.stringify(op.error)}`, 200, op);
  }
}
