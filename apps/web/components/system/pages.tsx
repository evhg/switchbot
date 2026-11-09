'use client';
/**
 * The nine System pages (docs/DESIGN.md §9.5). Each is one reading column (672 px; the plan 832 px plus a side
 * column from 1760) with a title, one sentence, then a few grouped lists. On the phone each is a drill-in with a
 * "‹ System" back bar; on desktop the sidebar's second level is the navigation.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useRouter } from 'next/navigation';
import { DEFAULT_PEOPLE, anchorCurve, resolveCurve, type TemperatureCurve } from '@sleep-lab/core';
import { MAX_NAME_LENGTH, useData, useLive, type DataMode } from '@/lib/data/context.tsx';
import { SIM_NIGHTS, SIM_SEED } from '@/lib/data/sim.ts';
import { hasRealData, useAuth } from '@/lib/auth.tsx';
import { supabaseClient, supabaseConfigured, supabaseUserEmail } from '@/lib/data/supabase.ts';
import { sanitizeCurve, usePlannedCurve, useTonightCurve } from '@/lib/curve-store.ts';
import { startGoogleConnect, useBandSync, useOAuthResult, useSyncNow, type BandSync } from '@/lib/bands.ts';
import { useBackendStatus, useHealthLinks } from '@/lib/system-status.ts';
import { onsetAfterLightsOut } from '@/lib/tonight.ts';
import { dayLabel, fmt, hm, ictDate, MIN, shortDate } from '@/lib/format.ts';
import { disablePush, enablePush, pushSubscribed, pushSupported, resolveVapidKey } from '@/lib/push.ts';
import { isNightHour, useTheme, type ResolvedTheme, type ThemeMode } from '@/lib/theme.tsx';
import { NotMember, OnboardingSteps } from '../account/Onboarding.tsx';
import { SetPassword } from '../account/SetPassword.tsx';
import { Passkeys } from '../account/Passkeys.tsx';
import { CurveEditor } from '../CurveEditor.tsx';
import { Icon } from '../icons.tsx';
import { withViewTransition } from '../motion.tsx';
import { systemHref, useChrome, type SystemSlug } from '../nav.tsx';
import { Button, Chip, Chips, Field, Group, Input, PageHeader, PersonField, Readout, Readouts, Row, Segmented, Skeleton, Status, Switch, ThemeThumbs } from '../ui.tsx';
import {
  CAMERA_LATER,
  DEVICES,
  type DeviceId,
  NIGHT_MODE_HOURS,
  SETUP,
  TAGS,
  TIME_ZONE,
  aircon,
  clock,
  planTimes,
  driftAlerts,
  isDefaultCurve,
  lastNightOnPlan,
  nightCounts,
  useCalibrations,
  useMorningReport,
  usePlanClock,
  useSetupProgress,
  useQuietMode,
  useTonightTags,
} from './model.ts';
import { ago } from './bands.tsx';
import { AlertsPage } from './alerts.tsx';
import { CameraPage } from './camera.tsx';
import { LocationPage } from './location.tsx';
import { PresencePage, TonightBlock } from './presence.tsx';
import pkg from '../../package.json';
import s from './system.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** Shell of every System page: phone back bar, title + one sentence, reading column. */
function SubPage({ title, lede, back = true, plan = false, children }: { title: string; lede?: ReactNode; back?: boolean; plan?: boolean; children: ReactNode }) {
  useChrome(back ? { back: { href: '/settings', label: 'System' } } : {});
  return (
    <div className={cx(s.sub, plan ? s.planCol : s.col, back && s.drill)}>
      <PageHeader title={title} lede={lede} className={s.header} />
      {children}
    </div>
  );
}

const Skel = ({ w = 72 }: { w?: number }) => <Skeleton w={w} h={14} r="text" inline />;

// ───────────────────────────────────────── Tonight's plan ─────────────────────────────────────────

export function PlanPage({ back = true }: { back?: boolean }) {
  const { latest, dataset } = useData();
  const [localCurve, setCurve, resetCurve] = usePlannedCurve();
  const tonightCurve = useTonightCurve();
  // Real data: tonight runs the household's curve. Edits are a preview on this device (no RPC stores a custom curve).
  const [preview, setPreview] = useState<TemperatureCurve | null>(null);
  const live = tonightCurve.live;
  const curve = live ? preview ?? tonightCurve.curve : localCurve;
  const pc = usePlanClock();
  const ph = curve.phases;
  const times = planTimes(curve, pc.lightsOut, pc.wake);
  const [quiet, setQuiet] = useQuietMode();
  // Set points with the backend's measured bias (ac_state.bias_c) when signed in.
  const plan = aircon(curve, pc.lightsOut, quiet, pc.tonight.biasC, pc.wake, pc.sleepOnset);
  const firstAsleep = plan.steps.find((st) => st.asleep);
  const asleepNote =
    plan.asleepCount === 0
      ? 'The plan sends nothing while you sleep: the room holds its temperature until the aircon goes off.'
      : `The first command while you sleep is at ${firstAsleep?.at ?? '…'}.`;
  // The editor shows the curve on tonight's clock: phases that count from sleep onset are placed at tonight's onset.
  const onsetOffset = onsetAfterLightsOut(pc.lightsOut, pc.sleepOnset);
  const shown = useMemo(() => resolveCurve(curve, 0, onsetOffset * MIN), [curve, onsetOffset]);
  const anchored = useMemo(() => curve.phases.filter((p) => p.anchor === 'sleepOnset').map((p) => p.name), [curve]);
  const last = useMemo(() => lastNightOnPlan(dataset ?? latest), [dataset, latest]);
  const actual = useMemo(() => {
    const n = (dataset ?? latest)?.nights.at(-1);
    if (!n) return undefined;
    const out: { m: number; t: number }[] = [];
    for (const r of n.room) {
      const m = (r.ts - n.lightsOut) / MIN;
      // From lights out: the pre-cool start is often far above the 17–24° scale (stated in the summary instead).
      if (m < 0 || m > 660 || !Number.isFinite(r.tempC)) continue;
      if (out.length && m - out.at(-1)!.m < 3) continue;
      out.push({ m, t: r.tempC });
    }
    return out;
  }, [dataset, latest]);
  const pcReady = pc.ready;

  return (
    <SubPage
      back={back}
      plan
      title="Tonight’s plan"
      lede={
        <>
          The temperature the aircon aims for at bed height, phase by phase from lights out ({pcReady ? clock(pc.lightsOut) : <Skel w={44} />} every day).
        </>
      }
    >
      <div className={s.planGrid}>
        <div className={s.planMain}>
          <TonightBlock t={pc.tonight} asleepNote={asleepNote} />
          <div className={s.summary}>
            <Readouts n={3}>
              <Readout label="Starts" value={<span className="num">{clock(times.starts)}</span>} />
              <Readout label="Coolest" value={<span className="num">{fmt(times.coolest, 1)}°</span>} />
              <Readout label="Wake" value={<span className="num">{clock(times.wake)}</span>} />
            </Readouts>
          </div>
          <CurveEditor
            curve={shown}
            onChange={(c) => {
              const next = anchorCurve(c, curve, onsetOffset);
              if (live) setPreview(sanitizeCurve({ ...next, id: 'preview', name: `${tonightCurve.curve.name} (preview)` }));
              else setCurve(next);
            }}
            onReset={live ? () => setPreview(null) : resetCurve}
            lightsOut={pc.lightsOut}
            actual={actual}
            sleepOnset={{ offsetMin: onsetOffset, anchored }}
            isDefault={live ? preview === null : isDefaultCurve(curve)}
            {...(live
              ? {
                  saveNote: preview
                    ? `Preview on this device only. Tonight’s aircon still runs ${tonightCurve.curve.name}.`
                    : `Tonight runs ${tonightCurve.loading ? '…' : tonightCurve.curve.name}. Changes here are a preview on this device and don’t change the aircon.`,
                  resetLabel: 'Back to tonight’s plan',
                }
              : {})}
          />
        </div>

        <aside className={s.planAside} aria-label="Tonight in detail">
          <section className={s.asideBlock}>
            <h2 className={s.asideH}>{live && preview ? 'With your preview (not sent to the aircon)' : 'What the aircon will do tonight'}</h2>
            <div className={s.quiet}>
              <p className={s.quietLine}>
                <Icon name="bell" size={18} />
                <span>
                  {quiet ? 'Quiet mode: ' : 'Preview without quiet mode: '}
                  <b className="num">{plan.asleepCount}</b> {plan.asleepCount === 1 ? 'command' : 'commands'} while you sleep
                  <span className="ink-3">
                    {quiet
                      ? plan.maxExtraAsleep
                        ? `, at most ${plan.maxExtraAsleep} more if needed`
                        : ''
                      : ', plus corrections'}
                  </span>
                </span>
              </p>
              <Switch checked={quiet} onChange={setQuiet} label={<span className="sr-only">Preview the plan with quiet mode (does not change the aircon)</span>} />
            </div>
            <ol className={s.sched}>
              {plan.steps.map((st, i) => (
                <li key={i}>
                  <span className="num ink-2">{st.at}</span>
                  <b className="num">{st.targetC === null ? 'Off' : `${fmt(st.targetC, 1)}°`}</b>
                  <span>
                    {st.what}
                    {st.setC !== null && st.setC !== st.targetC && <span className="ink-3"> · set {st.setC}°</span>}
                  </span>
                  <span className={s.beep}>{st.asleep && <Icon name="bell" size={16} title="Beeps while you sleep" />}</span>
                </li>
              ))}
            </ol>
            <p className="cap">
              The aircon’s receiver beeps on every command.{' '}
              {quiet
                ? `Quiet mode changes the setting only at these planned steps while you sleep (a glide is one step), plus at most one extra command: a resend if a step doesn’t take, or a cooling correction if the room stays 1.5° too warm for 20 min. It never warms the room while you sleep. A set point can end up 1° different once the room’s offset is measured.`
                : 'Preview only: the aircon stays in quiet mode, which is set on the server. Without it, the controller would also follow each glide degree by degree and correct whenever the room drifts, so more beeps.'}{' '}
              Half-degree targets are sent rounded. The switch only changes this preview.
            </p>
          </section>
          <section className={s.asideBlock}>
            <h2 className={s.asideH}>Last night on this plan</h2>
            {last ? (
              <dl className={s.kv}>
                <div>
                  <dt>Time on target</dt>
                  <dd className="num">{fmt(last.onTargetPct)}%</dd>
                </div>
                <div>
                  <dt>First 4 hours, average</dt>
                  <dd className="num">{fmt(last.earlyMean, 1)}°</dd>
                </div>
                <div>
                  <dt>Warmest, at {hm(last.warmestAt)}</dt>
                  <dd className="num">{fmt(last.warmest, 1)}°</dd>
                </div>
                <div>
                  <dt>Corrections sent</dt>
                  <dd className="num">
                    {last.corrections}
                    <span className="ink-3"> of {last.commands} commands</span>
                  </dd>
                </div>
              </dl>
            ) : (
              <div className="vstack" style={{ ['--gap' as string]: '12px' }}>
                <Skeleton h={18} />
                <Skeleton h={18} />
                <Skeleton h={18} />
              </div>
            )}
            {last && <p className="cap">Night ending {dayLabel(last.date)}.</p>}
          </section>
        </aside>
      </div>
    </SubPage>
  );
}

// ───────────────────────────────────────── Tonight's tags ─────────────────────────────────────────

export function TagsPage() {
  const { tags, toggle, night, live, canWrite, loading, error } = useTonightTags();
  return (
    <SubPage title="Tonight’s tags" lede={<>For the night ending {night ? dayLabel(night) : <Skel w={140} />}. One tap each evening.</>}>
      <Chips label="Tonight's tags">
        {TAGS.map((t) => (
          <Chip key={t.key} selected={tags.includes(t.key)} disabled={loading || (live && !canWrite)} onClick={() => toggle(t.key)}>
            {t.label}
          </Chip>
        ))}
      </Chips>
      <p className={cx('sec', s.after)}>
        {tags.length ? `${tags.length} tagged tonight.` : 'Nothing tagged yet tonight.'} Tags become filters and experiment arms in the Lab.
      </p>
      <p className="cap">
        {error ? (
          <span className="sig">{error}</span>
        ) : live ? (
          canWrite ? 'Saved to tonight’s night for the whole household.' : 'Your household role is read-only.'
        ) : (
          'Saved on this device. Sign in to share them with the household.'
        )}
      </p>
    </SubPage>
  );
}

// ───────────────────────────────────────── General ─────────────────────────────────────────

function resolveFor(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'auto') return mode;
  if (isNightHour(Date.now())) return 'night';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Theme thumbnails; the change reveals from the tap point (instant into or out of night mode). */
function Appearance() {
  const { mode, resolved, setMode } = useTheme();
  const pt = useRef<{ x: number; y: number } | null>(null);
  const choose = (m: ThemeMode) => {
    if (m === mode) return;
    const target = resolveFor(m);
    if (target === resolved || target === 'night' || resolved === 'night') {
      setMode(m);
      return;
    }
    withViewTransition(
      () => {
        flushSync(() => setMode(m));
        document.documentElement.setAttribute('data-theme', target);
      },
      { kind: 'theme', x: pt.current?.x ?? window.innerWidth / 2, y: pt.current?.y ?? window.innerHeight / 2 },
    );
  };
  return (
    <div className={cx('card', s.themes)} onPointerDown={(e) => (pt.current = { x: e.clientX, y: e.clientY })}>
      <ThemeThumbs value={mode} onChange={choose} />
    </div>
  );
}

/** General › Account: who is signed in, and sign out (only when real data is configured on this deployment). */
function Account() {
  const auth = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!auth.configured) return null;
  if (auth.status !== 'signed-in')
    return (
      <Group label="Account" footer="Signing in is only needed for real data. The simulator works without an account.">
        <Row title="Not signed in" value={auth.status === 'loading' ? <Skel /> : undefined} href={auth.status === 'loading' ? undefined : '/signin?next=/settings/general'} />
      </Group>
    );
  const p = auth.probe;
  return (
    <>
    <Group
      label="Account"
      footer={auth.settled && !p?.member ? 'This account isn’t in the household yet, so it can’t read any data.' : 'Signing out only affects this device. The app falls back to the simulator.'}
    >
      <Row
        title={<span style={{ overflowWrap: 'anywhere' }}>{auth.email ?? 'Signed in'}</span>}
        sub={!auth.settled ? 'Checking household…' : p?.member ? `Household ${p.role ?? 'member'}${p.personId ? ` · person ${p.personId}` : ''}` : 'Not in the household yet'}
      />
      <Row
        title={busy ? 'Signing out…' : 'Sign out'}
        chevron={false}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          auth.signOut().finally(() => {
            setBusy(false);
            router.refresh();
          });
        }}
      />
    </Group>
    <div className={s.block}>
      <h3 className="label group-label">Face ID</h3>
      <Passkeys />
      <p className="group-foot">A passkey signs you in with Face ID inside the app. iCloud Keychain syncs it to your other Apple devices.</p>
    </div>
    <div className={s.block}>
      <h3 className="label group-label">Password</h3>
      <SetPassword email={auth.email} />
      <p className="group-foot">Set or change the password for {auth.email ?? 'this account'}, so signing in needs no email code.</p>
    </div>
    </>
  );
}

export function GeneralPage() {
  const { dataset, latest, names, sourcePeople, setPersonName, sourceKind } = useData();
  const shown = (dataset ?? latest)?.people;
  const people = shown?.length ? shown : DEFAULT_PEOPLE;
  return (
    <SubPage title="General" lede="How the app looks and who it’s for.">
      <Group label="Appearance" footer={`Auto follows your device’s light or dark setting, then turns red on black from ${NIGHT_MODE_HOURS} so it won’t wake your eyes.`}>
        <li className={s.bare}>
          <Appearance />
        </li>
      </Group>
      <Group
        label="People"
        footer={
          sourceKind === 'supabase'
            ? 'Names come from the household. A name changed here applies on this device only; leave it empty to use the household’s name.'
            : 'Names are stored on this device. Leave one empty to use the default.'
        }
      >
        {people.map((p, i) => {
          const fallback = (sourcePeople ?? DEFAULT_PEOPLE).find((d) => d.id === p.id)?.name ?? p.id;
          return (
            <li key={p.id} className={s.personLi}>
              <PersonField
                letter={(names[p.id] || fallback).slice(0, 1)}
                person={i === 1 ? 'b' : 'a'}
                label={`Person ${i + 1}`}
                value={names[p.id] ?? fallback}
                placeholder={fallback}
                maxLength={MAX_NAME_LENGTH}
                onChange={(v) => setPersonName(p.id, v)}
              />
            </li>
          );
        })}
      </Group>
      <Group label="Region">
        <Row title="Time zone" value={TIME_ZONE} />
        <Row title="Night mode hours" value={NIGHT_MODE_HOURS} />
      </Group>
      <Account />
    </SubPage>
  );
}

// ───────────────────────────────────────── Morning report ─────────────────────────────────────────

function usePermission(): string {
  const [p, setP] = useState('–');
  useEffect(() => {
    if (!pushSupported()) return setP('Not supported here');
    const map: Record<NotificationPermission, string> = { granted: 'Allowed', denied: 'Blocked', default: 'Not asked yet' };
    setP(map[Notification.permission]);
  }, []);
  return p;
}

export function MorningPage() {
  const [on, setOn] = useMorningReport();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const perm = usePermission();
  const auth = useAuth();
  const member = supabaseConfigured() && auth.status === 'signed-in' && Boolean(auth.probe?.member);
  // null = still asking the backend; '' = no key published yet.
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    if (!member) return;
    let alive = true;
    resolveVapidKey().then((k) => alive && setKey(k ?? ''));
    // The device's real state wins over the stored preference (a cleared browser has no subscription).
    pushSubscribed().then((sub) => alive && sub !== null && setOn(sub));
    return () => {
      alive = false;
    };
  }, [member, setOn]);
  const ready = member && Boolean(key) && pushSupported();
  const toggle = (v: boolean) => {
    setBusy(true);
    const p = v ? enablePush().then((r) => (setOn(r.ok), r.text)) : disablePush().then((t) => (setOn(false), t));
    p.then(setMsg, (e: unknown) => setMsg(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  const why = !supabaseConfigured()
    ? 'Delivery needs Supabase. See Diagnostics for the two settings.'
    : !member
      ? 'Sign in as a household member to get the report on this device.'
      : !pushSupported()
        ? 'This browser can’t receive push. On iPhone, add Jarvis to the Home Screen and open it from there.'
        : key === null
          ? 'Checking whether notifications are ready…'
          : !key
            ? 'Notifications aren’t ready yet: the backend hasn’t published its push key. The switch becomes available as soon as it has.'
            : 'iPhone allows notifications only in the Home Screen app.';
  return (
    <SubPage title="Morning report" lede="A notification on this device when last night’s report is ready, about an hour after you wake.">
      <Group footer={msg ?? why}>
        <Row
          title="Morning report notifications"
          sub={ready ? (on ? 'On for this device' : 'Off for this device') : member && key === '' ? 'Not ready yet' : member ? undefined : supabaseConfigured() ? 'Needs sign-in' : 'Needs Supabase'}
          trailing={<Switch checked={on && ready} disabled={!ready || busy} onChange={toggle} label={<span className="sr-only">Morning report notifications</span>} />}
        />
        <Row title="Notifications on this device" value={perm} />
      </Group>
    </SubPage>
  );
}

// ───────────────────────────────────────── Data & devices ─────────────────────────────────────────

type Live = ReturnType<typeof useLive>;

/** "Cath today 14:05 · Erik 3 min ago": each person's newest band_sync run. */
function bandSyncLine(people: readonly { id: string; name: string }[], bands: Record<string, BandSync> | null): string | null {
  if (!bands) return null;
  const parts = people.flatMap((p) => {
    const b = bands[p.id];
    if (!b?.lastSyncAt) return [];
    return [`${p.name} ${ago(b.lastSyncAt)}${b.lastSyncOk === false ? ' (errors)' : ''}`];
  });
  return parts.length ? parts.join(' · ') : null;
}

function Freshness({ live, bands, member }: { live: Live; bands: Record<string, BandSync> | null; member: boolean }) {
  const { sourceKind, status, dataset, latest } = useData();
  const configured = useAuth().configured;
  const people = (dataset ?? latest)?.people ?? DEFAULT_PEOPLE;
  const lagSec = live.reading ? Math.max(0, (live.now - live.reading.ts) / 1000) : NaN;
  const ago_ = !Number.isFinite(lagSec) ? '' : lagSec < 90 ? `${fmt(lagSec)} s ago` : `${fmt(lagSec / 60)} min ago`;
  const gaps = useMemo(() => {
    const h = live.history;
    if (h.length < 2) return null;
    let n = 0;
    for (let i = 1; i < h.length; i++) if (h[i]!.ts - h[i - 1]!.ts > 5 * MIN) n++;
    return n;
  }, [live.history]);
  const synced = bandSyncLine(people, bands);
  return (
    <Group label="Freshness">
      <Row title="Last room reading" sub={sourceKind === 'sim' ? 'Simulated' : undefined} value={live.reading ? <span className="num">{`${hm(live.reading.ts)} · ${ago_}`}</span> : sourceKind === 'supabase' && status !== 'loading' ? 'None yet' : <Skel />} />
      <Row title="Gaps in the last 24 h" value={gaps === null ? '–' : gaps === 0 ? 'None' : `${gaps}`} />
      <Row
        title="Google Health last sync"
        sub={member && synced ? synced : undefined}
        value={!member ? <Status tone="off">{configured ? 'Sign in to see' : 'Not linked'}</Status> : bands === null ? <Skel /> : synced ? <Status tone={Object.values(bands).some((b) => b.lastSyncOk === false) ? 'alert' : 'on'}>Syncing</Status> : <Status tone="off">Not linked</Status>}
      />
    </Group>
  );
}

/** One row per device: linked or not, from the backend, with how fresh it is. */
function Devices({ live, bands, member, backend }: { live: Live; bands: Record<string, BandSync> | null; member: boolean; backend: ReturnType<typeof useBackendStatus> }) {
  const auth = useAuth();
  const { sourceKind, dataset, latest } = useData();
  const people = (dataset ?? latest)?.people ?? DEFAULT_PEOPLE;
  const kinds = new Set((auth.probe?.devices ?? []).map((d) => d.kind));
  const reading = sourceKind === 'supabase' && live.reading ? live.reading.ts : null;
  const ac = backend.ac;
  const synced = bandSyncLine(people, bands);
  const bandsOk = bands ? people.filter((p) => bands[p.id]?.lastSyncOk).length : 0;
  const linked = deviceLinks(kinds, ac?.linked ?? false, bandsOk);
  const off = <Status tone="off">Not linked</Status>;
  const loading = member && !auth.settled;
  const lastCmd = ac?.last
    ? `Last command ${ago(ac.last.ts)}: ${ac.last.power ? `${ac.last.setpointC ?? '–'}°` : 'off'}${ac.last.dryRun ? ' (dry run)' : ac.last.ok === false ? ' (not sent)' : ''}`
    : null;
  const detail = (id: DeviceId, base: string) => {
    if (!member) return base;
    if (id === 'hub' || id === 'meter') return reading ? `${base} · newest reading ${ago(reading)}` : base;
    if (id === 'ac') return lastCmd ? `${base} · ${lastCmd}` : base;
    return synced ? `${base} · last sync ${synced}` : base;
  };
  return (
    <Group label="Devices" footer={member ? undefined : 'Sign in as a household member to see which devices are linked.'}>
      {DEVICES.map((d) => (
        <Row
          key={d.id}
          title={d.name}
          sub={detail(d.id, d.detail)}
          value={
            loading ? (
              <Skel />
            ) : !linked[d.id] ? (
              off
            ) : d.id === 'ac' ? (
              <Status tone="on">Linked · commands only</Status>
            ) : d.id === 'bands' ? (
              <Status tone={bandsOk === people.length ? 'on' : 'alert'}>{bandsOk === people.length ? 'Linked' : `${bandsOk} of ${people.length} linked`}</Status>
            ) : (
              <Status tone="on">Linked</Status>
            )
          }
        />
      ))}
    </Group>
  );
}

/** Which of the four devices the backend knows: hub and meter from public.devices, the aircon from ac_state, the bands from band_sync. */
function deviceLinks(kinds: ReadonlySet<string>, acLinked: boolean, bandsOk: number): Record<DeviceId, boolean> {
  return { hub: kinds.has('hub'), meter: kinds.has('meter'), ac: acLinked || kinds.has('ac'), bands: bandsOk > 0 };
}

const MODE_COPY: Record<DataMode, string> = {
  auto: 'Real data once your sensors or bands have sent anything; until then, the simulator.',
  supabase: 'Always your household’s data, even before anything has arrived.',
  sim: 'Always the simulator, 90 generated nights. Nothing is read from the backend.',
};

/** The one switch between real and simulated nights. Real data is offered only when the deployment has Supabase. */
function SourceBlock() {
  const { status, mode, setMode, realGate } = useData();
  const auth = useAuth();
  const router = useRouter();
  if (!auth.configured)
    return (
      <Group label="Source" footer="Real data needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY on this deployment (see Diagnostics).">
        <Row title="Simulated" sub="The only source on this deployment" value={<Status tone="sim">On</Status>} />
      </Group>
    );
  const choose = (m: DataMode) => {
    // Real data needs an account: go through sign-in first and come back with Real data selected.
    if (m === 'supabase' && auth.status === 'signed-out') return router.push('/signin?next=/settings/data&mode=real');
    setMode(m);
  };
  const gateMsg =
    mode === 'sim'
      ? null
      : realGate === 'sign-in'
        ? 'Sign in to see real data. Until then this device shows the simulator.'
        : realGate === 'not-member'
          ? 'Signed in, but not in the household yet, so the simulator is showing.'
          : realGate === 'no-data' && mode === 'auto'
            ? 'Nothing real has arrived yet, so the simulator is showing. It switches by itself.'
            : null;
  return (
    <div className={s.block}>
      <h3 className="label group-label">Source</h3>
      <Segmented
        value={mode}
        onChange={choose}
        label="Data source"
        block
        options={[
          { value: 'auto', label: 'Automatic' },
          { value: 'supabase', label: 'Real data' },
          { value: 'sim', label: 'Simulated' },
        ]}
      />
      <p className="group-foot">{MODE_COPY[mode]}</p>
      {gateMsg && <p className={cx('sec', s.after)}>{gateMsg}</p>}
      {status === 'error' && mode !== 'sim' && <p className={cx('sec', s.alert)}>Loading real data failed. Choose Simulated, or try again later.</p>}
      {realGate === 'sign-in' && mode !== 'sim' && (
        <div className={s.inline}>
          <Button variant="primary" href={`/signin?next=/settings/data${mode === 'supabase' ? '&mode=real' : ''}`}>
            Sign in
          </Button>
        </div>
      )}
    </div>
  );
}

/** Signed in, member, nothing real yet: what to set up next (the same list as the tabs' onboarding state). */
function NextSteps() {
  const auth = useAuth();
  if (auth.status !== 'signed-in' || !auth.settled) return null;
  if (!auth.probe?.member)
    return (
      <div className={s.block}>
        <h3 className="label group-label">Household</h3>
        <NotMember variant="inline" />
      </div>
    );
  if (hasRealData(auth.probe) && auth.probe.healthRows > 0) return null;
  return (
    <div className={s.block}>
      <h3 className="label group-label">Set up next</h3>
      <OnboardingSteps probe={auth.probe} />
    </div>
  );
}

export function DataPage() {
  const { dataset, sourceKind, source, status } = useData();
  const auth = useAuth();
  const member = auth.status === 'signed-in' && Boolean(auth.probe?.member);
  const live = useLive(24);
  const { bands } = useBandSync(member);
  const backend = useBackendStatus(member);
  const none = status === 'ready' && !!dataset && dataset.nights.length === 0;
  const kinds = new Set((auth.probe?.devices ?? []).map((d) => d.kind));
  const bandsOk = bands ? Object.values(bands).filter((b) => b.lastSyncOk).length : 0;
  const links = deviceLinks(kinds, backend.ac?.linked ?? false, bandsOk);
  const linked = member ? Object.values(links).filter(Boolean).length : 0;
  const nc = nightCounts(dataset);
  const left = nc ? [nc.sick && `${nc.sick} sick`, nc.away && `${nc.away} away`, nc.gaps && `${nc.gaps} with sensor gaps`].filter(Boolean).join(' · ') : '';
  return (
    <SubPage title="Data & devices" lede="Where the nights come from: the bedroom’s hub, meter and aircon, and both bands through Google Health.">
      {/* One answer to "is anything connected?" before any detail. */}
      <div className={cx('card', s.dataSummary)}>
        <Status tone={sourceKind === 'sim' ? 'sim' : 'on'}>
          <b>{sourceKind === 'sim' ? 'Showing simulated data' : `Showing real data · ${source.label}`}</b>
        </Status>
        <p className="sec">
          {member ? `${linked} of ${DEVICES.length} devices linked.` : 'Sign in to see which devices are linked.'}
          {sourceKind === 'sim' ? ` Every reading below comes from the simulator (seed ${SIM_SEED}), not from your bedroom.` : ''}
        </p>
      </div>
      <SourceBlock />
      <NextSteps />
      <Group label="Nights" footer="Sick and away nights, and nights where a sensor or band dropped out, are left out of the Lab.">
        <Row title="Nights" sub={nc ? `${shortDate(nc.first)} – ${shortDate(nc.last)}` : undefined} value={nc ? <span className="num">{nc.total}</span> : none ? <span className="num">0</span> : <Skel w={40} />} />
        <Row title="With complete data" sub="The Lab uses only these" value={nc ? <span className="num">{nc.complete}</span> : none ? <span className="num">0</span> : <Skel w={40} />} />
        {nc && left && <Row title="Left out" value={left} />}
      </Group>
      <Freshness live={live} bands={bands} member={member} />
      <Devices live={live} bands={bands} member={member} backend={backend} />
      <Group label="Camera" footer="The Mac at home listens to the bedroom camera at night: snoring and noise per minute, with short clips. The video is off. Ideas for later are listed below.">
        <Row title="Pan/Tilt Cam Plus 3K" sub="Night sounds through the Mac" value="Camera" href={systemHref('camera')} />
        {CAMERA_LATER.map((x) => (
          <Row key={x} title={<span className="ink-2">{x}</span>} />
        ))}
      </Group>
    </SubPage>
  );
}

// ───────────────────────────────────────── Google Health ─────────────────────────────────────────

const HEALTH_READS = ['Sleep stages', 'Heart rate and resting heart rate', 'Heart-rate variability', 'Blood oxygen', 'Breathing rate', 'Skin temperature', 'Steps'];

/**
 * Google consent starts at the google-oauth Edge Function: the app POSTs /google-oauth/start with the signed-in
 * user's access token, the function binds a one-time state to that user's household person and returns Google's
 * consent URL, and the browser goes there. The callback stores the refresh token and comes back to this page with
 * ?google=connected (or google=error&reason=…).
 */
export function HealthPage() {
  const { dataset, latest } = useData();
  const auth = useAuth();
  const member = auth.status === 'signed-in' && Boolean(auth.probe?.member);
  const writer = member && (auth.probe?.role === 'owner' || auth.probe?.role === 'member');
  const me = member ? auth.probe?.personId ?? null : null;
  const [nonce, setNonce] = useState(0);
  const links = useHealthLinks(member, nonce);
  const { bands } = useBandSync(member, nonce);
  const shown = (dataset ?? latest)?.people;
  const people = shown?.length ? shown : DEFAULT_PEOPLE;
  const token = auth.session?.access_token ?? null;
  const connected = me ? Boolean(links?.[me] || bands?.[me]?.lastSyncOk) : false;
  const result = useOAuthResult();
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const sync = useSyncNow(token);
  const anyConnected = Boolean(links && Object.values(links).some(Boolean)) || Boolean(bands && Object.values(bands).some((b) => b.lastSyncOk));

  const connect = async () => {
    if (!token) return;
    setStarting(true);
    setStartErr(null);
    const r = await startGoogleConnect(token);
    if ('url' in r) {
      window.location.assign(r.url);
      return;
    }
    setStarting(false);
    setStartErr(r.error);
  };

  let action: ReactNode;
  let foot: ReactNode;
  if (!auth.configured) {
    action = (
      <Button variant="primary" disabled>
        Connect Google Health
      </Button>
    );
    foot = 'Needs the Supabase backend on this deployment. Until then the bands below are simulated.';
  } else if (auth.status !== 'signed-in') {
    action = (
      <Button variant="primary" href="/signin?next=/settings/health">
        Sign in to connect
      </Button>
    );
    foot = 'Each person signs in with their own account first, so the band is linked to the right person.';
  } else if (!auth.settled) {
    action = <Skel w={180} />;
    foot = null;
  } else if (!writer || !me) {
    action = (
      <Button variant="primary" disabled>
        Connect Google Health
      </Button>
    );
    foot = !member ? 'This account isn’t in the household yet.' : !writer ? 'This account is read-only.' : 'This account isn’t linked to a person yet. Ask the owner to set person_id in household_members.';
  } else {
    action = (
      <div className={s.actions}>
        <Button variant={connected ? 'secondary' : 'primary'} disabled={!token || starting} onClick={connect}>
          {starting ? 'Opening Google…' : connected ? 'Reconnect Google Health' : 'Connect Google Health'}
        </Button>
        {anyConnected && (
          <Button disabled={!token || sync.busy} onClick={() => sync.run().then(() => setNonce((n) => n + 1))}>
            {sync.busy ? 'Syncing…' : 'Sync now'}
          </Button>
        )}
      </div>
    );
    foot = (
      <>
        {`Read-only. Connects your band to ${people.find((p) => p.id === me)?.name ?? `person ${me}`}. The other person connects from their own phone, signed in as themselves. Google shows an “unverified app” screen once: tap Advanced › Go to the app.`}{' '}
        {(startErr || sync.msg) && <span className="sig">{startErr ?? sync.msg}</span>}
      </>
    );
  }

  return (
    <SubPage title="Google Health" lede="Sleep and overnight vitals from both Fitbit Air bands.">
      {result && (
        <p className={s.status}>
          <Status tone={result.ok ? 'on' : 'alert'}>{result.text}</Status>
        </p>
      )}
      <Group label="Bands" footer="Synced every hour and on Sync now. Sleep usually appears an hour or two after waking, once the phone app has synced the band.">
        {people.map((p) => {
          const linked = links ? links[p.id] : undefined;
          const b = bands?.[p.id];
          const on = Boolean(linked || b?.lastSyncOk);
          const sub = b?.lastSyncAt
            ? `Fitbit Air · checked ${ago(b.lastSyncAt)}${b.bandSeenAt ? ` · band synced ${ago(b.bandSeenAt)}` : ''}${b.lastSyncOk === false && b.lastError ? ` · ${b.lastError.slice(0, 120)}` : ''}`
            : 'Fitbit Air';
          return (
            <Row
              key={p.id}
              title={p.id === me && p.name !== 'You' ? `${p.name} (you)` : p.name}
              sub={sub}
              value={on ? <Status tone={b?.lastSyncOk === false ? 'alert' : 'on'}>{b?.lastSyncOk === false ? 'Sync errors' : 'Connected'}</Status> : <Status>Not connected</Status>}
            />
          );
        })}
      </Group>
      <div className={s.block}>
        {action}
        {foot && <p className="group-foot">{foot}</p>}
      </div>
      <Group label="What is read">
        {HEALTH_READS.map((x) => (
          <Row key={x} title={x} />
        ))}
      </Group>
    </SubPage>
  );
}

// ───────────────────────────────────────── CO₂ calibration ─────────────────────────────────────────

export function Co2Page() {
  const { dataset } = useData();
  const [cals, setCals] = useCalibrations();
  const [ppm, setPpm] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const drift = useMemo(() => driftAlerts(dataset), [dataset]);
  const log = useMemo(
    () =>
      [
        ...cals.map((c, i) => ({ key: `c${i}`, date: c.date, title: `Outdoor check · ${fmt(c.ppm)} ppm`, sub: c.note || (c.ppm <= 500 ? 'In the expected range' : 'Higher than outdoor air usually is'), alert: false })),
        ...drift.map((d) => ({ key: d.date, date: d.date, title: `Night minimum ${fmt(d.min)} ppm`, sub: 'Below outdoor air: likely sensor drift', alert: true })),
      ].sort((a, b) => (a.date < b.date ? 1 : -1)),
    [cals, drift],
  );
  return (
    <SubPage title="CO₂ calibration" lede="Outdoor air is about 420 ppm. Log an outdoor check now and then; nights that dip below it point to sensor drift.">
      {drift.length > 0 && (
        <p className={s.status}>
          <Status tone="alert">
            {drift.length === 1 ? '1 night' : `${drift.length} nights`} below outdoor air. Recalibrate the meter outdoors.
          </Status>
        </p>
      )}
      <form
        className={cx(s.block, s.calForm)}
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(ppm);
          if (!Number.isFinite(v) || v < 300 || v > 700) return setErr('Enter the outdoor reading, 300–700 ppm.');
          setErr(null);
          setCals((c) => [{ date: ictDate(Date.now()), ppm: v, note: note.trim() }, ...c].slice(0, 50));
          setPpm('');
          setNote('');
        }}
      >
        <Field label="Outdoor reading" htmlFor="cal-ppm" hint={err ?? 'Give the meter 5–10 min outside, untouched.'}>
          <Input id="cal-ppm" className="num" inputMode="numeric" placeholder="ppm" value={ppm} onChange={(e) => setPpm(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor="cal-note">
          <Input id="cal-note" placeholder="Balcony, 5 min" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className={s.calBtn}>
          <Button type="submit">Log check</Button>
        </div>
      </form>
      <Group label="History" footer="Outdoor checks are saved on this device. The drift alerts come from the meter’s own night readings.">
        {log.length ? (
          log.map((x) => <Row key={x.key} title={x.alert ? <span className="sig">{x.title}</span> : x.title} sub={x.sub} value={shortDate(x.date)} />)
        ) : (
          <Row title={<span className="ink-2">No entries yet. Every week or two is plenty.</span>} />
        )}
      </Group>
    </SubPage>
  );
}

// ───────────────────────────────────────── Setup guide ─────────────────────────────────────────

export function SetupPage() {
  const { done, setDone, count, total } = useSetupProgress();
  return (
    <SubPage title="Setup guide" lede="Reference: how the devices were set up. The ticks are kept on this device.">
      <div className={s.progress}>
        <div className={s.meter} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={count} aria-label="Setup progress">
          <i style={{ transform: `scaleX(${count / total})` }} />
        </div>
        <span className="sec">
          {count === total ? 'All set up' : `${count} of ${total} done`}
        </span>
      </div>
      <ol className={cx('list-group', s.checklist)}>
        {SETUP.map((g, i) => {
          const on = Boolean(done[g.id]);
          return (
            <li key={g.id} className={s.check} data-done={on || undefined}>
              <label className={s.box}>
                <input type="checkbox" className="sr-only" checked={on} onChange={(e) => setDone((x) => ({ ...x, [g.id]: e.target.checked }))} aria-label={`${g.title} done`} />
                <svg width={26} height={26} viewBox="0 0 26 26" aria-hidden>
                  <circle cx={13} cy={13} r={11.5} className={s.ring} />
                  <path d="M8 13.4l3.4 3.3 6.6-7" className={s.tick} />
                </svg>
              </label>
              <details className={s.details}>
                <summary>
                  <span className={s.checkT}>
                    <b>
                      <span className="ink-3 num">{i + 1}. </span>
                      {g.title}
                    </b>
                    <span>
                      {g.steps.length} steps
                    </span>
                  </span>
                  <svg className={s.chev} width={18} height={18} viewBox="0 0 24 24" aria-hidden>
                    <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </summary>
                <ol className={s.steps}>
                  {g.steps.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ol>
              </details>
            </li>
          );
        })}
      </ol>
    </SubPage>
  );
}

// ───────────────────────────────────────── Diagnostics ─────────────────────────────────────────

const APP_VERSION = pkg.version;

const builtAt = () => {
  const t = Number(process.env.NEXT_PUBLIC_BUILD_ID);
  return Number.isFinite(t) && t > 0 ? `${shortDate(ictDate(t))}, ${hm(t)}` : '–';
};

export function DiagnosticsPage() {
  const { dataset, sourceKind } = useData();
  const auth = useAuth();
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const ready = supabaseConfigured();
  const member = auth.status === 'signed-in' && Boolean(auth.probe?.member);
  const backend = useBackendStatus(member);
  useEffect(() => {
    let alive = true;
    supabaseUserEmail().then((u) => alive && setUser(u), () => alive && setUser(null));
    return () => {
      alive = false;
    };
  }, []);
  const q = backend.quota;
  const wh = backend.newestWebhook;
  const po = backend.newestPoll;
  const lagMin = wh !== null && po !== null ? Math.round((po - wh) / MIN) : null;
  const pending = member && backend.loading;
  return (
    <SubPage title="Diagnostics" lede="For troubleshooting. Nothing here needs changing day to day.">
      <Group label="Data">
        <Row title="Source" value={sourceKind === 'sim' ? 'Simulator' : 'Supabase (real data)'} />
        {sourceKind === 'sim' && <Row title="Seed / window" value={<span className="num">{`${SIM_SEED} / ${SIM_NIGHTS} nights`}</span>} />}
        <Row title="Metrics computed in" value={dataset ? <span className="num">{`${fmt(dataset.computeMs)} ms${dataset.cached ? ' · cached' : ''}`}</span> : <Skel />} />
        <Row title="App version" value={<span className="num">{`${APP_VERSION} · built ${builtAt()}`}</span>} />
      </Group>
      <Group label="SwitchBot" footer="Budget 5,000 of the 10,000 daily limit (UTC day). Polling every minute costs about 1,440 calls a day; the rest leaves room for aircon commands and retries without risking an hours-long lockout.">
        <Row
          title="Calls today"
          sub={q?.remaining != null ? `SwitchBot reports ${fmt(q.remaining)} left of its own limit` : undefined}
          value={pending ? <Skel /> : <span className="num">{`${q ? fmt(q.used) : member ? '0' : '–'} of 5,000`}</span>}
        />
        <Row
          title="Webhook vs poll lag"
          sub={wh !== null || po !== null ? `Webhook ${wh !== null ? ago(wh) : 'never'} · poll ${po !== null ? ago(po) : 'never'}` : undefined}
          value={
            pending ? (
              <Skel />
            ) : !member ? (
              <Status>{ready ? 'Sign in to see' : 'Not linked'}</Status>
            ) : lagMin === null ? (
              <Status tone="off">{wh === null && po === null ? 'No readings yet' : wh === null ? 'No webhook yet' : 'No poll yet'}</Status>
            ) : (
              <span className="num">{lagMin === 0 ? 'Same minute' : lagMin > 0 ? `Webhook ${lagMin} min behind` : `Poll ${-lagMin} min behind`}</span>
            )
          }
        />
      </Group>
      <Group label="Supabase">
        <Row title="Configured" value={ready ? 'Yes' : 'No'} />
        <Row title="Signed in" value={!ready ? '–' : user === undefined ? <Skel /> : user ?? 'No'} />
      </Group>
      {!ready && (
        <div className={s.block}>
          <p className="sec measure-text">
            To read real data, set <span className="code ink">NEXT_PUBLIC_SUPABASE_URL</span> and <span className="code ink">NEXT_PUBLIC_SUPABASE_ANON_KEY</span> in the deployment’s environment, then redeploy.
          </p>
        </div>
      )}
    </SubPage>
  );
}

export const SYSTEM_SCREENS: Record<SystemSlug, () => ReactNode> = {
  plan: () => <PlanPage />,
  tags: () => <TagsPage />,
  presence: () => <PresencePage />,
  location: () => <LocationPage />,
  general: () => <GeneralPage />,
  morning: () => <MorningPage />,
  alerts: () => <AlertsPage />,
  data: () => <DataPage />,
  health: () => <HealthPage />,
  camera: () => <CameraPage />,
  co2: () => <Co2Page />,
  setup: () => <SetupPage />,
  diagnostics: () => <DiagnosticsPage />,
};
