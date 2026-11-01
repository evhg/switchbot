'use client';
/**
 * Live (/live): the living-room camera, live, plus everything needed to run the relay behind it.
 *
 *   player     go2rtc's own player in an iframe: 3K (stream living_hd, the main stream transcoded to H.264 on the Mac)
 *              or Low data (living, the 640×400 sub-stream). The address comes from household_settings.camera_stream_url
 *              (members only, never in this public repo); the choice is remembered per browser.
 *   commands   copyable Terminal commands for Erik's Mac: the go2rtc LaunchAgent, the Tailscale Funnel that publishes
 *              it, the camera login, and a new secret link. Nothing here can reach the Mac by itself.
 *   camera     what the SwitchBot app controls (pan/tilt, presets, patrol, privacy, night vision): its cloud API has no
 *              commands for this model, and ONVIF on the camera doesn't list the app's presets.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth.tsx';
import { useChrome, systemHref } from '../nav.tsx';
import { SWITCHBOT_APP_URL, STREAM, STREAM_HD, cameraEmbedUrl, useCameraUrl } from '../system/camera.tsx';
import { Group, PageHeader, Row, Segmented, Skeleton, Status } from '../ui.tsx';
import sys from '../system/system.module.css';
import s from './live.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
const PREF = 'sleeplab.live.stream';
type Quality = 'hd' | 'sd';

const TS = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const AGENT = 'gui/$(id -u)/com.sleeplab.go2rtc';

interface Cmd {
  title: string;
  sub?: ReactNode;
  cmd: string;
}

const STREAM_CMDS: Cmd[] = [
  { title: 'Is it running?', sub: 'Prints state = running and a pid.', cmd: `launchctl print ${AGENT} | grep -E 'state|pid ='` },
  { title: 'Restart the stream', sub: 'After a camera reboot, a frozen picture, or a config change.', cmd: `launchctl kickstart -k ${AGENT}` },
  { title: 'Stop the stream', sub: 'Until you start it again or the Mac next logs in. This page goes dark.', cmd: `launchctl bootout ${AGENT}` },
  { title: 'Start the stream', cmd: 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sleeplab.go2rtc.plist' },
  { title: 'Live log', sub: 'Ctrl-C to stop watching.', cmd: 'tail -f ~/sleep-lab-home/logs/go2rtc.log' },
];

const LINK_CMDS: Cmd[] = [
  { title: 'Take it offline', sub: 'The public link stops answering; go2rtc keeps running at home.', cmd: `${TS} funnel --https=443 off` },
  { title: 'Bring it back online', sub: 'Same link as before.', cmd: `${TS} funnel --bg 1984` },
  { title: 'Check the link', cmd: `${TS} funnel status` },
  {
    title: 'New secret link',
    sub: (
      <>
        Retires the current link everywhere. Paste the new one in <a href={systemHref('camera')}>System › Camera</a>.
      </>
    ),
    cmd: '~/sleep-lab-home/rotate-link.sh',
  },
  { title: 'Camera login changed', sub: 'Asks for the Camera Account username and password, then restart the stream.', cmd: '~/sleep-lab-home/make-config.sh' },
];

function CopyCmd({ cmd }: { cmd: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(id);
  }, [done]);
  const copy = () => {
    navigator.clipboard?.writeText(cmd).then(
      () => setDone(true),
      () => {},
    );
  };
  return (
    <div className={s.cmd}>
      <code className={cx('code', s.cmdText)}>{cmd}</code>
      <button type="button" className="btn text sm" onClick={copy} aria-label="Copy command">
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function CmdGroup({ label, footer, cmds }: { label: string; footer?: ReactNode; cmds: Cmd[] }) {
  return (
    <Group label={label} footer={footer}>
      {cmds.map((c) => (
        <li key={c.title} className={s.cmdRow}>
          <b className={s.cmdTitle}>{c.title}</b>
          {c.sub && <span className={cx('sec', s.cmdSub)}>{c.sub}</span>}
          <CopyCmd cmd={c.cmd} />
        </li>
      ))}
    </Group>
  );
}

export function LiveScreen() {
  useChrome({ title: 'Live' });
  const auth = useAuth();
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const { url, error } = useCameraUrl(live);
  const [quality, setQuality] = useState<Quality>('hd');
  useEffect(() => {
    try {
      if (window.localStorage.getItem(PREF) === 'sd') setQuality('sd');
    } catch {
      /* storage unavailable */
    }
  }, []);
  const choose = (q: Quality) => {
    setQuality(q);
    try {
      window.localStorage.setItem(PREF, q);
    } catch {
      /* ignore */
    }
  };
  const embed = cameraEmbedUrl(url, quality === 'hd' ? STREAM_HD : STREAM);

  return (
    <div className={cx('content', s.page)}>
      <PageHeader
        title="Live"
        lede="The living room, live from the Pan/Tilt Cam, through the relay on Erik’s Mac."
        actions={
          <Segmented<Quality>
            label="Picture"
            value={quality}
            onChange={choose}
            options={[
              { value: 'hd', label: '3K' },
              { value: 'sd', label: 'Low data' },
            ]}
          />
        }
      />

      {url === undefined ? (
        <Skeleton h={320} r="lg" />
      ) : embed ? (
        <div className={sys.camera}>
          <iframe
            key={embed}
            className={sys.cameraFrame}
            src={embed}
            title="Living room camera, live"
            allow="fullscreen; autoplay; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        <div className={cx('card', sys.dataSummary)}>
          <Status tone="off">
            <b>No live view yet</b>
          </Status>
          <p className="sec">
            The stream address isn’t saved yet. Paste it in <a href={systemHref('camera')}>System › Camera</a>.
          </p>
        </div>
      )}
      {error && <p className={cx('sec', sys.alert)}>{error}</p>}

      <div className={cx(sys.inline, sys.cameraLinks)}>
        {embed && (
          <a className="btn secondary" href={embed} target="_blank" rel="noopener noreferrer">
            Open full screen
          </a>
        )}
        <a className="btn secondary" href={SWITCHBOT_APP_URL} target="_blank" rel="noopener noreferrer">
          Open in SwitchBot app
        </a>
      </div>
      <p className={cx('cap', s.note)}>
        3K is 2592 × 1620 at 15 frames a second, about 4 Mbit/s. Low data is 640 × 400, about 0.25 Mbit/s. The picture is a few seconds behind. If it stays black, the Mac is
        asleep, its lid is closed, or the stream is stopped.
      </p>

      <div className={s.cols}>
        <div>
          <CmdGroup
            label="Stream on the Mac"
            footer="Run these in Terminal on Erik’s Mac. The stream starts by itself when the Mac logs in, and comes back by itself if it crashes."
            cmds={STREAM_CMDS}
          />
          <CmdGroup
            label="Public link"
            footer="Tailscale Funnel publishes the stream at a secret https address. Anyone who has the full address can watch, so share it only through this app."
            cmds={LINK_CMDS}
          />
        </div>
        <div>
          <Group label="Camera controls" footer="In the SwitchBot app: tap the camera, then use the controls under the live view. These settings also apply to this page’s picture.">
            <Row title="Pan and tilt" sub="Drag the live view, or use the arrow pad. 360° pan with end stops, 115° tilt." />
            <Row title="Presets" sub="Up to 6 saved positions; tap one to move there. Separate from Preset Points." />
            <Row title="Preset Points" sub="Up to 4. Only these can be used in SwitchBot scenes and automations, e.g. ‘bed at 22:00’." />
            <Row title="Patrol" sub="Cycles through the presets on a timer." />
            <Row title="Privacy mode" sub="The lens turns into the body: this page shows nothing until it’s off again." />
            <Row title="Night vision" sub="Auto, on or off. Invisible 940 nm infrared; black and white in the dark." />
            <Row title="Motion tracking" sub="Follows movement. Off keeps the view still for this page." />
          </Group>
          <Group label="How it works">
            <Row title="Camera" sub="RTSP on the home network: 3K main stream (H.265) and 640 × 400 sub-stream" />
            <Row title="go2rtc on Erik’s Mac" sub="Reads both, turns 3K into H.264 only while someone watches" />
            <Row title="Tailscale Funnel" sub="Outbound only, so it works behind the CGNAT. HTTPS on a secret path" value={url ? <Status tone="on">Set</Status> : <Status tone="off">Not set</Status>} />
          </Group>
        </div>
      </div>
    </div>
  );
}
