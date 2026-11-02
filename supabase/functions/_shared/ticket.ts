// Camera viewer tickets (camera-ticket Edge Function → the Mac's ticket gate in front of go2rtc). Tested in
// tests/ticket.test.ts. The Mac proxy reimplements verifyTicket(); this header is the format's reference.
//
// Format:   <part1>.<part2>
//   part1 = base64url (RFC 4648 §5, NO padding) of the UTF-8 JSON payload
//           {"sub":"<auth user uuid>","iat":<epoch seconds>,"exp":<epoch seconds>,"aud":"camera"}
//   part2 = base64url (no padding) of the 64-byte Ed25519 signature (RFC 8032, pure Ed25519) over the ASCII bytes of
//           part1 exactly as sent (the signature is NOT over the decoded JSON).
// Key:      one Ed25519 key pair for the household (private.camera_ticket_key, migration 0023). The public key is the
//           raw 32 bytes, base64url without padding (43 chars); GET /functions/v1/camera-ticket returns it as publicKey.
// Verify:   split on the single '.', reject anything else (and tickets longer than TICKET_MAX_LEN); verify the
//           signature of part1's bytes with the public key; decode part1 → JSON object; require aud === "camera",
//           typeof sub === "string", exp > now (seconds) and iat <= now + TICKET_SKEW_S. No other algorithm exists.
// Lifetime: TICKET_TTL_S (12 h). The app fetches a new one when it is within 30 min of exp.
// The URL form the app embeds: <camera_stream_url>/t/<encodeURIComponent(ticket)>/<stream path…>.

export const TICKET_TTL_S = 12 * 3600;
export const TICKET_AUD = 'camera';
/** Clock skew tolerated on iat (a ticket "issued" further in the future than this is refused). */
export const TICKET_SKEW_S = 300;
export const TICKET_MAX_LEN = 1024;

export interface TicketPayload {
  sub: string;
  iat: number;
  exp: number;
  aud: typeof TICKET_AUD;
}

export type TicketCheck =
  | { ok: true; payload: TicketPayload }
  | { ok: false; reason: 'format' | 'signature' | 'expired' | 'audience' | 'not_yet_valid' };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64url without padding; throws on anything else. */
export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh key pair: the private key as a JWK (to store) and the public key as base64url of the raw 32 bytes. */
export async function generateTicketKey(): Promise<{ privateJwk: JsonWebKey; publicRaw: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const publicRaw = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  return { privateJwk, publicRaw };
}

export function importTicketPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
}

export function importTicketPublicKey(raw: string): Promise<CryptoKey> {
  const bytes = b64urlDecode(raw);
  if (bytes.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return crypto.subtle.importKey('raw', bytes, { name: 'Ed25519' }, false, ['verify']);
}

/** The payload for a user at `nowS` (epoch seconds). */
export function ticketPayload(sub: string, nowS: number, ttlS = TICKET_TTL_S): TicketPayload {
  const iat = Math.floor(nowS);
  return { sub, iat, exp: iat + ttlS, aud: TICKET_AUD };
}

export async function signTicket(key: CryptoKey, payload: TicketPayload): Promise<string> {
  const part1 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, enc.encode(part1)));
  return `${part1}.${b64urlEncode(sig)}`;
}

/** Checks a ticket against the public key at `nowS` (epoch seconds). */
export async function verifyTicket(ticket: string, publicKey: CryptoKey, nowS: number): Promise<TicketCheck> {
  if (typeof ticket !== 'string' || ticket.length > TICKET_MAX_LEN) return { ok: false, reason: 'format' };
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'format' };
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64urlDecode(parts[1]);
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (sig.length !== 64) return { ok: false, reason: 'format' };
  const good = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, sig, enc.encode(parts[0]));
  if (!good) return { ok: false, reason: 'signature' };
  let p: unknown;
  try {
    p = JSON.parse(dec.decode(b64urlDecode(parts[0])));
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { ok: false, reason: 'format' };
  const o = p as Record<string, unknown>;
  if (o.aud !== TICKET_AUD) return { ok: false, reason: 'audience' };
  if (typeof o.sub !== 'string' || typeof o.exp !== 'number' || typeof o.iat !== 'number') return { ok: false, reason: 'format' };
  if (o.exp <= nowS) return { ok: false, reason: 'expired' };
  if (o.iat > nowS + TICKET_SKEW_S) return { ok: false, reason: 'not_yet_valid' };
  return { ok: true, payload: { sub: o.sub, iat: o.iat, exp: o.exp, aud: TICKET_AUD } };
}
