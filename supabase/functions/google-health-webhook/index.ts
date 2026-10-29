// Google Health API webhook subscriber. Google echoes endpointAuthorization.secret in the Authorization
// header (GOOGLE_HEALTH_WEBHOOK_SECRET) and signs bodies with ECDSA P-256 (GOOGLE-HEALTH-API-SIGNATURE).
// Verification POSTs get 200 (authorized) / 401; notifications get 204 at once, then sync jobs are queued
// and google-health-sync is kicked in the background.
import { checkGoogleHealthAuthorization, fetchGoogleHealthKeyset, GOOGLE_HEALTH_SIGNATURE_HEADER, isGoogleHealthVerification, parseGoogleHealthNotifications, type TinkKeyset, verifyGoogleHealthSignature } from '../../../packages/core/src/health/signature.ts';
import { functionsBaseUrl, optEnv, serviceKey } from '../_shared/env.ts';
import { background, json, serve } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';

let keyset: { keys: TinkKeyset; at: number } | null = null;

async function signatureOk(raw: string, header: string | null): Promise<boolean> {
  if (!keyset || Date.now() - keyset.at > 6 * 3_600_000) keyset = { keys: await fetchGoogleHealthKeyset(), at: Date.now() };
  return verifyGoogleHealthSignature(raw, header, keyset.keys);
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const raw = await req.text();
  const secret = optEnv('GOOGLE_HEALTH_WEBHOOK_SECRET');
  if (!secret) {
    console.warn('google-health-webhook: not configured (GOOGLE_HEALTH_WEBHOOK_SECRET is not set); rejecting');
    return json({ error: 'unauthorized' }, 401);
  }
  if (!checkGoogleHealthAuthorization(req.headers.get('authorization'), secret)) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  if (isGoogleHealthVerification(body)) return json({ ok: true }, 200);

  // 'off' | 'log' (default: verify, log mismatches, accept) | 'enforce'. The verifier is best effort (no Tink).
  const mode = optEnv('GOOGLE_HEALTH_SIGNATURE') ?? 'log';
  if (mode !== 'off') {
    const ok = await signatureOk(raw, req.headers.get(GOOGLE_HEALTH_SIGNATURE_HEADER)).catch(() => false);
    if (!ok && mode === 'enforce') return json({ error: 'bad signature' }, 401);
    if (!ok) console.warn('google-health-webhook: signature did not verify (accepted, mode=log)');
  }

  const pending = background(enqueue(body));
  if (pending) await pending;
  return new Response(null, { status: 204 });
});

async function enqueue(body: unknown) {
  const db = serviceClient();
  const notes = parseGoogleHealthNotifications(body);
  if (!notes.length) return;
  const { data: people } = await db.from('people').select('id, google_health_user_id');
  const byHealthId = new Map(((people ?? []) as { id: string; google_health_user_id: string | null }[])
    .filter((p) => p.google_health_user_id)
    .map((p) => [p.google_health_user_id!, p.id]));

  // One job per person per delivery; an unknown healthUserId becomes a job for everyone (person_id null).
  const jobs = new Map<string, { person_id: string | null; data_types: Set<string>; intervals: unknown[] }>();
  for (const n of notes) {
    const pid = (n.healthUserId && byHealthId.get(n.healthUserId)) ?? null;
    const k = pid ?? '*';
    const j = jobs.get(k) ?? { person_id: pid, data_types: new Set<string>(), intervals: [] };
    j.data_types.add(n.dataType);
    j.intervals.push(...n.intervals);
    jobs.set(k, j);
  }
  const ins = await db.from('health_sync_jobs').insert(
    [...jobs.values()].map((j) => ({ person_id: j.person_id, data_types: [...j.data_types], intervals: j.intervals, reason: 'webhook' })),
  );
  if (ins.error) throw new Error(`health_sync_jobs: ${ins.error.message}`);

  // Kick the queue now; pg_cron drains it every 10 min if this call fails.
  const res = await fetch(`${functionsBaseUrl()}/google-health-sync`, {
    method: 'POST',
    // `apikey` works for both the legacy service-role JWT and the new sb_secret_ keys (see _shared/auth.ts).
    headers: { 'Content-Type': 'application/json', apikey: serviceKey() },
    body: JSON.stringify({ mode: 'queue' }),
  });
  await res.body?.cancel();
}
