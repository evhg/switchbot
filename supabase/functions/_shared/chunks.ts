// Splits rows for bulk writes: at most `maxRows` rows and about `maxBytes` of JSON per statement. Heart-rate archive
// rows (raw_health) are hourly chunks of 1 Hz points, several hundred KB each, so a row cap alone still sent a 48 h
// batch as one multi-MB statement that ran into the statement timeout.

export interface ChunkOptions {
  maxRows?: number;
  maxBytes?: number;
}

/** Consecutive, order-preserving chunks; a single row larger than maxBytes gets a chunk of its own. */
export function chunkRows<T>(rows: readonly T[], { maxRows = 500, maxBytes = 1_000_000 }: ChunkOptions = {}): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const r of rows) {
    const size = JSON.stringify(r)?.length ?? 0;
    if (cur.length && (cur.length >= maxRows || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}
