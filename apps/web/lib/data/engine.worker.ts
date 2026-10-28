import { handle } from './engine.ts';
import type { EngineRequest, EngineResponse } from './types.ts';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; req: EngineRequest }>) => void) | null;
  postMessage(msg: EngineResponse): void;
};

ctx.onmessage = async (e) => {
  const { id, req } = e.data;
  try {
    ctx.postMessage({ id, ok: true, result: await handle(req) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
