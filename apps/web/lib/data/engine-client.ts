// Runs engine requests in a Web Worker (keeps the UI responsive on phones); falls back to the main thread.
import type { BulkMessage, Dataset, DatasetChunk, EngineEmit, EngineRequest, EngineResponse } from './types.ts';

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; emit?: EngineEmit }>();
let mainThreadState = false;

/** Per request: the dataset assembled so far from the bulk stream (newest nights first to arrive). */
const acc = new Map<number, DatasetChunk>();

// ---------- lazy bulk intake ----------
// MessageEvent.data is deserialised on first access, on the main thread. Bulk chunks (~6 nights each) are therefore
// queued untouched and opened one per idle slot, never while the page is scrolling, so a scroll that starts right
// after first paint is not frozen by data arriving.
const queue: MessageEvent<BulkMessage>[] = [];
let lastScroll = 0;
let scheduled = false;
let firstQueuedAt = 0;
type IdleWin = Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };

function listenScroll() {
  if (typeof window === 'undefined') return;
  const mark = () => void (lastScroll = performance.now());
  window.addEventListener('scroll', mark, { passive: true, capture: true });
  window.addEventListener('touchmove', mark, { passive: true });
  window.addEventListener('wheel', mark, { passive: true });
}

function schedule() {
  if (scheduled || !queue.length) return;
  scheduled = true;
  const w = window as IdleWin;
  const run = () => {
    scheduled = false;
    const now = performance.now();
    // Hold off while scrolling (up to 4 s; the data must land eventually).
    if (now - lastScroll < 220 && now - firstQueuedAt < 4000) {
      scheduled = true;
      window.setTimeout(() => {
        scheduled = false;
        schedule();
      }, 160);
      return;
    }
    const ev = queue.shift();
    if (ev) applyBulk(ev.data);
    if (queue.length) schedule();
    else firstQueuedAt = 0;
  };
  if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 600 });
  else window.setTimeout(run, 16);
}

function seed(id: number, ds: Dataset) {
  acc.set(id, { nights: ds.nights, room: ds.room, person: ds.person });
}

function applyBulk(msg: BulkMessage) {
  const p = pending.get(msg.id);
  if (!p) return;
  if ('chunk' in msg) {
    const a = acc.get(msg.id) ?? { nights: [], room: [], person: {} };
    const person: DatasetChunk['person'] = {};
    for (const k of new Set([...Object.keys(a.person), ...Object.keys(msg.chunk.person)]))
      person[k] = (msg.chunk.person[k] ?? []).concat(a.person[k] ?? []);
    acc.set(msg.id, { nights: msg.chunk.nights.concat(a.nights), room: msg.chunk.room.concat(a.room), person });
    return;
  }
  if ('commit' in msg) {
    const a = acc.get(msg.id) ?? { nights: [], room: [], person: {} };
    const ds = { ...msg.commit.meta, nights: a.nights, room: a.room, person: a.person } as Dataset;
    if (msg.commit.final) {
      acc.delete(msg.id);
      pending.delete(msg.id);
      const { partial: _drop, ...full } = ds;
      p.resolve(full);
      return;
    }
    p.emit?.({ partial: { ...ds, partial: true }, progress: msg.progress });
    return;
  }
  if (msg.progress) p.emit?.({ progress: msg.progress });
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<EngineResponse>) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if ('stream' in msg) {
        if (msg.partial) seed(msg.id, msg.partial as Dataset);
        p.emit?.({ partial: msg.partial, progress: msg.progress });
        return;
      }
      pending.delete(msg.id);
      acc.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker?.terminate();
      worker = null;
      queue.length = 0;
      acc.clear();
      for (const [, p] of pending) p.reject(new Error('worker failed'));
      pending.clear();
    };
    if (typeof MessageChannel !== 'undefined') {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e: MessageEvent<BulkMessage>) => {
        if (!queue.length) firstQueuedAt = performance.now();
        queue.push(e);
        schedule();
      };
      worker.postMessage({ bulkPort: ch.port2 }, [ch.port2]);
      listenScroll();
    }
  } catch {
    worker = null;
  }
  return worker;
}

async function onMainThread<T>(req: EngineRequest, emit?: EngineEmit): Promise<T> {
  mainThreadState = true;
  const { handle } = await import('./engine.ts');
  await new Promise((r) => setTimeout(r, 0));
  return (await handle(req, emit)) as T;
}

/** `emit` receives streamed partial results / progress lines (simulate only). */
export async function runEngine<T>(req: EngineRequest, emit?: EngineEmit): Promise<T> {
  // Detail requests must go where the dataset lives.
  if (mainThreadState) return onMainThread<T>(req, emit);
  const w = getWorker();
  if (!w) return onMainThread<T>(req, emit);
  const id = ++seq;
  try {
    return await new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, emit });
      w.postMessage({ id, req });
    });
  } catch (err) {
    if (req.type === 'detail' || (err instanceof Error && err.message !== 'worker failed')) throw err;
    return onMainThread<T>(req, emit);
  }
}
