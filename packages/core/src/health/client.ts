// Google Health API v4 client. See docs/research/health-data.md §2.4.
import type { Ms } from '../types.ts';
import type { FetchLike } from '../switchbot/sign.ts';

export const GOOGLE_HEALTH_BASE_URL = 'https://health.googleapis.com/v4';

export type DataSourceFamily = 'all-sources' | 'google-wearables' | 'google-sources' | 'self-sources';

export interface ListDataPointsOptions {
  /** AIP-160 expression with snake_case paths, e.g. sampleTimeFilter('heart-rate', from, to). */
  filter?: string;
  /** Default 1440, max 10000; sleep/exercise max 25. */
  pageSize?: number;
  pageToken?: string;
  /** Not supported for sleep. Short names are expanded to users/me/dataSourceFamilies/<name>. */
  dataSourceFamily?: DataSourceFamily | string;
}

export interface DataPointsPage {
  dataPoints?: unknown[];
  nextPageToken?: string;
  [k: string]: unknown;
}

export class GoogleHealthError extends Error {
  status: number;
  /** google.rpc status string, e.g. 'FAILED_PRECONDITION' (412 = no Google Health profile yet). */
  code?: string;
  retryAfterMs?: number;
  body?: unknown;

  constructor(message: string, status: number, extra: { code?: string; retryAfterMs?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'GoogleHealthError';
    this.status = status;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
    if (extra.body !== undefined) this.body = extra.body;
  }
}

const iso = (ms: Ms) => new Date(ms).toISOString();
const snake = (dataType: string) => dataType.replace(/-/g, '_');

/** `{type}.sample_time.physical_time` in [from, to). For heart-rate, heart-rate-variability, oxygen-saturation. */
export function sampleTimeFilter(dataType: string, from: Ms, to: Ms): string {
  const f = `${snake(dataType)}.sample_time.physical_time`;
  return `${f} >= "${iso(from)}" AND ${f} < "${iso(to)}"`;
}

/** `{type}.interval.<field>` in [from, to). For sleep, use field 'end_time' to catch sessions ending in the window. */
export function intervalFilter(dataType: string, from: Ms, to: Ms, field: 'start_time' | 'end_time' = 'start_time'): string {
  const f = `${snake(dataType)}.interval.${field}`;
  return `${f} >= "${iso(from)}" AND ${f} < "${iso(to)}"`;
}

export interface GoogleHealthClientOptions {
  baseUrl?: string;
  /** Retries for 429 / 5xx. Default 2. */
  maxRetries?: number;
  maxRetryWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class GoogleHealthClient {
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    accessToken: string,
    fetchImpl?: FetchLike,
    opts: GoogleHealthClientOptions = {},
  ) {
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl ?? ((i, init) => fetch(i, init));
    this.baseUrl = (opts.baseUrl ?? GOOGLE_HEALTH_BASE_URL).replace(/\/$/, '');
    this.maxRetries = opts.maxRetries ?? 2;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async get<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const url = `${this.baseUrl}${path}${qs.size ? `?${qs}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' } });
      if (res.ok) return (await res.json()) as T;
      const ra = res.headers.get('Retry-After');
      const retryAfter = ra !== null && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : undefined;
      const wait = retryAfter ?? 1000 * 2 ** attempt;
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries && wait <= this.maxRetryWaitMs) {
        await this.sleep(wait);
        continue;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const err = (body as { error?: { message?: string; status?: string } } | undefined)?.error;
      const extra: { code?: string; retryAfterMs?: number; body?: unknown } = { body };
      if (err?.status) extra.code = err.status;
      if (retryAfter !== undefined) extra.retryAfterMs = retryAfter;
      throw new GoogleHealthError(`Google Health ${res.status}${err?.message ? `: ${err.message}` : ''}`, res.status, extra);
    }
  }

  private dpQuery(opts: ListDataPointsOptions) {
    const fam = opts.dataSourceFamily;
    return {
      filter: opts.filter,
      pageSize: opts.pageSize,
      pageToken: opts.pageToken,
      dataSourceFamily: fam && !fam.includes('/') ? `users/me/dataSourceFamilies/${fam}` : fam,
    };
  }

  /** Raw points with per-point dataSource. Results are ordered newest first. */
  listDataPoints(dataType: string, opts: ListDataPointsOptions = {}): Promise<DataPointsPage> {
    return this.get(`/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints`, this.dpQuery(opts));
  }

  /** Merged stream, deduplicated across devices. */
  reconcileDataPoints(dataType: string, opts: ListDataPointsOptions = {}): Promise<DataPointsPage> {
    return this.get(`/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:reconcile`, this.dpQuery(opts));
  }

  /** Yields each page until nextPageToken is empty (or maxPages is hit). */
  async *paginate(
    dataType: string,
    opts: ListDataPointsOptions = {},
    { reconcile = false, maxPages = 100 }: { reconcile?: boolean; maxPages?: number } = {},
  ): AsyncGenerator<DataPointsPage> {
    let pageToken = opts.pageToken;
    for (let i = 0; i < maxPages; i++) {
      const q: ListDataPointsOptions = { ...opts };
      if (pageToken) q.pageToken = pageToken;
      const page = reconcile ? await this.reconcileDataPoints(dataType, q) : await this.listDataPoints(dataType, q);
      yield page;
      pageToken = page.nextPageToken;
      if (!pageToken) return;
    }
  }

  /** All points across pages, flattened. */
  async listAll(dataType: string, opts: ListDataPointsOptions = {}, paging: { reconcile?: boolean; maxPages?: number } = {}): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const page of this.paginate(dataType, opts, paging)) out.push(...(page.dataPoints ?? []));
    return out;
  }

  /** {name, legacyUserId, healthUserId}. */
  identity(): Promise<{ name?: string; legacyUserId?: string; healthUserId?: string; [k: string]: unknown }> {
    return this.get('/users/me/identity');
  }

  /** Battery and lastSyncTime per paired device. */
  pairedDevices(): Promise<{ pairedDevices?: unknown[]; [k: string]: unknown }> {
    return this.get('/users/me/pairedDevices');
  }
}
