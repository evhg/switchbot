import { describe, expect, it } from 'vitest';
import {
  createNutritionLog,
  deleteNutritionLogs,
  foodPrompt,
  foodRequestBody,
  geminiResponseText,
  mealTypeAt,
  nutritionLogDataPoint,
  nutritionPointId,
  NutritionLogError,
  parseFoodAnalysis,
  FOOD_RESPONSE_SCHEMA,
} from '../src/index.ts';

// gemini-2.5-flash generateContent with responseMimeType application/json (trimmed usage metadata): pad kra pao gai
// with a fried egg and jasmine rice, and a Thai iced tea.
const KRAPAO = {
  is_food: true,
  title: 'Pad kra pao with egg and tea',
  items: [
    { name: 'Jasmine rice', grams: 200, kcal: 260, protein_g: 5.4, carbs_g: 57, fat_g: 0.6, fiber_g: 0.8, sugar_g: 0.1 },
    { name: 'Stir-fried chicken with holy basil', grams: 180, kcal: 340, protein_g: 31, carbs_g: 9, fat_g: 20, fiber_g: 1.2, sugar_g: 5 },
    { name: 'Fried egg (khai dao)', grams: 55, kcal: 120, protein_g: 7, carbs_g: 0.4, fat_g: 10, fiber_g: 0, sugar_g: 0.2 },
    { name: 'Thai iced tea with condensed milk', grams: 350, kcal: 240, protein_g: 3, carbs_g: 44, fat_g: 6, fiber_g: 0, sugar_g: 42 },
  ],
  totals: { kcal: 960, protein_g: 46.4, carbs_g: 110.4, fat_g: 36.6, fiber_g: 2, sugar_g: 47.3 },
  confidence: 0.72,
  notes: 'Oil in the stir-fry and the amount of condensed milk are guesses.',
};
const GEMINI_RESPONSE = {
  candidates: [
    {
      content: { parts: [{ text: JSON.stringify(KRAPAO) }], role: 'model' },
      finishReason: 'STOP',
      index: 0,
    },
  ],
  usageMetadata: { promptTokenCount: 1490, candidatesTokenCount: 310, totalTokenCount: 2604, thoughtsTokenCount: 804 },
  modelVersion: 'gemini-2.5-flash',
  responseId: 'xYQFadKXBePfz7IP1Y2-0Ac',
};

describe('food/meal', () => {
  it('reads the answer text and parses a realistic analysis; totals are the item sums', () => {
    const a = parseFoodAnalysis(geminiResponseText(GEMINI_RESPONSE))!;
    expect(a.isFood).toBe(true);
    expect(a.title).toBe('Pad kra pao with egg and tea');
    expect(a.items).toHaveLength(4);
    expect(a.items[1]).toMatchObject({ name: 'Stir-fried chicken with holy basil', grams: 180, kcal: 340, protein_g: 31 });
    expect(a.totals).toEqual({ kcal: 960, protein_g: 46.4, carbs_g: 110.4, fat_g: 36.6, fiber_g: 2, sugar_g: 47.3 });
    expect(a.confidence).toBe(0.72);
    expect(a.notes).toMatch(/condensed milk/);
    expect(a.modelTotals).toBeNull();
  });

  it('clamps nonsense numbers, drops unnamed items and keeps the model totals only when they disagree', () => {
    const a = parseFoodAnalysis({
      title: '  Som tam\n ',
      items: [
        { name: 'Som tam', grams: '250', kcal: -10, protein_g: 4, carbs_g: 20, fat_g: 'x', fiber_g: 30, sugar_g: 50 },
        { name: '', grams: 100, kcal: 100 },
        { name: 'Sticky rice', grams: 1e9, kcal: 1e9, protein_g: 6, carbs_g: 80, fat_g: 1, fiber_g: 1, sugar_g: 0 },
      ],
      totals: { kcal: 300, protein_g: 10, carbs_g: 100, fat_g: 1, fiber_g: 3, sugar_g: 10 },
      confidence: 3,
    })!;
    expect(a.items.map((i) => i.name)).toEqual(['Som tam', 'Sticky rice']);
    expect(a.items[0]).toMatchObject({ grams: 250, kcal: 0, fat_g: 0, fiber_g: 20, sugar_g: 20 });
    expect(a.items[1]).toMatchObject({ grams: 3000, kcal: 5000 });
    expect(a.totals.kcal).toBe(5000);
    expect(a.modelTotals?.kcal).toBe(300);
    expect(a.confidence).toBe(1);
    expect(a.title).toBe('Som tam');
    expect(a.isFood).toBe(true);
  });

  it('handles no food, code fences, model totals without items and garbage', () => {
    const none = parseFoodAnalysis('```json\n{"is_food":false,"title":"","items":[],"totals":{"kcal":0},"confidence":0.9}\n```')!;
    expect(none.isFood).toBe(false);
    expect(none.totals.kcal).toBe(0);
    const totalsOnly = parseFoodAnalysis({ title: 'Latte', items: [], totals: { kcal: 190, protein_g: 10, carbs_g: 15, fat_g: 7 }, confidence: 0.8 })!;
    expect(totalsOnly.totals).toMatchObject({ kcal: 190, protein_g: 10, carbs_g: 15, fat_g: 7, fiber_g: 0, sugar_g: 0 });
    expect(totalsOnly.isFood).toBe(true);
    expect(parseFoodAnalysis('not json')).toBeNull();
    expect(parseFoodAnalysis([1, 2])).toBeNull();
  });

  it('geminiResponseText skips thought parts and reports blocks and empty answers', () => {
    expect(geminiResponseText({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"a":' }, { text: '1}' }] } }] })).toBe('{"a":1}');
    expect(() => geminiResponseText({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/blocked: SAFETY/);
    expect(() => geminiResponseText({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] })).toThrow(/MAX_TOKENS/);
  });

  it('mealTypeAt uses the ICT clock', () => {
    expect(mealTypeAt(Date.parse('2026-11-01T01:30:00Z'))).toBe('breakfast'); // 08:30
    expect(mealTypeAt(Date.parse('2026-11-01T05:15:00Z'))).toBe('lunch'); // 12:15
    expect(mealTypeAt(Date.parse('2026-11-01T09:30:00Z'))).toBe('snack'); // 16:30
    expect(mealTypeAt(Date.parse('2026-11-01T12:45:00Z'))).toBe('dinner'); // 19:45
    expect(mealTypeAt(Date.parse('2026-11-01T16:00:00Z'))).toBe('snack'); // 23:00
    expect(mealTypeAt(Date.parse('2026-11-01T22:30:00Z'))).toBe('breakfast'); // 05:30 next day
  });

  it('prompt and request body carry the photo, the local time, the note and the schema', () => {
    const takenAt = Date.parse('2026-11-01T12:10:00Z');
    expect(foodPrompt({ takenAt, mealType: 'dinner', note: 'half the rice' })).toMatch(/19:10, logged as dinner[\s\S]*"half the rice"/);
    const body = foodRequestBody({ takenAt, imageBase64: 'AAAA', mimeType: 'image/jpeg' }) as {
      contents: { parts: Record<string, unknown>[] }[];
      generationConfig: Record<string, unknown>;
    };
    expect(body.contents[0]!.parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBe(FOOD_RESPONSE_SCHEMA);
    expect(FOOD_RESPONSE_SCHEMA.properties.items.items.required).toContain('sugar_g');
  });
});

describe('food/nutrition', () => {
  const meal = {
    id: '6f1c2b3a-9d4e-4f5a-8b7c-0e1d2c3b4a59',
    title: 'Pad kra pao with egg and tea',
    mealType: 'lunch' as const,
    takenAt: Date.parse('2026-11-01T05:12:30Z'),
    kcal: 960.4,
    protein_g: 46.4,
    carbs_g: 110.4,
    fat_g: 36.6,
    fiber_g: 0,
    sugar_g: 47.3,
  };

  it('maps a meal to a NutritionLog data point (ICT offsets, nutrients without zeros)', () => {
    const id = nutritionPointId(meal.id);
    expect(id).toBe('meal-6f1c2b3a-9d4e-4f5a-8b7c-0e1d2c3b4a59');
    expect(nutritionLogDataPoint(meal, id)).toEqual({
      name: 'users/me/dataTypes/nutrition-log/dataPoints/meal-6f1c2b3a-9d4e-4f5a-8b7c-0e1d2c3b4a59',
      nutritionLog: {
        foodDisplayName: 'Pad kra pao with egg and tea',
        mealType: 'LUNCH',
        energy: { kcal: 960 },
        totalCarbohydrate: { grams: 110.4 },
        totalFat: { grams: 36.6 },
        nutrients: [
          { nutrient: 'PROTEIN', quantity: { grams: 46.4 } },
          { nutrient: 'SUGAR', quantity: { grams: 47.3 } },
        ],
        interval: {
          startTime: '2026-11-01T05:12:30.000Z',
          endTime: '2026-11-01T05:27:30.000Z',
          startUtcOffset: '25200s',
          endUtcOffset: '25200s',
        },
      },
    });
  });

  it('nutritionPointId counts rewrites and stays within 63 characters', () => {
    const first = nutritionPointId(meal.id);
    const second = nutritionPointId(meal.id, `users/me/dataTypes/nutrition-log/dataPoints/${first}`);
    expect(second).toBe(`${first}-2`);
    expect(nutritionPointId(meal.id, second)).toBe(`${first}-3`);
    expect(nutritionPointId(meal.id, 'users/me/dataTypes/nutrition-log/dataPoints/something-else')).toBe(first);
    expect(nutritionPointId(meal.id, `${first}-41`).length).toBeLessThanOrEqual(63);
  });

  it('createNutritionLog posts the point and reads the operation', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const point = nutritionLogDataPoint(meal, nutritionPointId(meal.id));
    const done = await createNutritionLog('tok', point, {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ name: 'operations/abc', done: true, response: { '@type': 'type.googleapis.com/google.devicesandservices.health.v4.DataPoint', name: point.name } }));
      },
    });
    expect(calls[0]!.url).toBe('https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints');
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0]!.init!.body)).nutritionLog.mealType).toBe('LUNCH');
    expect(done).toEqual({ status: 'ok', name: point.name, operation: 'operations/abc' });

    const pending = await createNutritionLog('tok', point, { fetch: async () => new Response(JSON.stringify({ name: 'operations/def', done: false })) });
    expect(pending.status).toBe('pending');

    await expect(
      createNutritionLog('tok', point, {
        fetch: async () => new Response(JSON.stringify({ error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } }), { status: 403 }),
      }),
    ).rejects.toThrow(NutritionLogError);
    await expect(
      createNutritionLog('tok', point, { fetch: async () => new Response(JSON.stringify({ name: 'operations/x', done: true, error: { code: 3, message: 'bad interval' } })) }),
    ).rejects.toThrow(/bad interval/);
  });

  it('deleteNutritionLogs posts names to :batchDelete and skips an empty list', async () => {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      return new Response('{}');
    };
    await deleteNutritionLogs('tok', [], { fetch: f });
    await deleteNutritionLogs('tok', ['users/me/dataTypes/nutrition-log/dataPoints/meal-x'], { fetch: f });
    expect(urls).toEqual(['https://health.googleapis.com/v4/users/me/dataTypes/nutrition-log/dataPoints:batchDelete']);
  });
});
