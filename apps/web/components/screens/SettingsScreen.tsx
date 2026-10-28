'use client';
import { useMemo, useState } from 'react';
import type { TagKey } from '@sleep-lab/core';
import { useData, useLive } from '@/lib/data/context.tsx';
import { supabaseConfigured, supabaseSignIn } from '@/lib/data/supabase.ts';
import { enablePush } from '@/lib/push.ts';
import { SIM_NIGHTS, SIM_SEED } from '@/lib/data/sim.ts';
import { usePlannedCurve } from '@/lib/curve-store.ts';
import { addDays, dayLabel, fmt, hm, ictDate, ictHour, shortDate } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';
import { useTheme, type ThemeMode } from '@/lib/theme.tsx';
import { CurveEditor } from '../CurveEditor.tsx';
import { Card, Loading, Segmented, StatusDot } from '../ui.tsx';

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

interface Calibration {
  date: string;
  ppm: number;
  note: string;
}

export function SettingsScreen() {
  const { status, dataset, progress, sourceKind, setSourceKind, source } = useData();
  const { mode, resolved, setMode } = useTheme();
  const [curve, setCurve, resetCurve] = usePlannedCurve();
  const [tagStore, setTagStore] = usePref<Record<string, TagKey[]>>('tags', {});
  const [setup, setSetup] = usePref<Record<string, boolean>>('setup', {});
  const [cals, setCals] = usePref<Calibration[]>('calibrations', []);
  const [calPpm, setCalPpm] = useState('');
  const [calNote, setCalNote] = useState('');
  const [email, setEmail] = useState('');
  const [signInMsg, setSignInMsg] = useState<string | null>(null);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const live = useLive(1);

  const now = Date.now();
  const tonight = ictHour(now) >= 12 ? addDays(ictDate(now), 1) : ictDate(now);
  const tagsTonight = tagStore[tonight] ?? [];
  const toggleTag = (k: TagKey) =>
    setTagStore((s) => {
      const cur = s[tonight] ?? [];
      return { ...s, [tonight]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] };
    });

  const suspect = useMemo(
    () =>
      (dataset?.nights ?? [])
        .map((n) => ({ date: n.date, min: Math.min(...n.room.filter((r) => r.ts >= n.lightsOut && r.ts <= n.wake).map((r) => r.co2)) }))
        .filter((x) => x.min < 420),
    [dataset],
  );

  if (status === 'loading' && !dataset) return <Loading text={progress} />;
  const setupDone = SETUP.filter((s) => setup[s.id]).length;
  const lagSec = live.reading ? Math.max(0, (live.now - live.reading.ts) / 1000) : NaN;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>System</h1>
          <div className="page-sub">Settings, curve, tags and device health</div>
        </div>
      </header>
      <div className="stack two">
        <Card title="Appearance" sub={`Now showing: ${resolved}${mode === 'auto' ? ' (auto)' : ''}`}>
          <Segmented<ThemeMode>
            value={mode}
            onChange={setMode}
            label="Theme"
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'night', label: 'Night' },
            ]}
          />
          <p className="card-note">Auto follows the phone&apos;s light/dark setting and switches to red-on-black night mode from 21:00 to 07:00 (Phuket time).</p>
        </Card>

        <Card title="Data source" sub={source.label}>
          <Segmented
            value={sourceKind}
            onChange={(k) => setSourceKind(k)}
            label="Data source"
            options={[
              { value: 'sim', label: 'Simulator' },
              { value: 'supabase', label: supabaseConfigured() ? 'Supabase' : 'Supabase (not set up)' },
            ]}
          />
          {!supabaseConfigured() && <p className="card-note">Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to read real data.</p>}
          {status === 'error' && <p className="small bad">Load failed. Switch back to Simulator, or sign in below.</p>}
          {supabaseConfigured() && sourceKind === 'supabase' && (
            <form
              className="row"
              style={{ marginTop: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                supabaseSignIn(email).then((err) => setSignInMsg(err ?? 'Check your email for the sign-in link.'));
              }}
            >
              <input className="input" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 160 }} aria-label="Email" />
              <button className="btn" type="submit">
                Email link
              </button>
              {signInMsg && <span className="small t2">{signInMsg}</span>}
            </form>
          )}
          {supabaseConfigured() && sourceKind === 'supabase' && (
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" type="button" onClick={() => enablePush().then(setPushMsg, (e: unknown) => setPushMsg(e instanceof Error ? e.message : String(e)))}>
                Morning report notifications
              </button>
              {pushMsg && <span className="small t2">{pushMsg}</span>}
            </div>
          )}
          {dataset && (
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Nights</dt>
              <dd>
                {dataset.nights.length} ({shortDate(dataset.nights[0]!.date)} – {shortDate(dataset.nights.at(-1)!.date)})
              </dd>
              {sourceKind === 'sim' && (
                <>
                  <dt>Seed / window</dt>
                  <dd>
                    {SIM_SEED} / {SIM_NIGHTS} nights
                  </dd>
                </>
              )}
              <dt>Metrics computed in</dt>
              <dd>
                {fmt(dataset.computeMs)} ms{dataset.cached ? ' (cached on this device)' : ''}
              </dd>
            </dl>
          )}
        </Card>

        <Card id="curve" title="Temperature curve" sub="Room air at bed height, relative to lights-out" className="span-2">
          <CurveEditor curve={curve} onChange={setCurve} onReset={resetCurve} />
        </Card>

        <Card title="Tonight's tags" sub={`For the night ending ${dayLabel(tonight)}`}>
          <div className="row">
            {TAGS.map((t) => (
              <button key={t.key} type="button" className="chip" aria-pressed={tagsTonight.includes(t.key)} onClick={() => toggleTag(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          <p className="card-note">One tap each evening. Tags become filters and experiment arms in the Lab. Stored on this phone until the backend is connected.</p>
        </Card>

        <Card title="Data freshness" sub="Phase 1 fills these from the ingest log">
          <dl className="kv">
            <dt>Last room reading</dt>
            <dd>{live.reading ? `${hm(live.reading.ts)} (${fmt(lagSec)} s ago)` : '–'}</dd>
            <dt>Webhook vs poll lag</dt>
            <dd className="muted">not connected</dd>
            <dt>Gaps in the last 24 h</dt>
            <dd className="muted">–</dd>
            <dt>SwitchBot calls today</dt>
            <dd>
              <span className="muted">– / 5,000</span>
            </dd>
            <dt>Google Health last sync</dt>
            <dd className="muted">not connected</dd>
          </dl>
          <p className="card-note">Budget 5,000 of the 10,000 daily limit. A minute poll costs ≈1,440 calls/day; the budget leaves room for aircon commands and retries without risking an hours-long lockout.</p>
        </Card>

        <Card title="Device status">
          <ul className="list small">
            {[
              { name: 'Hub Mini', detail: 'IR to aircon · gateway for the meter', state: 'Not connected' },
              { name: 'Meter Pro CO2', detail: 'USB-C power · 1-min CO₂ · battery n/a', state: 'Not connected' },
              { name: 'Aircon (Toshiba Carrier)', detail: 'Remote profile: setAll (assumed)', state: 'Open loop' },
              { name: 'Fitbit Air × 2', detail: 'Google Health pairedDevices: last sync, battery', state: 'Not connected' },
              { name: 'Pan/Tilt Cam Plus 3K', detail: 'RTSP on LAN, needs a home box', state: 'Later' },
            ].map((d) => (
              <li key={d.name}>
                {d.state === 'Open loop' ? <StatusDot status="warn" /> : <i className="status-dot" style={{ background: 'var(--axis)', marginTop: 5 }} aria-hidden />}
                <span style={{ flex: 1 }}>
                  <b style={{ fontWeight: 600 }}>{d.name}</b>
                  <br />
                  <span className="muted">{d.detail}</span>
                </span>
                <span className="t2">{d.state}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Setup checklist" sub={`Install order · ${setupDone}/${SETUP.length} done`}>
          <ul className="list small">
            {SETUP.map((s) => (
              <li key={s.id}>
                <input type="checkbox" checked={Boolean(setup[s.id])} onChange={(e) => setSetup((x) => ({ ...x, [s.id]: e.target.checked }))} aria-label={s.title} style={{ marginTop: 3 }} />
                <details style={{ flex: 1 }}>
                  <summary style={{ fontWeight: 600, textDecoration: setup[s.id] ? 'line-through' : undefined, color: setup[s.id] ? 'var(--muted)' : undefined }}>{s.title} <span className="muted" style={{ fontWeight: 400 }}>· {s.steps.length} steps ▾</span></summary>
                  <ol style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--text-2)' }}>
                    {s.steps.map((st) => (
                      <li key={st} style={{ padding: '2px 0', border: 0, display: 'list-item' }}>
                        {st}
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Calibration log" sub="Outdoor checks and impossible-low nights">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const ppm = Number(calPpm);
              if (!Number.isFinite(ppm) || ppm < 300 || ppm > 700) return;
              setCals((c) => [{ date: ictDate(Date.now()), ppm, note: calNote.trim() }, ...c].slice(0, 50));
              setCalPpm('');
              setCalNote('');
            }}
          >
            <input className="input num" inputMode="numeric" placeholder="ppm outside" value={calPpm} onChange={(e) => setCalPpm(e.target.value)} style={{ width: 110 }} aria-label="Outdoor reading in ppm" />
            <input className="input" placeholder="note" value={calNote} onChange={(e) => setCalNote(e.target.value)} style={{ flex: 1, minWidth: 100 }} aria-label="Note" />
            <button className="btn primary" type="submit">
              Log
            </button>
          </form>
          <ul className="list small" style={{ marginTop: 8 }}>
            {cals.map((c, i) => (
              <li key={i}>
                <StatusDot status={c.ppm <= 500 ? 'good' : 'warn'} />
                <span style={{ flex: 1 }}>
                  {shortDate(c.date)} · outdoor {c.ppm} ppm {c.note && <span className="muted">· {c.note}</span>}
                </span>
              </li>
            ))}
            {suspect.map((s) => (
              <li key={s.date}>
                <StatusDot status="critical" />
                <span style={{ flex: 1 }}>
                  {shortDate(s.date)} · night minimum {fmt(s.min)} ppm, below outdoor air: sensor drift
                </span>
              </li>
            ))}
            {!cals.length && !suspect.length && <li className="muted">No entries. Give the meter 5–10 min outside every week or two and log the reading.</li>}
          </ul>
        </Card>

        <Card title="Coming later: camera" sub="Phase 3, with a small home box">
          <ul className="list small t2">
            <li>Movement strip under the hypnogram (IR video frame difference)</li>
            <li>Sleep position and covers on/off from snapshots</li>
            <li>Snoring and sound timeline with playable clips</li>
            <li>Nightly light-leak map: new glows get circled</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
