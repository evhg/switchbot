// SwitchBot OpenAPI v1.1 request signing. See docs/research/openapi.md §1.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/** Accepts standard and URL-safe base64, with or without padding. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  let s = b64.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SignOptions {
  /** Epoch ms; default Date.now(). */
  t?: number;
  /** Default crypto.randomUUID(). */
  nonce?: string;
  /**
   * The vendor CLI (@switchbot/openapi-cli 3.9) uppercases the base64 sign; the Python/JS README samples don't.
   * The server accepts both in practice. Default true (match the vendor client).
   */
  uppercase?: boolean;
}

/** sign = base64(HMAC-SHA256(key=secret, msg=token + t + nonce)), uppercased by default. */
export async function switchBotSignHeaders(token: string, secret: string, opts: SignOptions = {}): Promise<Record<string, string>> {
  const t = String(opts.t ?? Date.now());
  const nonce = opts.nonce ?? crypto.randomUUID();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(token + t + nonce)));
  const b64 = bytesToBase64(mac);
  return {
    Authorization: token,
    sign: opts.uppercase === false ? b64 : b64.toUpperCase(),
    t,
    nonce,
    'Content-Type': 'application/json; charset=utf8',
  };
}
