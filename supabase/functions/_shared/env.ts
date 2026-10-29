import { HttpError } from './http.ts';

/** A required function secret. Missing → 503 {"error":"not configured","missing":NAME}; the request is not retried. */
export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new NotConfiguredError(name);
  return v;
}

export class NotConfiguredError extends HttpError {
  missing: string;
  constructor(name: string) {
    super(503, 'not configured');
    this.name = 'NotConfiguredError';
    this.missing = name;
  }
}

/**
 * The key that bypasses RLS, for the service client: the legacy JWT service-role key while the project still
 * has it (SUPABASE_SERVICE_ROLE_KEY; Supabase retires legacy keys at the end of 2026), else the new secret key
 * (SUPABASE_SECRET_KEYS.default, `sb_secret_…`).
 */
export function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const k = serviceKeys()[0];
  if (!k) throw new NotConfiguredError('SUPABASE_SECRET_KEYS');
  return k;
}

/** Every service-level key this project accepts (new secret keys first, then the legacy service-role key). */
export function serviceKeys(): string[] {
  const out: string[] = [];
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, unknown>;
      const ordered = ['default', ...Object.keys(keys).filter((k) => k !== 'default')];
      for (const k of ordered) if (typeof keys[k] === 'string' && keys[k]) out.push(keys[k] as string);
    } catch {
      console.warn('SUPABASE_SECRET_KEYS is not JSON');
    }
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) out.push(legacy);
  return out;
}

export function optEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v ? v : undefined;
}

export function envFlag(name: string, fallback = false): boolean {
  const v = Deno.env.get(name);
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/**
 * Fail-safe flag: true unless the value is explicitly one of false/0/no/off. Used for DRY_RUN, so a typo
 * ("flase", "live") keeps the safe behaviour instead of turning it off.
 */
export function envFlagSafe(name: string): boolean {
  const v = Deno.env.get(name);
  if (v === undefined || v === '') return true;
  return !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());
}

export function envNumber(name: string, fallback: number): number {
  const n = Number(Deno.env.get(name));
  return Deno.env.get(name) && Number.isFinite(n) ? n : fallback;
}

/** Public base URL of this project's functions, e.g. https://<ref>.supabase.co/functions/v1. */
export function functionsBaseUrl(): string {
  const explicit = optEnv('PUBLIC_FUNCTIONS_URL');
  return (explicit ?? `${env('SUPABASE_URL')}/functions/v1`).replace(/\/$/, '');
}
