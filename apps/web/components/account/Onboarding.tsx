'use client';
/**
 * Signed in, but nothing real has arrived yet. Instead of empty charts: one sentence on where things stand and the
 * four things that make data appear, each with an honest state taken from what the backend can see.
 *   variant 'page'    replaces a tab's content (Today, Room, Body, Lab) when Real data is chosen and there are no nights
 *   variant 'inline'  the same list inside System › Data & devices
 * Also covers the account that signed in but isn't in household_members yet (RLS shows it nothing).
 */
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth.tsx';
import { useData } from '@/lib/data/context.tsx';
import { claimHousehold, type BackendProbe } from '@/lib/data/supabase.ts';
import { systemHref } from '../nav.tsx';
import { Button, Field, Input, PageHeader } from '../ui.tsx';
import s from './account.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

interface Step {
  id: string;
  title: string;
  body: ReactNode;
  done: boolean;
  state: string;
}

export function onboardingSteps(p: BackendProbe | null): Step[] {
  const real = (p?.devices ?? []).filter((d) => d.kind !== 'sim');
  const hub = real.some((d) => d.kind === 'hub' || d.kind === 'ac');
  const meter = real.some((d) => d.kind === 'meter') || (p?.realReadings ?? 0) > 0;
  const readings = (p?.realReadings ?? 0) > 0;
  const health = (p?.healthRows ?? 0) > 0;
  return [
    {
      id: 'hub',
      title: 'Hub Mini',
      body: (
        <>
          Pair it in the SwitchBot app with a clear line of sight to the aircon, then add the aircon remote. The{' '}
          <Link href={systemHref('setup')}>setup guide</Link> has the order.
        </>
      ),
      done: hub,
      state: hub ? 'Linked' : 'Not linked yet',
    },
    {
      id: 'meter',
      title: 'Meter Pro CO2',
      body: 'Calibrate it outdoors, run it on USB-C at bed height, CO₂ every minute, cloud storage on.',
      done: meter,
      state: meter ? 'Linked' : 'Not linked yet',
    },
    {
      id: 'token',
      title: 'SwitchBot token',
      body: 'Copy the token and secret from the app’s developer options into the Supabase function secrets. The minute poll starts on its own; the aircon stays in dry run until you turn it on.',
      done: readings,
      state: readings ? `${p!.realReadings.toLocaleString('en-GB')} readings so far` : 'No readings yet',
    },
    {
      id: 'health',
      title: 'Google Health',
      body: (
        <>
          Each person connects their own band once, from <Link href={systemHref('health')}>System › Google Health</Link>.
        </>
      ),
      done: health,
      state: health ? 'Receiving data' : 'Not connected',
    },
  ];
}

export function OnboardingSteps({ probe }: { probe: BackendProbe | null }) {
  const steps = onboardingSteps(probe);
  return (
    <ol className={cx('list-group', s.steps)} aria-label="What to set up next">
      {steps.map((st, i) => (
        <li key={st.id} className={s.step} data-done={st.done || undefined}>
          <span className={cx('num', s.n)} aria-hidden>
            {st.done ? '✓' : i + 1}
          </span>
          <div className={s.stepT}>
            <b>{st.title}</b>
            <p>{st.body}</p>
            <span className={s.state}>{st.done ? `Done · ${st.state}` : st.state}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function NotMember({ variant = 'page' }: { variant?: 'page' | 'inline' }) {
  const auth = useAuth();
  const { setMode } = useData();
  return (
    <div className={variant === 'page' ? cx(s.col, s.wide) : undefined}>
      {variant === 'page' && (
        <PageHeader className={s.header} title="Almost there" lede={<>You’re signed in as <span className={s.who}>{auth.email}</span>, but this account isn’t in the household yet, so there’s nothing it may read.</>} />
      )}
      <ClaimForm onDone={auth.refresh} />
      <div className={cx(s.actions, s.after)}>
        <Button onClick={auth.refresh}>Check again</Button>
        {variant === 'page' && <Button onClick={() => setMode('auto')}>Show simulated nights meanwhile</Button>}
      </div>
    </div>
  );
}

/** One-time household code from the owner → household_members row (public.claim_household). */
function ClaimForm({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    const e = await claimHousehold(code);
    setBusy(false);
    if (e) setErr(e);
    else onDone();
  };
  return (
    <form
      className={cx(s.form, s.after)}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <Field
        label="Household code"
        htmlFor="claim-code"
        hint={err ? <span className={s.err} role="alert">{err}</span> : 'The owner creates one code per person. It works once and expires after 7 days.'}
      >
        <Input
          id="claim-code"
          className="num"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          maxLength={40}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          aria-invalid={err ? true : undefined}
        />
      </Field>
      <div className={s.actions}>
        <Button type="submit" variant="primary" disabled={busy || !code.trim()}>
          {busy ? 'Joining…' : 'Join the household'}
        </Button>
      </div>
    </form>
  );
}

/** Full-page state for a tab when Real data is chosen and nothing has arrived. */
export function Onboarding() {
  const auth = useAuth();
  const { setMode } = useData();
  if (auth.status === 'signed-in' && auth.settled && !auth.probe?.member) return <NotMember />;
  const steps = onboardingSteps(auth.probe);
  const left = steps.filter((x) => !x.done).length;
  return (
    <div className={cx(s.col, s.wide)}>
      <PageHeader
        className={s.header}
        title="No nights yet"
        lede={
          <>
            You’re signed in{auth.email ? <> as <span className={s.who}>{auth.email}</span></> : ''}. Sleep Lab fills in by itself once the bedroom sensor and the bands start reporting.{' '}
            {left ? `${left} of ${steps.length} things left to set up.` : 'Everything is linked: the first night appears the morning after.'}
          </>
        }
      />
      <OnboardingSteps probe={auth.probe} />
      <div className={cx(s.actions, s.after)}>
        <Button variant="primary" href={systemHref('setup')}>
          Open the setup guide
        </Button>
        <Button onClick={() => setMode('auto')}>Show simulated nights meanwhile</Button>
      </div>
      <p className={cx('cap', s.after)}>With “Automatic” under System › Data &amp; devices, real nights replace the simulator as soon as the first readings arrive.</p>
    </div>
  );
}
