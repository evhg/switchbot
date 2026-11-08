'use client';
/**
 * Tonight and presence (decided 2026-10-29, 2026-10-30): bedtime 22:00 every day, asleep by ~23:00 and wake 08:30
 * (both editable), and the pre-cool (its start comes from tonight's curve) when the household is home: home by default,
 * except away dates (e.g. Bangkok), "Away tonight", or the reporting phones saying "away". Whose phones report is
 * household_settings.presence_people (migration 0031; {b}: Erik's phone decides for both, Cath follows it).
 * `TonightBlock` sits on top of System › Tonight's plan with the live / dry-run switch and the away dates;
 * `PresencePage` (System › Presence) explains how it decides, points to OwnTracks (System › Location) as the setup,
 * keeps the old iOS Shortcuts automations as a collapsed alternative, and creates/rotates each reporting person's
 * token, plus per-device tokens under "Other devices" (lib/device-tokens.ts, migration 0028). Data and rules:
 * lib/tonight.ts.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_PEOPLE } from '@sleep-lab/core';
import { useAuth } from '@/lib/auth.tsx';
import { useData } from '@/lib/data/context.tsx';
import { supabaseConfigured } from '@/lib/data/supabase.ts';
import { dayLabel, hm, MIN } from '@/lib/format.ts';
import { awayLabel, hhmm, parseHhmm, presenceUrl, rotatePresenceToken, usePresenceTokens, validSleepOnset, type Override, type Tonight } from '@/lib/tonight.ts';
import { useBandSync } from '@/lib/bands.ts';
import { FALLBACK_NAMES, leaderOf, phonesLabel, reportsSelf, useLocationSettings } from '@/lib/location.ts';
import {
  createDeviceToken,
  DEFAULT_DEVICE_LABEL,
  DEVICE_KINDS,
  deviceStatus,
  macInstruction,
  MAX_DEVICE_LABEL,
  revokeDeviceToken,
  SAMPLE_DEVICE_TOKENS,
  useDeviceTokens,
  type DeviceKind,
  type DeviceToken,
} from '@/lib/device-tokens.ts';
import { systemHref, useChrome } from '../nav.tsx';
import { Button, Disclosure, Group, Input, PageHeader, Row, Segmented, Skeleton, Status, Switch } from '../ui.tsx';
import { ago, BandPresenceGroup } from './bands.tsx';
import s from './system.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** A person's display name ("You" in the dataset falls back to Cath / Erik). */
const displayName = (people: readonly { id: string; name: string }[], id: string) => {
  const n = people.find((p) => p.id === id)?.name?.trim();
  return n && n.toLowerCase() !== 'you' ? n : (FALLBACK_NAMES[id] ?? id);
};

/** household_settings.presence_people with names: who reports, who follows, "Erik’s phone". */
function usePresenceSetup(live: boolean, people: readonly { id: string; name: string }[]) {
  const { settings } = useLocationSettings(live);
  const pp = live ? (settings?.presencePeople ?? null) : null;
  const nameOf = (id: string) => displayName(people, id);
  const followers = pp ? people.filter((p) => !reportsSelf(p.id, pp)) : [];
  return {
    pp,
    nameOf,
    /** Some people follow others' phones (presence_people set and not everyone). */
    limited: followers.length > 0,
    followers,
    phones: pp ? phonesLabel(pp, nameOf) : 'the phones',
    follows: (id: string) => leaderOf(id, pp),
  };
}

const STATE_LABEL = { home: 'Home', away: 'Away', unknown: 'Unknown' } as const;
type Choice = 'auto' | 'home' | 'away';
const CHOICES: readonly { value: Choice; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'home', label: 'Home tonight' },
  { value: 'away', label: 'Away tonight' },
];

/**
 * Tonight's schedule, who is home and what the pre-cool will do. `asleepNote`: what the plan does while you sleep
 * (from the plan page's schedule), under "Asleep by".
 */
export function TonightBlock({ t, asleepNote }: { t: Tonight; asleepNote?: string }) {
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
  const locked = !ready || (t.live && !t.canWrite);
  const writable = t.live && t.canWrite;
  const { dataset, latest } = useData();
  const ps = usePresenceSetup(t.live, (dataset ?? latest)?.people ?? DEFAULT_PEOPLE);

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
              <span>Usually an hour after lights out.{asleepNote ? ` ${asleepNote}` : ''}</span>
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
        <Row
          title="Home by default"
          sub={
            t.defaultPresence === 'home'
              ? `Pre-cool every night unless away dates, “Away tonight” or ${ps.limited ? `${ps.phones} says` : 'every phone says'} away`
              : `Pre-cool only after ${ps.limited ? ps.phones : 'a phone'} says home, or “Home tonight”`
          }
          trailing={<Switch checked={t.defaultPresence === 'home'} disabled={!writable} onChange={(v) => run(t.setDefaultPresence(v ? 'home' : 'unknown'))} label={<span className="sr-only">Home by default</span>} />}
        />
        <Row
          title="Aircon control"
          sub={
            t.acLive === null
              ? t.live
                ? 'Loading…'
                : 'Sign in to see whether the aircon is controlled live'
              : t.acLive
                ? 'Live: the controller sends the commands to the aircon (it beeps)'
                : 'Dry-run: the controller only logs what it would send'
          }
          value={t.acLive === null ? undefined : <Status tone={t.acLive ? 'on' : 'off'}>{t.acLive ? 'Live' : 'Dry-run'}</Status>}
          trailing={<Switch checked={t.acLive === true} disabled={!writable || t.acLive === null} onChange={(v) => run(t.setAcLive(v))} label={<span className="sr-only">Aircon control live</span>} />}
        />
        <Row
          title="Presence"
          sub={ps.limited ? `${ps.phones} (OwnTracks) decides home / away for you both` : 'Who is home, from OwnTracks on the iPhones'}
          href={systemHref('presence')}
        />
      </Group>
      <AwayDates t={t} onMsg={setMsg} />
    </section>
  );
}

const todayIct = () => new Date(Date.now() + 7 * 60 * MIN).toISOString().slice(0, 10);

/** Away dates (public.away_periods): evenings nobody sleeps at home; the aircon stays off those nights. */
export function AwayDates({ t, onMsg }: { t: Tonight; onMsg?: (m: string | null) => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsgLocal] = useState<string | null>(null);
  const say = (m: string | null) => (onMsg ? onMsg(m) : setMsgLocal(m));
  const writable = t.live && t.canWrite;
  const add = async () => {
    setBusy(true);
    const e = await t.addAway(from, to || from, note);
    setBusy(false);
    say(e);
    if (!e) {
      setFrom('');
      setTo('');
      setNote('');
    }
  };
  return (
    <Group
      label="Away dates"
      footer={
        <>
          Evenings nobody sleeps at home: no pre-cool and the aircon stays off those nights. Home again the next evening. Trips you are both on in Google Calendar appear here by themselves.{' '}
          {!onMsg && msg && <span className="sig">{msg}</span>}
        </>
      }
    >
      {!t.live ? (
        <Row title="Sign in as a household member to plan away dates" />
      ) : t.awayPeriods.length === 0 ? (
        <Row title="No trips planned" sub="Home every night" />
      ) : (
        t.awayPeriods.map((p) => (
          <Row
            key={p.id}
            title={p.note || 'Away'}
            sub={`${awayLabel({ ...p, note: null })}${p.source === 'calendar' ? ' · from calendar' : ''}`}
            value={t.awayTonight?.id === p.id ? <Status tone="off">Tonight</Status> : undefined}
            trailing={
              <Button size="sm" variant="text" disabled={!writable} onClick={() => t.removeAway(p.id).then(say)}>
                Remove
              </Button>
            }
          />
        ))
      )}
      {writable && (
        <li>
          <div className={cx('list-row', s.awayForm)}>
            <label className={s.awayField}>
              <span className="cap">First evening away</span>
              <Input type="date" className="num" min={todayIct()} value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className={s.awayField}>
              <span className="cap">Last evening away</span>
              <Input type="date" className="num" min={from || todayIct()} value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <label className={s.awayField}>
              <span className="cap">Note</span>
              <Input type="text" maxLength={60} placeholder="Trip" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <Button size="sm" variant="primary" disabled={busy || !from} onClick={add}>
              {busy ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </li>
      )}
    </Group>
  );
}

// ───────────────────────────────────────── System › Presence ─────────────────────────────────────────

export function CopyField({ label, value }: { label: string; value: string }) {
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

export function Steps({ items }: { items: readonly ReactNode[] }) {
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
  const { bands } = useBandSync(live);
  const [shown, setShown] = useState<{ personId: string; token: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const url = supabaseConfigured() ? presenceUrl() : 'https://<project>.supabase.co/functions/v1/presence';
  const ps = usePresenceSetup(live, people);
  const followerNames = ps.followers.map((p) => ps.nameOf(p.id)).join(' and ');

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
        lede={
          ps.limited
            ? `The household counts as home every night, except on away dates. ${ps.phones} also tells the app when you arrive home or leave, so the pre-cool doesn’t cool an empty room. ${followerNames} ${ps.followers.length === 1 ? 'is' : 'are'} always with ${ps.pp!.map(ps.nameOf).join(' and ')}, so ${ps.followers.length === 1 ? 'she follows' : 'they follow'} ${ps.phones}.`
            : 'The household counts as home every night, except on away dates. Each iPhone can also tell the app when its owner arrives home or leaves, so the pre-cool doesn’t cool an empty room.'
        }
        className={s.header}
      />

      <Group
        label="How it decides"
        footer="OwnTracks sends the phone’s position (for the Map) and the app works out home or away from it; the Shortcut sends only “home” or “away” and the time."
      >
        <Row title="Home by default, no signal needed" sub="Switch “Home by default” off in Tonight’s plan to wait for a phone instead. Pre-cool starts before lights out, at the time tonight’s curve sets" value="Pre-cool" />
        <Row title="Away dates (e.g. Bangkok)" sub="Planned in Tonight’s plan; the aircon stays off those nights" value="Off" />
        {ps.limited ? (
          <>
            <Row title={`${ps.followers.map((p) => ps.nameOf(p.id)).join(' and ')} follows ${ps.phones}`} sub={`Always together: ${ps.phones} decides home / away for you both`} value="Follows" />
            <Row title={`${ps.phones.replace(/^./, (c) => c.toUpperCase())} said “away” in the last 12 h`} sub="Counts as everyone away. Starts later if you arrive before 01:00" value="Waits" />
            <Row title={`The latest signal from ${ps.phones} is “home”`} value="Pre-cool" />
          </>
        ) : (
          <>
            <Row title="Every phone said “away” in the last 12 h" sub="Starts later if someone arrives before 01:00" value="Waits" />
            <Row title="Someone’s latest signal is “home”" value="Pre-cool" />
          </>
        )}
        <Row title="Without “Home by default”" sub="No signal: no pre-cool. A “home” older than 48 h counts only with rising bedroom CO₂" value="Waits" />
        <Row title="Pre-cool started by a phone signal" sub="A notification lets you switch to “Away tonight”" value="Notifies" />
        <Row title="“Home tonight” / “Away tonight”" sub="One tap in Tonight’s plan, wins over the phones" value="Override" />
      </Group>

      <Group label="Set up" footer="OwnTracks runs in the background and reports arriving and leaving home by itself; it also draws the Map.">
        <Row
          title="OwnTracks (recommended)"
          sub={ps.limited ? `On ${ps.phones} only · System › Location` : 'On each iPhone · System › Location'}
          value="Location"
          href={systemHref('location')}
        />
      </Group>

      {people.map((p) => {
        const tok = tokens?.find((x) => x.personId === p.id);
        const fresh = shown?.personId === p.id ? shown.token : null;
        const leader = ps.follows(p.id);
        const label = p.name.trim().toLowerCase() === 'you' ? 'Your iPhone' : `${p.name}’s iPhone`;
        if (leader) {
          // Follows another phone: no token needed; creating one stays possible, as a secondary action.
          return (
            <Group key={p.id} label={label} footer={fresh ? 'Shown once. After you leave this page only a fingerprint of it is kept.' : undefined}>
              <Row
                title={`Follows ${ps.nameOf(leader)}’s phone`}
                sub={`${ps.nameOf(p.id)} is always with ${ps.nameOf(leader)}: no token or OwnTracks needed on this phone.${tok ? ` A token exists (${tok.lastUsedAt ? `last signal ${hm(tok.lastUsedAt)}` : 'no signal yet'}); its signals don’t decide home / away.` : ''}`}
                value={<Status tone="ok">Follows {ps.nameOf(leader)}</Status>}
              />
              {fresh && (
                <li className={s.reveal}>
                  <CopyField label="URL" value={url} />
                  <CopyField label="Header X-Presence-Token" value={fresh} />
                </li>
              )}
              {mayRotate(p.id) && (
                <li className={s.btnLi}>
                  <Button variant="text" size="sm" disabled={busy !== null} onClick={() => rotate(p.id)}>
                    {busy === p.id ? 'Creating…' : tok ? 'Rotate token' : 'Create a token anyway'}
                  </Button>
                </li>
              )}
            </Group>
          );
        }
        return (
          <Group
            key={p.id}
            label={label}
            footer={
              fresh
                ? 'Shown once. Paste it into OwnTracks (Password) now; after you leave this page only a fingerprint of it is kept. Rotating makes a new token and the old one stops working.'
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
                      : 'Not created yet: OwnTracks uses it as its password'
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

      <OtherDevices people={people} live={live} canWrite={canWrite} mayManage={mayRotate} url={url} />

      <BandPresenceGroup people={people} bands={bands} live={live} />

      <Disclosure title="Alternative: iOS Shortcuts" count="Arrive / leave automations">
        <div className={s.howtoBox}>
          <p className="sec">
            The older way, without OwnTracks: two Shortcuts automations, one for arriving and one for leaving.{' '}
            {ps.limited ? `Only on ${ps.phones}, with its token (${followerNames} follows it).` : 'Each person does this on their own phone, with their own token.'}
          </p>
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
      </Disclosure>
      <p className="cap">Lost phone or shared the token by mistake? Rotate it here: the old token stops working at once. Then paste the new one into OwnTracks (and any Shortcut or Mac that uses it).</p>
    </div>
  );
}

const DEVICE_STATUS_TONE = { Working: 'on', Waiting: 'off', Revoked: 'off' } as const;

/**
 * System › Presence › Other devices (migration 0028): a token per device (the Mac's night listener, a second phone),
 * so rotating a phone's own token never stops it. The plain token is shown once, right after it is created.
 */
function OtherDevices({
  people,
  live,
  canWrite,
  mayManage,
  url,
}: {
  people: readonly { id: string; name: string }[];
  live: boolean;
  canWrite: boolean;
  mayManage: (personId: string) => boolean;
  url: string;
}) {
  const { tokens, error, missing, refresh } = useDeviceTokens(live);
  const defaultPerson = people.some((p) => p.id === 'b') ? 'b' : (people[0]?.id ?? 'a');
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(DEFAULT_DEVICE_LABEL);
  const [personId, setPersonId] = useState(defaultPerson);
  const [kind, setKind] = useState<DeviceKind>('listener');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [shown, setShown] = useState<{ id: number; token: string; kind: DeviceKind } | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const whose = (id: string) => {
    const n = nameOf(id);
    return n.trim().toLowerCase() === 'you' ? 'yours' : `for ${n}`;
  };
  const now = Date.now();
  const list: DeviceToken[] | null = live ? tokens : SAMPLE_DEVICE_TOKENS(now);
  const writable = live && canWrite && !missing;

  const create = async () => {
    setBusy(true);
    setMsg(null);
    const r = await createDeviceToken(personId, label, kind);
    setBusy(false);
    if ('error' in r) return setMsg(r.error);
    setShown({ id: r.id, token: r.token, kind });
    setOpen(false);
    refresh();
  };
  const revoke = async (id: number) => {
    setBusy(true);
    setMsg(null);
    const e = await revokeDeviceToken(id);
    setBusy(false);
    setConfirmId(null);
    if (e) return setMsg(e);
    if (shown?.id === id) setShown(null);
    refresh();
  };

  return (
    <Group
      id="devices"
      label="Other devices"
      footer={
        <>
          Give each device its own token, so changing a phone’s token never stops it.
          {!live && ' Sample: sign in as a household member to create real tokens.'} {(msg ?? error) && <span className="sig">{msg ?? error}</span>}
        </>
      }
    >
      {list === null ? (
        <Row title="Device tokens" sub={<Skeleton w={160} h={14} r="text" inline />} />
      ) : list.length === 0 ? (
        <Row title={missing ? 'Not available yet' : 'No device tokens yet'} sub={missing ? 'Apply migration 0028 on the server first' : 'E.g. one for the night listener on the Mac'} />
      ) : (
        list.map((t) => {
          const st = deviceStatus(t);
          const kindLabel = DEVICE_KINDS.find((k) => k.value === t.kind)?.label ?? 'Other';
          return (
            <Row
              key={t.id}
              title={t.label}
              sub={`${kindLabel} · ${whose(t.personId)} · ${t.revokedAt !== null ? `revoked ${ago(t.revokedAt, now)}` : t.lastUsedAt !== null ? `last used ${ago(t.lastUsedAt, now)}` : 'not used yet'}`}
              value={<Status tone={DEVICE_STATUS_TONE[st]}>{st}</Status>}
              trailing={
                t.revokedAt === null && live ? (
                  confirmId === t.id ? (
                    <span className={s.confirm}>
                      <Button size="sm" variant="primary" disabled={busy} onClick={() => void revoke(t.id)}>
                        {busy ? 'Revoking…' : 'Revoke'}
                      </Button>
                      <Button size="sm" variant="text" onClick={() => setConfirmId(null)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="text" disabled={!writable || !mayManage(t.personId) || busy} onClick={() => setConfirmId(t.id)}>
                      Revoke
                    </Button>
                  )
                ) : undefined
              }
            />
          );
        })
      )}
      {confirmId !== null && <li className={cx('cap', s.btnLi)}>Revoke it? The device stops working at once; this can’t be undone (create a new token instead).</li>}
      {shown && (
        <li className={s.reveal}>
          <span className="sec">
            Shown once: after you leave this page only a fingerprint of it is kept.
            {shown.kind === 'listener' ? ' Paste the line below into the Mac session:' : ' Use it like a phone token (header X-Presence-Token).'}
          </span>
          {shown.kind === 'listener' ? (
            <CopyField label="For the Mac session" value={macInstruction(shown.token)} />
          ) : (
            <CopyField label="URL" value={url} />
          )}
          <CopyField label="Token" value={shown.token} />
        </li>
      )}
      {writable && open && (
        <li>
          <div className={cx('list-row', s.awayForm)}>
            <label className={s.awayField}>
              <span className="cap">Name</span>
              <Input type="text" maxLength={MAX_DEVICE_LABEL} value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className={s.awayField}>
              <span className="cap">Acts for</span>
              <select className="input" value={personId} onChange={(e) => setPersonId(e.target.value)}>
                {people.map((p) => (
                  <option key={p.id} value={p.id} disabled={!mayManage(p.id)}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={s.awayField}>
              <span className="cap">Kind</span>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as DeviceKind)}>
                {DEVICE_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="primary" disabled={busy || !label.trim() || !mayManage(personId)} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
            <Button size="sm" variant="text" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </li>
      )}
      {!open && (
        <li className={s.btnLi}>
          <Button
            variant="secondary"
            disabled={!writable || busy}
            onClick={() => {
              setMsg(null);
              setPersonId(mayManage(defaultPerson) ? defaultPerson : (people.find((p) => mayManage(p.id))?.id ?? defaultPerson));
              setOpen(true);
            }}
          >
            New device token
          </Button>
        </li>
      )}
    </Group>
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
