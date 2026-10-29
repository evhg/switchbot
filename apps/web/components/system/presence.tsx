'use client';
/**
 * Tonight and presence (decided 2026-10-29): bedtime 22:00 every day, asleep by ~23:00 and wake 08:30 (both
 * editable; the warming step comes 4 h 30 after falling asleep), and the 21:30 pre-cool only when
 * someone is home. `TonightBlock` sits on top of System › Tonight's plan; `PresencePage` (System › Presence) explains the
 * iPhone Shortcuts setup and creates/rotates each person's token. Data and rules: lib/tonight.ts.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_PEOPLE } from '@sleep-lab/core';
import { useAuth } from '@/lib/auth.tsx';
import { useData } from '@/lib/data/context.tsx';
import { supabaseConfigured } from '@/lib/data/supabase.ts';
import { dayLabel, hm, MIN } from '@/lib/format.ts';
import { hhmm, onsetAfterLightsOut, parseHhmm, presenceUrl, rotatePresenceToken, usePresenceTokens, validSleepOnset, type Override, type Tonight } from '@/lib/tonight.ts';
import { systemHref, useChrome } from '../nav.tsx';
import { Button, Group, PageHeader, Row, Segmented, Skeleton, Status } from '../ui.tsx';
import s from './system.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

const STATE_LABEL = { home: 'Home', away: 'Away', unknown: 'Unknown' } as const;
type Choice = 'auto' | 'home' | 'away';
const CHOICES: readonly { value: Choice; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'home', label: 'Home tonight' },
  { value: 'away', label: 'Away tonight' },
];

/** Tonight's schedule, who is home and what the pre-cool will do. */
export function TonightBlock({ t }: { t: Tonight }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [wakeText, setWakeText] = useState(hhmm(t.wakeMin));
  useEffect(() => setWakeText(hhmm(t.wakeMin)), [t.wakeMin]);
  const [onsetText, setOnsetText] = useState(hhmm(t.sleepOnsetMin));
  useEffect(() => setOnsetText(hhmm(t.sleepOnsetMin)), [t.sleepOnsetMin]);
  const ready = t.date !== null;
  const run = (p: Promise<string | null>) => p.then((e) => setMsg(e));
  const commitWake = () => {
    const m = parseHhmm(wakeText);
    if (m === null || m >= 12 * 60 || m < 3 * 60) {
      setMsg('Wake must be between 03:00 and 11:59.');
      setWakeText(hhmm(t.wakeMin));
      return;
    }
    if (m !== t.wakeMin) run(t.setWake(m));
  };
  const commitOnset = () => {
    const m = parseHhmm(onsetText);
    if (m === null || !validSleepOnset(t.lightsOutMin, m)) {
      setMsg(`Asleep by must be between ${hhmm(t.lightsOutMin)} and ${hhmm(t.lightsOutMin + 180)}.`);
      setOnsetText(hhmm(t.sleepOnsetMin));
      return;
    }
    if (m !== t.sleepOnsetMin) run(t.setSleepOnset(m));
  };
  const choice: Choice = t.override ?? 'auto';
  const offAt = hhmm(t.wakeMin + 30);
  const warmAt = hhmm(t.lightsOutMin + onsetAfterLightsOut(t.lightsOutMin, t.sleepOnsetMin) + 270);
  const locked = !ready || (t.live && !t.canWrite);

  return (
    <section aria-label="Tonight">
      <Group
        label={ready ? `Tonight · night ending ${dayLabel(t.date!)}` : 'Tonight'}
        footer={
          <>
            {t.live ? 'Saved for the household; the aircon controller reads it every 5 minutes.' : 'Stored on this device. Sign in to share it with the aircon controller.'}{' '}
            {msg && <span className="sig">{msg}</span>}
          </>
        }
      >
        <Row title="Lights out" value={<span className="num">{hhmm(t.lightsOutMin)} · every day</span>} />
        <li>
          <div className="list-row">
            <label className="list-row-t" htmlFor="onset-time">
              <b>Asleep by</b>
              <span>Usually an hour after lights out. The one warming step comes 4&nbsp;h&nbsp;30 later, at {warmAt}</span>
            </label>
            <input
              id="onset-time"
              className={cx('input num', s.time)}
              type="time"
              step={300}
              value={onsetText}
              disabled={locked}
              onChange={(e) => setOnsetText(e.target.value)}
              onBlur={commitOnset}
              onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            />
          </div>
        </li>
        <li>
          <div className="list-row">
            <label className="list-row-t" htmlFor="wake-time">
              <b>Wake</b>
              <span>Aircon off 30 min later, at {offAt}</span>
            </label>
            <input
              id="wake-time"
              className={cx('input num', s.time)}
              type="time"
              step={300}
              value={wakeText}
              disabled={locked}
              onChange={(e) => setWakeText(e.target.value)}
              onBlur={commitWake}
              onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            />
          </div>
        </li>
        <Row
          title="At home"
          sub={ready ? t.status.text : <Skeleton w={160} h={14} r="text" inline />}
          value={<Status tone={t.status.state === 'home' ? 'on' : 'off'}>{STATE_LABEL[t.status.state]}</Status>}
        />
        <li className={s.segLi}>
          <Segmented<Choice>
            label="Tonight"
            value={choice}
            options={CHOICES}
            block
            onChange={(v) => run(t.setOverride(v === 'auto' ? null : (v as Override)))}
          />
        </li>
        <Row title="Pre-cool" sub={t.precool.text || <Skeleton w={200} h={14} r="text" inline />} value={<Status tone={t.precool.tone}>{t.precool.tone === 'on' ? 'On' : t.precool.tone === 'alert' ? 'Waiting' : 'Off'}</Status>} />
        {t.co2Hint && (
          <li>
            <div className={cx('list-row', s.hint)}>
              <span className="list-row-t">
                <b>Looks like you’re home. Start pre-cool?</b>
                <span>
                  Bedroom CO₂ rose {t.co2Hint.rise} ppm in the last hour (now {t.co2Hint.ppm} ppm). A hint only: the aircon starts when someone is marked home.
                </span>
              </span>
              <Button size="sm" variant="primary" onClick={() => run(t.setOverride('home'))}>
                Home tonight
              </Button>
            </div>
          </li>
        )}
        <Row title="Presence on your iPhones" sub="Arrive / leave home automations" href={systemHref('presence')} />
      </Group>
    </section>
  );
}

// ───────────────────────────────────────── System › Presence ─────────────────────────────────────────

function CopyField({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className={s.copy}>
      <span className="label">{label}</span>
      <div className={s.copyRow}>
        <code className={cx('code', s.copyVal)}>{value}</code>
        <Button
          size="sm"
          onClick={() =>
            navigator.clipboard
              ?.writeText(value)
              .then(() => {
                setDone(true);
                window.setTimeout(() => setDone(false), 1500);
              })
              .catch(() => {})
          }
        >
          {done ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function Steps({ items }: { items: readonly ReactNode[] }) {
  return (
    <ol className={s.howto}>
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ol>
  );
}

export function PresencePage() {
  useChrome({ back: { href: '/settings', label: 'System' } });
  const { dataset, latest } = useData();
  const auth = useAuth();
  const people = (dataset ?? latest)?.people ?? DEFAULT_PEOPLE;
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const canWrite = live && (auth.probe?.role === 'owner' || auth.probe?.role === 'member');
  // Same rule as rotate_presence_token (migration 0010): your own phone's token, or any as the household owner.
  const mayRotate = (personId: string) => canWrite && (auth.probe?.role === 'owner' || auth.probe?.personId === personId);
  const { tokens, error, refresh } = usePresenceTokens(live);
  const [shown, setShown] = useState<{ personId: string; token: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const url = supabaseConfigured() ? presenceUrl() : 'https://<project>.supabase.co/functions/v1/presence';

  const rotate = async (personId: string) => {
    setBusy(personId);
    setMsg(null);
    const r = await rotatePresenceToken(personId);
    setBusy(null);
    if ('error' in r) return setMsg(r.error);
    setShown({ personId, token: r.token });
    refresh();
  };

  return (
    <div className={cx(s.sub, s.col, s.drill)}>
      <PageHeader
        title="Presence"
        lede="Each iPhone tells the app when its owner arrives home or leaves. The 21:30 pre-cool only runs when someone is home, so the aircon doesn’t cool an empty room."
        className={s.header}
      />

      <Group label="How it decides" footer="Your location never leaves the phone: the app only receives “home” or “away” and the time.">
        <Row title="Someone’s latest signal is “home”" value="Pre-cool at 21:30" />
        <Row title="Everyone is away" sub="Starts later if someone arrives before 01:00" value="Waits" />
        <Row title="No signal from anyone yet" value="No pre-cool" />
        <Row title="Latest “home” is older than 48 h" sub="A missed “leave” must not cool every night. Counts again with rising bedroom CO₂" value="Waits" />
        <Row title="Pre-cool started by a phone signal" sub="A notification lets you switch to “Away tonight”" value="Notifies" />
        <Row title="“Home tonight” / “Away tonight”" sub="One tap in Tonight’s plan, wins over the phones" value="Override" />
      </Group>

      {people.map((p) => {
        const tok = tokens?.find((x) => x.personId === p.id);
        const fresh = shown?.personId === p.id ? shown.token : null;
        return (
          <Group
            key={p.id}
            label={p.name.trim().toLowerCase() === 'you' ? 'Your iPhone' : `${p.name}’s iPhone`}
            footer={
              fresh
                ? 'Shown once. Paste it into the Shortcut now; after you leave this page only a fingerprint of it is kept. Rotating makes a new token and the old one stops working.'
                : undefined
            }
          >
            <Row
              title="Token"
              sub={
                !live
                  ? auth.status === 'loading'
                    ? 'Checking sign-in…'
                    : 'Sign in as a household member to create one'
                  : tokens === null
                    ? 'Loading…'
                    : tok
                      ? `Created ${dayLabel(new Date(tok.createdAt + 7 * 60 * MIN).toISOString().slice(0, 10))} · ${tok.lastUsedAt ? `last signal ${hm(tok.lastUsedAt)}` : 'no signal yet'}`
                      : 'Not created yet'
              }
              value={<Status tone={tok?.lastUsedAt ? 'on' : 'off'}>{tok ? (tok.lastUsedAt ? 'Working' : 'Waiting') : 'Not set up'}</Status>}
            />
            {fresh && (
              <li className={s.reveal}>
                <CopyField label="URL" value={url} />
                <CopyField label="Header X-Presence-Token" value={fresh} />
              </li>
            )}
            <li className={s.btnLi}>
              <Button variant={tok ? 'secondary' : 'primary'} disabled={!mayRotate(p.id) || busy !== null} onClick={() => rotate(p.id)}>
                {busy === p.id ? 'Creating…' : tok ? 'Rotate token' : 'Create token'}
              </Button>
              {canWrite && !mayRotate(p.id) && <span className="cap"> Only {p.name} or the household owner can change this token.</span>}
            </li>
          </Group>
        );
      })}
      {(msg || error) && <p className={cx('sec', s.alert)}>{msg ?? error}</p>}

      <Group label="Set up on each iPhone (about 3 minutes)">
        <li className={s.bare}>
          <div className={s.howtoBox}>
            <p className="sec">Each person does this on their own phone, with their own token. Two automations: one for arriving, one for leaving.</p>
            <h3 className={s.howtoH}>1 · When I arrive home</h3>
            <Steps
              items={[
                <>Open <b>Shortcuts</b> › <b>Automation</b> › <b>+</b> › <b>Personal Automation</b> (on iOS 17+: <b>New Automation</b>).</>,
                <>Choose <b>Arrive</b>, set <b>Location</b> to your home, and pick <b>Run Immediately</b> (turn off “Notify When Run”).</>,
                <>Add the action <b>Get Contents of URL</b>. URL: <span className="code">{url}</span></>,
                <>Tap ›, set <b>Method</b> to <b>POST</b>. Under <b>Headers</b> add <span className="code">Content-Type</span> = <span className="code">application/json</span> and <span className="code">X-Presence-Token</span> = your token.</>,
                <>Set <b>Request Body</b> to <b>JSON</b> and add a text field <span className="code">state</span> = <span className="code">home</span>. Tap <b>Done</b>.</>,
              ]}
            />
            <h3 className={s.howtoH}>2 · When I leave home</h3>
            <Steps
              items={[
                <>Same again with <b>Leave</b> instead of Arrive, <b>Run Immediately</b>.</>,
                <>Same URL and headers; body <span className="code">state</span> = <span className="code">away</span>.</>,
              ]}
            />
            <h3 className={s.howtoH}>3 · Check it</h3>
            <Steps
              items={[
                <>In the automation, tap the play button once. The token row above turns to <b>Working</b> and Tonight’s plan shows you as home.</>,
                <>Location Services must be on for Shortcuts (Settings › Privacy › Location Services › Shortcuts › While Using).</>,
              ]}
            />
          </div>
        </li>
      </Group>
      <p className="cap">Lost phone or shared the token by mistake? Rotate it here: the old token stops working at once.</p>
    </div>
  );
}

/** System root value: how many people send presence. */
export function usePresenceSummary(): ReactNode {
  const auth = useAuth();
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const { tokens } = usePresenceTokens(live);
  if (!live) return 'Not set up';
  if (tokens === null) return <Skeleton w={52} h={14} r="text" inline />;
  const working = tokens.filter((t) => t.lastUsedAt).length;
  return tokens.length ? `${working} of ${tokens.length} phones` : 'Not set up';
}
