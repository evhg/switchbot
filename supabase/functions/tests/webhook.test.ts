// SwitchBot webhook URL helpers: secret extraction, masking, reply parsing and the registration plan.
import { maskWebhookUrl, parseQueryDetails, parseQueryUrl, planRegistration, redact, webhookSecretCandidates, webhookUrl } from '../_shared/webhook.ts';

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const BASE = 'https://ref.supabase.co/functions/v1';
const SECRET = 'a'.repeat(64);
const OURS = webhookUrl(BASE, SECRET);

Deno.test('webhookSecretCandidates reads ?token= and the last path segment, not the function name', () => {
  eq(webhookSecretCandidates(`${OURS}`), [SECRET], 'path');
  eq(webhookSecretCandidates(`${BASE}/switchbot-webhook?token=xyz`), ['xyz'], 'query only');
  eq(webhookSecretCandidates(`${BASE}/switchbot-webhook/`), [], 'bare');
});

Deno.test('maskWebhookUrl never contains the secret', () => {
  const m = maskWebhookUrl(OURS);
  eq(m, `${BASE}/switchbot-webhook/aaaa…(64)`, 'masked');
  if (m.includes(SECRET)) throw new Error('leak');
  eq(maskWebhookUrl('https://x.example/hook?k=secret'), 'https://x.example/…?…', 'short segment and query masked');
  eq(redact(`setup failed for ${OURS}`, [SECRET]), `setup failed for ${BASE}/switchbot-webhook/…`, 'redact');
});

Deno.test('parseQueryUrl / parseQueryDetails accept the documented shapes', () => {
  eq(parseQueryUrl({ urls: [OURS] }), [OURS], 'urls');
  eq(parseQueryUrl(null), [], 'null');
  const d = parseQueryDetails([{ url: OURS, enable: true, deviceList: 'ALL', createTime: 1, lastUpdateTime: 2 }]);
  eq(d, [{ url: OURS, enable: true, deviceList: 'ALL', createTime: 1, lastUpdateTime: 2 }], 'details');
});

Deno.test('planRegistration: noop, setup, enable, replace own stale URL, refuse foreign', () => {
  const o = { functionsBase: BASE };
  eq(planRegistration(OURS, [OURS], true, o), [{ op: 'noop' }], 'noop');
  eq(planRegistration(OURS, [], null, o), [{ op: 'setup', url: OURS }], 'setup');
  eq(planRegistration(OURS, [OURS], false, o), [{ op: 'enable', url: OURS }], 'enable');
  const old = `${BASE}/switchbot-webhook/oldsecret`;
  eq(planRegistration(OURS, [old], null, o), [{ op: 'remove', url: old }, { op: 'setup', url: OURS }], 'rotate');
  const ha = 'https://ha.example/api/webhook/x';
  eq(planRegistration(OURS, [ha], null, o)[0]?.op, 'refuse', 'foreign');
  eq(planRegistration(OURS, [ha], null, { ...o, replaceForeign: true }), [{ op: 'remove', url: ha }, { op: 'setup', url: OURS }], 'replace');
});
