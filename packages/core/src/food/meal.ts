// Food photo → meal: the Gemini prompt and response schema, parsing and clamping of the model's answer, and the meal
// type from the local time. Used by the food-photo Edge Function (public.meals, migration 0020).
import type { Ms } from '../types.ts';

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export const MEAL_TYPES: readonly MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export const FOOD_MODEL = 'gemini-2.5-flash';

/** Nutrition of one item or of the whole meal. Grams of food, kcal, grams of each macro. */
export interface Nutrition {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
}

export interface FoodItem extends Nutrition {
  name: string;
  grams: number;
}

export interface FoodAnalysis {
  isFood: boolean;
  title: string;
  items: FoodItem[];
  /** Sums of the items; the model's own totals only when it listed no items. */
  totals: Nutrition;
  confidence: number;
  notes: string | null;
  /** The model's totals when they differ from the item sums by more than 10 % (kcal), else null. */
  modelTotals: Nutrition | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Per item: up to 3 kg of food, 5000 kcal, 1 kg of any macro. Per meal: 10,000 kcal, 2 kg of any macro. */
const ITEM_MAX = { grams: 3000, kcal: 5000, macro: 1000 };
const MEAL_MAX = { kcal: 10_000, macro: 2000 };
const MAX_ITEMS = 20;

const MACROS = ['protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g'] as const;

function nutrition(o: Obj, maxKcal: number, maxMacro: number): Nutrition {
  const g = (k: string) => round1(clamp(num(o[k]) ?? 0, 0, maxMacro));
  const n: Nutrition = {
    kcal: Math.round(clamp(num(o.kcal) ?? 0, 0, maxKcal)),
    protein_g: g('protein_g'),
    carbs_g: g('carbs_g'),
    fat_g: g('fat_g'),
    fiber_g: g('fiber_g'),
    sugar_g: g('sugar_g'),
  };
  // Sugar and fibre are part of the carbohydrate (as on a label); a model sometimes reports them on their own.
  if (n.carbs_g > 0) {
    n.sugar_g = Math.min(n.sugar_g, n.carbs_g);
    n.fiber_g = Math.min(n.fiber_g, n.carbs_g);
  }
  return n;
}

export function sumNutrition(xs: readonly Nutrition[]): Nutrition {
  const out: Nutrition = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0 };
  for (const x of xs) {
    out.kcal += x.kcal;
    for (const k of MACROS) out[k] += x[k];
  }
  out.kcal = Math.round(clamp(out.kcal, 0, MEAL_MAX.kcal));
  for (const k of MACROS) out[k] = round1(clamp(out[k], 0, MEAL_MAX.macro));
  return out;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * The model's JSON (already parsed, or as the JSON string) → a validated FoodAnalysis. Numbers are clamped to
 * plausible ranges, unnamed items dropped, totals recomputed from the items. Null when it isn't an object at all.
 */
export function parseFoodAnalysis(json: unknown): FoodAnalysis | null {
  let v = json;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(stripCodeFence(v));
    } catch {
      return null;
    }
  }
  if (!isObj(v)) return null;
  const items: FoodItem[] = [];
  for (const it of Array.isArray(v.items) ? v.items : []) {
    if (!isObj(it)) continue;
    const name = text(it.name, 80);
    if (!name) continue;
    items.push({ name, grams: Math.round(clamp(num(it.grams) ?? 0, 0, ITEM_MAX.grams)), ...nutrition(it, ITEM_MAX.kcal, ITEM_MAX.macro) });
    if (items.length >= MAX_ITEMS) break;
  }
  const reported = isObj(v.totals) ? nutrition(v.totals, MEAL_MAX.kcal, MEAL_MAX.macro) : null;
  const summed = sumNutrition(items);
  const totals = items.length ? summed : reported ?? summed;
  const differs = items.length > 0 && reported !== null && Math.abs(reported.kcal - summed.kcal) > Math.max(20, summed.kcal * 0.1);
  const isFood = typeof v.is_food === 'boolean' ? v.is_food : items.length > 0 || totals.kcal > 0;
  const title = text(v.title, 120) || (items.length ? items.map((i) => i.name).slice(0, 3).join(', ') : '');
  return {
    isFood,
    title,
    items,
    totals,
    confidence: round2(clamp(num(v.confidence) ?? 0, 0, 1)),
    notes: text(v.notes, 500) || null,
    modelTotals: differs ? reported : null,
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function stripCodeFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1]! : s;
}

/**
 * Text of the first candidate of a Gemini generateContent response (thought parts skipped). Throws with the block or
 * finish reason when there is none.
 */
export function geminiResponseText(json: unknown): string {
  if (!isObj(json)) throw new Error('Gemini: response is not an object');
  const cands = Array.isArray(json.candidates) ? json.candidates : [];
  const c = cands.find(isObj);
  if (!c) {
    const fb = isObj(json.promptFeedback) ? json.promptFeedback : null;
    throw new Error(`Gemini: no candidate${fb?.blockReason ? ` (blocked: ${fb.blockReason})` : ''}`);
  }
  const parts = isObj(c.content) && Array.isArray(c.content.parts) ? c.content.parts : [];
  const out = parts.filter((p): p is Obj => isObj(p) && p.thought !== true && typeof p.text === 'string').map((p) => p.text as string).join('');
  if (!out.trim()) throw new Error(`Gemini: empty answer${typeof c.finishReason === 'string' ? ` (finishReason ${c.finishReason})` : ''}`);
  return out;
}

/**
 * Meal type from the local clock time (default ICT, UTC+7): 05:00–10:59 breakfast, 11:00–15:59 lunch, 17:00–21:59
 * dinner, otherwise snack.
 */
export function mealTypeAt(ts: Ms, utcOffsetMin = 420): MealType {
  const d = new Date(ts + utcOffsetMin * 60_000);
  const h = d.getUTCHours();
  if (h >= 5 && h < 11) return 'breakfast';
  if (h >= 11 && h < 16) return 'lunch';
  if (h >= 17 && h < 22) return 'dinner';
  return 'snack';
}

export function isMealType(v: unknown): v is MealType {
  return typeof v === 'string' && (MEAL_TYPES as readonly string[]).includes(v);
}

/** "HH:MM" local time for the prompt. */
function localClock(ts: Ms, utcOffsetMin: number): string {
  return new Date(ts + utcOffsetMin * 60_000).toISOString().slice(11, 16);
}

export interface FoodPromptOptions {
  takenAt: Ms;
  mealType?: MealType;
  note?: string | null;
  utcOffsetMin?: number;
}

/** The instruction sent with the photo. The household eats mostly Thai and Western food in Phuket. */
export function foodPrompt(o: FoodPromptOptions): string {
  const off = o.utcOffsetMin ?? 420;
  const note = o.note ? text(o.note, 300) : '';
  return [
    'You are a careful nutritionist. Estimate what is in this photo of a meal and its nutrition.',
    `Context: home in Phuket, Thailand; local time ${localClock(o.takenAt, off)}${o.mealType ? `, logged as ${o.mealType}` : ''}.`,
    note ? `The person eating it says: "${note}". Trust this over what you see when they conflict.` : '',
    'List every distinct food or drink as an item with its estimated edible weight in grams (what is on the plate or in',
    'the glass, without bones, shells or packaging) and, for that weight: kcal, protein_g, carbs_g, fat_g, fiber_g,',
    'sugar_g (sugar and fibre are part of carbs). Use typical recipes, including cooking oil, sauces and dressings you',
    'can see. Judge portion sizes from plates, cutlery and hands. Shared dishes: estimate the whole dish shown.',
    'totals: the sums over the items. title: a short name for the meal (max 6 words, in English).',
    'confidence: 0..1, how sure you are about the portions and the dishes. notes: one sentence on what was uncertain.',
    'If the photo shows no food or drink, set is_food false, items [] and every total 0.',
  ].filter(Boolean).join('\n');
}

const NUTRITION_PROPS = {
  kcal: { type: 'NUMBER' },
  protein_g: { type: 'NUMBER' },
  carbs_g: { type: 'NUMBER' },
  fat_g: { type: 'NUMBER' },
  fiber_g: { type: 'NUMBER' },
  sugar_g: { type: 'NUMBER' },
} as const;
const NUTRITION_KEYS = Object.keys(NUTRITION_PROPS);

/** generationConfig.responseSchema (Gemini's OpenAPI subset) for the answer parseFoodAnalysis reads. */
export const FOOD_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_food: { type: 'BOOLEAN' },
    title: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, grams: { type: 'NUMBER' }, ...NUTRITION_PROPS },
        required: ['name', 'grams', ...NUTRITION_KEYS],
        propertyOrdering: ['name', 'grams', ...NUTRITION_KEYS],
      },
    },
    totals: { type: 'OBJECT', properties: { ...NUTRITION_PROPS }, required: NUTRITION_KEYS, propertyOrdering: NUTRITION_KEYS },
    confidence: { type: 'NUMBER' },
    notes: { type: 'STRING' },
  },
  required: ['is_food', 'title', 'items', 'totals', 'confidence'],
  propertyOrdering: ['is_food', 'title', 'items', 'totals', 'confidence', 'notes'],
} as const;

export interface FoodRequestOptions extends FoodPromptOptions {
  imageBase64: string;
  mimeType: string;
}

/** generateContent request body: the photo first, then the instruction; JSON output with FOOD_RESPONSE_SCHEMA. */
export function foodRequestBody(o: FoodRequestOptions): Record<string, unknown> {
  return {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: o.mimeType, data: o.imageBase64 } }, { text: foodPrompt(o) }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: FOOD_RESPONSE_SCHEMA, temperature: 0.2 },
  };
}
