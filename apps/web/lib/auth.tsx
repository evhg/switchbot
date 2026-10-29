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
      .then(({ data }) => {
        if (!alive) return;
        setSession(data.session);
        setStatus(data.session ? 'signed-in' : 'signed-out');
      })
      .catch(() => alive && setStatus('signed-out'));
    const { data: sub } = c.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setStatus(s ? 'signed-in' : 'signed-out');
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
