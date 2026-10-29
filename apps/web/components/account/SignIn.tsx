'use client';
/**
 * Sign in for real data (Supabase Auth), on one calm column:
 *   password  email + password (primary; the password is set once, signed in, from System › General › Account or here)
 *   email     email → "Send code" (signInWithOtp, shouldCreateUser: false, so only invited addresses get a code)
 *   code      the 6-digit code from the email (verifyOtp) — or tap the link in the same email on this device
 * Links land back on /signin: #access_token (email / admin magic links, implicit flow) is picked up by supabase-js;
 * ?token_hash=…&type=… is verified here. After any sign-in, a member continues to ?next; an account that isn't in
 * the household yet stays here on the household-code step.
 * ?next=/path returns there afterwards; ?mode=real also switches System › Data & devices to Real data.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth.tsx';
import { useData } from '@/lib/data/context.tsx';
import { supabaseSignIn, supabaseSignInWithPassword, supabaseVerifyCode, supabaseVerifyLink } from '@/lib/data/supabase.ts';
import { useChrome } from '../nav.tsx';
import { NotMember } from './Onboarding.tsx';
import { SetPassword } from './SetPassword.tsx';
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
  const [step, setStep] = useState<'password' | 'email' | 'code'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const params = useRef<{ next: string; real: boolean; fromLink: boolean; linkError: string | null }>({ next: '/', real: false, fromLink: false, linkError: null });
  /** Set by a successful sign-in: continue once membership is known (members go on, others get the code step). */
  const pending = useRef(false);
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
      fromLink: h.has('access_token') || q.has('code') || h.has('token_hash') || q.has('token_hash'),
      linkError: linkErr,
    };
    if (linkErr) setLinkError(/expired|invalid/i.test(linkErr) ? 'That sign-in link has expired or was already used. Sign in with your password, or request a new code.' : linkErr);
    // ?token_hash=…&type=magiclink: verify it here (supabase-js only reads #access_token by itself).
    const th = q.get('token_hash') ?? h.get('token_hash');
    if (th) {
      const type = q.get('type') ?? h.get('type') ?? 'magiclink';
      const clean = new URL(window.location.href);
      for (const k of ['token_hash', 'type']) clean.searchParams.delete(k);
      window.history.replaceState(null, '', clean.pathname + clean.search);
      void supabaseVerifyLink(th, type).then((e) => {
        if (e) {
          params.current.fromLink = false;
          setLinkError(/expired|doesn’t match/i.test(e) ? 'That sign-in link has expired or was already used. Sign in with your password, or request a new code.' : e);
        }
      });
    }
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

  // Arrived from a link: wait for the session, then treat it like any other sign-in.
  useEffect(() => {
    if (auth.status === 'signed-in' && params.current.fromLink) {
      params.current.fromLink = false;
      pending.current = true;
    }
    if (pending.current && auth.status === 'signed-in' && auth.settled) {
      pending.current = false;
      // Not in the household yet: stay here, where the signed-in view asks for the household code.
      if (auth.probe?.member) finish();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, auth.settled, auth.probe]);

  const remember = (e: string) => {
    try {
      window.sessionStorage.setItem('sleeplab.signin', JSON.stringify({ next: params.current.next, real: params.current.real, email: e }));
    } catch {
      /* ignore */
    }
  };

  const signInPassword = async () => {
    const e = email.trim();
    if (!EMAIL_RE.test(e)) return setErr('Enter the email address you were invited with.');
    if (!password) return setErr('Enter your password.');
    setBusy(true);
    setErr(null);
    setLinkError(null);
    remember(e);
    const res = await supabaseSignInWithPassword(e, password);
    setBusy(false);
    if (res) return setErr(res);
    setPassword('');
    pending.current = true;
  };

  const send = async () => {
    const e = email.trim();
    if (!EMAIL_RE.test(e)) return setErr('Enter the email address you were invited with.');
    setBusy(true);
    setErr(null);
    setLinkError(null);
    remember(e);
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
    pending.current = true;
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
    if (auth.settled && !member) {
      // Signed in, not in the household yet: the household-code step, then a way out.
      return (
        <>
          <NotMember />
          <div className={`${s.col} ${s.wide}`}>
            <div className={s.actions}>
              <Button variant="text" onClick={() => void auth.signOut()}>
                Sign out
              </Button>
            </div>
          </div>
        </>
      );
    }
    return (
      <div className={s.col}>
        <PageHeader className={s.header} title="You’re signed in" lede={<>As <span className={s.who}>{auth.email}</span>.</>} />
        <Group>
          <Row title="Household" value={!auth.settled ? <Status tone="off">Checking…</Status> : <Status tone="on">Member</Status>} />
        </Group>
        <div className={`${s.actions} ${s.after}`}>
          <Button variant="primary" onClick={finish}>
            Continue
          </Button>
          <Button variant="text" onClick={() => void auth.signOut()}>
            Sign out
          </Button>
        </div>
        <h2 className={`label ${s.after}`}>Password</h2>
        <p className={s.note} style={{ marginBottom: 'var(--sp-5)' }}>
          Set one so the next sign-in needs no email code. You can change it later in System › General.
        </p>
        <SetPassword email={auth.email} />
      </div>
    );
  }

  const emailField = (hint: string) => (
    <Field label="Email" htmlFor="si-email" hint={err && step !== 'password' ? <span className={s.err} role="alert">{err}</span> : hint}>
      <Input
        id="si-email"
        type="email"
        name="username"
        inputMode="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-invalid={err ? true : undefined}
      />
    </Field>
  );

  return (
    <div className={s.col}>
      <PageHeader
        className={s.header}
        title={step === 'code' ? 'Check your email' : 'Sign in for real data'}
        lede={
          step === 'password' ? (
            'Your bedroom’s readings and both bands’ sleep are private to the household.'
          ) : step === 'email' ? (
            'We’ll email you a one-time code. Only invited addresses can sign in.'
          ) : (
            <>
              We sent a code to <span className={s.who}>{email.trim()}</span>. Enter it here, or tap the link in the same email on this device.
            </>
          )
        }
      />
      {linkError && <p className={s.err} role="alert" style={{ marginBottom: 'var(--sp-5)' }}>{linkError}</p>}
      {step === 'password' ? (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void signInPassword();
          }}
          noValidate
        >
          {emailField('The address you were invited with.')}
          <Field label="Password" htmlFor="si-password" hint={err ? <span className={s.err} role="alert">{err}</span> : 'No password yet? Use an email code once, then set one.'}>
            <Input
              id="si-password"
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={err ? true : undefined}
            />
          </Field>
          <div className={s.actions}>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
            <Button
              variant="text"
              onClick={() => {
                setStep('email');
                setErr(null);
              }}
            >
              Email me a code instead
            </Button>
          </div>
        </form>
      ) : step === 'email' ? (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          noValidate
        >
          {emailField('Only invited addresses can sign in.')}
          <div className={s.actions}>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </Button>
            <Button
              variant="text"
              onClick={() => {
                setStep('password');
                setErr(null);
              }}
            >
              Use a password instead
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
