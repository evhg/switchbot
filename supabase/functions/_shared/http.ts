// Response helpers, CORS, error mapping and background work for Edge Functions.

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...headers },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${body}`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Wraps a handler with OPTIONS preflight and error → JSON mapping. */
export function serve(fn: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}

type EdgeRuntimeLike = { waitUntil(p: Promise<unknown>): void };

/**
 * Runs `p` after the response is sent when the Supabase runtime supports it (EdgeRuntime.waitUntil);
 * otherwise returns the promise so the caller can await it before responding.
 */
export function background(p: Promise<unknown>): Promise<void> | null {
  const guarded = p.then(() => undefined, (e) => console.error('background task failed', e));
  const rt = (globalThis as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime;
  if (rt?.waitUntil) {
    rt.waitUntil(guarded);
    return null;
  }
  return guarded;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (req.method !== 'POST') return {};
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
