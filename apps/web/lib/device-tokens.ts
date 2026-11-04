'use client';
/**
 * Device tokens (System › Presence › Other devices; migration 0028): one token per device that acts for a person, e.g.
 * the Mac's night listener, so rotating a phone's own presence token never stops it. Same "slp_" format as presence
 * tokens; the server keeps only a hash and returns the plain token once, from create_device_token.
 * Signed out / simulator: a sample row only.
 */
import { useEffect, useState } from 'react';
import { supabaseClient } from './data/supabase.ts';
import { MIN } from './format.ts';

export type DeviceKind = 'listener' | 'phone' | 'device';

export interface DeviceToken {
  id: number;
  personId: string;
  label: string;
  kind: DeviceKind;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export const DEVICE_KINDS: readonly { value: DeviceKind; label: string }[] = [
  { value: 'listener', label: 'Night listener' },
  { value: 'phone', label: 'Phone' },
  { value: 'device', label: 'Other' },
];

export const DEFAULT_DEVICE_LABEL = 'Night listener (Erik’s Mac)';
export const MAX_DEVICE_LABEL = 60;

/** A server message that means "migration 0028 isn't applied yet". */
export const missingDeviceTokens = (m: string) => /does not exist|schema cache|could not find|device_token/i.test(m);
export const DEVICE_NOT_YET = 'Device tokens aren’t on the server yet (migration 0028).';

export type DeviceStatus = 'Working' | 'Waiting' | 'Revoked';
export const deviceStatus = (t: Pick<DeviceToken, 'lastUsedAt' | 'revokedAt'>): DeviceStatus => (t.revokedAt !== null ? 'Revoked' : t.lastUsedAt !== null ? 'Working' : 'Waiting');

/** The line to paste into the Mac session, token included. */
export const macInstruction = (token: string) =>
  `Replace the token in ~/sleep-lab-home/night-sound/token with this one (keep the file at 0600, don't print it): ${token}`;

/** Simulator / signed out: what a working night-listener token looks like. */
export const SAMPLE_DEVICE_TOKENS = (now = Date.now()): DeviceToken[] => [
  { id: 0, personId: 'b', label: DEFAULT_DEVICE_LABEL, kind: 'listener', createdAt: now - 2 * 24 * 60 * MIN, lastUsedAt: now - 2 * MIN, revokedAt: null },
];

type Row = Record<string, unknown>;
const ms = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : null);
const kindOf = (v: unknown): DeviceKind => (v === 'listener' || v === 'phone' ? v : 'device');
const errText = (m: string) => (missingDeviceTokens(m) ? DEVICE_NOT_YET : m);

export function useDeviceTokens(enabled: boolean): { tokens: DeviceToken[] | null; error: string | null; missing: boolean; refresh: () => void } {
  const [tokens, setTokens] = useState<DeviceToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    supabaseClient()
      .rpc('list_device_tokens')
      .then(({ data, error: e }) => {
        if (off) return;
        if (e) {
          setMissing(missingDeviceTokens(e.message));
          setTokens([]);
          return setError(errText(e.message));
        }
        setMissing(false);
        setError(null);
        setTokens(
          ((data ?? []) as Row[]).map((r) => ({
            id: Number(r.id),
            personId: String(r.person_id),
            label: String(r.label ?? ''),
            kind: kindOf(r.kind),
            createdAt: ms(r.created_at) ?? NaN,
            lastUsedAt: ms(r.last_used_at),
            revokedAt: ms(r.revoked_at),
          })),
        );
      });
    return () => {
      off = true;
    };
  }, [enabled, nonce]);
  return { tokens, error, missing, refresh: () => setNonce((n) => n + 1) };
}

const rpcError = (m: string) => {
  if (missingDeviceTokens(m)) return DEVICE_NOT_YET;
  if (/own person/i.test(m)) return 'Only that person or the household owner can manage their device tokens.';
  if (/not allowed/i.test(m)) return 'Your household role is read-only.';
  return m;
};

/** Creates a device token; the plain token is returned only here, once. */
export async function createDeviceToken(personId: string, label: string, kind: DeviceKind): Promise<{ id: number; token: string } | { error: string }> {
  const l = label.trim();
  if (!l || l.length > MAX_DEVICE_LABEL) return { error: `Name it with 1 to ${MAX_DEVICE_LABEL} characters.` };
  const { data, error } = await supabaseClient().rpc('create_device_token', { p_person_id: personId, p_label: l, p_kind: kind });
  if (error) return { error: rpcError(error.message) };
  const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
  return row && typeof row.token === 'string' ? { id: Number(row.id), token: row.token } : { error: 'No token returned.' };
}

/** Stops the token at once; the row stays, marked Revoked. */
export async function revokeDeviceToken(id: number): Promise<string | null> {
  const { error } = await supabaseClient().rpc('revoke_device_token', { p_id: id });
  return error ? rpcError(error.message) : null;
}
