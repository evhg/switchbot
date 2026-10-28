// Runs engine requests in a Web Worker (keeps the UI responsive on phones); falls back to the main thread.
import type { EngineRequest, EngineResponse } from './types.ts';

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let mainThreadState = false;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<EngineResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker?.terminate();
      worker = null;
      for (const [, p] of pending) p.reject(new Error('worker failed'));
      pending.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

async function onMainThread<T>(req: EngineRequest): Promise<T> {
  mainThreadState = true;
  const { handle } = await import('./engine.ts');
  await new Promise((r) => setTimeout(r, 0));
  return (await handle(req)) as T;
}

export async function runEngine<T>(req: EngineRequest): Promise<T> {
  // Detail requests must go where the dataset lives.
  if (mainThreadState) return onMainThread<T>(req);
  const w = getWorker();
  if (!w) return onMainThread<T>(req);
  const id = ++seq;
  try {
    return await new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      w.postMessage({ id, req });
    });
  } catch (err) {
    if (req.type === 'detail' || (err instanceof Error && err.message !== 'worker failed')) throw err;
    return onMainThread<T>(req);
  }
}
