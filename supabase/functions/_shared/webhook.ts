// Pure helpers for the SwitchBot webhook URL: path-secret extraction, masking, parsing queryWebhook replies and
// planning a (re)registration. Runtime-neutral (no Deno globals, no I/O), unit-tested in tests/webhook.test.ts.

/** The candidate secret of a webhook request: `?token=` if present, else the last path segment. */
export function webhookSecretCandidates(reqUrl: string): string[] {
  const url = new URL(reqUrl);
  const out: string[] = [];
  const q = url.searchParams.get('token');
  if (q) out.push(q);
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (last && last !== 'switchbot-webhook') out.push(decodeURIComponent(last));
  return out;
}

/** `<base>/switchbot-webhook/<secret>`. */
export function webhookUrl(functionsBase: string, secret: string): string {
  return `${functionsBase.replace(/\/$/, '')}/switchbot-webhook/${encodeURIComponent(secret)}`;
}

/** Hides the last path segment and any query: `…/switchbot-webhook/ab12…(64)`. Never returns a secret. */
export function maskWebhookUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const parts = u.pathname.split('/');
    const last = parts.pop() ?? '';
    const masked = last.length > 8 ? `${last.slice(0, 4)}…(${last.length})` : last ? '…' : '';
    return `${u.origin}${[...parts, masked].join('/')}${u.search ? '?…' : ''}`;
  } catch {
    return '(unparseable url)';
  }
}

/** Replaces every occurrence of each secret in a string (for error messages that echo a URL). */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('…');
  return out;
}

/** queryUrl reply body → registered URLs. Accepts `{urls:[…]}`, a bare array or a single string. */
export function parseQueryUrl(body: unknown): string[] {
  const urls = Array.isArray(body) ? body : (body as { urls?: unknown } | null)?.urls;
  if (typeof urls === 'string') return [urls];
  return Array.isArray(urls) ? urls.filter((u): u is string => typeof u === 'string' && u !== '') : [];
}

export interface WebhookDetail {
  url: string;
  enable: boolean | null;
  deviceList: string | null;
  createTime: number | null;
  lastUpdateTime: number | null;
}

/** queryDetails reply body (array of configs, or `{urls|details:[…]}`) → details. */
export function parseQueryDetails(body: unknown): WebhookDetail[] {
  const list = Array.isArray(body)
    ? body
    : (body as { details?: unknown; urls?: unknown } | null)?.details ?? (body as { urls?: unknown } | null)?.urls;
  if (!Array.isArray(list)) return [];
  const out: WebhookDetail[] = [];
  for (const it of list) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    if (typeof o.url !== 'string') continue;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    out.push({
      url: o.url,
      enable: typeof o.enable === 'boolean' ? o.enable : o.enable === 'true' ? true : o.enable === 'false' ? false : null,
      deviceList: typeof o.deviceList === 'string' ? o.deviceList : null,
      createTime: n(o.createTime),
      lastUpdateTime: n(o.lastUpdateTime),
    });
  }
  return out;
}

export type RegistrationStep =
  | { op: 'noop' }
  | { op: 'enable'; url: string }
  | { op: 'remove'; url: string }
  | { op: 'setup'; url: string }
  | { op: 'refuse'; reason: string; foreign: string[] };

/**
 * What to do to end with exactly `ours` registered and enabled. SwitchBot accepts one URL per account in
 * practice and updateWebhook only toggles `enable`, so a different URL is removed before setupWebhook.
 * A URL that is not one of this project's switchbot-webhook endpoints (another integration, e.g. Home
 * Assistant) is only replaced when `replaceForeign` is set.
 */
export function planRegistration(
  ours: string,
  registered: string[],
  oursEnabled: boolean | null,
  { functionsBase, replaceForeign = false }: { functionsBase: string; replaceForeign?: boolean },
): RegistrationStep[] {
  const ownPrefix = `${functionsBase.replace(/\/$/, '')}/switchbot-webhook`;
  const others = registered.filter((u) => u !== ours);
  const foreign = others.filter((u) => !u.startsWith(ownPrefix));
  if (foreign.length && !replaceForeign) {
    return [{ op: 'refuse', reason: 'another integration owns the SwitchBot webhook; pass replace:true to take it over', foreign }];
  }
  const steps: RegistrationStep[] = others.map((url) => ({ op: 'remove', url }));
  if (!registered.includes(ours)) steps.push({ op: 'setup', url: ours });
  else if (oursEnabled !== true) steps.push({ op: 'enable', url: ours });
  return steps.length ? steps : [{ op: 'noop' }];
}
