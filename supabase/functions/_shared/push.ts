// Web Push to every household subscription (push_subscriptions), with the same bookkeeping as the morning report:
// success resets failures, 404/410 deletes the subscription, anything else counts a failure.
import { optEnv } from './env.ts';
import type { Db } from './supabase.ts';
import { declarativePayload, type NotificationContent, sendWebPush, type VapidKeys } from './webpush.ts';

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

export async function pushToAll(db: Db, n: NotificationContent, topic: string): Promise<{ skipped?: string; subscriptions?: number; sent?: number }> {
  const pub = optEnv('VAPID_PUBLIC_KEY');
  const priv = optEnv('VAPID_PRIVATE_KEY');
  if (!pub || !priv) return { skipped: 'no VAPID keys' };
  const keys: VapidKeys = { publicKey: pub, privateKey: priv, subject: optEnv('VAPID_SUBJECT') ?? 'mailto:admin@example.com' };
  const { data, error } = await db.from('push_subscriptions').select('id,endpoint,p256dh,auth,failures');
  if (error) throw new Error(`push_subscriptions: ${error.message}`);
  const subs = (data ?? []) as { id: number; endpoint: string; p256dh: string; auth: string; failures: number }[];
  const message = declarativePayload(n);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await sendWebPush(s, message, keys, { urgency: 'high', topic });
      if (r.ok) {
        sent++;
        await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), failures: 0 }).eq('id', s.id);
      } else if (r.gone) {
        await db.from('push_subscriptions').delete().eq('id', s.id);
      } else {
        await db.from('push_subscriptions').update({ failures: s.failures + 1 }).eq('id', s.id);
      }
    } catch (e) {
      console.warn('push failed', s.endpoint.slice(0, 40), e);
      await db.from('push_subscriptions').update({ failures: s.failures + 1 }).eq('id', s.id);
    }
  }));
  return { subscriptions: subs.length, sent };
}
