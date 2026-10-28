// Google OAuth 2.0 (web server flow) for the Google Health API. See docs/research/health-data.md §2.2–2.3.
import type { Ms } from '../types.ts';
import type { FetchLike } from '../switchbot/sign.ts';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/googlehealth.';
export const SCOPE_HEALTH_METRICS = `${SCOPE_PREFIX}health_metrics_and_measurements.readonly`;
export const SCOPE_SLEEP = `${SCOPE_PREFIX}sleep.readonly`;
export const SCOPE_ACTIVITY = `${SCOPE_PREFIX}activity_and_fitness.readonly`;
export const GOOGLE_HEALTH_SCOPES = [SCOPE_HEALTH_METRICS, SCOPE_SLEEP, SCOPE_ACTIVITY] as const;

export interface GoogleAuthUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  loginHint?: string;
}

/**
 * access_type=offline + prompt=consent so Google returns a refresh token every time.
 * No include_granted_scopes: mixing in legacy scopes has caused 403s on reads.
 */
export function googleAuthUrl(p: GoogleAuthUrlParams): string {
  const qs = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: (p.scopes ?? GOOGLE_HEALTH_SCOPES).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: p.state,
  });
  if (p.loginHint) qs.set('login_hint', p.loginHint);
  return `${GOOGLE_AUTH_URL}?${qs}`;
}

export interface GoogleTokens {
  accessToken: string;
  /** Only on code exchange (and not always on refresh). Testing-mode apps: expires after 7 days. */
  refreshToken?: string;
  expiresAt: Ms;
  scope: string[];
  tokenType: string;
  idToken?: string;
}

export class GoogleOAuthError extends Error {
  status: number;
  /** e.g. 'invalid_grant' (refresh token revoked/expired → re-consent). */
  error?: string;

  constructor(message: string, status: number, error?: string) {
    super(message);
    this.name = 'GoogleOAuthError';
    this.status = status;
    if (error !== undefined) this.error = error;
  }
}

interface TokenRequestBase {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  now?: () => Ms;
}

async function tokenRequest(base: TokenRequestBase, params: Record<string, string>): Promise<GoogleTokens> {
  const f = base.fetch ?? ((i, init) => fetch(i, init));
  const res = await f(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: base.clientId, client_secret: base.clientSecret, ...params }).toString(),
  });
  let j: Record<string, unknown> = {};
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    // fall through to the status check
  }
  if (!res.ok || typeof j.access_token !== 'string') {
    const err = typeof j.error === 'string' ? j.error : undefined;
    const desc = typeof j.error_description === 'string' ? j.error_description : '';
    throw new GoogleOAuthError(`token endpoint ${res.status}${err ? ` ${err}` : ''}${desc ? `: ${desc}` : ''}`, res.status, err);
  }
  const now = (base.now ?? Date.now)();
  const t: GoogleTokens = {
    accessToken: j.access_token,
    expiresAt: now + (typeof j.expires_in === 'number' ? j.expires_in : 3599) * 1000,
    scope: typeof j.scope === 'string' ? j.scope.split(' ').filter(Boolean) : [],
    tokenType: typeof j.token_type === 'string' ? j.token_type : 'Bearer',
  };
  if (typeof j.refresh_token === 'string') t.refreshToken = j.refresh_token;
  if (typeof j.id_token === 'string') t.idToken = j.id_token;
  return t;
}

export function exchangeCode(p: TokenRequestBase & { code: string; redirectUri: string }): Promise<GoogleTokens> {
  return tokenRequest(p, { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri });
}

/** The returned tokens usually lack refreshToken; keep the existing one. */
export function refreshAccessToken(p: TokenRequestBase & { refreshToken: string }): Promise<GoogleTokens> {
  return tokenRequest(p, { grant_type: 'refresh_token', refresh_token: p.refreshToken });
}
