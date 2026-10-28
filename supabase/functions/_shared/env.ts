import { HttpError } from './http.ts';

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new HttpError(500, `missing secret ${name}`);
  return v;
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

export function envNumber(name: string, fallback: number): number {
  const n = Number(Deno.env.get(name));
  return Deno.env.get(name) && Number.isFinite(n) ? n : fallback;
}

/** Public base URL of this project's functions, e.g. https://<ref>.supabase.co/functions/v1. */
export function functionsBaseUrl(): string {
  const explicit = optEnv('PUBLIC_FUNCTIONS_URL');
  return (explicit ?? `${env('SUPABASE_URL')}/functions/v1`).replace(/\/$/, '');
}
