import { handle } from './engine.ts';
import type { Dataset, DatasetChunk, EngineResponse, WorkerInbound } from './types.ts';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerInbound>) => void) | null;
  postMessage(msg: EngineResponse, transfer?: Transferable[]): void;
};

/**
 * Large datasets never go to the main thread in one message: deserialising ~12 MB of nights there froze the UI for
 * 0.3–0.8 s. Instead the multi-night results travel over a dedicated "bulk" port, as deltas (only nights the main
 * thread hasn't received yet, newest → oldest) in small chunks. The main thread reads that port lazily, when the
 * page isn't scrolling, one chunk per idle slot. The 1-night first preview and detail answers stay on the fast path.
 */
let bulk: MessagePort | null = null;
const CHUNK_NIGHTS = 6;

function isDataset(x: unknown): x is Dataset {
  return !!x && typeof x === 'object' && Array.isArray((x as Dataset).nights) && Array.isArray((x as Dataset).room);
}

/** Sends nights [0, N - sentNewest) as chunks (newest first), then a commit marker carrying the metadata. */
function sendDelta(id: number, ds: Dataset, sent: { n: number }, final: boolean, progress?: string) {
  const N = ds.nights.length;
  const port = bulk!;
  for (let end = N - sent.n; end > 0; end -= CHUNK_NIGHTS) {
    const from = Math.max(0, end - CHUNK_NIGHTS);
    const chunk: DatasetChunk = {
      nights: ds.nights.slice(from, end),
      room: ds.room.slice(from, end),
      person: Object.fromEntries(Object.entries(ds.person).map(([k, v]) => [k, v.slice(from, end)])),
    };
    port.postMessage({ id, chunk });
  }
  sent.n = N;
  const { nights: _n, room: _r, person: _p, ...meta } = ds;
  port.postMessage({ id, commit: { meta, total: N, final }, progress });
}

ctx.onmessage = async (e) => {
  const data = e.data;
  if ('bulkPort' in data) {
    bulk = data.bulkPort;
    return;
  }
  const { id, req } = data;
  const useBulk = !!bulk && (req.type === 'simulate' || req.type === 'compute');
  const sent = { n: 0 };
  try {
    const result = await handle(req, (m) => {
      if (useBulk && isDataset(m.partial) && sent.n > 0) return sendDelta(id, m.partial, sent, false, m.progress);
      if (isDataset(m.partial)) sent.n = m.partial.nights.length;
      if (useBulk && !m.partial) {
        // Progress lines follow the bulk stream so they stay ordered with it.
        bulk!.postMessage({ id, progress: m.progress });
        return;
      }
      ctx.postMessage({ id, stream: true, ...m });
    });
    if (useBulk && isDataset(result)) {
      // Cache hits arrive without previews: put the newest night on the fast path first so it paints at once.
      if (sent.n === 0 && result.nights.length) {
        const N = result.nights.length;
        const preview: Dataset = {
          ...result,
          nights: result.nights.slice(N - 1),
          room: result.room.slice(N - 1),
          person: Object.fromEntries(Object.entries(result.person).map(([k, v]) => [k, v.slice(N - 1)])),
          partial: true,
        };
        ctx.postMessage({ id, stream: true, partial: preview });
        sent.n = 1;
      }
      sendDelta(id, result, sent, true);
    }
    else ctx.postMessage({ id, ok: true, result });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
