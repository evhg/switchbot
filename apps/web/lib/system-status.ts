'use client';
/**
 * Backend status for System › Data & devices and Diagnostics (household members may read all of these tables):
 * - the aircon: ac_state rows and the newest ac_commands row (what was last sent, and whether it was a dry run);
 * - SwitchBot API use today: api_quota (api 'switchbot', day = today in UTC, the counter's own day);
 * - webhook vs poll: the newest public.readings ts per source.
 * Plus people.google_health_user_id (set by the OAuth callback) for "is this person's band linked".
 */
import { useEffect, useState } from 'react';
import { supabaseClient } from './data/supabase.ts';
import { pushSubscribed } from './push.ts';

type Row = Record<string, unknown>;
const ms = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);
const orNull = (x: number) => (Number.isFinite(x) ? x : null);

export interface AcStatus {
  /** ac_state has at least one row: the backend has a remote it drives. */
  linked: boolean;
  last: { ts: number; power: boolean; setpointC: number | null; dryRun: boolean; ok: boolean | null; reason: string | null } | null;
}

export interface BackendStatus {
  loading: boolean;
  ac: AcStatus | null;
  /** api_quota for 'switchbot' today (UTC); null = no row yet today or not readable. */
  quota: { used: number; remaining: number | null; updatedAt: number | null } | null;
  /** Newest reading per source (epoch ms), null when none. */
  newestWebhook: number | null;
  newestPoll: number | null;
}

const EMPTY: BackendStatus = { loading: false, ac: null, quota: null, newestWebhook: null, newestPoll: null };

/** Today's date in UTC: api_quota counts per UTC day (SwitchBot's daily limit resets at 00:00 UTC). */
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export function useBackendStatus(enabled: boolean): BackendStatus {
  const [st, setSt] = useState<BackendStatus>(EMPTY);
  useEffect(() => {
    if (!enabled) return setSt(EMPTY);
    let alive = true;
    const db = supabaseClient();
    const newest = (source: string) => db.from('readings').select('ts').eq('source', source).order('ts', { ascending: false }).limit(1).maybeSingle();
    setSt((s) => ({ ...s, loading: true }));
    Promise.all([
      db.from('ac_state').select('device_id'),
      db.from('ac_commands').select('ts,state,dry_run,sent_ok,reason').order('ts', { ascending: false }).limit(1).maybeSingle(),
      db.from('api_quota').select('used,server_remaining,updated_at').eq('api', 'switchbot').eq('day', utcDay()).maybeSingle(),
      newest('webhook'),
      newest('poll'),
    ]).then(
      ([as, ac, q, wh, po]) => {
        if (!alive) return;
        const c = ac.error ? null : (ac.data as Row | null);
        const state = (c?.state ?? null) as { power?: unknown; setpointC?: unknown } | null;
        const qr = q.error ? null : (q.data as Row | null);
        setSt({
          loading: false,
          ac: {
            linked: !as.error && (as.data ?? []).length > 0,
            last: c
              ? {
                  ts: ms(c.ts),
                  power: state?.power === true,
                  setpointC: typeof state?.setpointC === 'number' ? state.setpointC : null,
                  dryRun: c.dry_run === true,
                  ok: typeof c.sent_ok === 'boolean' ? c.sent_ok : null,
                  reason: typeof c.reason === 'string' ? c.reason : null,
                }
              : null,
          },
          quota: qr ? { used: Number(qr.used) || 0, remaining: typeof qr.server_remaining === 'number' ? qr.server_remaining : null, updatedAt: orNull(ms(qr.updated_at)) } : null,
          newestWebhook: wh.error ? null : orNull(ms((wh.data as Row | null)?.ts)),
          newestPoll: po.error ? null : orNull(ms((po.data as Row | null)?.ts)),
        });
      },
      () => alive && setSt(EMPTY),
    );
    return () => {
      alive = false;
    };
  }, [enabled]);
  return st;
}

/** people.google_health_user_id is set by the OAuth callback; members may read it. person id → linked. */
export function useHealthLinks(enabled: boolean, nonce = 0): Record<string, boolean> | null {
  const [links, setLinks] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    if (!enabled) return setLinks(null);
    let alive = true;
    supabaseClient()
      .from('people')
      .select('id,google_health_user_id')
      .then(({ data }) => {
        if (!alive || !data) return;
        setLinks(Object.fromEntries((data as { id: string; google_health_user_id: string | null }[]).map((r) => [r.id, Boolean(r.google_health_user_id)])));
      });
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);
  return links;
}

/** This device's push subscription: undefined while checking, null when push isn't supported here. */
export function usePushSubscribed(): boolean | null | undefined {
  const [sub, setSub] = useState<boolean | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    pushSubscribed().then(
      (v) => alive && setSub(v),
      () => alive && setSub(null),
    );
    return () => {
      alive = false;
    };
  }, []);
  return sub;
}
