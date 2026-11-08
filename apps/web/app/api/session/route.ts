/**
 * A year-long backup of the sign-in, so Safari can't sign you out.
 *
 * The Supabase session lives in localStorage, and Safari deletes a site's localStorage after about 7 days without a
 * visit in that browser (ITP); the home-screen app and the Safari tab also keep separate storage. A cookie set by
 * this server (same origin, HttpOnly) is not subject to that cap, so the client keeps the current refresh token here
 * and restores the session from it when localStorage comes back empty.
 *
 *   POST   {"refresh_token": "…"}  store / update the backup (after every sign-in and token refresh)
 *   GET                            exchange the stored refresh token for a fresh session (the cookie is rotated
 *                                  with it), or 401 and clear the cookie when there is none or it no longer works
 *   DELETE                         forget it (explicit sign-out)
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const COOKIE = 'sl_rt';
const MAX_AGE = 365 * 24 * 60 * 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,512}$/;

function setBackup(res: NextResponse, token: string): NextResponse {
  res.cookies.set(COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/session', maxAge: MAX_AGE });
  return res;
}

function clearBackup(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/session', maxAge: 0 });
  return res;
}

export async function POST(req: Request) {
  let token: unknown;
  try {
    token = ((await req.json()) as { refresh_token?: unknown }).refresh_token;
  } catch {
    return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
  }
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return NextResponse.json({ error: 'refresh_token missing' }, { status: 400 });
  return setBackup(new NextResponse(null, { status: 204 }), token);
}

export async function GET() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token || !TOKEN_RE.test(token)) return clearBackup(NextResponse.json({ error: 'no backup' }, { status: 401 }));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ error: 'not configured' }, { status: 503 });
  let r: Response;
  try {
    r = await fetch(`${url.replace(/\/$/, '')}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: token }),
      cache: 'no-store',
    });
  } catch {
    // Network trouble: keep the backup for the next try.
    return NextResponse.json({ error: 'auth unreachable' }, { status: 502 });
  }
  if (!r.ok) {
    // 5xx: keep it; 4xx (revoked, expired, user gone): drop it.
    const res = NextResponse.json({ error: 'backup no longer valid' }, { status: r.status >= 500 ? 502 : 401 });
    return r.status >= 500 ? res : clearBackup(res);
  }
  const s = (await r.json()) as { access_token?: string; refresh_token?: string };
  if (!s.access_token || !s.refresh_token) return clearBackup(NextResponse.json({ error: 'unexpected response' }, { status: 502 }));
  const res = NextResponse.json({ access_token: s.access_token, refresh_token: s.refresh_token }, { headers: { 'Cache-Control': 'no-store' } });
  return setBackup(res, s.refresh_token);
}

export async function DELETE() {
  return clearBackup(new NextResponse(null, { status: 204 }));
}
