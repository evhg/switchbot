'use client';
/**
 * Set (or change) a password for the signed-in account, so the next sign-in is email + password instead of an
 * emailed code (which Supabase's built-in mailer rate-limits). Used in System › General › Account and on /signin.
 */
import { useState } from 'react';
import { MIN_PASSWORD, supabaseSetPassword } from '@/lib/data/supabase.ts';
import { Button, Field, Input } from '../ui.tsx';
import s from './account.module.css';

export function SetPassword({ email, className }: { email?: string | null; className?: string }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (pw.length < MIN_PASSWORD) return setErr(`Use at least ${MIN_PASSWORD} characters.`);
    if (pw !== pw2) return setErr('The two passwords don’t match.');
    setBusy(true);
    setErr(null);
    const e = await supabaseSetPassword(pw);
    setBusy(false);
    if (e) return setErr(e);
    setPw('');
    setPw2('');
    setDone(true);
  };

  return (
    <form
      className={[s.form, className].filter(Boolean).join(' ')}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
      aria-label="Set password"
    >
      {/* Lets password managers file the new password under the right account. */}
      <input type="email" name="username" autoComplete="username" value={email ?? ''} readOnly hidden />
      <Field label="New password" htmlFor="pw-new" hint={`At least ${MIN_PASSWORD} characters.`}>
        <Input
          id="pw-new"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          value={pw}
          onChange={(e) => {
            setPw(e.target.value);
            setDone(false);
          }}
          aria-invalid={err ? true : undefined}
        />
      </Field>
      <Field
        label="Repeat it"
        htmlFor="pw-new2"
        hint={err ? <span className={s.err} role="alert">{err}</span> : done ? <span role="status">Password saved. Next time, sign in with your email and this password.</span> : undefined}
      >
        <Input
          id="pw-new2"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          value={pw2}
          onChange={(e) => {
            setPw2(e.target.value);
            setDone(false);
          }}
          aria-invalid={err ? true : undefined}
        />
      </Field>
      <div className={s.actions}>
        <Button type="submit" variant="primary" disabled={busy || !pw || !pw2}>
          {busy ? 'Saving…' : 'Set password'}
        </Button>
      </div>
    </form>
  );
}
