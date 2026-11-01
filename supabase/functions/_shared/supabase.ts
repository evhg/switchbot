import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { chunkRows } from './chunks.ts';
import { env, serviceKey } from './env.ts';

// Untyped client: row shapes live in rows.ts.
// deno-lint-ignore no-explicit-any
export type Db = SupabaseClient<any, 'public', any>;

let cached: Db | undefined;

/** Service-role client (bypasses RLS). Never expose its key to the browser. */
export function serviceClient(): Db {
  cached ??= createClient(env('SUPABASE_URL'), serviceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as Db;
  return cached;
}

interface PgResult<T> {
  data: T | null;
  error: { message: string } | null;
}

/** Unwraps a PostgREST result or throws with context. */
export function must<T>(res: PgResult<T>, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

/** Pages through a query with .range() (PostgREST caps responses at max_rows, 1000 by default). */
export async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<PgResult<T[]>>,
  what: string,
  { pageSize = 1000, maxRows = 100_000 } = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const rows = must(await page(from, from + pageSize - 1), what) ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

/**
 * Upserts in chunks: at most `chunk` rows and about `maxBytes` of JSON per statement (see chunks.ts), so large batches
 * (a 48 h heart-rate backfill) stay well under the request body limit and the statement timeout.
 */
export async function upsertChunks(
  db: Db,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  { ignoreDuplicates = false, chunk = 500, maxBytes = 1_000_000 } = {},
): Promise<number> {
  for (const part of chunkRows(rows, { maxRows: chunk, maxBytes })) {
    const res = await db.from(table).upsert(part, { onConflict, ignoreDuplicates });
    if (res.error) throw new Error(`upsert ${table}: ${res.error.message}`);
  }
  return rows.length;
}
