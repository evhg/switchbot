// SwitchBot webhook receiver. Register https://<ref>.supabase.co/functions/v1/switchbot-webhook/<WEBHOOK_SECRET>
// (SwitchBot doesn't sign deliveries, so the secret path is the authentication). Replies 200 at once and writes
// in the background.
import { normalizeMac, parseWebhookEvent } from '../../../packages/core/src/switchbot/parse.ts';
import { urlSecretMatches } from '../_shared/auth.ts';
import { optEnv } from '../_shared/env.ts';
import { background, json, serve } from '../_shared/http.ts';
import { readingToRow } from '../_shared/rows.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { floorMinute } from '../_shared/time.ts';

serve(async (req) => {
  // 404 rather than 401 so the endpoint doesn't confirm it exists. Without WEBHOOK_SECRET nothing can match.
  const secret = optEnv('WEBHOOK_SECRET');
  if (!secret) console.warn('switchbot-webhook: not configured (WEBHOOK_SECRET is not set); rejecting');
  if (req.method !== 'POST' || !secret || !urlSecretMatches(req, secret)) return json({ error: 'not found' }, 404);
  const receivedAt = Date.now();
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({ ok: false, error: 'bad json' }, 200); // a 4xx would make SwitchBot retry garbage
  }
  const pending = background(store(body, receivedAt));
  if (pending) await pending;
  return json({ ok: true });
});

async function store(body: unknown, receivedAt: number) {
  const db = serviceClient();
  const ev = parseWebhookEvent(body, receivedAt);
  const ctx = (body as { eventType?: unknown; context?: { deviceMac?: unknown } } | null) ?? {};
  const raw = await db.from('raw_switchbot').insert({
    received_at: new Date(receivedAt).toISOString(),
    device_mac: typeof ctx.context?.deviceMac === 'string' ? ctx.context.deviceMac : null,
    event_type: typeof ctx.eventType === 'string' ? ctx.eventType : null,
    time_of_sample: ev?.timeOfSample ?? null,
    payload: body ?? {},
  });
  if (raw.error) console.error('raw_switchbot', raw.error.message);
  if (!ev?.reading) return;

  const deviceId = normalizeMac(ev.deviceMac);
  const reading = { ...ev.reading, ts: floorMinute(ev.reading.ts) };
  const [dev, up] = await Promise.all([
    db.from('devices').upsert({ device_id: deviceId, kind: 'meter', name: ev.deviceType || null }, { onConflict: 'device_id', ignoreDuplicates: true }),
    db.from('readings').upsert(readingToRow(deviceId, reading), { onConflict: 'device_id,ts' }),
  ]);
  if (dev.error) console.error('devices', dev.error.message);
  if (up.error) throw new Error(`readings: ${up.error.message}`);
}
