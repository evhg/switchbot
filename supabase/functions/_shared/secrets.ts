// App-level API keys: a function secret (env) when set, else Supabase Vault through public.app_secret() (migration
// 0020, service role only; allow-list 'google_weather_api_key', 'gemini_api_key'). Cached per worker for 10 min, so
// a rotated Vault value is picked up without a redeploy.
import { optEnv } from './env.ts';
import type { Db } from './supabase.ts';

export type AppSecretName = 'google_weather_api_key' | 'gemini_api_key';

const CACHE_MS = 10 * 60_000;
const cache = new Map<AppSecretName, { value: string | null; at: number }>();

/**
 * The secret's value, or null when neither the env var nor Vault has it. A Vault/RPC error (e.g. migration 0020 not
 * applied yet) is logged and treated as missing, so callers keep their fallback.
 */
export async function appSecret(db: Db, name: AppSecretName, envName: string): Promise<string | null> {
  const fromEnv = optEnv(envName);
  if (fromEnv) return fromEnv;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const { data, error } = await db.rpc('app_secret', { p_name: name });
  if (error) {
    console.error(`app_secret(${name})`, error.message);
    return null;
  }
  const value = typeof data === 'string' && data ? data : null;
  cache.set(name, { value, at: Date.now() });
  return value;
}
