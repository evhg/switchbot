// Google OAuth for the Google Health API (one-time per person).
//   GET /google-oauth/start?person=a&key=<OAUTH_START_SECRET>[&login_hint=email]  → redirect to Google consent
//   GET /google-oauth/callback?code=…&state=…                                       → store refresh token in Vault
// Add <functions-url>/google-oauth/callback as an authorized redirect URI in the Google Cloud console.
import { GoogleHealthClient } from '../../../packages/core/src/health/client.ts';
import { exchangeCode, googleAuthUrl } from '../../../packages/core/src/health/oauth.ts';
import { timingSafeEqual } from '../../../packages/core/src/health/signature.ts';
import { env, functionsBaseUrl, optEnv } from '../_shared/env.ts';
import { escapeHtml, html, serve } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';

const STATE_TTL_MS = 15 * 60_000;

const redirectUri = () => `${functionsBaseUrl()}/google-oauth/callback`;

function page(title: string, msg: string, status = 200) {
  const back = optEnv('APP_URL');
  return html(
    `<title>${escapeHtml(title)}</title><body style="font-family:system-ui;background:#0b0b0f;color:#eee;padding:2rem">` +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(msg)}</p>${back ? `<p><a style="color:#9cf" href="${escapeHtml(back)}">Back to the app</a></p>` : ''}`,
    status,
  );
}

serve(async (req) => {
  const url = new URL(req.url);
  const action = url.pathname.split('/').filter(Boolean).pop();
  const db = serviceClient();

  if (action === 'start') {
    const startSecret = optEnv('OAUTH_START_SECRET');
    if (!startSecret) return page('Not configured', 'Google Health sign-in is not set up yet (OAUTH_START_SECRET is missing).', 503);
    const key = url.searchParams.get('key') ?? '';
    if (!timingSafeEqual(key, startSecret)) return page('Not allowed', 'Missing or wrong key.', 401);
    const person = url.searchParams.get('person') ?? '';
    const { data: p } = await db.from('people').select('id').eq('id', person).maybeSingle();
    if (!p) return page('Unknown person', `No people row with id "${person}".`, 400);
    const state = crypto.randomUUID();
    const ins = await db.from('oauth_states').insert({ state, person_id: person });
    if (ins.error) throw new Error(`oauth_states: ${ins.error.message}`);
    const hint = url.searchParams.get('login_hint');
    const to = googleAuthUrl({ clientId: env('GOOGLE_CLIENT_ID'), redirectUri: redirectUri(), state, ...(hint ? { loginHint: hint } : {}) });
    return Response.redirect(to, 302);
  }

  if (action === 'callback') {
    const err = url.searchParams.get('error');
    if (err) return page('Google said no', err, 400);
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    // Single use: delete and read back in one statement.
    const { data: st } = await db.from('oauth_states').delete().eq('state', state).select('person_id, created_at').maybeSingle();
    const row = st as { person_id: string; created_at: string } | null;
    if (!row || Date.now() - Date.parse(row.created_at) > STATE_TTL_MS) return page('Link expired', 'Start again from the setup link.', 400);

    const tokens = await exchangeCode({ clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET'), code, redirectUri: redirectUri() });
    if (!tokens.refreshToken) {
      return page('No refresh token', 'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.', 400);
    }
    let healthUserId: string | null = null;
    try {
      healthUserId = (await new GoogleHealthClient(tokens.accessToken).identity()).healthUserId ?? null;
    } catch (e) {
      console.warn('identity lookup failed', e);
    }
    const r = await db.rpc('store_google_refresh_token', {
      p_person_id: row.person_id,
      p_refresh_token: tokens.refreshToken,
      p_scopes: tokens.scope,
      p_health_user_id: healthUserId,
    });
    if (r.error) throw new Error(`store token: ${r.error.message}`);
    if (healthUserId) await db.from('people').update({ google_health_user_id: healthUserId }).eq('id', row.person_id);
    // Backfill two weeks on the next queue run.
    await db.from('health_sync_jobs').insert({ person_id: row.person_id, reason: 'oauth' });
    return page('Connected', `Google Health is connected for ${row.person_id}. You can close this page.`);
  }

  return page('Not found', 'Use /google-oauth/start or /google-oauth/callback.', 404);
});
