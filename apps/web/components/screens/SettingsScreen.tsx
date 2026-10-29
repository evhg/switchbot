'use client';
/**
 * System tab (docs/DESIGN.md §11 "System"): iOS-settings-grade grouped lists. Hairline rows (≥ 44 px), tinted icon
 * tiles, mono values, Toggles and steppers. Appearance is four live swatches that swap the theme inside a circular
 * View Transition from the tap point (instant into / out of night mode). The page renders immediately; only the
 * dataset facts wait for data (skeleton values).
 */
import { useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { DEFAULT_PEOPLE, type TagKey } from '@sleep-lab/core';
import { MAX_NAME_LENGTH, personColor, useData, useLive } from '@/lib/data/context.tsx';
import { supabaseConfigured, supabaseSignIn } from '@/lib/data/supabase.ts';
import { enablePush } from '@/lib/push.ts';
import { SIM_NIGHTS, SIM_SEED } from '@/lib/data/sim.ts';
import { usePlannedCurve } from '@/lib/curve-store.ts';
import { addDays, dayLabel, fmt, hm, ictDate, ictHour, shortDate } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';
import { isNightHour, useTheme, type ResolvedTheme, type ThemeMode } from '@/lib/theme.tsx';
import { CurveEditor } from '../CurveEditor.tsx';
import { Icon, type IconName } from '../icons.tsx';
import { Reveal, useInViewCallback, withViewTransition } from '../motion.tsx';
import { Button, JumpBar, Segmented, Skeleton } from '../ui.tsx';
import s from './settings.module.css';

const TAGS: { key: TagKey; label: string }[] = [
  { key: 'alcohol', label: 'Alcohol' },
  { key: 'late_caffeine', label: 'Caffeine after 14:00' },
  { key: 'late_meal', label: 'Late meal' },
  { key: 'late_exercise', label: 'Late exercise' },
  { key: 'heavy_duvet', label: 'Heavy duvet' },
  { key: 'door_ajar', label: 'Door ajar' },
  { key: 'sick', label: 'Sick' },
  { key: 'travel', label: 'Away' },
];

/** Install order and key steps (docs/SETUP.md), ticked off on unboxing day. */
const SETUP: { id: string; title: string; steps: string[] }[] = [
  { id: 'app', title: 'SwitchBot app + account', steps: ['Install the SwitchBot app, region Thailand / Asia', 'Allow Bluetooth, Local Network, Notifications', 'Use 2.4 GHz Wi-Fi (or iPhone hotspot with Maximize Compatibility)'] },
  { id: 'hub', title: '1 · Hub Mini', steps: ['Line of sight to the AC receiver module', 'Note model W0202203 (Matter) or W0202200', 'Pair, then let it update firmware', 'Indicator Light → OFF'] },
  { id: 'meter', title: '2 · Meter Pro CO2', steps: ['Pair on AA batteries, update firmware', 'Calibrate outdoors on batteries (5 min untouched, expect 400–500 ppm)', 'Remove AAs, run on USB-C 5 V/1 A', 'CO₂ interval 1 min · Alert Sound & Light OFF', 'Store Data in Cloud · bed height, away from AC and shower'] },
  { id: 'ac', title: '3 · Aircon remote', steps: ['Hub Mini → Add Remote → Air Conditioner → Smart Matching', 'Test on/off, 18/20/22 °C, fan, DRY (full set = setAll)', 'Otherwise "Others" ladder C18…C24, DRY22, OFF', 'Learn ECO SLEEP + Hi-Power; note if the receiver beeps', 'Photograph the RAV-… rating plate'] },
  { id: 'token', title: '4 · Developer token', steps: ['Profile → Preferences → tap App Version ×10', 'Copy token + secret into Supabase secrets (never git)'] },
  { id: 'cam', title: '5 · Pan/Tilt Cam Plus 3K (can wait)', steps: ['Update firmware first (RTSP needs 2025 firmware)', 'Night Vision Auto · indicator off or taped', 'Create a Camera Account for RTSP'] },
  { id: 'dark', title: 'Darkness audit', steps: ['Lights off, eyes adapted 10 min', 'Tape AC receiver LEDs (not the IR window), chargers, router'] },
];

const DEVICES: { name: string; detail: string; state: string; icon: IconName; tint: string }[] = [
  { name: 'Hub Mini', detail: 'IR to aircon · gateway for the meter', state: 'Not linked', icon: 'house', tint: 'var(--ac-verdict)' },
  { name: 'Meter Pro CO2', detail: 'USB-C power · 1-min CO₂ · battery n/a', state: 'Not linked', icon: 'co2', tint: 'var(--co2)' },
  { name: 'Aircon (Toshiba Carrier)', detail: 'Remote profile: setAll (assumed)', state: 'Open loop', icon: 'snowflake', tint: 'var(--temp)' },
  { name: 'Fitbit Air × 2', detail: 'Google Health pairedDevices: last sync, battery', state: 'Not linked', icon: 'heart', tint: 'var(--person-b)' },
  { name: 'Pan/Tilt Cam Plus 3K', detail: 'RTSP on LAN, needs a home box', state: 'Later', icon: 'sparkle', tint: 'var(--text-2)' },
];

const JUMP = [
  { id: 'look', label: 'Look' },
  { id: 'data', label: 'Data' },
  { id: 'curve', label: 'Curve' },
  { id: 'tonight', label: 'Tags' },
  { id: 'health', label: 'Health' },
  { id: 'setup', label: 'Setup' },
] as const;

const THEMES: { value: ThemeMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Phone' },
  { value: 'light', label: 'Light', hint: 'Ivory' },
  { value: 'dark', label: 'Dark', hint: 'OLED' },
  { value: 'night', label: 'Night', hint: 'Red only' },
];

interface Calibration {
  date: string;
  ppm: number;
  note: string;
}

// ───────────────────────────────────────── building blocks ─────────────────────────────────────────

function Group({ id, n, title, meta, footer, children, className = '', bare = false, style }: { id?: string; n?: number; title: ReactNode; meta?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string; bare?: boolean; style?: CSSProperties }) {
  return (
    <Reveal as="section" id={id} data-jump={id ? '' : undefined} className={`${s.group} ${className}`.trim()} style={style} y={18}>
      <header className={s.gHead}>
        <h2 className="t-label">
          {n !== undefined && <span className={s.gNum}>{String(n).padStart(2, '0')}</span>}
          {title}
        </h2>
        {meta && <div className={`${s.gMeta} t-label`}>{meta}</div>}
      </header>
      <div className={bare ? s.gBare : s.gBody}>{children}</div>
      {footer && <p className={s.gFoot}>{footer}</p>}
    </Reveal>
  );
}

function IconTile({ icon, tint }: { icon: IconName; tint: string }) {
  return (
    <span className={s.tile} style={{ ['--tint' as string]: tint }} aria-hidden>
      <Icon name={icon} size={17} />
    </span>
  );
}

function Row({ icon, tint, title, sub, end, className = '' }: { icon?: IconName; tint?: string; title: ReactNode; sub?: ReactNode; end?: ReactNode; className?: string }) {
  return (
    <div className={`${s.row} ${className}`.trim()}>
      {icon && <IconTile icon={icon} tint={tint ?? 'var(--ch-accent)'} />}
      <div className={s.rowMain}>
        <div className={s.rowTitle}>{title}</div>
        {sub && <div className={s.rowSub}>{sub}</div>}
      </div>
      {end !== undefined && <div className={s.rowEnd}>{end}</div>}
    </div>
  );
}

function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn' | 'good' | 'off'; children: ReactNode }) {
  return <span className={`${s.pill} ${s[tone]} t-micro`}>{children}</span>;
}

function resolveFor(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'auto') return mode;
  if (isNightHour(Date.now())) return 'night';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function Appearance() {
  const { mode, resolved, setMode } = useTheme();
  const choose = (m: ThemeMode, e: MouseEvent<HTMLButtonElement>) => {
    if (m === mode) return;
    const target = resolveFor(m);
    if (target === resolved || target === 'night' || resolved === 'night') {
      setMode(m); // into / out of night mode is always instant
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX || r.left + r.width / 2;
    const y = e.clientY || r.top + r.height / 2;
    withViewTransition(
      () => {
        flushSync(() => setMode(m));
        document.documentElement.setAttribute('data-theme', target);
      },
      { kind: 'theme', x, y },
    );
  };
  return (
    <div className={s.swatches} role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.value} type="button" className={`${s.swatch} tap`} aria-pressed={mode === t.value} onClick={(e) => choose(t.value, e)}>
          <span className={s.prev} data-p={t.value} aria-hidden>
            <span className={s.prevNum}>76</span>
            <span className={s.prevBar} />
            <span className={s.prevCheck}>
              <Icon name="check" size={11} strokeWidth={2.6} />
            </span>
          </span>
          <span className={s.swLabel}>{t.label}</span>
          <span className={`${s.swHint} t-micro`}>{t.hint}</span>
        </button>
      ))}
    </div>
  );
}

function Freshness() {
  const live = useLive(1);
  const lagSec = live.reading ? Math.max(0, (live.now - live.reading.ts) / 1000) : NaN;
  const fresh = Number.isFinite(lagSec) && lagSec < 180;
  const ago = !Number.isFinite(lagSec) ? '' : lagSec < 90 ? `${fmt(lagSec)} s ago` : `${fmt(lagSec / 60)} min ago`;
  return (
    <>
      <Row
        icon="refresh"
        tint="var(--good)"
        title="Last room reading"
        end={
          <span className={s.value}>
            {live.reading ? (
              <>
                <i className={`${s.dot} ${fresh ? s.fresh : ''}`} style={{ background: fresh ? 'var(--good)' : 'var(--warn)' }} aria-hidden />
                {hm(live.reading.ts)} · {ago}
              </>
            ) : (
              '–'
            )}
          </span>
        }
      />
      <Row icon="wind" tint="var(--temp)" title="Webhook vs poll lag" end={<Pill tone="off">Not linked</Pill>} />
      <Row icon="alert" tint="var(--warn)" title="Gaps in the last 24 h" end={<span className={`${s.value} muted`}>–</span>} />
      <Row
        icon="pulse"
        tint="var(--ac-verdict)"
        title="SwitchBot calls today"
        sub={
          <span className={s.meter} aria-hidden>
            <i style={{ transform: 'scaleX(0)' }} />
          </span>
        }
        end={<span className={`${s.value} muted`}>– / 5,000</span>}
      />
      <Row icon="heart" tint="var(--person-b)" title="Google Health last sync" end={<Pill tone="off">Not linked</Pill>} />
    </>
  );
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useInViewCallback(ref, (v) => v && ref.current?.classList.add(s.ringIn!));
  const R = 20;
  const C = 2 * Math.PI * R;
  const f = total ? done / total : 0;
  return (
    <svg ref={ref} className={s.ring} width={52} height={52} viewBox="0 0 52 52" role="img" aria-label={`${done} of ${total} done`}>
      <circle cx={26} cy={26} r={R} fill="none" stroke="var(--ring-track)" strokeWidth={5} />
      <circle
        className={s.ringArc}
        cx={26}
        cy={26}
        r={R}
        fill="none"
        stroke="var(--ch-accent)"
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={C}
        style={{ ['--off' as string]: `${C * (1 - f)}`, ['--c' as string]: `${C}` }}
        transform="rotate(-90 26 26)"
      />
      <text x={26} y={30} textAnchor="middle" fill="var(--text)" fontSize={12} fontWeight={700} style={{ fontFamily: 'var(--font-num)' }}>
        {done}/{total}
      </text>
    </svg>
  );
}

// ───────────────────────────────────────── screen ─────────────────────────────────────────

export function SettingsScreen() {
  const { status, dataset, sourceKind, setSourceKind, source, names, sourcePeople, setPersonName } = useData();
  const { mode, resolved } = useTheme();
  const [curve, setCurve, resetCurve] = usePlannedCurve();
  const [tagStore, setTagStore] = usePref<Record<string, TagKey[]>>('tags', {});
  const [setup, setSetup] = usePref<Record<string, boolean>>('setup', {});
  const [cals, setCals] = usePref<Calibration[]>('calibrations', []);
  const [calPpm, setCalPpm] = useState('');
  const [calNote, setCalNote] = useState('');
  const [email, setEmail] = useState('');
  const [signInMsg, setSignInMsg] = useState<string | null>(null);
  const [pushMsg, setPushMsg] = useState<string | null>(null);

  const now = Date.now();
  const tonight = ictHour(now) >= 12 ? addDays(ictDate(now), 1) : ictDate(now);
  const tagsTonight = tagStore[tonight] ?? [];
  const toggleTag = (k: TagKey) =>
    setTagStore((st) => {
      const cur = st[tonight] ?? [];
      return { ...st, [tonight]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] };
    });

  const suspect = useMemo(
    () =>
      (dataset?.nights ?? [])
        .map((n) => ({ date: n.date, min: Math.min(...n.room.filter((r) => r.ts >= n.lightsOut && r.ts <= n.wake).map((r) => r.co2)) }))
        .filter((x) => x.min < 420),
    [dataset],
  );

  const setupDone = SETUP.filter((st) => setup[st.id]).length;
  const people = dataset?.people ?? DEFAULT_PEOPLE;
  const factSk = <Skeleton w={84} h={13} r="text" />;

  return (
    <div className={s.page}>
      <Reveal as="header" className="page-head" y={12}>
        <div style={{ minWidth: 0 }}>
          <div className="page-kicker t-label">Settings</div>
          <h1>System</h1>
          <div className="page-sub t-label">
            <span>Curve · tags · devices</span>
            {sourceKind === 'sim' ? <span className="badge">Simulated</span> : <span className="badge live">Live</span>}
          </div>
        </div>
      </Reveal>

      <JumpBar items={JUMP} label="System sections" />

      <div className={s.grid}>
        <Group id="look" n={1} title="Appearance" meta={`${resolved}${mode === 'auto' ? ' · auto' : ''}`} footer="Auto follows the phone's light/dark setting and switches to red-on-black night mode from 21:00 to 07:00 (Phuket time)." bare>
          <Appearance />
        </Group>

        <Group n={2} title="People" footer="Stored on this device. Leave a field empty to use the default name.">
          {people.map((p, i) => {
            const fallback = (sourcePeople ?? DEFAULT_PEOPLE).find((d) => d.id === p.id)?.name ?? p.id;
            return (
              <label key={p.id} className={s.row}>
                <span className={s.avatar} style={{ ['--tint' as string]: personColor(people, p.id) }} aria-hidden>
                  {(names[p.id] || fallback).slice(0, 1).toUpperCase()}
                </span>
                <span className={s.rowTitle} style={{ flex: 'none', width: 74 }}>
                  Person {i + 1}
                </span>
                <input
                  className={s.inline}
                  value={names[p.id] ?? ''}
                  placeholder={fallback}
                  maxLength={MAX_NAME_LENGTH}
                  onChange={(e) => setPersonName(p.id, e.target.value)}
                  aria-label={`Name for person ${i + 1}`}
                  autoComplete="off"
                />
              </label>
            );
          })}
        </Group>

        <Group
          id="data"
          n={3}
          title="Data source"
          meta={source.label}
          footer={!supabaseConfigured() ? 'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to read real data.' : undefined}
        >
          <div className={s.pad}>
            <Segmented
              value={sourceKind}
              onChange={(k) => setSourceKind(k)}
              label="Data source"
              className={s.fullSeg}
              options={[
                { value: 'sim', label: 'Simulator' },
                { value: 'supabase', label: supabaseConfigured() ? 'Supabase' : 'Supabase (not set up)' },
              ]}
            />
            {status === 'error' && <p className={`${s.err} small`}>Load failed. Switch back to Simulator, or sign in below.</p>}
          </div>
          {supabaseConfigured() && sourceKind === 'supabase' && (
            <form
              className={`${s.row} ${s.formRow}`}
              onSubmit={(e) => {
                e.preventDefault();
                supabaseSignIn(email).then((err) => setSignInMsg(err ?? 'Check your email for the sign-in link.'));
              }}
            >
              <input className={s.inline} style={{ textAlign: 'left' }} type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
              <Button variant="ghost" size="sm" type="submit">
                Email link
              </Button>
              {signInMsg && <span className={`${s.rowSub} ${s.full}`}>{signInMsg}</span>}
            </form>
          )}
          {supabaseConfigured() && sourceKind === 'supabase' && (
            <Row
              icon="alert"
              title="Morning report notifications"
              sub={pushMsg ?? undefined}
              end={
                <Button variant="ghost" size="sm" onClick={() => enablePush().then(setPushMsg, (e: unknown) => setPushMsg(e instanceof Error ? e.message : String(e)))}>
                  Enable
                </Button>
              }
            />
          )}
          <Row
            icon="calendar"
            tint="var(--ac-night)"
            title="Nights"
            end={<span className={s.value}>{dataset ? `${dataset.nights.length} · ${shortDate(dataset.nights[0]!.date)} – ${shortDate(dataset.nights.at(-1)!.date)}` : factSk}</span>}
          />
          {sourceKind === 'sim' && <Row icon="sparkle" tint="var(--ac-verdict)" title="Seed / window" end={<span className={s.value}>{`${SIM_SEED} / ${SIM_NIGHTS} nights`}</span>} />}
          <Row
            icon="clock"
            tint="var(--ac-tonight)"
            title="Metrics computed in"
            end={<span className={s.value}>{dataset ? `${fmt(dataset.computeMs)} ms${dataset.cached ? ' · cached' : ''}` : factSk}</span>}
          />
        </Group>

        <Group id="curve" n={4} title="Temperature curve" meta="Room air at bed height" className={s.span2}>
          <div className={s.padLg}>
            <CurveEditor curve={curve} onChange={setCurve} onReset={resetCurve} />
          </div>
        </Group>

        <Group
          id="tonight"
          n={5}
          title="Tonight's tags"
          meta={`Night ending ${dayLabel(tonight)}`}
          footer="One tap each evening. Tags become filters and experiment arms in the Lab. Stored on this phone until the backend is connected."
        >
          <div className={`${s.pad} ${s.chips}`}>
            {TAGS.map((t) => {
              const on = tagsTonight.includes(t.key);
              return (
                <button key={t.key} type="button" className="chip" aria-pressed={on} onClick={() => toggleTag(t.key)}>
                  {on && <Icon name="check" size={13} strokeWidth={2.4} />}
                  {t.label}
                </button>
              );
            })}
          </div>
        </Group>

        <Group
          id="health"
          n={6}
          title="Data freshness"
          meta="From the ingest log"
          footer="Budget 5,000 of the 10,000 daily limit. A minute poll costs ≈1,440 calls/day; the budget leaves room for aircon commands and retries without risking an hours-long lockout."
        >
          <Freshness />
        </Group>

        <Group n={7} title="Devices">
          {DEVICES.map((d) => (
            <Row
              key={d.name}
              icon={d.icon}
              tint={d.tint}
              title={d.name}
              sub={d.detail}
              end={<Pill tone={d.state === 'Open loop' ? 'warn' : d.state === 'Later' ? 'neutral' : 'off'}>{d.state}</Pill>}
            />
          ))}
        </Group>

        <Group id="setup" n={8} title="Setup checklist" meta="Install order">
          <div className={s.setupHead}>
            <ProgressRing done={setupDone} total={SETUP.length} />
            <div>
              <div className={s.setupTitle}>{setupDone === SETUP.length ? 'All set up' : `${SETUP.length - setupDone} steps to go`}</div>
              <div className={s.rowSub}>
                Install order · {setupDone}/{SETUP.length} done
              </div>
            </div>
          </div>
          {SETUP.map((st) => {
            const done = Boolean(setup[st.id]);
            return (
              <div key={st.id} className={s.check} data-done={done || undefined}>
                <label className={`${s.checkBox} tap`}>
                  <input className="sr-only" type="checkbox" checked={done} onChange={(e) => setSetup((x) => ({ ...x, [st.id]: e.target.checked }))} aria-label={st.title} />
                  <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden>
                    <circle cx={12} cy={12} r={10.5} className={s.checkRing} />
                    <circle cx={12} cy={12} r={11} className={s.checkFill} />
                    <path d="M7.2 12.4l3.2 3.1 6.4-6.8" pathLength={1} className={s.tick} />
                  </svg>
                </label>
                <details className={s.details}>
                  <summary>
                    <span className={s.checkTitle}>{st.title}</span>
                    <span className={`${s.checkMeta} t-micro`}>{st.steps.length} steps</span>
                    <Icon name="chevron-down" size={16} className={s.chev} />
                  </summary>
                  <ol>
                    {st.steps.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ol>
                </details>
              </div>
            );
          })}
        </Group>

        <Group n={9} title="Calibration log" meta="Outdoor checks">
          <form
            className={`${s.row} ${s.formRow}`}
            onSubmit={(e) => {
              e.preventDefault();
              const ppm = Number(calPpm);
              if (!Number.isFinite(ppm) || ppm < 300 || ppm > 700) return;
              setCals((c) => [{ date: ictDate(Date.now()), ppm, note: calNote.trim() }, ...c].slice(0, 50));
              setCalPpm('');
              setCalNote('');
            }}
          >
            <input className={`${s.field} num`} inputMode="numeric" placeholder="ppm outside" value={calPpm} onChange={(e) => setCalPpm(e.target.value)} style={{ width: 118, flex: 'none' }} aria-label="Outdoor reading in ppm" />
            <input className={s.field} placeholder="note" value={calNote} onChange={(e) => setCalNote(e.target.value)} style={{ flex: 1, minWidth: 0 }} aria-label="Note" />
            <Button variant="primary" size="sm" type="submit" shine={false} className={s.logBtn}>
              Log
            </Button>
          </form>
          {cals.map((c, i) => (
            <Row
              key={`c${i}`}
              icon="check"
              tint={c.ppm <= 500 ? 'var(--good)' : 'var(--warn)'}
              title={
                <>
                  Outdoor <span className="num">{c.ppm}</span> ppm
                </>
              }
              sub={c.note || undefined}
              end={<span className={s.value}>{shortDate(c.date)}</span>}
            />
          ))}
          {suspect.map((x) => (
            <Row key={x.date} icon="alert" tint="var(--critical)" title={<>Night minimum {fmt(x.min)} ppm</>} sub="Below outdoor air: sensor drift" end={<span className={s.value}>{shortDate(x.date)}</span>} />
          ))}
          {!cals.length && !suspect.length && <p className={s.empty}>No entries. Give the meter 5–10 min outside every week or two and log the reading.</p>}
        </Group>

        <Group n={10} title="Coming later: camera" meta="Phase 3 · home box">
          {['Movement strip under the hypnogram (IR video frame difference)', 'Sleep position and covers on/off from snapshots', 'Snoring and sound timeline with playable clips', 'Nightly light-leak map: new glows get circled'].map((x) => (
            <div key={x} className={`${s.row} ${s.later}`}>
              <i className={s.bullet} aria-hidden />
              <span className={s.rowSub} style={{ marginTop: 0 }}>
                {x}
              </span>
            </div>
          ))}
        </Group>
      </div>
    </div>
  );
}
