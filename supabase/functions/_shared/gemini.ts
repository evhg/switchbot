// Gemini API (generativelanguage.googleapis.com v1beta) generateContent with an API key: GEMINI_API_KEY when set, else
// the Vault secret 'gemini_api_key' (_shared/secrets.ts). The key goes in the x-goog-api-key header, never in a URL
// or an error message.
import { NotConfiguredError } from './env.ts';
import { appSecret } from './secrets.ts';
import type { Db } from './supabase.ts';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

/** The API key, or a 503 "not configured" (missing GEMINI_API_KEY) when neither the env nor Vault has one. */
export async function geminiApiKey(db: Db): Promise<string> {
  const key = await appSecret(db, 'gemini_api_key', 'GEMINI_API_KEY');
  if (!key) throw new NotConfiguredError('GEMINI_API_KEY');
  return key;
}

/**
 * POST models/<model>:generateContent. One retry on 429 / 5xx after 2 s (Gemini's "overloaded" 503s are brief).
 * Returns the parsed response body.
 */
export async function generateContent(apiKey: string, model: string, body: unknown, { timeoutMs = 90_000 } = {}): Promise<unknown> {
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
  for (let attempt = 0;; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new GeminiError('Gemini: response is not JSON', 502);
      }
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    let msg = text.slice(0, 300);
    try {
      const e = (JSON.parse(text) as { error?: { message?: string; status?: string } }).error;
      if (e?.message) msg = `${e.status ? `${e.status}: ` : ''}${e.message}`;
    } catch { /* not JSON */ }
    throw new GeminiError(`Gemini HTTP ${res.status}: ${msg}`, res.status);
  }
}
