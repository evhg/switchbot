'use client';
/**
 * Fitbit bands via Google Health: connect (OAuth start), "Sync now", and each person's band sync status
 * (public.band_sync, migration 0015, written by google-health-sync).
 *
 * band_sync.device_last_sync_at / newest_point_at say when the band last reached Google (through the phone app). It
 * is shown on System › Presence as a hint only; the aircon's presence gate does not use it (yet).
 */
import { useCallback, useEffect, useState } from 'react';
import { functionsUrl, supabaseClient } from './data/supabase.ts';

export interface BandSync {
  personId: string;
  /** When google-health-sync last ran for this person (any outcome). */
  lastSyncAt: number | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
  /** Newest pairedDevices lastSyncTime (band → phone → Google). */
  deviceLastSyncAt: number | null;
  /** Newest wearable data point seen (heart rate, HRV, SpO2, steps). */
  newestPointAt: number | null;
  /** Latest of the two: the best "band last seen" time. */
  bandSeenAt: number | null;
  battery: number | null;
}

const t = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);
const orNull = (x: number) => (Number.isFinite(x) ? x : null);

function battery(devices: unknown): number | null {
  if (!Array.isArray(devices)) return null;
  for (const d of devices) {
    const b = (d as { batteryLevel?: unknown } | null)?.batteryLevel;
    const n = typeof b === 'number' ? b : typeof b === 'string' ? Number(b) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** band_sync rows for the household (members may read). Refetches when `nonce` changes. */
export function useBandSync(enabled: boolean, nonce = 0): { bands: Record<string, BandSync> | null; error: string | null } {
  const [bands, setBands] = useState<Record<string, BandSync> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return setBands(null);
    let alive = true;
    supabaseClient()
      .from('band_sync')
      .select('person_id,last_sync_at,last_sync_ok,last_error,device_last_sync_at,newest_point_at,devices')
      .then(({ data, error: e }) => {
        if (!alive) return;
        if (e) {
          setError(e.message);
          setBands({});
          return;
        }
        const out: Record<string, BandSync> = {};
        for (const r of (data ?? []) as Record<string, unknown>[]) {
          const dev = orNull(t(r.device_last_sync_at));
          const pt = orNull(t(r.newest_point_at));
          out[String(r.person_id)] = {
            personId: String(r.person_id),
            lastSyncAt: orNull(t(r.last_sync_at)),
            lastSyncOk: typeof r.last_sync_ok === 'boolean' ? r.last_sync_ok : null,
            lastError: typeof r.last_error === 'string' ? r.last_error : null,
            deviceLastSyncAt: dev,
            newestPointAt: pt,
            bandSeenAt: dev === null ? pt : pt === null ? dev : Math.max(dev, pt),
            battery: battery(r.devices),
          };
        }
        setError(null);
        setBands(out);
      });
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);
  return { bands, error };
}

async function post(path: string, token: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${functionsUrl()}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // keep {}
  }
  return { status: res.status, json };
}

const NOT_CONFIGURED = 'Google sign-in isn’t set up on the server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing).';

/**
 * Asks google-oauth for a consent URL bound to the signed-in person (or `person`, owner only) and returns it; the
 * caller navigates there. {error} with a readable message otherwise.
 */
export async function startGoogleConnect(token: string, person?: string): Promise<{ url: string } | { error: string }> {
  try {
    const r = await post('google-oauth/start', token, person ? { person } : {});
    if (r.status === 200 && typeof r.json.url === 'string') return { url: r.json.url };
    if (r.status === 503) return { error: NOT_CONFIGURED };
    return { error: typeof r.json.error === 'string' ? r.json.error : `Couldn’t start (HTTP ${r.status}).` };
  } catch {
    return { error: 'Couldn’t reach the server. Check the connection and try again.' };
  }
}

/** Manual sync of every connected band (server: at most once per 2 min per person). */
export function useSyncNow(token: string | null): { busy: boolean; msg: string | null; run: () => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = useCallback(async () => {
    if (!token) return false;
    setBusy(true);
    setMsg(null);
    try {
      const r = await post('google-health-sync', token, { mode: 'full' });
      if (r.status === 429) setMsg('Synced less than 2 minutes ago. Try again shortly.');
      else if (r.status === 409) setMsg('No band is connected yet.');
      else if (r.status === 503) setMsg(NOT_CONFIGURED);
      else if (r.status !== 200) setMsg(typeof r.json.error === 'string' ? r.json.error : `Sync failed (HTTP ${r.status}).`);
      else setMsg(r.json.ok ? 'Synced.' : 'Synced, with some errors (see below).');
      return r.status === 200;
    } catch {
      setMsg('Couldn’t reach the server.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [token]);
  return { busy, msg, run };
}

/** The ?google=… flag the OAuth callback appends to /settings/health, read once and removed from the URL. */
export function useOAuthResult(): { ok: boolean; text: string } | null {
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const g = q.get('google');
    if (!g) return;
    const reason = q.get('reason') ?? '';
    const REASONS: Record<string, string> = {
      denied: 'You cancelled on Google’s page. Nothing was connected.',
      expired: 'The sign-in link expired (15 min). Start again.',
      no_refresh_token: 'Google didn’t return a long-lived token. Remove the app at myaccount.google.com/permissions, then connect again.',
      exchange: 'Google rejected the sign-in code. Try again; if it repeats, check the OAuth client secret.',
      store: 'Connected, but saving the token failed. Try again.',
      no_code: 'Google returned no sign-in code. Try again.',
      wrong_account: 'That Google account belongs to the other person in the household. Sign in to Google with your own account and connect again.',
    };
    setRes(
      g === 'connected'
        ? {
            ok: true,
            text:
              q.get('profile') === 'missing'
                ? 'Connected. Google Health has no profile for this account yet: open the Google Health (Fitbit) app once, then Sync now.'
                : 'Connected. The last two weeks arrive within about 10 minutes.',
          }
        : { ok: false, text: REASONS[reason] ?? `Google sign-in failed (${reason || 'unknown error'}).` },
    );
    q.delete('google');
    q.delete('reason');
    q.delete('person');
    q.delete('profile');
    const rest = q.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  }, []);
  return res;
}
