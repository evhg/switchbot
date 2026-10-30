'use client';
/**
 * Fitbit band status rows (public.band_sync via lib/bands.ts). Used on System › Presence ("band last seen", a hint:
 * the aircon's presence gate doesn't use it) and System › Google Health (last sync, Sync now).
 */
import type { ReactNode } from 'react';
import type { Person } from '@sleep-lab/core';
import type { BandSync } from '@/lib/bands.ts';
import { dayLabel, hm, ictDate, MIN } from '@/lib/format.ts';
import { Group, Row, Skeleton, Status } from '../ui.tsx';

/** "14:05", "yesterday 23:10"-style, or "3 min ago" when recent. */
export function ago(ts: number, now = Date.now()): string {
  const d = now - ts;
  if (d < MIN) return 'just now';
  if (d < 60 * MIN) return `${Math.round(d / MIN)} min ago`;
  return ictDate(ts) === ictDate(now) ? `today ${hm(ts)}` : `${dayLabel(ictDate(ts))} ${hm(ts)}`;
}

/** Band last reached Google within this window → "Recent". */
const RECENT_MS = 3 * 60 * MIN;

export function BandSeenRow({ name, band, loading }: { name: ReactNode; band: BandSync | undefined; loading: boolean }) {
  if (loading) return <Row title={name} sub={<Skeleton w={160} h={14} r="text" inline />} />;
  const seen = band?.bandSeenAt ?? null;
  const sub = !band?.lastSyncAt
    ? 'Not synced yet. Connect Google Health first'
    : seen === null
      ? `No band data yet · checked ${ago(band.lastSyncAt)}`
      : `Band last synced ${ago(seen)}${band.deviceLastSyncAt === null ? ' (newest data point)' : ''}${band.battery !== null ? ` · battery ${band.battery}%` : ''} · checked ${ago(band.lastSyncAt)}`;
  const recent = seen !== null && Date.now() - seen < RECENT_MS;
  return <Row title={name} sub={sub} value={<Status tone={recent ? 'on' : 'off'}>{seen === null ? 'Unknown' : recent ? 'Recent' : 'Stale'}</Status>} />;
}

export function BandPresenceGroup({ people, bands, live }: { people: readonly Person[]; bands: Record<string, BandSync> | null; live: boolean }) {
  if (!live) return null;
  return (
    <Group
      label="Fitbit bands (hint only)"
      footer="When each band last reached Google through its phone. A recent sync means the band was near its phone, not where the phone was, so it doesn’t switch the aircon. Synced hourly and on Sync now in System › Google Health."
    >
      {people.map((p) => (
        <BandSeenRow key={p.id} name={p.name.trim().toLowerCase() === 'you' ? 'Your band' : `${p.name}’s band`} band={bands?.[p.id]} loading={bands === null} />
      ))}
    </Group>
  );
}
