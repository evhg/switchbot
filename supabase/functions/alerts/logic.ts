// alerts: who gets which push, and public.alert_state rows ↔ the core decision states (no I/O here; tested in
// tests/alerts.test.ts).
import type { BatteryAlertState, ListenerAlertState, ListenerWatch, StaleAlertState } from '../../../packages/core/src/alerts/alerts.ts';
import type { Ms } from '../../../packages/core/src/types.ts';

export interface Member {
  user_id: string;
  person_id: string | null;
  role: string;
}

export type AlertKind = 'battery' | 'stale' | 'listener';

/**
 * Users to push to: battery and stale alerts go to that person's own account and the owner(s); listener alerts to
 * every member (viewers included: they live there too).
 */
export function recipients(kind: AlertKind, personId: string | null, members: readonly Member[]): string[] {
  const out = new Set<string>();
  for (const m of members) {
    if (kind === 'listener' || m.role === 'owner' || (personId !== null && m.person_id === personId)) out.add(m.user_id);
  }
  return [...out];
}

export const alertKey = (kind: AlertKind, personId?: string) => (kind === 'listener' ? 'listener' : `${kind}:${personId}`);

type Data = Record<string, unknown> | null | undefined;
const ms = (v: unknown): Ms | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const isoOrNull = (v: Ms | null) => (v === null ? null : new Date(v).toISOString());

export const batteryState = (d: Data): BatteryAlertState => ({ cycle: ms(d?.cycle) });
export const staleState = (d: Data): StaleAlertState => ({ seenAt: ms(d?.seen_at) });
export const listenerState = (d: Data): ListenerAlertState => ({ night: typeof d?.night === 'string' ? d.night : null });

/** alert_state 'listener_watch' (when the current listen=true stretch began; not an alert, never shown as sent). */
export const LISTENER_WATCH_KEY = 'listener_watch';
export function listenerWatch(d: Data): ListenerWatch | null {
  const since = ms(d?.since);
  return since !== null && typeof d?.night === 'string' ? { since, night: d.night } : null;
}
export const listenerWatchData = (w: ListenerWatch | null): Record<string, unknown> => (w ? { since: isoOrNull(w.since), night: w.night } : {});

/** alert_state.data for a sent alert: the dedupe state (snake_case, ISO times) plus what was sent. */
export function stateData(
  kind: AlertKind,
  state: BatteryAlertState | StaleAlertState | ListenerAlertState,
  sent: { title?: string; body?: string; personId?: string },
): Record<string, unknown> {
  const base: Record<string, unknown> = { title: sent.title ?? null, body: sent.body ?? null };
  if (sent.personId) base.person_id = sent.personId;
  if (kind === 'battery') return { ...base, cycle: isoOrNull((state as BatteryAlertState).cycle) };
  if (kind === 'stale') return { ...base, seen_at: isoOrNull((state as StaleAlertState).seenAt) };
  return { ...base, night: (state as ListenerAlertState).night };
}

/** band_sync's "band last seen": the later of device_last_sync_at and newest_point_at. */
export function bandSeenAt(row: { device_last_sync_at?: string | null; newest_point_at?: string | null }): Ms | null {
  const a = ms(row.device_last_sync_at);
  const b = ms(row.newest_point_at);
  return a === null ? b : b === null ? a : Math.max(a, b);
}
