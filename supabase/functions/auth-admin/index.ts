// Household account admin, for the owner only (via private.invoke_edge_function / the service key; never the PWA).
//   {action:'users'}                      → auth users: id, email, created_at, last_sign_in_at, confirmed (no tokens)
//   {action:'link', email, redirectTo?}   → {action_link, redirect_to, app_link} — one-time magic sign-in links:
//       action_link  Supabase's /verify URL; it redirects to redirectTo only if that URL is in the Auth redirect
//                    allow-list (otherwise to the Site URL), with #access_token for the PWA to pick up.
//       app_link     redirectTo?token_hash=…&type=magiclink; the PWA's /signin verifies it itself (verifyOtp), so it
//                    works whatever the allow-list says. Either link works once; the newer one replaces the older.
// Generating a link sends no email, so Supabase's built-in email rate limit does not apply. The link is a bearer
// credential for that account: only hand it to the person it belongs to.
import { requireCron } from '../_shared/auth.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Login tokens only ever go to the app itself.
const REDIRECT_HOST = /^(sleep-lab-lac\.vercel\.app|sleep-lab-[a-z0-9-]+-evhg\.vercel\.app)$/;

function allowedRedirect(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && REDIRECT_HOST.test(u.hostname) ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

serve(async (req) => {
  const db = serviceClient();
  await requireCron(req, db);
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  const body = await readJson(req);
  const action = body.action;

  if (action === 'users') {
    const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 100 });
    if (error) throw new HttpError(502, error.message);
    return json({
      users: data.users.map((u) => ({
        id: u.id,
        email: u.email ?? null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
        invited_at: u.invited_at ?? null,
      })),
    });
  }

  if (action === 'link') {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email required');
    if (body.redirectTo !== undefined && !allowedRedirect(body.redirectTo)) throw new HttpError(400, 'redirectTo must be the app');
    const redirectTo = allowedRedirect(body.redirectTo);
    // generateLink would sign up an unknown address; only existing (invited) accounts get a link.
    const { data: list, error: listError } = await db.auth.admin.listUsers({ page: 1, perPage: 100 });
    if (listError) throw new HttpError(502, listError.message);
    if (!list.users.some((u) => u.email?.toLowerCase() === email)) throw new HttpError(404, 'no such user');
    const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email, options: redirectTo ? { redirectTo } : undefined });
    if (error) throw new HttpError(/not found/i.test(error.message) ? 404 : 502, error.message);
    const link = data.properties?.action_link ?? null;
    let redirect_to: string | null = null;
    try {
      redirect_to = link ? new URL(link).searchParams.get('redirect_to') : null;
    } catch {
      /* ignore */
    }
    const hashed = data.properties?.hashed_token;
    let app_link: string | null = null;
    if (redirectTo && hashed) {
      const u = new URL(redirectTo);
      u.searchParams.set('token_hash', hashed);
      u.searchParams.set('type', 'magiclink');
      app_link = u.toString();
    }
    return json({ action_link: link, redirect_to, app_link, requested_redirect: redirectTo ?? null, user_id: data.user?.id ?? null });
  }

  throw new HttpError(400, "action must be 'users' or 'link'");
});
