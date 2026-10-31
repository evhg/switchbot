// Google access tokens for a person: the refresh token from Vault (oauth_tokens.refresh_token_secret_id) → a fresh
// access token. One consent covers Google Health and Calendar (core GOOGLE_APP_SCOPES), so google-health-sync and
// calendar-sync share this.
import { GoogleOAuthError, refreshAccessToken } from '../../../packages/core/src/health/oauth.ts';
import { env } from './env.ts';
import { type Db, must } from './supabase.ts';

export class GoogleTokenError extends Error {
  /** Google said invalid_grant: the person has to connect again (oauth_tokens.needs_reconsent). */
  reconsent: boolean;
  constructor(message: string, reconsent = false) {
    super(message);
    this.name = 'GoogleTokenError';
    this.reconsent = reconsent;
  }
}

/**
 * Access token for `personId`. A rotated refresh token is stored back in Vault; a failed refresh is recorded on
 * oauth_tokens (needs_reconsent, last_error) and thrown as GoogleTokenError.
 */
export async function googleAccessToken(db: Db, personId: string): Promise<{ accessToken: string; scopes: string[] }> {
  const refresh = must(await db.rpc('get_google_refresh_token', { p_person_id: personId }), 'get token') as string | null;
  if (!refresh) throw new GoogleTokenError('no refresh token; connect Google Health in the app');
  try {
    const t = await refreshAccessToken({ clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET'), refreshToken: refresh });
    if (t.refreshToken && t.refreshToken !== refresh) {
      await db.rpc('store_google_refresh_token', { p_person_id: personId, p_refresh_token: t.refreshToken, ...(t.scope.length ? { p_scopes: t.scope } : {}) });
    }
    return { accessToken: t.accessToken, scopes: t.scope };
  } catch (e) {
    const reconsent = e instanceof GoogleOAuthError && e.error === 'invalid_grant';
    const msg = String(e instanceof Error ? e.message : e);
    await db.from('oauth_tokens').update({ needs_reconsent: reconsent, last_error: msg }).eq('person_id', personId);
    throw new GoogleTokenError(`token refresh: ${msg}`, reconsent);
  }
}
