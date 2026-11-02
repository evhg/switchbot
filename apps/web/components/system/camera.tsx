'use client';
/**
 * System › Camera (/settings/camera): the bedroom camera's live view.
 *
 * The Pan/Tilt Cam's RTSP feed is relayed by go2rtc on the Mac at home and published at an https address; that
 * address is household_settings.camera_stream_url (migration 0020, set with set_camera_stream_url). The page embeds
 * go2rtc's own player (stream.html?src=living&mode=mse,hls) in an iframe. No address yet: an empty state explaining the
 * relay. Either way, "Open in SwitchBot app" is the fallback (an App Store link; the app has no documented deep link).
 * Below the live view, "Activity today": the Mac relay's sightings (camera_events, migration 0022; lib/camera.ts).
 *
 * Stream lock (migration 0023, household_settings.camera_ticket_required): when on, the Mac only serves the stream
 * behind a signed ticket. useCameraEmbed asks the camera-ticket Edge Function for one with the signed-in user's access
 * token (12 h, refreshed 30 min before it expires) and embeds <stream address>/t/<ticket>/stream.html?src=…; when off,
 * the plain address as before.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth.tsx';
import { sightingWho, useCameraActivity } from '@/lib/camera.ts';
import { useData } from '@/lib/data/context.tsx';
import { functionsUrl, supabaseClient } from '@/lib/data/supabase.ts';
import { dur, hm } from '@/lib/format.ts';
import { useChrome } from '../nav.tsx';
import { Button, Field, Group, Input, PageHeader, Row, Skeleton, Status, Switch } from '../ui.tsx';
import s from './system.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export const SWITCHBOT_APP_URL = 'https://apps.apple.com/app/switchbot/id1087374760';
/** go2rtc stream names on the Mac relay: the camera's sub-stream (640×400) and its 3K main stream as H.264. */
export const STREAM = 'living';
export const STREAM_HD = 'living_hd';

/**
 * The player URL for a stored address: an https go2rtc base ("https://host/" or ".../stream.html") becomes
 * stream.html?src=living&mode=mse,hls (HLS for iPhones without MSE); a src or mode already in the address is kept,
 * unless `stream` asks for a specific one. Null for anything else.
 */
export function cameraEmbedUrl(raw: string | null | undefined, stream?: string): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (!/\/stream\.html$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, '')}/stream.html`;
  if (stream) u.searchParams.set('src', stream);
  else if (!u.searchParams.has('src')) u.searchParams.set('src', STREAM);
  if (!u.searchParams.has('mode')) u.searchParams.set('mode', 'mse,hls');
  return u.toString();
}

/**
 * The player URL behind the Mac's ticket gate: the stored address's directory (with a trailing slash) + 't/' + the
 * ticket + '/' + the player path relative to it (stream.html?src=…&mode=…). Null when the address isn't usable.
 */
export function cameraTicketUrl(raw: string | null | undefined, ticket: string, stream?: string): string | null {
  const full = cameraEmbedUrl(raw, stream);
  if (!full) return null;
  const u = new URL(full);
  const dir = u.pathname.replace(/stream\.html$/, '');
  const base = dir.endsWith('/') ? dir : `${dir}/`;
  return `${u.origin}${base}t/${encodeURIComponent(ticket)}/stream.html${u.search}`;
}

/** household_settings.camera_ticket_required; undefined while loading, false when unreadable (before migration 0023). */
export function useCameraTicketRequired(enabled: boolean, nonce = 0): boolean | undefined {
  const [v, setV] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return setV(false);
    let alive = true;
    supabaseClient()
      .from('household_settings')
      .select('camera_ticket_required')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        setV(!error && (data as { camera_ticket_required?: unknown } | null)?.camera_ticket_required === true);
      });
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);
  return v;
}

const TICKET_EARLY_MS = 30 * 60_000;

/** A camera ticket from the camera-ticket Edge Function, for the signed-in user. */
async function fetchCameraTicket(): Promise<{ ticket: string; exp: number }> {
  const { data } = await supabaseClient().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in again to watch the camera.');
  const res = await fetch(`${functionsUrl()}/camera-ticket`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (res.status === 401) throw new Error('Sign in again to watch the camera.');
  if (res.status === 403) throw new Error('Only household members can watch the camera.');
  if (!res.ok || typeof json.ticket !== 'string') throw new Error(typeof json.error === 'string' ? json.error : `The camera pass couldn’t be issued (${res.status}).`);
  const exp = typeof json.exp === 'string' ? Date.parse(json.exp) : NaN;
  const ttl = typeof json.ttlS === 'number' ? json.ttlS * 1000 : 12 * 3_600_000;
  return { ticket: json.ticket, exp: Number.isFinite(exp) ? exp : Date.now() + ttl };
}

/** Retry a failed ticket fetch after 30 s, doubling up to 5 min. */
const TICKET_RETRY_MS = 30_000;
const TICKET_RETRY_MAX_MS = 5 * 60_000;

/**
 * The URL to embed for a stored address and stream: plain when the stream lock is off, with a fresh ticket when it's on.
 * embed: undefined while loading, null when there's nothing to show. `settingsNonce`: bump it to re-read the lock
 * setting (System › Camera does after toggling it). A failed fetch is retried with backoff, and the ticket is renewed
 * when the page comes back (visible / online) close to its expiry.
 */
export function useCameraEmbed(
  url: string | null | undefined,
  stream: string | undefined,
  enabled: boolean,
  settingsNonce = 0,
): { embed: string | null | undefined; locked: boolean; error: string | null } {
  const required = useCameraTicketRequired(enabled, settingsNonce);
  const [pass, setPass] = useState<{ key: string; ticket: string; exp: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const fails = useRef(0);
  const passRef = useRef(pass);
  passRef.current = pass;
  const key = `${url ?? ''}|${stream ?? ''}`;
  const want = required === true && !!url;

  useEffect(() => {
    if (!want) return;
    let alive = true;
    setError(null);
    fetchCameraTicket()
      .then((t) => {
        if (!alive) return;
        fails.current = 0;
        setPass({ key, ...t });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        fails.current += 1;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [want, key, nonce]);

  // Refresh 30 min before the ticket expires (at least a minute from now).
  useEffect(() => {
    if (!want || !pass) return;
    const id = window.setTimeout(() => setNonce((n) => n + 1), Math.max(60_000, pass.exp - TICKET_EARLY_MS - Date.now()));
    return () => window.clearTimeout(id);
  }, [want, pass]);

  // A failed fetch (first or refresh) tries again with backoff, so a blip never leaves the stream on an expiring pass.
  useEffect(() => {
    if (!want || !error) return;
    const delay = Math.min(TICKET_RETRY_MAX_MS, TICKET_RETRY_MS * 2 ** Math.max(0, fails.current - 1));
    const id = window.setTimeout(() => setNonce((n) => n + 1), delay);
    return () => window.clearTimeout(id);
  }, [want, error]);

  // Timers are throttled while a laptop sleeps or the tab is hidden: on return, renew if the pass is due or missing.
  useEffect(() => {
    if (!want) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const p = passRef.current;
      if (!p || p.key !== key || p.exp - Date.now() < TICKET_EARLY_MS) setNonce((n) => n + 1);
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
    };
  }, [want, key]);

  if (url === undefined || (enabled && required === undefined)) return { embed: undefined, locked: false, error: null };
  if (!want) return { embed: cameraEmbedUrl(url, stream), locked: false, error: null };
  if (pass && pass.key === key) return { embed: cameraTicketUrl(url, pass.ticket, stream), locked: true, error };
  return { embed: error ? null : undefined, locked: true, error };
}

/** household_settings.camera_stream_url for members (null = none or not readable); undefined while loading. */
export function useCameraUrl(enabled: boolean, nonce = 0): { url: string | null | undefined; error: string | null } {
  const [res, setRes] = useState<{ url: string | null | undefined; error: string | null }>({ url: undefined, error: null });
  useEffect(() => {
    if (!enabled) return setRes({ url: null, error: null });
    let alive = true;
    supabaseClient()
      .from('household_settings')
      .select('camera_stream_url')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        // Before migration 0020 the column doesn't exist: same as "no camera", with the reason.
        if (error) return setRes({ url: null, error: /camera_stream_url/.test(error.message) ? 'The camera setting isn’t on the server yet (migration 0020).' : error.message });
        const v = (data as { camera_stream_url?: unknown } | null)?.camera_stream_url;
        setRes({ url: typeof v === 'string' && v ? v : null, error: null });
      });
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);
  return res;
}

/** System root row value. */
export function useCameraSummary(): ReactNode {
  const auth = useAuth();
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const { url } = useCameraUrl(live);
  if (!live) return 'Not set up';
  if (url === undefined) return <Skeleton w={52} h={14} r="text" inline />;
  return url ? 'Live view' : 'Not set up';
}

function UrlForm({ current, onSaved }: { current: string | null; onSaved: () => void }) {
  const [value, setValue] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => setValue(current ?? ''), [current]);
  const save = useCallback(
    async (url: string | null) => {
      setBusy(true);
      setMsg(null);
      const { error } = await supabaseClient().rpc('set_camera_stream_url', { p_url: url });
      setBusy(false);
      if (error) return setMsg(/could not find the function/i.test(error.message) ? 'The camera setting isn’t on the server yet (migration 0020).' : error.message);
      onSaved();
    },
    [onSaved],
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (v && !cameraEmbedUrl(v)) return setMsg('Use the relay’s https:// address.');
    void save(v || null);
  };
  return (
    <form className={s.block} onSubmit={submit}>
      <Field label="Stream address" htmlFor="camera-url" hint="The https address go2rtc is published at, e.g. https://…/ or https://…/stream.html?src=living. Saved for the whole household.">
        <div className={s.inlineRow}>
          <Input id="camera-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://" value={value} onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" disabled={busy || value.trim() === (current ?? '')}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Field>
      {current && (
        <div className={s.inline}>
          <Button variant="text" size="sm" disabled={busy} onClick={() => void save(null)}>
            Remove the address
          </Button>
        </div>
      )}
      {msg && (
        <p className={cx('sec', s.alert)} role="alert">
          {msg}
        </p>
      )}
    </form>
  );
}

/** "Require sign-in for the stream" (set_camera_ticket_required, migration 0023). */
function StreamLock({ canWrite, nonce, onChanged }: { canWrite: boolean; nonce: number; onChanged: () => void }) {
  const required = useCameraTicketRequired(true, nonce);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = async (v: boolean) => {
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseClient().rpc('set_camera_ticket_required', { p_required: v });
    setBusy(false);
    if (error) return setMsg(/could not find the function/i.test(error.message) ? 'The stream lock isn’t on the server yet (migration 0023).' : error.message);
    onChanged();
  };
  return (
    <Group
      label="Stream lock"
      footer={
        <>
          Without the lock, anyone who has the exact secret link can watch. With it, the Mac only serves the stream to people signed in here: this app fetches a
          12-hour pass and the Mac checks it. Turn it on only after the Mac’s ticket gate is running, otherwise the stream stops working.{' '}
          {msg && <span className="sig">{msg}</span>}
        </>
      }
    >
      <Row
        title="Require sign-in for the stream"
        sub={required === undefined ? <Skeleton w={120} h={14} r="text" inline /> : required ? 'On: the stream needs a pass from this app' : 'Off: the secret link alone is enough'}
        trailing={<Switch checked={required === true} disabled={!canWrite || busy || required === undefined} onChange={(v) => void set(v)} label={<span className="sr-only">Require sign-in for the stream</span>} />}
      />
    </Group>
  );
}

const FALLBACK_NAMES: Record<string, string> = { a: 'Cath', b: 'Erik' };

/** Today's sightings from the Mac relay, newest first: time, who, zone, how long. */
function ActivityToday() {
  const { events, error, real } = useCameraActivity();
  const { latest, dataset } = useData();
  const people = (dataset ?? latest)?.people;
  const nameOf = (id: string) => people?.find((p) => p.id === id)?.name ?? FALLBACK_NAMES[id] ?? id;
  return (
    <Group
      label="Activity today"
      footer={real ? 'Face recognition runs on the Mac, for enrolled people only. Only names and zones are sent here, never images.' : 'Sample sightings (Simulated data).'}
    >
      {events === null ? (
        <Row title={<Skeleton w={160} h={14} r="text" inline />} />
      ) : events.length === 0 ? (
        <Row title="No camera activity yet" sub={error ?? 'The Mac relay posts sightings here'} />
      ) : (
        events.map((e) => (
          <Row
            key={e.id}
            title={sightingWho(e, nameOf)}
            sub={[e.activity && e.activity[0]!.toUpperCase() + e.activity.slice(1), e.durationS != null && e.durationS >= 60 ? dur(e.durationS / 60) : e.durationS != null ? `${e.durationS}s` : null].filter(Boolean).join(' · ') || undefined}
            value={hm(e.ts)}
          />
        ))
      )}
    </Group>
  );
}

export function CameraPage() {
  useChrome({ back: { href: '/settings', label: 'System' } });
  const auth = useAuth();
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const canWrite = live && (auth.probe?.role === 'owner' || auth.probe?.role === 'member');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((x) => x + 1), []);
  const { url, error } = useCameraUrl(live, nonce);
  // Shared by the lock switch and the preview, so toggling the lock re-reads it for both.
  const [lockNonce, setLockNonce] = useState(0);
  const lockChanged = useCallback(() => setLockNonce((x) => x + 1), []);
  const { embed, error: ticketError } = useCameraEmbed(url, undefined, live, lockNonce);

  return (
    <div className={cx(s.sub, s.col, s.drill)}>
      <PageHeader title="Camera" lede="The bedroom camera, live, through the relay on the Mac at home." className={s.header} />

      {url === undefined || embed === undefined ? (
        <Skeleton h={240} r="lg" />
      ) : embed ? (
        <div className={s.camera}>
          <iframe
            className={s.cameraFrame}
            src={embed}
            title="Bedroom camera, live"
            allow="fullscreen; autoplay; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        <div className={cx('card', s.dataSummary)}>
          <Status tone="off">
            <b>No live view yet</b>
          </Status>
          <p className="sec">
            The camera only streams on the home network (RTSP). go2rtc on the Mac at home picks that stream up and publishes it at an https address;{' '}
            {canWrite ? 'paste that address below' : 'once a household member saves that address'} and the live view appears here. Until then, use the SwitchBot app.
          </p>
          {!live && <p className="sec">Sign in as a household member to see the camera.</p>}
        </div>
      )}
      {(error || ticketError) && <p className={cx('sec', s.alert)}>{error ?? ticketError}</p>}

      <div className={cx(s.inline, s.cameraLinks)}>
        {embed && (
          <a className="btn secondary" href={embed} target="_blank" rel="noopener noreferrer">
            Open full screen
          </a>
        )}
        <a className="btn secondary" href={SWITCHBOT_APP_URL} target="_blank" rel="noopener noreferrer">
          Open in SwitchBot app
        </a>
      </div>

      <ActivityToday />

      {canWrite && <UrlForm current={url ?? null} onSaved={refresh} />}

      {live && <StreamLock canWrite={canWrite} nonce={lockNonce} onChanged={lockChanged} />}

      <Group label="How it works" footer="Anyone with the address can watch the stream. Keep it private, and put the relay behind a login or a hard-to-guess path.">
        <Row title="Pan/Tilt Cam Plus 3K" sub="RTSP on the home network (Camera Account in the SwitchBot app)" />
        <Row title="go2rtc on the Mac" sub={`Reads RTSP, serves stream “${STREAM}” as MSE video`} />
        <Row title="https address" sub="The relay published outside the home network; stored for the household" value={url ? <Status tone="on">Set</Status> : <Status tone="off">Not set</Status>} />
      </Group>
    </div>
  );
}
