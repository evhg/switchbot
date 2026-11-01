'use client';
/**
 * System › Camera (/settings/camera): the bedroom camera's live view.
 *
 * The Pan/Tilt Cam's RTSP feed is relayed by go2rtc on the Mac at home and published at an https address; that
 * address is household_settings.camera_stream_url (migration 0020, set with set_camera_stream_url). The page embeds
 * go2rtc's own player (stream.html?src=living&mode=mse,hls) in an iframe. No address yet: an empty state explaining the
 * relay. Either way, "Open in SwitchBot app" is the fallback (an App Store link; the app has no documented deep link).
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth.tsx';
import { supabaseClient } from '@/lib/data/supabase.ts';
import { useChrome } from '../nav.tsx';
import { Button, Field, Group, Input, PageHeader, Row, Skeleton, Status } from '../ui.tsx';
import s from './system.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export const SWITCHBOT_APP_URL = 'https://apps.apple.com/app/switchbot/id1087374760';
/** go2rtc stream name of the bedroom camera on the Mac relay. */
const STREAM = 'living';

/**
 * The player URL for a stored address: an https go2rtc base ("https://host/" or ".../stream.html") becomes
 * stream.html?src=living&mode=mse,hls (HLS for iPhones without MSE); a src or mode already in the address is kept.
 * Null for anything else.
 */
export function cameraEmbedUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (!/\/stream\.html$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, '')}/stream.html`;
  if (!u.searchParams.has('src')) u.searchParams.set('src', STREAM);
  if (!u.searchParams.has('mode')) u.searchParams.set('mode', 'mse,hls');
  return u.toString();
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

export function CameraPage() {
  useChrome({ back: { href: '/settings', label: 'System' } });
  const auth = useAuth();
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const canWrite = live && (auth.probe?.role === 'owner' || auth.probe?.role === 'member');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((x) => x + 1), []);
  const { url, error } = useCameraUrl(live, nonce);
  const embed = cameraEmbedUrl(url);

  return (
    <div className={cx(s.sub, s.col, s.drill)}>
      <PageHeader title="Camera" lede="The bedroom camera, live, through the relay on the Mac at home." className={s.header} />

      {url === undefined ? (
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
      {error && <p className={cx('sec', s.alert)}>{error}</p>}

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

      {canWrite && <UrlForm current={url ?? null} onSaved={refresh} />}

      <Group label="How it works" footer="Anyone with the address can watch the stream. Keep it private, and put the relay behind a login or a hard-to-guess path.">
        <Row title="Pan/Tilt Cam Plus 3K" sub="RTSP on the home network (Camera Account in the SwitchBot app)" />
        <Row title="go2rtc on the Mac" sub={`Reads RTSP, serves stream “${STREAM}” as MSE video`} />
        <Row title="https address" sub="The relay published outside the home network; stored for the household" value={url ? <Status tone="on">Set</Status> : <Status tone="off">Not set</Status>} />
      </Group>
    </div>
  );
}
