'use client';
/**
 * Live (/live): the bedroom camera's night sounds, plus everything needed to run the Mac behind it.
 *
 *   sounds     (default) the night listener on Erik's Mac: listening status from the newest sound_minutes row
 *              (migration 0024; "Listening" when a minute arrived < 3 min ago), Pause tonight / Resume
 *              (pause_sound_until), the last 60 minutes as loudness + snoring, and the newest moments with clip
 *              players (signed URLs from the private 'night-sounds' bucket). The Mac only listens from lights-out to
 *              the aircon's off time (wake + 30 min) and the night-sound Edge Function decides that, not this page.
 *   player     only when household_settings.live_video is true (System › Camera › Show live video, default off):
 *              go2rtc's own player in an iframe, 3K (living_hd) or Low data (living); with the stream lock on, the
 *              player URL carries a signed pass (useCameraEmbed). While it is off no ticket is fetched and no player
 *              is rendered.
 *   commands   collapsed: copyable Terminal commands for Erik's Mac (night listener, go2rtc, Tailscale Funnel).
 *   camera     collapsed: what the SwitchBot app controls (its cloud API has no commands for this model).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth.tsx';
import { hm, ictDate, MIN } from '@/lib/format.ts';
import { isListening, isPaused, nextNoon, pauseSoundUntil, useClipUrls, useRecentSounds, useSoundSettings, type SoundSettings } from '@/lib/sound.ts';
import { SoundChart } from '../charts/SoundChart.tsx';
import { useChrome, systemHref } from '../nav.tsx';
import { SoundMoments } from '../story/Sounds.tsx';
import { SWITCHBOT_APP_URL, STREAM, STREAM_HD, useCameraEmbed, useCameraUrl } from '../system/camera.tsx';
import { clock, usePlanClock } from '../system/model.ts';
import { Button, Disclosure, Group, PageHeader, Row, Segmented, Skeleton, Status } from '../ui.tsx';
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

const LISTENER = 'gui/$(id -u)/com.sleeplab.night-sound';
const LISTENER_CMDS: Cmd[] = [
  { title: 'Is it running?', sub: 'Prints state = running and a pid. It only opens the microphone feed while it should listen.', cmd: `launchctl print ${LISTENER} | grep -E 'state|pid ='` },
  { title: 'Restart the listener', cmd: `launchctl kickstart -k ${LISTENER}` },
  { title: 'Stop the listener', sub: 'Until you start it again or the Mac next logs in. Nothing is heard or sent.', cmd: `launchctl bootout ${LISTENER}` },
  { title: 'Start the listener', cmd: 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sleeplab.night-sound.plist' },
  { title: 'Live log', sub: 'Ctrl-C to stop watching.', cmd: 'tail -f ~/sleep-lab-home/logs/night-sound.log' },
];

const STREAM_CMDS: Cmd[] = [
  { title: 'Is it running?', sub: 'Prints state = running and a pid.', cmd: `launchctl print ${AGENT} | grep -E 'state|pid ='` },
  { title: 'Restart the stream', sub: 'After a camera reboot, a frozen picture, or a config change.', cmd: `launchctl kickstart -k ${AGENT}` },
  { title: 'Stop the stream', sub: 'Until you start it again or the Mac next logs in. The night listener reads it, so it stops hearing too.', cmd: `launchctl bootout ${AGENT}` },
  { title: 'Start the stream', cmd: 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sleeplab.go2rtc.plist' },
  { title: 'Live log', sub: 'Ctrl-C to stop watching.', cmd: 'tail -f ~/sleep-lab-home/logs/go2rtc.log' },
];

const LINK_CMDS: Cmd[] = [
  { title: 'Take it offline', sub: 'The public link stops answering; go2rtc keeps running at home. This is how it should be while the video is off.', cmd: `${TS} funnel --https=443 off` },
  { title: 'Check the link', sub: 'Should print “No serve config” while the video is off.', cmd: `${TS} funnel status` },
  { title: 'Bring it back online', sub: 'Only with Show live video on. Same link as before.', cmd: `${TS} funnel --bg 1984` },
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

/** Status line for the night listener: listening now, paused, off, or when it starts. */
function listenerLine(settings: SoundSettings | null | undefined, newest: number | null | undefined, plan: string, now: number): { tone: 'on' | 'off'; head: string; sub: string } {
  if (isListening(newest, now)) return { tone: 'on', head: 'Listening', sub: `Last minute ${hm(newest!)}` };
  const last = newest ? `Last heard ${hm(newest)}${now - newest > 20 * 3_600_000 ? ' (a while ago)' : ''}. ` : '';
  if (settings?.mode === 'off') return { tone: 'off', head: 'Not listening', sub: `${last}Turned off in System › Camera.` };
  if (isPaused(settings, now)) return { tone: 'off', head: 'Paused', sub: `${last}Back on ${settings!.pausedUntil! - now < 24 * 3_600_000 ? `at ${hm(settings!.pausedUntil!)}` : 'later'}.` };
  return { tone: 'off', head: 'Not listening', sub: `${last}It listens ${plan}, only when you’re home.` };
}

function NightSounds({ live, canWrite, video }: { live: boolean; canWrite: boolean; video: boolean }) {
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((x) => x + 1), []);
  const { settings, error: settingsError } = useSoundSettings(live, nonce);
  const { data, error } = useRecentSounds(live, nonce);
  const clips = useClipUrls(data?.events, live);
  const pc = usePlanClock();
  const plan = `from ${clock(pc.lightsOut - 15)} to ${clock(pc.wake + 30)}`;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const now = Date.now();
  const paused = isPaused(settings, now);
  const pauseEnd = nextNoon(now, pc.wake + 30);
  const pause = async (until: number | null) => {
    setBusy(true);
    setMsg(null);
    const e = await pauseSoundUntil(until);
    setBusy(false);
    if (e) return setMsg(e);
    refresh();
  };

  if (!live)
    return (
      <div className={cx('card', sys.dataSummary)}>
        <Status tone="off">
          <b>Night sounds</b>
        </Status>
        <p className="sec">Sign in as a household member to see what the bedroom heard at night.</p>
      </div>
    );

  const st = listenerLine(settings, data?.newest, plan, now);
  const hourFrom = Math.floor((now - 60 * MIN) / MIN) * MIN;
  return (
    <>
      <div className={cx('card', sys.dataSummary)}>
        {data === undefined || settings === undefined ? (
          <Skeleton w={180} h={18} r="text" />
        ) : (
          <>
            <Status tone={st.tone}>
              <b>{st.head}</b>
            </Status>
            <p className="sec">{st.sub}</p>
          </>
        )}
        {canWrite && settings && settings.mode === 'auto' && (
          <div className={sys.inline}>
            {paused ? (
              <Button size="sm" disabled={busy} onClick={() => void pause(null)}>
                Resume
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void pause(pauseEnd)}>
                Pause until {ictDate(pauseEnd) === ictDate(now) ? 'today' : 'tomorrow'} 12:00
              </Button>
            )}
          </div>
        )}
        {(msg || error || settingsError) && <p className={cx('sec', sys.alert)}>{msg ?? error ?? settingsError}</p>}
      </div>

      <h3 className="label">Last hour</h3>
      {data === undefined ? (
        <Skeleton h={180} r="lg" />
      ) : data.minutes.length ? (
        <SoundChart
          minutes={data.minutes}
          events={data.events}
          from={hourFrom}
          to={hourFrom + 60 * MIN}
          compact
          tickMin={15}
          label={`Loudness and snoring per minute, the last hour: ${data.minutes.length} minutes heard`}
        />
      ) : (
        <p className="sec">Nothing heard in the last hour. The Mac only listens {plan}.</p>
      )}

      <h3 className="label">Latest moments</h3>
      {data === undefined ? <Skeleton h={120} r="lg" /> : <SoundMoments events={data.events} clips={clips} max={20} empty="No moments yet. Snoring, coughs and loud noises show up here, with a short clip when one was kept." />}
      <p className={cx('cap', s.note)}>
        Sound is analysed on the Mac; only loudness, snoring and the kind of sound are sent, plus about 10 s clips of loud moments (never talking), kept 14 days.
        {!video && (
          <>
            {' '}
            The video is off: turn it back on in <a href={systemHref('camera')}>System › Camera</a> › Show live video.
          </>
        )}
      </p>
    </>
  );
}

function Player({ live }: { live: boolean }) {
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
  // With the stream lock on (System › Camera), the address carries a signed pass, fetched again for a new quality.
  const { embed, error: ticketError } = useCameraEmbed(url, quality === 'hd' ? STREAM_HD : STREAM, live);

  return (
    <>
      <div className={s.playerHead}>
        <h3 className="label">Live video</h3>
        <Segmented<Quality>
          label="Picture"
          value={quality}
          onChange={choose}
          options={[
            { value: 'hd', label: '3K' },
            { value: 'sd', label: 'Low data' },
          ]}
        />
      </div>
      {url === undefined || embed === undefined ? (
        <Skeleton h={320} r="lg" />
      ) : embed ? (
        <div className={sys.camera}>
          <iframe
            key={embed}
            className={sys.cameraFrame}
            src={embed}
            title="Bedroom camera, live"
            allow="fullscreen; autoplay; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        <div className={cx('card', sys.dataSummary)}>
          <Status tone="off">
            <b>No live view</b>
          </Status>
          <p className="sec">
            {url ? (
              'The stream is locked to signed-in members and this app couldn’t get a pass for it.'
            ) : (
              <>
                The stream address isn’t saved. Paste it in <a href={systemHref('camera')}>System › Camera</a>.
              </>
            )}
          </p>
        </div>
      )}
      {(error || ticketError) && <p className={cx('sec', sys.alert)}>{error ?? ticketError}</p>}
      <div className={cx(sys.inline, sys.cameraLinks)}>
        {embed && (
          <a className="btn secondary" href={embed} target="_blank" rel="noopener noreferrer">
            Open full screen
          </a>
        )}
      </div>
      <p className={cx('cap', s.note)}>
        3K is 2592 × 1620 at 15 frames a second, about 4 Mbit/s. Low data is 640 × 400, about 0.25 Mbit/s. It needs the Tailscale Funnel on (see the commands
        below). Turn the video off again in <a href={systemHref('camera')}>System › Camera</a>.
      </p>
    </>
  );
}

export function LiveScreen() {
  useChrome({ title: 'Live' });
  const auth = useAuth();
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const canWrite = live && (auth.probe?.role === 'owner' || auth.probe?.role === 'member');
  const { settings } = useSoundSettings(live);
  // The video player (and its ticket fetch) only exists while live_video is on; default off.
  const video = live && settings?.liveVideo === true;

  return (
    <div className={cx('content', s.page)}>
      <PageHeader
        title="Live"
        lede={video ? 'Night sounds from the bedroom, and the live video.' : 'Night sounds from the bedroom, heard by the camera and analysed on Erik’s Mac. The video is off.'}
      />

      <div className={s.stack}>
        <NightSounds live={live} canWrite={canWrite} video={video} />
        {video && <Player live={live} />}
      </div>

      <div className={cx(sys.inline, sys.cameraLinks)}>
        <a className="btn secondary" href={SWITCHBOT_APP_URL} target="_blank" rel="noopener noreferrer">
          Open in SwitchBot app
        </a>
      </div>

      <div className={s.more}>
        <Disclosure title="Commands for Erik’s Mac" count="Terminal">
          <div className={s.cols}>
            <div>
              <CmdGroup
                label="Night listener"
                footer="Asks the server every minute whether to listen; only then reads the camera’s sound. Starts by itself when the Mac logs in."
                cmds={LISTENER_CMDS}
              />
              <CmdGroup
                label="Stream on the Mac"
                footer="go2rtc reads the camera on the home network. The night listener gets the sound from it, so keep it running."
                cmds={STREAM_CMDS}
              />
            </div>
            <div>
              <CmdGroup
                label="Public link"
                footer="Tailscale Funnel publishes the video at a secret https address. Keep it off while the video is off, so nothing leaves the house."
                cmds={LINK_CMDS}
              />
            </div>
          </div>
        </Disclosure>
        <Disclosure title="Camera controls and how it works">
          <div className={s.cols}>
            <div>
              <Group label="Camera controls" footer="In the SwitchBot app: tap the camera, then use the controls under the live view.">
                <Row title="Pan and tilt" sub="Drag the live view, or use the arrow pad. 360° pan with end stops, 115° tilt." />
                <Row title="Presets" sub="Up to 6 saved positions; tap one to move there." />
                <Row title="Privacy mode" sub="The lens turns into the body. The microphone may stay on; check in the SwitchBot app." />
                <Row title="Night vision" sub="Auto, on or off. Invisible 940 nm infrared." />
                <Row title="Motion tracking" sub="Off keeps the camera still, facing the wall." />
              </Group>
            </div>
            <div>
              <Group label="How it works">
                <Row title="Camera" sub="On the bedside table, facing the wall. RTSP on the home network, with sound" />
                <Row title="go2rtc on Erik’s Mac" sub="Reads the camera at home; nothing is published while the Funnel is off" />
                <Row title="Night listener on the Mac" sub="Only from lights-out to the aircon’s off time. Classifies sound on the Mac and sends minute summaries" />
                <Row title="Video" value={video ? <Status tone="on">On</Status> : <Status tone="off">Off</Status>} />
              </Group>
            </div>
          </div>
        </Disclosure>
      </div>
    </div>
  );
}
