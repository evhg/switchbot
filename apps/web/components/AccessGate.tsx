'use client';
/**
 * The whole app is private to the household: every route renders the sign-in screen until the visitor is signed in
 * AND a household member (RLS already hides all data from anyone else; this keeps the screens, the simulator and the
 * camera page out of view too). Only Cath's and Erik's addresses can hold an account at all: the database refuses
 * any other new user (migration 0021; the addresses live in the database, not in this public repo).
 *
 *   not configured (no Supabase env, e.g. local dev)  → the app as before, simulator only
 *   /privacy                                           → public (Google's OAuth consent screen links to it)
 *   checking the session / membership                  → a quiet loading state, never a flash of the app
 *   signed in + member                                 → the app
 *   anything else                                      → <SignIn/> on a bare page (no sidebar, no tab bar)
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth.tsx';
import { SignIn } from './account/SignIn.tsx';
import { Loading } from './ui.tsx';

function Bare({ children }: { children: ReactNode }) {
  return (
    <div className="app-main">
      <main className="shell" id="main" tabIndex={-1}>
        <div className="page">{children}</div>
        <footer className="site-foot">
          <Link href="/privacy">Privacy</Link>
        </footer>
      </main>
    </div>
  );
}

export function AccessGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const path = usePathname();
  if (!auth.configured) return <>{children}</>;
  if (path === '/privacy') return <Bare>{children}</Bare>;
  if (auth.status === 'loading' || (auth.status === 'signed-in' && !auth.settled)) return <Bare><Loading text="Checking your sign-in…" /></Bare>;
  if (auth.status === 'signed-in' && auth.probe?.member) return <>{children}</>;
  return (
    <Bare>
      <SignIn />
    </Bare>
  );
}
