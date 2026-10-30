// Web Push administration. VAPID keys are created here (or on the first push) with WebCrypto and kept in Vault
// (migration 0016); the private key never leaves the database / functions.
//   GET  /push-admin                     → {"publicKey": "<base64url>"} — public, no auth (it is the PWA's
//                                          applicationServerKey). Creates the key pair on first call.
//   POST {"action":"ensure-keys"}        → {"publicKey", "created"} (cron secret / service key)
//   POST {"action":"status"}             → {"publicKey", "subscriptions", "subject"}
//   POST {"action":"test", "title"?, "body"?} → sends a test notification to every subscription
// The same public key is in household_settings.vapid_public_key (members can read it).
import { requireCron } from '../_shared/auth.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { appUrl, pushToAll } from '../_shared/push.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { loadVapidKeys } from '../_shared/vapid.ts';

serve(async (req) => {
  const db = serviceClient();
  if (req.method === 'GET') {
    const keys = await loadVapidKeys(db, { create: true });
    return json({ publicKey: keys!.publicKey }, 200, { 'Cache-Control': 'public, max-age=300' });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
  await requireCron(req, db);
  const body = await readJson(req);
  switch (body.action) {
    case 'ensure-keys': {
      const keys = await loadVapidKeys(db, { create: true });
      return json({ ok: true, publicKey: keys!.publicKey, created: keys!.created });
    }
    case 'status': {
      const keys = await loadVapidKeys(db, { create: false });
      const { count, error } = await db.from('push_subscriptions').select('id', { count: 'exact', head: true });
      if (error) throw new Error(`push_subscriptions: ${error.message}`);
      return json({ ok: true, publicKey: keys?.publicKey ?? null, subject: keys?.subject ?? null, subscriptions: count ?? 0 });
    }
    case 'test': {
      const r = await pushToAll(db, {
        title: typeof body.title === 'string' ? body.title.slice(0, 80) : 'Sleep Lab',
        body: typeof body.body === 'string' ? body.body.slice(0, 200) : 'Test notification: Web Push works.',
        navigate: `${appUrl()}/`,
        tag: 'test',
      }, 'test', { urgency: 'normal', ttlSec: 600 });
      return json({ ok: true, push: r });
    }
    default:
      throw new HttpError(400, 'action must be ensure-keys, status or test');
  }
});
