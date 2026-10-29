'use client';
/**
 * Sign in for real data (Supabase Auth). Two steps on one calm column:
 *   1. email → "Send code" (signInWithOtp, shouldCreateUser: false, so only invited addresses get a code)
 *   2. the 6-digit code from the email (verifyOtp) — or tap the link in the same email on this device
 * The magic link lands back on /signin; supabase-js picks the session out of the URL and this page moves on.
 * ?next=/path returns there afterwards; ?mode=real also switches System › Data & devices to Real data.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth.tsx';
import { useData } from '@/lib/data/context.tsx';
import { supabaseSignIn, supabaseVerifyCode } from '@/lib/data/supabase.ts';
import { useChrome } from '../nav.tsx';
import { Button, Field, Group, Input, PageHeader, Row, Status } from '../ui.tsx';
import s from './account.module.css';

const RESEND_S = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Only same-origin paths: never redirect to another site from a query parameter. */
function safeNext(v: string | null): string {
  return v && v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

export function SignIn() {
  useChrome({ back: { href: '/settings/data', label: 'System' } });
  const router = useRouter();
  const auth = useAuth();
  const { setMode } = useData();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const params = useRef<{ next: string; real: boolean; fromLink: boolean; linkError: string | null }>({ next: '/', real: false, fromLink: false, linkError: null });
  const [linkError, setLinkError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Read the query and the magic-link hash once, before supabase-js consumes the hash.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const linkErr = h.get('error_description') ?? q.get('error_description');
    params.current = {
      next: safeNext(q.get('next')),
      real: q.get('mode') === 'real',
      fromLink: h.has('access_token') || q.has('code') || h.has('token_hash'),
      linkError: linkErr,
    };
    if (linkErr) setLinkError(/expired|invalid/i.test(linkErr) ? 'That sign-in link has expired or was already used. Request a new code below.' : linkErr);
    try {
      const saved = window.sessionStorage.getItem('sleeplab.signin');
      if (saved) {
        const v = JSON.parse(saved) as { next?: string; real?: boolean; email?: string };
        if (!q.get('next') && v.next) params.current.next = safeNext(v.next);
        if (v.real) params.current.real = true;
        if (v.email) setEmail(v.email);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  const finish = () => {
    if (params.current.real) setMode('supabase');
    try {
      window.sessionStorage.removeItem('sleeplab.signin');
    } catch {
      /* ignore */
    }
    router.replace(params.current.next);
  };

  // Arrived from the magic link: continue as soon as the session is in.
  useEffect(() => {
    if (auth.status === 'signed-in' && params.current.fromLink) {
      params.current.fromLink = false;
      finish();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  const send = async () => {
    const e = email.trim();
    if (!EMAIL_RE.test(e)) return setErr('Enter the email address you were invited with.');
    setBusy(true);
    setErr(null);
    setLinkError(null);
    try {
      window.sessionStorage.setItem('sleeplab.signin', JSON.stringify({ next: params.current.next, real: params.current.real, email: e }));
    } catch {
      /* ignore */
    }
    const res = await supabaseSignIn(e);
    setBusy(false);
    if (res) return setErr(res);
    setStep('code');
    setCode('');
    setCooldown(RESEND_S);
  };

  const verify = async () => {
    const c = code.replace(/\s+/g, '');
    if (!/^\d{6,10}$/.test(c)) return setErr('The code is the 6 digits in the email.');
    setBusy(true);
    setErr(null);
    const res = await supabaseVerifyCode(email, c);
    setBusy(false);
    if (res) return setErr(res);
    finish();
  };

  if (!auth.configured) {
    return (
      <div className={s.col}>
        <PageHeader className={s.header} title="Real data isn’t set up here" lede="This copy of Sleep Lab runs on the simulator only. Everything works; the nights are generated, not measured." />
        <Button variant="primary" href="/">
          Back to the simulated nights
        </Button>
      </div>
    );
  }

  if (auth.status === 'signed-in') {
    const member = auth.probe?.member;
    return (
      <div className={s.col}>
        <PageHeader className={s.header} title="You’re signed in" lede={<>As <span className={s.who}>{auth.email}</span>.</>} />
        <Group>
          <Row
            title="Household"
            value={!auth.settled ? <Status tone="off">Checking…</Status> : member ? <Status tone="on">Member</Status> : <Status tone="alert">Not added yet</Status>}
          />
        </Group>
        {auth.settled && !member && (
          <p className={`group-foot ${s.note}`}>Only household members can read the data. Ask the owner to add this account, then check again.</p>
        )}
        <div className={`${s.actions} ${s.after}`}>
          <Button variant="primary" onClick={finish}>
            Continue
          </Button>
          {auth.settled && !member && <Button onClick={auth.refresh}>Check again</Button>}
          <Button variant="text" onClick={() => void auth.signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={s.col}>
      <PageHeader
        className={s.header}
        title={step === 'email' ? 'Sign in for real data' : 'Check your email'}
        lede={
          step === 'email' ? (
            'Your bedroom’s readings and both bands’ sleep are private to the household. We’ll email you a one-time code.'
          ) : (
            <>
              We sent a code to <span className={s.who}>{email.trim()}</span>. Enter it here, or tap the link in the same email on this device.
            </>
          )
        }
      />
      {linkError && <p className={s.err} role="alert" style={{ marginBottom: 'var(--sp-5)' }}>{linkError}</p>}
      {step === 'email' ? (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          noValidate
        >
          <Field label="Email" htmlFor="si-email" hint={err ? <span className={s.err} role="alert">{err}</span> : 'Only invited addresses can sign in.'}>
            <Input
              id="si-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={err ? true : undefined}
            />
          </Field>
          <div className={s.actions}>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </Button>
            <Button variant="text" href="/">
              Keep exploring the simulator
            </Button>
          </div>
        </form>
      ) : (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
          noValidate
        >
          <Field label="Code" htmlFor="si-code" hint={err ? <span className={s.err} role="alert">{err}</span> : 'It expires after an hour.'}>
            <Input
              ref={codeRef}
              id="si-code"
              className={`num ${s.code}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={10}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ''))}
              aria-invalid={err ? true : undefined}
            />
          </Field>
          <div className={s.actions}>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Checking…' : 'Sign in'}
            </Button>
            <Button variant="text" disabled={busy || cooldown > 0} onClick={() => void send()}>
              {cooldown > 0 ? `New code in ${cooldown} s` : 'Send a new code'}
            </Button>
          </div>
          <p className={s.note}>
            Wrong address?{' '}
            <button
              type="button"
              className="btn text sm"
              onClick={() => {
                setStep('email');
                setErr(null);
              }}
            >
              Use a different email
            </button>
          </p>
        </form>
      )}
      <p className={`cap ${s.after}`}>
        Signing in changes nothing for anyone else: the simulator stays public. <Link href="/settings/data">Data &amp; devices</Link> switches between real and simulated nights.
      </p>
    </div>
  );
}
