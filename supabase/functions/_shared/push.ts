// Web Push to every household subscription (push_subscriptions): success resets failures, 404/410 deletes the
// subscription, anything else counts a failure. Keys come from Vault (vapid.ts), created on first use.
import { optEnv } from './env.ts';
import type { Db } from './supabase.ts';
import { loadVapidKeys } from './vapid.ts';
import { declarativePayload, type NotificationContent, sendWebPush } from './webpush.ts';

export const appUrl = () => (optEnv('APP_URL') ?? '').replace(/\/$/, '');

/** "Pre-cool started" notice; tapping it opens Tonight's plan, where "Away tonight" switches the aircon off. */
export function precoolNotice(date: string, reason: string, base = appUrl()): NotificationContent {
  return {
    title: 'Aircon pre-cool started',
    body: `Someone looks home: ${reason}. Not home tonight? Tap and choose “Away tonight”.`,
    navigate: `${base}/settings/plan`,
    tag: `precool-${date}`,
  };
}

export interface PushSummary {
  skipped?: string;
  subscriptions?: number;
  sent?: number;
  removed?: number;
  failed?: number;
}

export async function pushToAll(
  db: Db,
  n: NotificationContent,
  topic: string,
  opts: { urgency?: 'very-low' | 'low' | 'normal' | 'high'; ttlSec?: number } = {},
): Promise<PushSummary> {
  const keys = await loadVapidKeys(db, { create: true });
  if (!keys) return { skipped: 'no VAPID keys' };
  const { data, error } = await db.from('push_subscriptions').select('id,endpoint,p256dh,auth,failures');
  if (error) throw new Error(`push_subscriptions: ${error.message}`);
  const subs = (data ?? []) as { id: number; endpoint: string; p256dh: string; auth: string; failures: number }[];
  const message = declarativePayload(n);
  let sent = 0, removed = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await sendWebPush(s, message, keys, { urgency: opts.urgency ?? 'high', topic, ttlSec: opts.ttlSec });
      if (r.ok) {
        sent++;
        await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), failures: 0 }).eq('id', s.id);
      } else if (r.gone) {
        removed++;
        await db.from('push_subscriptions').delete().eq('id', s.id);
      } else {
        failed++;
        console.warn('push rejected', r.status, s.endpoint.slice(0, 40));
        await db.from('push_subscriptions').update({ failures: s.failures + 1 }).eq('id', s.id);
      }
    } catch (e) {
      failed++;
      console.warn('push failed', s.endpoint.slice(0, 40), e);
      await db.from('push_subscriptions').update({ failures: s.failures + 1 }).eq('id', s.id);
    }
  }));
  return { subscriptions: subs.length, sent, removed, failed };
}
