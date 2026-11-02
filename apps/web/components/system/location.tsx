'use client';
/**
 * System › Location (/settings/location): everything the Map needs.
 *
 *   Phones       each person's newest fix in public.locations (migration 0023): "Sending" (< 2 h), "Quiet", "Not set up"
 *   OwnTracks    setup steps for the iPhone app (HTTP mode → the owntracks Edge Function, Basic auth with the same
 *                presence token as the Shortcut and the Mac)
 *   Home         household_settings.home_lat / home_lon / home_radius_m, set from this device's position
 *                (set_home_location); OwnTracks fixes inside the radius count as "home" for the pre-cool
 *   Maps key     household_settings.maps_browser_key (set_maps_browser_key): the Google Maps browser key, shown only as
 *                its last 4 characters
 * Writers (owner / member) can change Home and the key; everyone in the household can read.
 */
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { DEFAULT_PEOPLE } from '@sleep-lab/core';
import { useAuth } from '@/lib/auth.tsx';
import { useData } from '@/lib/data/context.tsx';
import {
  FALLBACK_NAMES,
  HOME_RADII,
  SENDING_MS,
  distLabel,
  owntracksUrl,
  setHomeLocation,
  setMapsKey,
  useLatestFixes,
  useLocationSettings,
  type Fix,
} from '@/lib/location.ts';
import { systemHref, useChrome } from '../nav.tsx';
import { Button, Field, Group, Input, PageHeader, Row, Segmented, Skeleton, Status } from '../ui.tsx';
import { ago } from './bands.tsx';
import { CopyField, Steps } from './presence.tsx';
import s from './system.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

const MAPS_CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials?project=sleep-lab-513214';

function fixStatus(f: Fix | null | undefined, now: number): { tone: 'on' | 'off'; label: string } {
  if (!f) return { tone: 'off', label: 'Not set up' };
  return now - f.ts < SENDING_MS ? { tone: 'on', label: 'Sending' } : { tone: 'off', label: 'Quiet' };
}

/** System root value: how many phones are sending. */
export function useLocationSummary(): ReactNode {
  const auth = useAuth();
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const { fixes } = useLatestFixes(live);
  if (!live) return 'Not set up';
  if (fixes === undefined) return <Skeleton w={52} h={14} r="text" inline />;
  const now = Date.now();
  const all = Object.values(fixes).filter(Boolean).length;
  const sending = Object.values(fixes).filter((f) => f && now - f.ts < SENDING_MS).length;
  return all ? `${sending} of ${all} sending` : 'Not set up';
}

type GeoState = { busy: boolean; msg: string | null };

export function LocationPage() {
  useChrome({ back: { href: '/settings', label: 'System' } });
  const auth = useAuth();
  const { dataset, latest } = useData();
  const people = (dataset ?? latest)?.people ?? DEFAULT_PEOPLE;
  const nameOf = (id: string) => {
    const n = people.find((p) => p.id === id)?.name?.trim();
    return n && n.toLowerCase() !== 'you' ? n : (FALLBACK_NAMES[id] ?? id);
  };
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const canWrite = live && (auth.probe?.role === 'owner' || auth.probe?.role === 'member');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((x) => x + 1), []);
  const { settings, error } = useLocationSettings(live, nonce);
  const { fixes, error: fixError } = useLatestFixes(live, nonce);
  const url = owntracksUrl();
  const now = Date.now();

  return (
    <div className={cx(s.sub, s.col, s.drill)}>
      <PageHeader
        title="Location"
        lede="Each iPhone runs OwnTracks, which sends its position here. The Map shows where you both are, and arriving or leaving home sets Presence by itself."
        className={s.header}
      />

      <Group label="Phones" footer={live ? 'Sending: a location in the last 2 hours. Quiet phones send again when they move.' : undefined}>
        {!live ? (
          <Row title={auth.status === 'loading' ? 'Checking sign-in…' : 'Sign in as a household member to see the phones'} />
        ) : (
          (['a', 'b'] as const).map((id) => {
            const f = fixes?.[id];
            const st = fixStatus(f, now);
            return (
              <Row
                key={id}
                title={`${nameOf(id)}’s iPhone`}
                sub={
                  fixes === undefined ? (
                    <Skeleton w={160} h={14} r="text" inline />
                  ) : f ? (
                    [`Last location ${ago(f.ts, now)}`, f.batt !== null ? `battery ${f.batt}%` : null].filter(Boolean).join(' · ')
                  ) : (
                    'No location yet'
                  )
                }
                value={fixes === undefined ? undefined : <Status tone={st.tone}>{st.label}</Status>}
              />
            );
          })
        )}
      </Group>
      {(error || fixError) && <p className={cx('sec', s.alert)}>{error ?? fixError}</p>}

      <Group label="Set up OwnTracks on each iPhone (about 3 minutes)">
        <li className={s.bare}>
          <div className={s.howtoBox}>
            <p className="sec">Each person does this on their own iPhone, with their own presence token.</p>
            <h3 className={s.howtoH}>1 · Install and connect</h3>
            <Steps
              items={[
                <>Install <b>OwnTracks</b> from the App Store (free, by OwnTracks).</>,
                <>Open it, tap <b>(i)</b> › <b>Settings</b>. Set <b>Mode</b> to <b>HTTP</b>.</>,
                <>
                  <b>URL</b>: the address below (Copy).
                </>,
                <>
                  Turn <b>Authentication</b> on. <b>UserID</b>: <span className="code">cath</span> or <span className="code">erik</span>. <b>Password</b>: your presence token
                  from <a href={systemHref('presence')}>System › Presence</a>.
                </>,
                <>
                  <b>TrackerID</b>: <span className="code">C</span> or <span className="code">E</span> (the letter on the other phone’s map).
                </>,
              ]}
            />
            <CopyField label="URL" value={url} />
            <h3 className={s.howtoH}>2 · How often it reports</h3>
            <Steps
              items={[
                <>
                  On the map screen, tap the monitoring button until it shows <b>Significant</b>: easy on the battery, a location about every 500 m or every few
                  minutes on the move.
                </>,
                <>
                  Or <b>Move</b>: detailed trails for the Timelapse, at a clear cost in battery. You can switch any time.
                </>,
              ]}
            />
            <h3 className={s.howtoH}>3 · Let it run in the background</h3>
            <Steps
              items={[
                <>
                  iOS Settings › <b>OwnTracks</b> › <b>Location</b>: <b>Always</b>, and <b>Precise Location</b> on. Background App Refresh on.
                </>,
                <>Back in OwnTracks, tap the upload button once. The phone above turns to <b>Sending</b>, and the other person appears on your OwnTracks map.</>,
              ]}
            />
            <p className="sec">
              The token is the same one the Shortcut and the Mac use. Creating a new token in System › Presence means pasting it again everywhere it’s used, including
              OwnTracks. Once OwnTracks runs, the Shortcut’s home and away automations are optional: OwnTracks reports arriving and leaving home itself.
            </p>
          </div>
        </li>
      </Group>

      <HomeGroup settings={settings} canWrite={canWrite} live={live} onSaved={refresh} />
      <MapsKeyGroup current={settings?.mapsKey ?? null} loading={settings === undefined} canWrite={canWrite} live={live} onSaved={refresh} />
    </div>
  );
}

function HomeGroup({
  settings,
  canWrite,
  live,
  onSaved,
}: {
  settings: ReturnType<typeof useLocationSettings>['settings'];
  canWrite: boolean;
  live: boolean;
  onSaved: () => void;
}) {
  const home = settings?.home ?? null;
  const [radius, setRadius] = useState<number | null>(null);
  const r = radius ?? home?.radiusM ?? 150;
  const [geo, setGeo] = useState<GeoState>({ busy: false, msg: null });

  const save = async (lat: number | null, lon: number | null, rad: number, ok: string | null) => {
    const e = await setHomeLocation(lat, lon, rad);
    setGeo({ busy: false, msg: e ?? ok });
    if (!e) onSaved();
  };

  const here = () => {
    if (!('geolocation' in navigator)) return setGeo({ busy: false, msg: 'This browser can’t share its location.' });
    setGeo({ busy: true, msg: 'Finding where you are…' });
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const acc = Math.round(p.coords.accuracy);
        const warn = acc > 100 ? ' That’s rough: try again near a window, or with Wi-Fi on.' : '';
        void save(p.coords.latitude, p.coords.longitude, r, `Home saved, accurate to ± ${distLabel(acc)}.${warn}`);
      },
      (e) =>
        setGeo({
          busy: false,
          msg: e.code === e.PERMISSION_DENIED ? 'Location permission was refused. Allow it for this site in the browser’s settings, then try again.' : 'Couldn’t get a position. Try again.',
        }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  };

  const pickRadius = (v: string) => {
    const n = Number(v);
    setRadius(n);
    if (home) {
      setGeo({ busy: true, msg: null });
      void save(home.lat, home.lon, n, null);
    }
  };

  return (
    <Group
      label="Home"
      footer={
        <>
          OwnTracks locations inside this circle count as home, outside it (with some margin) as away; that sets Presence for the pre-cool. Stand at home when you set it.{' '}
          {geo.msg && <span className="sig">{geo.msg}</span>}
        </>
      }
    >
      <Row
        title="Home point"
        sub={settings === undefined ? <Skeleton w={160} h={14} r="text" inline /> : home ? `${home.lat.toFixed(5)}, ${home.lon.toFixed(5)} · radius ${home.radiusM} m` : 'Not set'}
        value={settings === undefined ? undefined : <Status tone={home ? 'on' : 'off'}>{home ? 'Set' : 'Not set'}</Status>}
      />
      <li className={s.segLi}>
        <Segmented<string>
          label="Home radius"
          value={String(r)}
          block
          onChange={pickRadius}
          options={HOME_RADII.map((x) => ({ value: String(x), label: `${x} m` }))}
        />
      </li>
      <li className={s.btnLi}>
        <div className={s.inlineRow}>
          <Button variant="primary" disabled={!canWrite || geo.busy} onClick={here}>
            {geo.busy ? 'Saving…' : 'Set home to where I am now'}
          </Button>
          {home && (
            <Button variant="text" disabled={!canWrite || geo.busy} onClick={() => void save(null, null, r, 'Home cleared.')}>
              Clear
            </Button>
          )}
        </div>
        {!live && <span className="cap">Sign in as a household member to set home.</span>}
        {live && !canWrite && <span className="cap">Your household role is read-only.</span>}
      </li>
    </Group>
  );
}

function MapsKeyGroup({ current, loading, canWrite, live, onSaved }: { current: string | null; loading: boolean; canWrite: boolean; live: boolean; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (key: string | null) => {
    setBusy(true);
    setMsg(null);
    const e = await setMapsKey(key);
    setBusy(false);
    setMsg(e ?? (key ? 'Saved. The Map now uses Google Maps.' : 'Key removed. The Map shows the simple view.'));
    if (!e) {
      setValue('');
      onSaved();
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(v)) return setMsg('That doesn’t look like a Maps key (letters, digits, - and _, 20 to 100 characters).');
    void save(v);
  };
  return (
    <Group label="Google Maps key" footer={msg ? <span className="sig">{msg}</span> : 'Saved for the household. A browser key is visible to anyone who uses the Map, so it is restricted to this website in Google Cloud.'}>
      <Row
        title="Browser key"
        sub={loading ? <Skeleton w={120} h={14} r="text" inline /> : current ? `Saved · ends in ${current.slice(-4)}` : 'Not saved: the Map shows a simple view without streets'}
        value={loading ? undefined : <Status tone={current ? 'on' : 'off'}>{current ? 'Saved' : 'Not set'}</Status>}
        trailing={
          current && canWrite ? (
            <Button size="sm" variant="text" disabled={busy} onClick={() => void save(null)}>
              Clear
            </Button>
          ) : undefined
        }
      />
      {canWrite ? (
        <li className={s.btnLi}>
          <form onSubmit={submit}>
            <Field
              label={current ? 'Replace the key' : 'Paste the key'}
              htmlFor="maps-key"
              hint={
                <>
                  Open{' '}
                  <a href={MAPS_CONSOLE_URL} target="_blank" rel="noopener noreferrer">
                    Google Cloud › Credentials
                  </a>
                  , open the key <b>sleep-lab maps (browser)</b>, tap <b>Show key</b>, copy it and paste it here.
                </>
              }
            >
              <div className={s.inlineRow}>
                <Input
                  id="maps-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="AIza…"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                <Button type="submit" disabled={busy || !value.trim()}>
                  {busy ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </Field>
          </form>
        </li>
      ) : (
        <Row title={live ? 'Your household role is read-only' : 'Sign in as a household member to save the key'} />
      )}
    </Group>
  );
}
