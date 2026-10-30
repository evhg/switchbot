// SwitchBot webhook receiver, registered by switchbot-admin {"action":"register-webhook"} as
// https://<ref>.supabase.co/functions/v1/switchbot-webhook/<secret>. SwitchBot doesn't sign deliveries, so the
// secret path segment is the authentication. It matches either the WEBHOOK_SECRET function secret (optional) or
// the Vault secret `switchbot_webhook_secret` (migration 0008, checked through a service_role-only RPC).
// Replies 200 at once and writes in the background. A webhook reading replaces a poll row for the same minute
// (poll-meter never overwrites a webhook row). A 0 ppm warm-up artifact keeps temp/RH with the last valid CO2.
import { timingSafeEqual } from '../../../packages/core/src/health/signature.ts';
import { normalizeMac, parseWebhookEvent } from '../../../packages/core/src/switchbot/parse.ts';
import { urlSecretMatches } from '../_shared/auth.ts';
import { optEnv } from '../_shared/env.ts';
import { background, json, serve } from '../_shared/http.ts';
import { recentCo2 } from '../_shared/readings.ts';
import { readingToRow } from '../_shared/rows.ts';
import { type Db, serviceClient } from '../_shared/supabase.ts';
import { floorMinute } from '../_shared/time.ts';
import { webhookSecretCandidates } from '../_shared/webhook.ts';

// A path secret that verified against Vault is cached per worker for a few minutes, so a burst of deliveries
// doesn't add a database round trip each. Only a value that already verified is cached.
const VAULT_CACHE_MS = 5 * 60_000;
let vaultOk: { secret: string; at: number } | null = null;

async function authorized(req: Request, db: Db): Promise<boolean> {
  const configured = optEnv('WEBHOOK_SECRET');
  if (configured && urlSecretMatches(req, configured)) return true;
  const candidates = webhookSecretCandidates(req.url).filter((c) => c.length >= 32 && c.length <= 256);
  if (vaultOk && Date.now() - vaultOk.at < VAULT_CACHE_MS && candidates.some((c) => timingSafeEqual(c, vaultOk!.secret))) return true;
  for (const c of candidates) {
    const { data, error } = await db.rpc('verify_switchbot_webhook_secret', { p_secret: c });
    if (error) console.error('verify_switchbot_webhook_secret', error.message);
    if (data === true) {
      vaultOk = { secret: c, at: Date.now() };
      return true;
    }
  }
  return false;
}

serve(async (req) => {
  // 404 rather than 401 so the endpoint doesn't confirm it exists.
  if (req.method !== 'POST' || !(await authorized(req, serviceClient()))) return json({ error: 'not found' }, 404);
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
  let ev = parseWebhookEvent(body, receivedAt);
  if (ev && !ev.reading && parseWebhookEvent(body, receivedAt, { co2Fallback: 420 })?.reading) {
    // Only the CO2 is implausible (warm-up artifact): reuse the last valid value, or skip the reading.
    const fb = await recentCo2(db, normalizeMac(ev.deviceMac), receivedAt);
    if (fb !== null) ev = parseWebhookEvent(body, receivedAt, { co2Fallback: fb });
  }
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
