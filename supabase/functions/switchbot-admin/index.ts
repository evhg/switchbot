// SwitchBot account administration, called by pg_cron / SQL (x-cron-secret) or with the service key:
//   {"action":"status"}            → the registered webhook URL(s) and their details, masked.
//   {"action":"register-webhook"}  → makes <functions>/switchbot-webhook/<vault secret> the account's single,
//                                    enabled webhook (no-op when it already is), then confirms with queryDetails.
//                                    Add "replace":true to take over a URL owned by another integration.
//   {"action":"devices"}           → the account's devices and IR remotes (ids, names, types); nothing is stored.
//   {"action":"ac-test", "param":"18,2,1,on"}  → one setAll to the aircon remote (AC_DEVICE_ID / discovered), for a
//                                    daytime remote test. 17..30 °C only (the Carrier remote cannot encode 16).
//   {"action":"ac-test", "button":"C17", "deviceId":"…"}  → one learned button (customize) on a remote of this account.
//                                    Test sends are not logged in ac_commands, so they never steer the controller.
// The path secret is the Vault secret `switchbot_webhook_secret` (migration 0008); it never leaves this function
// unmasked. SwitchBot calls go through the quota session, so they are counted in api_quota.
//
// Trigger from SQL: select private.invoke_edge_function('switchbot-admin', '{"action":"register-webhook"}', 30000);
import { SwitchBotError } from '../../../packages/core/src/switchbot/client.ts';
import { requireCron } from '../_shared/auth.ts';
import { knownDeviceId } from '../_shared/devices.ts';
import { functionsBaseUrl, optEnv } from '../_shared/env.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { type Db, serviceClient } from '../_shared/supabase.ts';
import { errorStatus, type QuotaSession, switchBotSession } from '../_shared/switchbot.ts';
import {
  maskWebhookUrl,
  parseQueryDetails,
  parseQueryUrl,
  planRegistration,
  redact,
  type RegistrationStep,
  webhookUrl,
  type WebhookDetail,
} from '../_shared/webhook.ts';

interface WebhookState {
  urls: string[];
  details: WebhookDetail[];
}

async function readState(sb: QuotaSession): Promise<WebhookState> {
  let urls: string[];
  try {
    urls = parseQueryUrl(await sb.client.queryWebhook());
  } catch (e) {
    // queryUrl answers statusCode 190 when the account has no webhook at all; treat that as "none registered".
    if (e instanceof SwitchBotError && e.statusCode === 190) urls = [];
    else throw e;
  }
  const details = urls.length ? parseQueryDetails(await sb.client.queryWebhook(urls)) : [];
  return { urls, details };
}

function sanitize(state: WebhookState, ours: string) {
  return {
    registered: state.urls.map((u) => {
      const d = state.details.find((x) => x.url === u);
      return {
        url: maskWebhookUrl(u),
        ours: u === ours,
        enable: d?.enable ?? null,
        deviceList: d?.deviceList ?? null,
        createTime: d?.createTime ? new Date(d.createTime).toISOString() : null,
        lastUpdateTime: d?.lastUpdateTime ? new Date(d.lastUpdateTime).toISOString() : null,
      };
    }),
  };
}

const maskStep = (s: RegistrationStep) =>
  s.op === 'refuse' ? { ...s, foreign: s.foreign.map(maskWebhookUrl) } : 'url' in s ? { ...s, url: maskWebhookUrl(s.url) } : s;

serve(async (req) => {
  const db = serviceClient();
  await requireCron(req, db);
  const body = await readJson(req);
  const action = body.action;
  if (action === 'devices' || action === 'ac-test') return remoteAction(db, action, body);
  if (action !== 'status' && action !== 'register-webhook') {
    throw new HttpError(400, 'action must be "status", "register-webhook", "devices" or "ac-test"');
  }

  const { data: secret, error } = await db.rpc('switchbot_webhook_secret');
  if (error) throw new Error(`switchbot_webhook_secret: ${error.message}`);
  if (typeof secret !== 'string' || secret.length < 32) {
    return json({ ok: false, error: 'vault secret switchbot_webhook_secret is missing (apply migration 0008)' }, 503);
  }
  const base = functionsBaseUrl();
  const ours = webhookUrl(base, secret);
  const secrets = [secret, optEnv('WEBHOOK_SECRET') ?? ''];
  const sb = await switchBotSession(db, 'switchbot-admin');

  try {
    const before = await readState(sb);
    if (action === 'status') {
      await sb.finish('ok', 'status');
      return json({ ok: true, url: maskWebhookUrl(ours), ...sanitize(before, ours), quota: sb.client.quota() });
    }

    const oursEnabled = before.details.find((d) => d.url === ours)?.enable ?? null;
    const steps = planRegistration(ours, before.urls, oursEnabled, { functionsBase: base, replaceForeign: body.replace === true });
    const refused = steps.find((s) => s.op === 'refuse');
    if (refused) {
      await sb.finish('skipped:foreign-webhook', `${before.urls.length} url(s) registered`);
      return json({ ok: false, steps: steps.map(maskStep), before: sanitize(before, ours) }, 409);
    }
    if (steps[0]?.op === 'noop') {
      await sb.finish('ok', 'register-webhook: already registered and enabled');
      return json({ ok: true, changed: false, url: maskWebhookUrl(ours), ...sanitize(before, ours), quota: sb.client.quota() });
    }

    for (const s of steps) {
      if (s.op === 'remove') await sb.client.deleteWebhook(s.url);
      else if (s.op === 'setup') await sb.client.setupWebhook(s.url);
      else if (s.op === 'enable') await sb.client.updateWebhook(s.url, true);
    }
    const after = await readState(sb);
    const confirmed = after.details.find((d) => d.url === ours)?.enable === true;
    await sb.finish(confirmed ? 'ok' : 'error:unconfirmed', `register-webhook: ${steps.map((s) => s.op).join(',')}`);
    return json(
      { ok: confirmed, changed: true, url: maskWebhookUrl(ours), steps: steps.map(maskStep), before: sanitize(before, ours), after: sanitize(after, ours), quota: sb.client.quota() },
      confirmed ? 200 : 502,
    );
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e), secrets);
    await sb.finish(errorStatus(e), msg.slice(0, 300));
    return json({ ok: false, error: msg }, 502);
  }
});

const SETALL_TEST = /^(1[7-9]|2\d|30),[1-5],[1-4],(on|off)$/;
const BUTTON = /^[A-Za-z0-9 _+-]{1,32}$/;

async function remoteAction(db: Db, action: 'devices' | 'ac-test', body: Record<string, unknown>) {
  const sb = await switchBotSession(db, 'switchbot-admin');
  try {
    const { deviceList = [], infraredRemoteList = [] } = await sb.client.listDevices();
    if (action === 'devices') {
      await sb.finish('ok', 'devices');
      return json({
        ok: true,
        devices: deviceList.map((d) => ({ id: d.deviceId, name: d.deviceName, type: d.deviceType, hub: d.hubDeviceId ?? null })),
        remotes: infraredRemoteList.map((r) => ({ id: r.deviceId, name: r.deviceName, type: r.remoteType, hub: r.hubDeviceId ?? null })),
        quota: sb.client.quota(),
      });
    }
    let deviceId: string | null;
    let cmd: { command: string; parameter: string; commandType: 'command' | 'customize' };
    if (typeof body.param === 'string') {
      if (!SETALL_TEST.test(body.param)) throw new HttpError(400, 'param must be "temp,mode,fan,on|off" with temp 17..30');
      deviceId = await knownDeviceId(db, 'ac');
      cmd = { command: 'setAll', parameter: body.param, commandType: 'command' };
    } else if (typeof body.button === 'string' && BUTTON.test(body.button)) {
      deviceId = typeof body.deviceId === 'string' ? body.deviceId : await knownDeviceId(db, 'ac');
      cmd = { command: body.button, parameter: 'default', commandType: 'customize' };
    } else {
      throw new HttpError(400, 'ac-test needs "param" (setAll) or "button" (learned button)');
    }
    if (!deviceId || !infraredRemoteList.some((r) => r.deviceId === deviceId)) {
      throw new HttpError(400, 'no such IR remote on this account');
    }
    const res = await sb.client.sendCommand(deviceId, cmd);
    console.log('switchbot ac-test', JSON.stringify({ deviceId, ...cmd }), JSON.stringify(res));
    await sb.finish('ok', `ac-test ${cmd.command} ${cmd.parameter}`);
    return json({ ok: true, sentAt: new Date().toISOString(), deviceId, ...cmd, response: res, quota: sb.client.quota() });
  } catch (e) {
    if (e instanceof HttpError) {
      await sb.finish('skipped:bad-request', e.message);
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    await sb.finish(errorStatus(e), msg.slice(0, 300));
    return json({ ok: false, error: msg }, 502);
  }
}
