import { timingSafeEqual } from '../../../packages/core/src/index.ts';
import { HttpError } from './http.ts';
import type { Db } from './supabase.ts';

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** Scheduled calls: x-cron-secret (pg_cron, from Vault) or the service-role key as a bearer token. */
export function isCronRequest(req: Request): boolean {
  const secret = Deno.env.get('CRON_SECRET');
  const got = req.headers.get('x-cron-secret');
  if (secret && got && timingSafeEqual(got, secret)) return true;
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const tok = bearer(req);
  return !!(svc && tok && timingSafeEqual(tok, svc));
}

export function requireCron(req: Request): void {
  if (!isCronRequest(req)) throw new HttpError(401, 'unauthorized');
}

/**
 * Cron/service, or a signed-in household owner/member (e.g. a "sync now" / "regenerate" button in the PWA).
 * 'viewer' members are read-only and get 403: every caller of this triggers writes, API calls or pushes.
 */
export async function requireCronOrMember(req: Request, db: Db): Promise<'cron' | string> {
  if (isCronRequest(req)) return 'cron';
  const tok = bearer(req);
  if (!tok) throw new HttpError(401, 'unauthorized');
  const { data, error } = await db.auth.getUser(tok);
  if (error || !data.user) throw new HttpError(401, 'unauthorized');
  const m = await db.from('household_members').select('user_id,role').eq('user_id', data.user.id).maybeSingle();
  if (m.error || !m.data) throw new HttpError(403, 'not a household member');
  const role = (m.data as { role?: string }).role;
  if (role !== 'owner' && role !== 'member') throw new HttpError(403, 'read-only household role');
  return data.user.id;
}

/** Shared secret from the last path segment or ?token= (for webhooks that can't sign requests). */
export function urlSecretMatches(req: Request, expected: string): boolean {
  const url = new URL(req.url);
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  const q = url.searchParams.get('token') ?? '';
  return (q !== '' && timingSafeEqual(q, expected)) || (last !== '' && timingSafeEqual(last, expected));
}
