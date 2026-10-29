'use client';
/**
 * The nine System pages (docs/DESIGN.md §9.5). Each is one reading column (672 px; the plan 832 px plus a side
 * column from 1760) with a title, one sentence, then a few grouped lists. On the phone each is a drill-in with a
 * "‹ System" back bar; on desktop the sidebar's second level is the navigation.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { DEFAULT_PEOPLE } from '@sleep-lab/core';
import { MAX_NAME_LENGTH, useData, useLive } from '@/lib/data/context.tsx';
import { SIM_NIGHTS, SIM_SEED } from '@/lib/data/sim.ts';
import { supabaseConfigured, supabaseSignIn, supabaseUserEmail } from '@/lib/data/supabase.ts';
import { usePlannedCurve } from '@/lib/curve-store.ts';
import { dayLabel, fmt, hm, ictDate, MIN, shortDate } from '@/lib/format.ts';
import { enablePush, pushSupported } from '@/lib/push.ts';
import { isNightHour, useTheme, type ResolvedTheme, type ThemeMode } from '@/lib/theme.tsx';
import { CurveEditor } from '../CurveEditor.tsx';
import { withViewTransition } from '../motion.tsx';
import { useChrome, type SystemSlug } from '../nav.tsx';
import { Button, Chip, Chips, Field, Group, Input, PageHeader, PersonField, Readout, Readouts, Row, Segmented, Skeleton, Status, Switch, ThemeThumbs } from '../ui.tsx';
import {
  CAMERA_LATER,
  DEVICES,
  NIGHT_MODE_HOURS,
  SETUP,
  SETUP_LATER,
  TAGS,
  TIME_ZONE,
  aircon,
  clock,
  planTimes,
  driftAlerts,
  lastNightOnPlan,
  nightCounts,
  useCalibrations,
  useMorningReport,
  usePlanClock,
  useSetupProgress,
  useTonightTags,
} from './model.ts';
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
  const [curve, setCurve, resetCurve] = usePlannedCurve();
  const pc = usePlanClock();
  const ph = curve.phases;
  const times = planTimes(curve, pc.lightsOut);
  const schedule = aircon(curve, pc.lightsOut);
  const last = useMemo(() => lastNightOnPlan(dataset ?? latest), [dataset, latest]);
  const actual = useMemo(() => {
    const n = (dataset ?? latest)?.nights.at(-1);
    if (!n) return undefined;
    const out: { m: number; t: number }[] = [];
    for (const r of n.room) {
      const m = (r.ts - n.lightsOut) / MIN;
      // From lights out: the pre-cool start is often far above the 17–24° scale (stated in the summary instead).
      if (m < 0 || m > 540 || !Number.isFinite(r.tempC)) continue;
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
          The temperature the aircon aims for at bed height, phase by phase from lights out (usually {pcReady ? clock(pc.lightsOut) : <Skel w={44} />}).
        </>
      }
    >
      <div className={s.planGrid}>
        <div className={s.planMain}>
          <div className={s.summary}>
            <Readouts n={3}>
              <Readout label="Starts" value={<span className="num">{clock(times.starts)}</span>} />
              <Readout label="Coolest" value={<span className="num">{fmt(times.coolest, 1)}°</span>} />
              <Readout label="Wake" value={<span className="num">{clock(times.wake)}</span>} />
            </Readouts>
          </div>
          <CurveEditor curve={curve} onChange={setCurve} onReset={resetCurve} lightsOut={pc.lightsOut} actual={actual} />
        </div>

        <aside className={s.planAside} aria-label="Tonight in detail">
          <section className={s.asideBlock}>
            <h2 className={s.asideH}>What the aircon will do tonight</h2>
            <ol className={s.sched}>
              {schedule.map((st, i) => (
                <li key={i}>
                  <span className="num ink-2">{st.at}</span>
                  <b className="num">{st.targetC === null ? 'Off' : `${fmt(st.targetC, 1)}°`}</b>
                  <span>
                    {st.what}
                    {st.setC !== null && st.setC !== st.targetC && <span className="ink-3"> · set {st.setC}°</span>}
                  </span>
                </li>
              ))}
            </ol>
            <p className="cap">The aircon only takes whole degrees, so half-degree targets are sent rounded; the controller corrects by up to 2° if the room drifts.</p>
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
  const [tags, toggle, night] = useTonightTags();
  return (
    <SubPage title="Tonight’s tags" lede={<>For the night ending {night ? dayLabel(night) : <Skel w={140} />}. One tap each evening.</>}>
      <Chips label="Tonight's tags">
        {TAGS.map((t) => (
          <Chip key={t.key} selected={tags.includes(t.key)} onClick={() => toggle(t.key)}>
            {t.label}
          </Chip>
        ))}
      </Chips>
      <p className={cx('sec', s.after)}>
        {tags.length ? `${tags.length} tagged tonight.` : 'Nothing tagged yet tonight.'} Tags become filters and experiment arms in the Lab.
      </p>
      <p className="cap">Stored on this phone until the backend is connected.</p>
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

export function GeneralPage() {
  const { dataset, latest, names, sourcePeople, setPersonName } = useData();
  const people = (dataset ?? latest)?.people ?? DEFAULT_PEOPLE;
  return (
    <SubPage title="General" lede="How the app looks and who it’s for.">
      <Group label="Appearance" footer={`Auto follows your device’s light or dark setting, then turns red on black from ${NIGHT_MODE_HOURS} so it won’t wake your eyes.`}>
        <li className={s.bare}>
          <Appearance />
        </li>
      </Group>
      <Group label="People" footer="Names are stored on this device. Leave one empty to use the default.">
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
  const perm = usePermission();
  const ready = supabaseConfigured();
  const toggle = (v: boolean) => {
    setOn(v);
    if (v) enablePush().then(setMsg, (e: unknown) => setMsg(e instanceof Error ? e.message : String(e)));
    else setMsg(null);
  };
  return (
    <SubPage title="Morning report" lede="A notification on this device when last night’s report is ready.">
      <Group footer={msg ?? (ready ? 'iPhone allows notifications only in the Home Screen app.' : 'Delivery needs Supabase. See Diagnostics for the two settings.')}>
        <Row title="Send the morning report" sub={ready ? undefined : 'Needs Supabase'} trailing={<Switch checked={on && ready} disabled={!ready} onChange={toggle} label={<span className="sr-only">Send the morning report</span>} />} />
        <Row title="Notifications on this device" value={perm} />
      </Group>
    </SubPage>
  );
}

// ───────────────────────────────────────── Data & devices ─────────────────────────────────────────

function Freshness() {
  const live = useLive(24);
  const { sourceKind } = useData();
  const lagSec = live.reading ? Math.max(0, (live.now - live.reading.ts) / 1000) : NaN;
  const ago = !Number.isFinite(lagSec) ? '' : lagSec < 90 ? `${fmt(lagSec)} s ago` : `${fmt(lagSec / 60)} min ago`;
  const gaps = useMemo(() => {
    const h = live.history;
    if (h.length < 2) return null;
    let n = 0;
    for (let i = 1; i < h.length; i++) if (h[i]!.ts - h[i - 1]!.ts > 5 * MIN) n++;
    return n;
  }, [live.history]);
  return (
    <Group label="Freshness">
      <Row title="Last room reading" sub={sourceKind === 'sim' ? 'Simulated' : undefined} value={live.reading ? <span className="num">{`${hm(live.reading.ts)} · ${ago}`}</span> : <Skel />} />
      <Row title="Gaps in the last 24 h" value={gaps === null ? '–' : gaps === 0 ? 'None' : `${gaps}`} />
      <Row title="Google Health last sync" value={<Status tone="off">Not linked</Status>} />
    </Group>
  );
}

function SourceBlock() {
  const { status, sourceKind, setSourceKind } = useData();
  const [email, setEmail] = useState('');
  const [signInMsg, setSignInMsg] = useState<string | null>(null);
  const ready = supabaseConfigured();
  return (
    <div className={s.block}>
      <h3 className="label group-label">Source</h3>
      <Segmented
        value={sourceKind}
        onChange={(k) => setSourceKind(k)}
        label="Data source"
        block
        options={[
          { value: 'sim', label: 'Simulator' },
          { value: 'supabase', label: ready ? 'Supabase' : 'Supabase · not set up' },
        ]}
      />
      {status === 'error' && <p className={cx('sec', s.alert)}>Loading failed. Switch back to the simulator, or sign in below.</p>}
      {!ready && <p className="group-foot">Supabase isn’t set up yet. The two settings it needs are in Diagnostics.</p>}
      {ready && sourceKind === 'supabase' && (
        <form
          className={s.inline}
          onSubmit={(e) => {
            e.preventDefault();
            supabaseSignIn(email).then((err) => setSignInMsg(err ?? 'Check your email for the sign-in link.'));
          }}
        >
          <Field label="Sign in with email" htmlFor="sb-email" hint={signInMsg ?? undefined}>
            <div className={s.inlineRow}>
              <Input id="sb-email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <Button type="submit">Email link</Button>
            </div>
          </Field>
        </form>
      )}
    </div>
  );
}

export function DataPage() {
  const { dataset, sourceKind, source } = useData();
  const nc = nightCounts(dataset);
  const left = nc ? [nc.sick && `${nc.sick} sick`, nc.away && `${nc.away} away`, nc.gaps && `${nc.gaps} with sensor gaps`].filter(Boolean).join(' · ') : '';
  return (
    <SubPage title="Data & devices" lede="Where the nights come from. The simulator stands in until the sensors arrive.">
      {/* One answer to "is anything connected?" before any detail. */}
      <div className={cx('card', s.dataSummary)}>
        <Status tone={sourceKind === 'sim' ? 'sim' : 'on'}>
          <b>{sourceKind === 'sim' ? 'Running on simulated data' : `Live data · ${source.label}`}</b>
        </Status>
        <p className="sec">
          0 of {DEVICES.length} devices linked.
          {sourceKind === 'sim' ? ` Every reading below comes from the simulator (seed ${SIM_SEED}), not from your bedroom.` : ''}
        </p>
      </div>
      <SourceBlock />
      <Group label="Nights" footer="Sick and away nights, and nights where a sensor or band dropped out, are left out of the Lab.">
        <Row title="Nights" sub={nc ? `${shortDate(nc.first)} – ${shortDate(nc.last)}` : undefined} value={nc ? <span className="num">{nc.total}</span> : <Skel w={40} />} />
        <Row title="With complete data" sub="The Lab uses only these" value={nc ? <span className="num">{nc.complete}</span> : <Skel w={40} />} />
        {nc && left && <Row title="Left out" value={left} />}
      </Group>
      <Freshness />
      <Group label="Devices">
        {DEVICES.map((d) => (
          <Row key={d.name} title={d.name} sub={d.detail} value={<Status tone={d.state === 'Open loop' ? 'on' : 'off'}>{d.state === 'Open loop' ? 'Open loop (commands only)' : d.state}</Status>} />
        ))}
      </Group>
      <Group label="Coming later: camera" footer="Phase 3. Needs a small home box for RTSP on the LAN.">
        <Row title="Pan/Tilt Cam Plus 3K" sub="Not set up yet" value="Later" />
        {CAMERA_LATER.map((x) => (
          <Row key={x} title={<span className="ink-2">{x}</span>} />
        ))}
      </Group>
    </SubPage>
  );
}

// ───────────────────────────────────────── Google Health ─────────────────────────────────────────

const HEALTH_READS = ['Sleep stages', 'Heart rate and resting heart rate', 'Heart-rate variability', 'Blood oxygen', 'Breathing rate', 'Skin temperature', 'Steps'];

export function HealthPage() {
  const { dataset, latest } = useData();
  const people = (dataset ?? latest)?.people ?? DEFAULT_PEOPLE;
  return (
    <SubPage title="Google Health" lede="Sleep and overnight vitals from both Fitbit Air bands.">
      <Group label="Bands">
        {people.map((p) => (
          <Row key={p.id} title={p.name} sub="Fitbit Air · last sync –" value={<Status>Not connected</Status>} />
        ))}
      </Group>
      <div className={s.block}>
        <Button variant="primary" disabled>
          Connect Google Health
        </Button>
        <p className="group-foot">Read-only. Each person signs in with their own Google account once the backend is running.</p>
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
      <Group label="History">
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
    <SubPage title="Setup guide" lede="Install order for unboxing day. Tick each part as you finish it.">
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
                      {g.steps.length} steps{SETUP_LATER.has(g.id) ? ' · can wait' : ''}
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

const builtAt = () => {
  const t = Number(process.env.NEXT_PUBLIC_BUILD_ID);
  return Number.isFinite(t) && t > 0 ? `${shortDate(ictDate(t))}, ${hm(t)}` : '–';
};

export function DiagnosticsPage() {
  const { dataset, sourceKind } = useData();
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const ready = supabaseConfigured();
  useEffect(() => {
    let alive = true;
    supabaseUserEmail().then((u) => alive && setUser(u), () => alive && setUser(null));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <SubPage title="Diagnostics" lede="For troubleshooting. Nothing here needs changing day to day.">
      <Group label="Data">
        <Row title="Source" value={sourceKind === 'sim' ? 'Simulator' : 'Supabase'} />
        {sourceKind === 'sim' && <Row title="Seed / window" value={<span className="num">{`${SIM_SEED} / ${SIM_NIGHTS} nights`}</span>} />}
        <Row title="Metrics computed in" value={dataset ? <span className="num">{`${fmt(dataset.computeMs)} ms${dataset.cached ? ' · cached' : ''}`}</span> : <Skel />} />
        <Row title="App version" value={<span className="num">{`0.1.0 · built ${builtAt()}`}</span>} />
      </Group>
      <Group label="SwitchBot" footer="Budget 5,000 of the 10,000 daily limit. Polling every minute costs about 1,440 calls a day; the rest leaves room for aircon commands and retries without risking an hours-long lockout.">
        <Row title="Calls today" value={<span className="num">– of 5,000</span>} />
        <Row title="Webhook vs poll lag" value={<Status>Not linked</Status>} />
      </Group>
      <Group label="Supabase">
        <Row title="Configured" value={ready ? 'Yes' : 'No'} />
        <Row title="Signed in" value={!ready ? '–' : user === undefined ? <Skel /> : user ?? 'No'} />
      </Group>
      <div className={s.block}>
        <p className="sec measure-text">
          To read real data, set <span className="code ink">NEXT_PUBLIC_SUPABASE_URL</span> and <span className="code ink">NEXT_PUBLIC_SUPABASE_ANON_KEY</span> in the deployment’s environment, then redeploy.
        </p>
      </div>
    </SubPage>
  );
}

export const SYSTEM_SCREENS: Record<SystemSlug, () => ReactNode> = {
  plan: () => <PlanPage />,
  tags: () => <TagsPage />,
  general: () => <GeneralPage />,
  morning: () => <MorningPage />,
  data: () => <DataPage />,
  health: () => <HealthPage />,
  co2: () => <Co2Page />,
  setup: () => <SetupPage />,
  diagnostics: () => <DiagnosticsPage />,
};
