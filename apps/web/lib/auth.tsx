'use client';
/**
 * Sign-in state for real data (Supabase Auth, email one-time code or magic link).
 *
 *   configured   NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY are set at build time
 *   status       'off' (not configured) · 'loading' · 'signed-out' · 'signed-in'
 *   probe        after sign-in: household membership, and whether any real readings / Google Health data exist
 *
 * Nothing here is needed for the simulator: with no env, or signed out, the app stays the public demo.
 */
import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { probeBackend, supabaseClient, supabaseConfigured, supabaseSignOut, type BackendProbe } from './data/supabase.ts';

export type AuthStatus = 'off' | 'loading' | 'signed-out' | 'signed-in';

let lastSaved: string | null = null;
/** Stores the current refresh token in the year-long HttpOnly backup cookie (app/api/session). Best effort. */
function saveSessionBackup(refreshToken: string): void {
  if (refreshToken === lastSaved) return;
  lastSaved = refreshToken;
  void fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    keepalive: true,
  }).catch(() => {
    lastSaved = null;
  });
}

/** Restores a session from the backup cookie when localStorage has none; null when there is no usable backup. */
async function restoreSessionBackup(): Promise<Session | null> {
  try {
    const r = await fetch('/api/session', { cache: 'no-store' });
    if (!r.ok) return null;
    const t = (await r.json()) as { access_token?: string; refresh_token?: string };
    if (!t.access_token || !t.refresh_token) return null;
    lastSaved = t.refresh_token;
    const { data, error } = await supabaseClient().auth.setSession({ access_token: t.access_token, refresh_token: t.refresh_token });
    return error ? null : data.session;
  } catch {
    return null;
  }
}

interface AuthCtx {
  configured: boolean;
  status: AuthStatus;
  session: Session | null;
  email: string | null;
  /** Null until checked (or when signed out). */
  probe: BackendProbe | null;
  probeError: string | null;
  /** True once the probe is done (or not needed). */
  settled: boolean;
  signOut: () => Promise<void>;
  /** Re-check membership and data (e.g. after the owner adds you to the household). */
  refresh: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = supabaseConfigured();
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>(configured ? 'loading' : 'off');
  const [probe, setProbe] = useState<{ key: string; value: BackendProbe | null; error: string | null } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!configured) return;
    const c = supabaseClient();
    let alive = true;
    c.auth
      .getSession()
      .then(async ({ data }) => {
        // Safari empties localStorage after ~7 days away (and the home-screen app has its own): restore the session
        // from the year-long backup cookie (app/api/session) before showing "signed out".
        const restored = data.session ?? (await restoreSessionBackup());
        if (!alive) return;
        setSession(restored);
        setStatus(restored ? 'signed-in' : 'signed-out');
      })
      .catch(() => alive && setStatus('signed-out'));
    const { data: sub } = c.auth.onAuthStateChange((event, s) => {
      setSession(s);
      setStatus(s ? 'signed-in' : 'signed-out');
      // Keep the backup on the newest refresh token (they rotate on every refresh).
      if (s?.refresh_token && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION')) saveSessionBackup(s.refresh_token);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [configured]);

  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!userId) {
      setProbe(null);
      return;
    }
    let alive = true;
    const key = `${userId}:${nonce}`;
    probeBackend(userId)
      .then((value) => alive && setProbe({ key, value, error: null }))
      .catch((e: unknown) => alive && setProbe({ key, value: null, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [userId, nonce]);

  const signOut = useCallback(async () => {
    await fetch('/api/session', { method: 'DELETE' }).catch(() => undefined);
    await supabaseSignOut();
    setSession(null);
    setStatus('signed-out');
  }, []);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<AuthCtx>(() => {
    const probeDone = !userId || (probe !== null && probe.key === `${userId}:${nonce}`);
    return {
      configured,
      status,
      session,
      email: session?.user.email ?? null,
      probe: probe?.value ?? null,
      probeError: probe?.error ?? null,
      settled: status !== 'loading' && probeDone,
      signOut,
      refresh,
    };
  }, [configured, status, session, probe, userId, nonce, signOut, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

/** Real data exists once a sensor has written a non-simulated reading or Google Health data has been archived. */
export const hasRealData = (p: BackendProbe | null) => Boolean(p && (p.realReadings > 0 || p.healthRows > 0));
