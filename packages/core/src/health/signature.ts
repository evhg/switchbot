// Google Health webhook authentication. See docs/research/health-data.md §2.7 and
// https://developers.google.com/health/webhooks.
//
// Best effort: the docs describe a Tink-formatted ECDSA P-256/SHA-256 signature over the raw body, base64 in the
// GOOGLE-HEALTH-API-SIGNATURE header (5-byte Tink prefix 0x01 + keyId, then DER), with public keys in a Tink JSON
// keyset whose `value` is a serialized EcdsaPublicKey protobuf. This mirrors that without the Tink library; if
// Google's format drifts, fall back to the shared-secret Authorization check (always do that one anyway).
import type { FetchLike } from '../switchbot/sign.ts';
import { base64ToBytes } from '../switchbot/sign.ts';

export const GOOGLE_HEALTH_KEYSET_URL = 'https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json';
export const GOOGLE_HEALTH_SIGNATURE_HEADER = 'GOOGLE-HEALTH-API-SIGNATURE';

export interface TinkKey {
  keyData: { typeUrl?: string; value: string; keyMaterialType?: string };
  status?: string;
  keyId: number;
  outputPrefixType?: 'TINK' | 'LEGACY' | 'RAW' | 'CRUNCHY' | string;
}

export interface TinkKeyset {
  primaryKeyId?: number;
  key: TinkKey[];
}

/** A Tink keyset, a JWK, a PEM (SPKI) string, or a list of these. */
export type GoogleHealthPublicKeys = TinkKeyset | JsonWebKey | string | (TinkKeyset | JsonWebKey | string)[];

export async function fetchGoogleHealthKeyset(fetchImpl?: FetchLike): Promise<TinkKeyset> {
  const f = fetchImpl ?? ((i, init) => fetch(i, init));
  const res = await f(GOOGLE_HEALTH_KEYSET_URL, { method: 'GET' });
  if (!res.ok) throw new Error(`keyset fetch failed: HTTP ${res.status}`);
  return (await res.json()) as TinkKeyset;
}

// ---------- minimal protobuf / DER ----------

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (;;) {
    const byte = b[pos++];
    if (byte === undefined) throw new Error('truncated varint');
    v += (byte & 0x7f) * mul;
    if (!(byte & 0x80)) return [v, pos];
    mul *= 128;
  }
}

/** Top-level fields of a protobuf message: field number → varint or bytes (last one wins). */
function readProto(b: Uint8Array): Map<number, number | Uint8Array> {
  const out = new Map<number, number | Uint8Array>();
  let pos = 0;
  while (pos < b.length) {
    const [tag, p1] = readVarint(b, pos);
    const fieldNo = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      const [v, p2] = readVarint(b, p1);
      out.set(fieldNo, v);
      pos = p2;
    } else if (wire === 2) {
      const [len, p2] = readVarint(b, p1);
      if (p2 + len > b.length) throw new Error('truncated field');
      out.set(fieldNo, b.subarray(p2, p2 + len));
      pos = p2 + len;
    } else if (wire === 5) pos = p1 + 4;
    else if (wire === 1) pos = p1 + 8;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

/** Big-endian unsigned integer → exactly `size` bytes (drops the sign byte, left-pads). */
function fixedWidth(x: Uint8Array, size: number): Uint8Array {
  let i = 0;
  while (i < x.length - 1 && x[i] === 0) i++;
  const v = x.subarray(i);
  if (v.length > size) throw new Error('integer too large');
  const out = new Uint8Array(size);
  out.set(v, size - v.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** DER SEQUENCE { INTEGER r, INTEGER s } → r||s (WebCrypto's IEEE P1363 format). Null if not DER. */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array | null {
  try {
    let pos = 0;
    if (der[pos++] !== 0x30) return null;
    let len = der[pos++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + der[pos++]!;
    }
    if (pos + len !== der.length) return null;
    const ints: Uint8Array[] = [];
    for (let k = 0; k < 2; k++) {
      if (der[pos++] !== 0x02) return null;
      const l = der[pos++]!;
      ints.push(der.subarray(pos, pos + l));
      pos += l;
    }
    if (pos !== der.length) return null;
    return concat(fixedWidth(ints[0]!, size), fixedWidth(ints[1]!, size));
  } catch {
    return null;
  }
}

// ---------- key import ----------

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export interface ParsedTinkKey {
  key: CryptoKey;
  keyId: number;
  prefix: string;
  /** EcdsaSignatureEncoding: 1 = IEEE_P1363, 2 = DER. */
  encoding: number;
}

/** EcdsaPublicKey { version=1; params=2 { hash_type=1; curve=2; encoding=3 }; x=3; y=4 }. */
export async function importTinkKey(k: TinkKey): Promise<ParsedTinkKey | null> {
  if (k.status && k.status !== 'ENABLED') return null;
  if (k.keyData.typeUrl && !k.keyData.typeUrl.endsWith('EcdsaPublicKey')) return null;
  const msg = readProto(base64ToBytes(k.keyData.value));
  const params = msg.get(2);
  const x = msg.get(3);
  const y = msg.get(4);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) return null;
  const p = params instanceof Uint8Array ? readProto(params) : new Map<number, number | Uint8Array>();
  // HashType SHA256 = 3, EllipticCurveType NIST_P256 = 2.
  if ((p.get(1) ?? 3) !== 3 || (p.get(2) ?? 2) !== 2) return null;
  const raw = concat(new Uint8Array([0x04]), fixedWidth(x, 32), fixedWidth(y, 32));
  const key = await crypto.subtle.importKey('raw', raw, ECDSA_P256, false, ['verify']);
  const enc = p.get(3);
  return { key, keyId: k.keyId, prefix: k.outputPrefixType ?? 'TINK', encoding: typeof enc === 'number' ? enc : 2 };
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  return base64ToBytes(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
}

function isKeyset(k: unknown): k is TinkKeyset {
  return typeof k === 'object' && k !== null && Array.isArray((k as TinkKeyset).key);
}

async function ecVerify(key: CryptoKey, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  const p1363 = sig.length === 64 ? sig : derToP1363(sig);
  if (!p1363) return false;
  try {
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(p1363), new Uint8Array(data));
  } catch {
    return false;
  }
}

/**
 * Verifies GOOGLE-HEALTH-API-SIGNATURE against the raw request body (verify before JSON.parse; re-serialising
 * changes the bytes). Returns false on any mismatch or malformed input; never throws.
 */
export async function verifyGoogleHealthSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  keys: GoogleHealthPublicKeys,
): Promise<boolean> {
  if (!signatureHeader) return false;
  try {
    const data = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody;
    const sig = base64ToBytes(signatureHeader);
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      if (isKeyset(k)) {
        const hasPrefix = sig.length > 5 && (sig[0] === 0x01 || sig[0] === 0x00);
        const sigKeyId = hasPrefix ? ((sig[1]! << 24) >>> 0) + (sig[2]! << 16) + (sig[3]! << 8) + sig[4]! : null;
        for (const tk of k.key) {
          const parsed = await importTinkKey(tk).catch(() => null);
          if (!parsed) continue;
          let body = sig;
          let msg = data;
          if (parsed.prefix === 'RAW') {
            // no prefix
          } else {
            if (sigKeyId !== parsed.keyId) continue;
            body = sig.subarray(5);
            // LEGACY keys sign data || 0x00.
            if (parsed.prefix === 'LEGACY') msg = concat(data, new Uint8Array([0]));
          }
          if (parsed.encoding === 1 && body.length !== 64) continue;
          if (await ecVerify(parsed.key, body, msg)) return true;
        }
      } else {
        const key =
          typeof k === 'string'
            ? await crypto.subtle.importKey('spki', pemToDer(k), ECDSA_P256, false, ['verify'])
            : await crypto.subtle.importKey('jwk', k, ECDSA_P256, false, ['verify']);
        // Accept a bare signature or one with a 5-byte Tink prefix.
        if (await ecVerify(key, sig, data)) return true;
        if (sig.length > 5 && (await ecVerify(key, sig.subarray(5), data))) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Constant-time string compare (length leaks, content doesn't). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Google echoes the subscriber's endpointAuthorization.secret in the Authorization header. `expected` is that
 * secret exactly as configured (e.g. 'Bearer abc'); a bare token also matches 'Bearer <token>'.
 */
export function checkGoogleHealthAuthorization(header: string | null | undefined, expected: string): boolean {
  if (!header || !expected) return false;
  return timingSafeEqual(header, expected) || timingSafeEqual(header, `Bearer ${expected}`);
}

export interface GoogleHealthNotification {
  healthUserId?: string;
  dataType: string;
  operation?: 'UPSERT' | 'DELETE' | string;
  clientProvidedSubscriptionName?: string;
  version?: string;
  recordId?: string;
  intervals: unknown[];
}

/** Endpoint verification POSTs carry {"type":"verification"}; answer 200/201 if authorized, 401/403 if not. */
export function isGoogleHealthVerification(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { type?: unknown }).type === 'verification';
}

/** Batches arrive as a JSON array of `{data: {...}}` (≤99); a single object is accepted too. */
export function parseGoogleHealthNotifications(body: unknown): GoogleHealthNotification[] {
  const items = Array.isArray(body) ? body : [body];
  const out: GoogleHealthNotification[] = [];
  for (const it of items) {
    const d = (typeof it === 'object' && it !== null && 'data' in it ? (it as { data: unknown }).data : it) as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || typeof d.dataType !== 'string') continue;
    const n: GoogleHealthNotification = { dataType: d.dataType, intervals: Array.isArray(d.intervals) ? d.intervals : [] };
    for (const k of ['healthUserId', 'operation', 'clientProvidedSubscriptionName', 'version', 'recordId'] as const) {
      const v = d[k];
      if (typeof v === 'string') n[k] = v;
    }
    out.push(n);
  }
  return out;
}
