import { chunkRows } from '../_shared/chunks.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

Deno.test('chunkRows caps rows per statement (48 h of 1-min heart rate → 6 statements)', () => {
  const rows = Array.from({ length: 2880 }, (_, i) => ({ person_id: 'a', ts: new Date(Date.UTC(2026, 9, 30) + i * 60_000).toISOString(), bpm: 60, n: 12 }));
  const parts = chunkRows(rows, { maxRows: 500 });
  assert(parts.length === 6 && parts[0]!.length === 500 && parts[5]!.length === 380, `sizes ${parts.map((p) => p.length)}`);
  assert(parts.flat().every((r, i) => r === rows[i]), 'order kept');
});

Deno.test('chunkRows also caps bytes: big hourly raw_health chunks go a few per statement', () => {
  const hour = { person_id: 'a', data_type: 'heart-rate', payload: { points: 'x'.repeat(400_000) } };
  const parts = chunkRows(Array.from({ length: 48 }, () => hour), { maxRows: 500, maxBytes: 1_000_000 });
  assert(parts.length === 24 && parts.every((p) => p.length === 2), `sizes ${parts.map((p) => p.length)}`);
  const huge = chunkRows([{ p: 'y'.repeat(2_000_000) }, { p: 'z' }], { maxBytes: 1_000_000 });
  assert(huge.length === 2 && huge[0]!.length === 1, 'an oversized row gets its own chunk');
  assert(chunkRows([]).length === 0, 'empty');
});
