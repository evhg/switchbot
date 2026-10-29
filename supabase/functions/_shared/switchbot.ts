// SwitchBot client whose daily call counter is shared across invocations via api_quota.
import { SwitchBotClient, SwitchBotError } from '../../../packages/core/src/switchbot/client.ts';
import { env, envNumber } from './env.ts';
import type { Db } from './supabase.ts';
import { utcDay } from './time.ts';

export interface QuotaSession {
  client: SwitchBotClient;
  /** Calls left before the local budget, as of the start of this invocation plus our own calls. */
  remaining(): number;
  /** Persists this invocation's calls and writes one api_quota_log row. */
  finish(status: string, note?: string): Promise<void>;
}

export async function switchBotSession(db: Db, fn: string): Promise<QuotaSession> {
  const day = utcDay(Date.now());
  const { data } = await db.from('api_quota').select('used').eq('api', 'switchbot').eq('day', day).maybeSingle();
  let calls = 0;
  const client = new SwitchBotClient({
    token: env('SWITCHBOT_TOKEN'),
    secret: env('SWITCHBOT_SECRET'),
    dailyBudget: envNumber('SWITCHBOT_DAILY_BUDGET', 5000),
    quota: { day, used: (data as { used?: number } | null)?.used ?? 0 },
    onQuota: () => {
      calls++;
    },
    // Edge Functions are short-lived; don't sit out long Retry-After waits.
    maxRetries: 1,
    maxRetryWaitMs: 5_000,
  });
  return {
    client,
    remaining: () => client.quota().remaining,
    async finish(status, note) {
      const q = client.quota();
      let usedToday: number | null = null;
      if (calls > 0) {
        const r = await db.rpc('bump_api_quota', { p_api: 'switchbot', p_day: q.day, p_calls: calls, p_server_remaining: q.serverRemaining });
        if (r.error) console.error('bump_api_quota', r.error.message);
        else usedToday = r.data as number;
      }
      const log = await db.from('api_quota_log').insert({
        api: 'switchbot',
        fn,
        calls,
        used_today: usedToday ?? q.used,
        server_remaining: q.serverRemaining,
        status,
        note: note ?? null,
      });
      if (log.error) console.error('api_quota_log', log.error.message);
    },
  };
}

export function errorStatus(e: unknown): string {
  return e instanceof SwitchBotError ? `error:${e.kind}` : 'error';
}
