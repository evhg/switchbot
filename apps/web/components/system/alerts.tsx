'use client';
/**
 * System › Alerts (/settings/alerts): phone pushes from Jarvis (migration 0026, supabase/functions/alerts).
 *
 *   Alerts        on/off per kind (household_settings.alerts via set_alerts; owner / member)
 *   Batteries     each person's Fitbit: level now and time left from the drain rate ("83 %, ~5 days left")
 *   Last sent     the newest push of each kind (public.alert_state)
 *   This device   whether this phone receives pushes (the same subscription as the morning report)
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_PEOPLE, batteryText, needsCharge, type DrainEstimate } from '@sleep-lab/core';
import { useAuth } from '@/lib/auth.tsx';
import { useData } from '@/lib/data/context.tsx';
import { ALERT_PEOPLE, setAlerts, useAlerts, type SentAlert } from '@/lib/alerts.ts';
import { fmt } from '@/lib/format.ts';
import { FALLBACK_NAMES } from '@/lib/location.ts';
import { disablePush, enablePush, pushSubscribed, pushSupported, resolveVapidKey } from '@/lib/push.ts';
import { systemHref, useChrome } from '../nav.tsx';
import { Group, PageHeader, Row, Skeleton, Status, Switch } from '../ui.tsx';
import { ago } from './bands.tsx';
import s from './system.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Key = 'battery' | 'stale_sync' | 'listener';

const KINDS: { key: Key; field: 'battery' | 'staleSync' | 'listener'; title: string; sub: string }[] = [
  { key: 'battery', field: 'battery', title: 'Fitbit battery', sub: 'When a band has less than a day left. Daytime only (08:00–21:30).' },
  { key: 'stale_sync', field: 'staleSync', title: 'Fitbit not syncing', sub: 'When a band hasn’t synced for 6 hours (08:00–22:00).' },
  { key: 'listener', field: 'listener', title: 'Night listener stopped', sub: 'When the Mac stops listening during the night. Once a night.' },
];

const KIND_LABEL: Record<SentAlert['kind'], string> = { battery: 'Battery', stale: 'Not syncing', listener: 'Night listener' };

function batteryRow(e: DrainEstimate | null | undefined, now: number): { value: ReactNode; sub: string } {
  if (e === undefined) return { value: <Skeleton w={96} h={14} r="text" inline />, sub: '' };
  if (e === null) return { value: <Status tone="off">No reading yet</Status>, sub: 'Shows up after the next band sync that reports a battery level.' };
  const low = needsCharge(e);
  return {
    value: low ? <Status tone="alert">{batteryText(e)}</Status> : <span className="num">{batteryText(e)}</span>,
    sub: [
      `Reported ${fmt(e.level)} % ${ago(e.at, now)}`,
      e.ratePerHour === null ? 'learning the drain rate (needs 3 h)' : `uses ${fmt(e.ratePerHour, 1)} % an hour`,
    ].join(' · '),
  };
}

/** This device's push subscription (shared with the morning report). */
function DevicePush({ member }: { member: boolean }) {
  const [on, setOn] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!member) return;
    let alive = true;
    resolveVapidKey().then((k) => alive && setKey(k ?? ''));
    pushSubscribed().then((v) => alive && v !== null && setOn(v));
    return () => {
      alive = false;
    };
  }, [member]);
  const ready = member && Boolean(key) && pushSupported();
  const toggle = (v: boolean) => {
    setBusy(true);
    const p = v ? enablePush().then((r) => (setOn(r.ok), r.text)) : disablePush().then((t) => (setOn(false), t));
    p.then(setMsg, (e: unknown) => setMsg(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  const why = !member
    ? 'Sign in as a household member to get alerts on this device.'
    : !pushSupported()
      ? 'This browser can’t receive push. On iPhone, add Jarvis to the Home Screen and open it from there.'
      : key === null
        ? 'Checking whether notifications are ready…'
        : !key
          ? 'Notifications aren’t ready yet: the backend hasn’t published its push key.'
          : 'Alerts and the morning report use the same switch.';
  return (
    <Group label="This device" footer={msg ?? why}>
      <Row
        title="Notifications on this device"
        sub={ready ? (on ? 'On' : 'Off') : undefined}
        trailing={<Switch checked={on && ready} disabled={!ready || busy} onChange={toggle} label={<span className="sr-only">Notifications on this device</span>} />}
      />
      <Row title="Morning report" href={systemHref('morning')} />
    </Group>
  );
}

/** System root value: how many alert kinds are on. */
export function useAlertsSummary(): ReactNode {
  const auth = useAuth();
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const { data } = useAlerts(live);
  if (!live) return 'Not set up';
  if (!data) return <Skeleton w={52} h={14} r="text" inline />;
  if (!data.available) return 'Not set up';
  const on = KINDS.filter((k) => data.settings[k.field]).length;
  return on === KINDS.length ? 'All on' : on === 0 ? 'Off' : `${on} of ${KINDS.length} on`;
}

export function AlertsPage() {
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
  const { data, error } = useAlerts(live, nonce);
  const [busy, setBusy] = useState<Key | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const now = Date.now();

  const toggle = (k: Key, v: boolean) => {
    setBusy(k);
    setMsg(null);
    setAlerts({ [k]: v })
      .then((e) => {
        setMsg(e);
        refresh();
      })
      .finally(() => setBusy(null));
  };

  return (
    <div className={cx(s.sub, s.col, s.drill)}>
      <PageHeader title="Alerts" lede="Jarvis sends a push to your phone when something needs a hand: a band to charge, a band that stopped syncing, or the night listener going quiet." className={s.header} />

      <Group label="Alerts" footer={!live ? 'Sign in as a household member to change these.' : !canWrite ? 'Your household role is read-only.' : 'Battery and syncing alerts go to that person and the owner. The night listener alert goes to everyone.'}>
        {KINDS.map((k) => (
          <Row
            key={k.key}
            title={k.title}
            sub={k.sub}
            trailing={
              data ? (
                <Switch checked={data.available && data.settings[k.field]} disabled={!canWrite || !data.available || busy !== null} onChange={(v) => toggle(k.key, v)} label={<span className="sr-only">{k.title}</span>} />
              ) : (
                <Skeleton w={44} h={24} r="pill" inline />
              )
            }
          />
        ))}
      </Group>
      {(msg || error) && <p className={cx('sec', s.alert)}>{msg ?? error}</p>}

      <Group label="Fitbit batteries" footer={live && data && !data.available ? 'Not available yet.' : live ? 'Time left comes from how fast the battery dropped since the last charge.' : 'Sample numbers. Sign in to see your bands.'}>
        {ALERT_PEOPLE.map((id) => {
          const r = batteryRow(data ? (data.batteries[id] ?? null) : undefined, now);
          return <Row key={id} title={`${nameOf(id)}’s Fitbit`} sub={r.sub || undefined} value={r.value} />;
        })}
      </Group>

      <Group label="Last sent">
        {!data ? (
          <Row title={<Skeleton w={160} h={14} r="text" inline />} />
        ) : data.sent.length === 0 ? (
          <Row title="Nothing sent yet" />
        ) : (
          data.sent.slice(0, 6).map((a) => (
            <Row key={a.key} title={a.body ?? KIND_LABEL[a.kind]} sub={`${KIND_LABEL[a.kind]}${a.personId ? ` · ${nameOf(a.personId)}` : ''}`} value={<span className="num">{ago(a.sentAt, now)}</span>} />
          ))
        )}
      </Group>

      <DevicePush member={live} />
    </div>
  );
}
