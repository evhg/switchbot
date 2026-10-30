// Google OAuth for the Google Health API (one-time per person).
//   POST /google-oauth/start  Authorization: Bearer <Supabase access token of a signed-in household owner/member>
//        body {person?}  → {url}. The state is bound to the caller's own person (household_members.person_id); only
//        the owner may pass another person. The PWA then navigates to `url` (Google consent).
//   GET  /google-oauth/start?person=a&key=<OAUTH_START_SECRET>[&login_hint=email]  → 302 to Google consent.
//        Legacy setup link; only works while the OAUTH_START_SECRET function secret is set.
//   GET  /google-oauth/callback?code=…&state=…  → stores the refresh token in Vault for the state's person, queues a
//        two-week backfill, and redirects to <APP_URL>/settings/health?google=connected&person=a (or google=error&reason=…).
// Add <functions-url>/google-oauth/callback as an authorized redirect URI of the Google Cloud OAuth client.
// Account check (2026-10-30): the consent also asks 'openid email'; when the consenting Google account is the login of
// ANOTHER household person (Erik finishing Cath's link on a shared phone), nothing is stored and the app shows
// reason=wrong_account. A Google account that is nobody's app login is accepted (the band may use its own account).
import { GoogleHealthClient } from '../../../packages/core/src/health/client.ts';
import { exchangeCode, GOOGLE_HEALTH_SCOPES, googleAuthUrl } from '../../../packages/core/src/health/oauth.ts';
import { timingSafeEqual } from '../../../packages/core/src/health/signature.ts';
import { env, functionsBaseUrl, optEnv } from '../_shared/env.ts';
import { idTokenEmail, wrongAccount } from '../_shared/health.ts';
import { escapeHtml, html, HttpError, json, readJson, serve } from '../_shared/http.ts';
import { type Db, serviceClient } from '../_shared/supabase.ts';

const STATE_TTL_MS = 15 * 60_000;
const DEFAULT_APP_URL = 'https://sleep-lab-git-claude-determined-ride-59txro-evhg.vercel.app';

/** Health scopes plus 'openid email', so the callback learns which Google account consented. */
const SCOPES = [...GOOGLE_HEALTH_SCOPES, 'openid', 'email'];

const redirectUri = () => `${functionsBaseUrl()}/google-oauth/callback`;
const appUrl = () => (optEnv('APP_URL') ?? DEFAULT_APP_URL).replace(/\/$/, '');

/** Back to System › Google Health with a result flag the page shows. */
function backToApp(params: Record<string, string>): Response {
  const qs = new URLSearchParams(params);
  return new Response(null, { status: 302, headers: { Location: `${appUrl()}/settings/health?${qs}` } });
}

function page(title: string, msg: string, status = 200) {
  return html(
    `<title>${escapeHtml(title)}</title><body style="font-family:system-ui;background:#0b0b0f;color:#eee;padding:2rem">` +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(msg)}</p><p><a style="color:#9cf" href="${escapeHtml(appUrl())}/settings/health">Back to the app</a></p>`,
    status,
  );
}

function bearer(req: Request): string | null {
  const m = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** Signed-in owner/member → the person the consent is for (their own, or `requested` when the caller is the owner). */
async function memberPerson(db: Db, req: Request, requested: unknown): Promise<{ personId: string; email: string | null }> {
  const tok = bearer(req);
  if (!tok) throw new HttpError(401, 'sign in first');
  const { data, error } = await db.auth.getUser(tok);
  if (error || !data.user) throw new HttpError(401, 'sign in first');
  const m = await db.from('household_members').select('person_id,role').eq('user_id', data.user.id).maybeSingle();
  const row = m.data as { person_id: string | null; role: string } | null;
  if (m.error || !row) throw new HttpError(403, 'not a household member');
  if (row.role !== 'owner' && row.role !== 'member') throw new HttpError(403, 'read-only household role');
  const other = typeof requested === 'string' && requested !== '' && requested !== row.person_id ? requested : null;
  if (other) {
    if (row.role !== 'owner') throw new HttpError(403, 'only the household owner can connect another person');
    const { data: p } = await db.from('people').select('id').eq('id', other).maybeSingle();
    if (!p) throw new HttpError(400, `unknown person "${other}"`);
    return { personId: other, email: null };
  }
  if (!row.person_id) throw new HttpError(409, 'this account is not linked to a person yet');
  return { personId: row.person_id, email: data.user.email ?? null };
}

/** Every household login with its person (for the callback's account check). Read errors → [] (no check). */
async function householdLogins(db: Db): Promise<{ personId: string | null; email: string | null }[]> {
  const m = await db.from('household_members').select('user_id,person_id');
  if (m.error) {
    console.error('household_members', m.error.message);
    return [];
  }
  const out: { personId: string | null; email: string | null }[] = [];
  for (const r of (m.data ?? []) as { user_id: string; person_id: string | null }[]) {
    const u = await db.auth.admin.getUserById(r.user_id);
    out.push({ personId: r.person_id, email: u.data.user?.email ?? null });
  }
  return out;
}

async function newState(db: Db, personId: string): Promise<string> {
  const state = crypto.randomUUID();
  const ins = await db.from('oauth_states').insert({ state, person_id: personId });
  if (ins.error) throw new Error(`oauth_states: ${ins.error.message}`);
  return state;
}

serve(async (req) => {
  const url = new URL(req.url);
  const action = url.pathname.split('/').filter(Boolean).pop();
  const db = serviceClient();

  if (action === 'start' && req.method === 'POST') {
    const body = await readJson(req);
    const who = await memberPerson(db, req, body.person);
    const clientId = env('GOOGLE_CLIENT_ID');
    env('GOOGLE_CLIENT_SECRET'); // fail now (503 + missing) rather than after the user consented
    const state = await newState(db, who.personId);
    const hint = typeof body.loginHint === 'string' && body.loginHint ? body.loginHint : who.email;
    return json({ url: googleAuthUrl({ clientId, redirectUri: redirectUri(), state, scopes: SCOPES, ...(hint ? { loginHint: hint } : {}) }), person: who.personId });
  }

  if (action === 'start') {
    const startSecret = optEnv('OAUTH_START_SECRET');
    if (!startSecret) return page('Start from the app', 'Open the app, then System › Google Health › Connect Google Health.', 404);
    const key = url.searchParams.get('key') ?? '';
    if (!timingSafeEqual(key, startSecret)) return page('Not allowed', 'Missing or wrong key.', 401);
    const person = url.searchParams.get('person') ?? '';
    const { data: p } = await db.from('people').select('id').eq('id', person).maybeSingle();
    if (!p) return page('Unknown person', `No people row with id "${person}".`, 400);
    const state = await newState(db, person);
    const hint = url.searchParams.get('login_hint');
    const to = googleAuthUrl({ clientId: env('GOOGLE_CLIENT_ID'), redirectUri: redirectUri(), state, scopes: SCOPES, ...(hint ? { loginHint: hint } : {}) });
    return Response.redirect(to, 302);
  }

  if (action === 'callback') {
    const state = url.searchParams.get('state') ?? '';
    // Single use: remove and read back in one statement (also when Google reports an error, so the state can't be replayed).
    const { data: st } = state
      ? await db.from('oauth_states').delete().eq('state', state).select('person_id, created_at').maybeSingle()
      : { data: null };
    const row = st as { person_id: string; created_at: string } | null;
    const err = url.searchParams.get('error');
    if (err) return backToApp({ google: 'error', reason: err === 'access_denied' ? 'denied' : err, ...(row ? { person: row.person_id } : {}) });
    if (!row || Date.now() - Date.parse(row.created_at) > STATE_TTL_MS) return backToApp({ google: 'error', reason: 'expired' });
    const person = row.person_id;
    const code = url.searchParams.get('code') ?? '';
    if (!code) return backToApp({ google: 'error', reason: 'no_code', person });

    let tokens;
    try {
      tokens = await exchangeCode({ clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET'), code, redirectUri: redirectUri() });
    } catch (e) {
      console.error('code exchange failed', e);
      return backToApp({ google: 'error', reason: 'exchange', person });
    }
    // Revoke the app at myaccount.google.com/permissions and connect again to get a new one.
    if (!tokens.refreshToken) return backToApp({ google: 'error', reason: 'no_refresh_token', person });
    const googleEmail = idTokenEmail(tokens.idToken, env('GOOGLE_CLIENT_ID'));
    const other = wrongAccount(googleEmail, person, await householdLogins(db));
    if (other) {
      console.warn(`google-oauth: ${googleEmail} is the login of person ${other}, not ${person}; nothing stored`);
      return backToApp({ google: 'error', reason: 'wrong_account', person });
    }
    let healthUserId: string | null = null;
    try {
      healthUserId = (await new GoogleHealthClient(tokens.accessToken).identity()).healthUserId ?? null;
    } catch (e) {
      // 400 ACCOUNT_NOT_LINKED: the Google account has no Google Health profile yet. The token is still stored.
      console.warn('identity lookup failed', e);
    }
    const r = await db.rpc('store_google_refresh_token', {
      p_person_id: person,
      p_refresh_token: tokens.refreshToken,
      p_scopes: tokens.scope,
      p_health_user_id: healthUserId,
    });
    if (r.error) {
      console.error('store token', r.error.message);
      return backToApp({ google: 'error', reason: 'store', person });
    }
    if (healthUserId) await db.from('people').update({ google_health_user_id: healthUserId }).eq('id', person);
    // Backfill two weeks on the next queue run (every 10 min).
    await db.from('health_sync_jobs').insert({ person_id: person, reason: 'oauth' });
    return backToApp({ google: 'connected', person, ...(healthUserId ? {} : { profile: 'missing' }) });
  }

  return page('Not found', 'Use POST /google-oauth/start or /google-oauth/callback.', 404);
});
