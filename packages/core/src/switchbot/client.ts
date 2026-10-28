// SwitchBot OpenAPI v1.1 client. See docs/research/openapi.md.
import type { AcCommand, AcState, Ms } from '../types.ts';
import { acStateToSetAllParam, toSwitchBotCommand, type SwitchBotCommandBody } from './ac.ts';
import { switchBotSignHeaders, type FetchLike } from './sign.ts';

export const SWITCHBOT_BASE_URL = 'https://api.switch-bot.com/v1.1';
/** Server limit is 10,000/day, but resets have been skipped (issue #518); budget well under it. */
export const SWITCHBOT_DEFAULT_DAILY_BUDGET = 5000;

export type SwitchBotErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'budget'
  | 'device_type'
  | 'not_found'
  | 'unsupported'
  | 'offline'
  | 'internal'
  | 'http'
  | 'bad_response';

const STATUS_KINDS: Record<number, [SwitchBotErrorKind, string]> = {
  151: ['device_type', 'device type error'],
  152: ['not_found', 'device not found'],
  160: ['unsupported', 'command is not supported'],
  // 171 is sometimes returned when the device (not the hub) is offline, so both map to 'offline'.
  161: ['offline', 'device offline'],
  171: ['offline', 'hub offline'],
  190: ['internal', 'device internal error or invalid command format'],
};

export class SwitchBotError extends Error {
  /** HTTP status. */
  status?: number;
  /** SwitchBot envelope statusCode. */
  statusCode?: number;
  kind: SwitchBotErrorKind;
  retryAfterMs?: number;

  constructor(message: string, kind: SwitchBotErrorKind, extra: { status?: number; statusCode?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'SwitchBotError';
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.statusCode !== undefined) this.statusCode = extra.statusCode;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

export interface SwitchBotDevice {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  hubDeviceId?: string;
  enableCloudService?: boolean;
  [k: string]: unknown;
}

export interface SwitchBotIrRemote {
  deviceId: string;
  deviceName: string;
  remoteType: string;
  hubDeviceId?: string;
  [k: string]: unknown;
}

export interface SwitchBotScene {
  sceneId: string;
  sceneName: string;
}

export interface QuotaState {
  /** UTC date (YYYY-MM-DD) the local counter belongs to. The server reset time is undocumented. */
  day: string;
  used: number;
}

export interface QuotaInfo extends QuotaState {
  budget: number;
  remaining: number;
  /** Last X-RateLimit-Remaining seen, if the server sent one. */
  serverRemaining: number | null;
}

export interface SwitchBotClientOptions {
  token: string;
  secret: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Local daily call budget; the client throws a 'budget' error before exceeding it. Default 5000. */
  dailyBudget?: number;
  /** Seed the counter (e.g. loaded from the database) so serverless invocations share a budget. */
  quota?: QuotaState;
  /** Called after each counted request, to persist the counter. */
  onQuota?: (q: QuotaInfo) => void;
  /** Retries for 429 / 5xx. Default 2. */
  maxRetries?: number;
  /** Don't sleep longer than this for a single retry; a longer Retry-After throws instead. Default 30 s. */
  maxRetryWaitMs?: number;
  now?: () => Ms;
  sleep?: (ms: number) => Promise<void>;
}

const utcDay = (ms: Ms) => new Date(ms).toISOString().slice(0, 10);

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(v: string | null, now: Ms): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - now) : null;
}

export class SwitchBotClient {
  private readonly token: string;
  private readonly secret: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly budget: number;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;
  private readonly now: () => Ms;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onQuota?: (q: QuotaInfo) => void;
  private q: QuotaState;
  private serverRemaining: number | null = null;

  constructor(opts: SwitchBotClientOptions) {
    this.token = opts.token;
    this.secret = opts.secret;
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
    this.baseUrl = (opts.baseUrl ?? SWITCHBOT_BASE_URL).replace(/\/$/, '');
    this.budget = opts.dailyBudget ?? SWITCHBOT_DEFAULT_DAILY_BUDGET;
    this.maxRetries = opts.maxRetries ?? 2;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (opts.onQuota) this.onQuota = opts.onQuota;
    this.q = opts.quota ? { ...opts.quota } : { day: utcDay(this.now()), used: 0 };
  }

  quota(): QuotaInfo {
    this.rollDay();
    return { ...this.q, budget: this.budget, remaining: Math.max(0, this.budget - this.q.used), serverRemaining: this.serverRemaining };
  }

  private rollDay() {
    const d = utcDay(this.now());
    if (d !== this.q.day) this.q = { day: d, used: 0 };
  }

  /** Low-level request. Returns the envelope `body` on statusCode 100, throws SwitchBotError otherwise. */
  async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.rollDay();
      if (this.q.used >= this.budget) {
        throw new SwitchBotError(`local daily budget of ${this.budget} calls reached`, 'budget');
      }
      const headers = await switchBotSignHeaders(this.token, this.secret, { t: this.now() });
      this.q.used++;
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await this.fetchImpl(this.baseUrl + path, init);

      const rem = res.headers.get('X-RateLimit-Remaining');
      if (rem !== null && Number.isFinite(Number(rem))) this.serverRemaining = Number(rem);
      this.onQuota?.(this.quota());

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseRetryAfter(res.headers.get('Retry-After'), this.now());
        const wait = retryAfter ?? 1000 * 2 ** attempt;
        // A 5xx on a POST may still have reached the hub (an IR command would fire twice), so only GETs and 429s retry.
        const retryable = res.status === 429 || method === 'GET';
        if (retryable && attempt < this.maxRetries && wait <= this.maxRetryWaitMs && this.serverRemaining !== 0) {
          await this.sleep(wait);
          continue;
        }
        const extra: { status: number; retryAfterMs?: number } = { status: res.status };
        if (retryAfter !== null) extra.retryAfterMs = retryAfter;
        throw res.status === 429
          ? new SwitchBotError('rate limited (HTTP 429); may be throttling or daily quota', 'rate_limit', extra)
          : new SwitchBotError(`HTTP ${res.status}`, 'http', extra);
      }
      if (res.status === 401) {
        // The README says an exhausted quota also returns 401.
        throw this.serverRemaining === 0
          ? new SwitchBotError('daily quota exhausted (HTTP 401)', 'rate_limit', { status: 401 })
          : new SwitchBotError('unauthorized: bad token/secret or quota exhausted', 'auth', { status: 401 });
      }
      if (!res.ok) throw new SwitchBotError(`HTTP ${res.status}`, 'http', { status: res.status });

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new SwitchBotError('response is not JSON', 'bad_response', { status: res.status });
      }
      const env = (typeof json === 'object' && json !== null ? json : {}) as { statusCode?: unknown; message?: unknown; body?: unknown };
      const code = typeof env.statusCode === 'number' ? env.statusCode : undefined;
      if (code === 100) return env.body as T;
      const msg = typeof env.message === 'string' ? env.message : '';
      if (code === undefined) throw new SwitchBotError(`missing statusCode${msg ? `: ${msg}` : ''}`, 'bad_response', { status: res.status });
      const [kind, text] = STATUS_KINDS[code] ?? ['http', 'unexpected statusCode'];
      throw new SwitchBotError(`${code} ${text}${msg ? `: ${msg}` : ''}`, kind, { status: res.status, statusCode: code });
    }
  }

  listDevices() {
    return this.request<{ deviceList: SwitchBotDevice[]; infraredRemoteList: SwitchBotIrRemote[] }>('GET', '/devices');
  }

  getStatus<T = Record<string, unknown>>(deviceId: string) {
    return this.request<T>('GET', `/devices/${encodeURIComponent(deviceId)}/status`);
  }

  sendCommand(deviceId: string, cmd: { command: string; parameter?: string; commandType?: 'command' | 'customize' }) {
    const body: SwitchBotCommandBody = { command: cmd.command, parameter: cmd.parameter ?? 'default', commandType: cmd.commandType ?? 'command' };
    return this.request<unknown>('POST', `/devices/${encodeURIComponent(deviceId)}/commands`, body);
  }

  setAll(deviceId: string, state: AcState) {
    return this.sendCommand(deviceId, { command: 'setAll', parameter: acStateToSetAllParam(state), commandType: 'command' });
  }

  /** Sends a learned button; `button` must match the name in the app exactly. */
  customize(deviceId: string, button: string) {
    return this.sendCommand(deviceId, { command: button, parameter: 'default', commandType: 'customize' });
  }

  turnOn(deviceId: string) {
    return this.sendCommand(deviceId, { command: 'turnOn' });
  }

  turnOff(deviceId: string) {
    return this.sendCommand(deviceId, { command: 'turnOff' });
  }

  sendAcCommand(deviceId: string, cmd: AcCommand) {
    return this.sendCommand(deviceId, toSwitchBotCommand(cmd));
  }

  listScenes() {
    return this.request<SwitchBotScene[]>('GET', '/scenes');
  }

  executeScene(sceneId: string) {
    return this.request<unknown>('POST', `/scenes/${encodeURIComponent(sceneId)}/execute`);
  }

  /** Only deviceList 'ALL' is supported; in practice one URL per account. */
  setupWebhook(url: string) {
    return this.request<unknown>('POST', '/webhook/setupWebhook', { action: 'setupWebhook', url, deviceList: 'ALL' });
  }

  /** Without `urls`: action queryUrl (registered URLs). With `urls`: action queryDetails. */
  queryWebhook(urls?: string[]) {
    return this.request<unknown>(
      'POST',
      '/webhook/queryWebhook',
      urls ? { action: 'queryDetails', urls } : { action: 'queryUrl' },
    );
  }

  updateWebhook(url: string, enable: boolean) {
    return this.request<unknown>('POST', '/webhook/updateWebhook', { action: 'updateWebhook', config: { url, enable } });
  }

  deleteWebhook(url: string) {
    return this.request<unknown>('POST', '/webhook/deleteWebhook', { action: 'deleteWebhook', url });
  }
}
