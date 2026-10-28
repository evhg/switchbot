// Web Push with crypto.subtle only: RFC 8291 payload encryption (aes128gcm, RFC 8188) and RFC 8292 VAPID.
// Payloads use the Declarative Web Push shape (iOS 18.4+ shows it without running the service worker);
// older clients read the same JSON in their push handler.

export interface PushTarget {
  endpoint: string;
  /** Subscription keys, base64url: p256dh = 65-byte uncompressed P-256 point, auth = 16 bytes. */
  p256dh: string;
  auth: string;
}

export interface VapidKeys {
  /** base64url, 65-byte uncompressed P-256 public key (the applicationServerKey given to the browser). */
  publicKey: string;
  /** base64url, 32-byte private scalar d. */
  privateKey: string;
  /** mailto: or https: contact. */
  subject: string;
}

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
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

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export interface EncryptOptions {
  /** For tests only: fixed salt and sender key pair. */
  salt?: Uint8Array<ArrayBuffer>;
  senderKeys?: CryptoKeyPair;
  /** Record size; one record carries the whole payload (max ~4 KB for push services). */
  recordSize?: number;
}

/** RFC 8291 §3–4: body = salt(16) ‖ rs(4) ‖ idlen(1) ‖ sender public key(65) ‖ AES-128-GCM(payload ‖ 0x02). */
export async function encryptPayload(payload: Uint8Array, target: Pick<PushTarget, 'p256dh' | 'auth'>, opts: EncryptOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlDecode(target.p256dh);
  const authSecret = b64urlDecode(target.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const rs = opts.recordSize ?? 4096;
  if (payload.length + 17 > rs) throw new Error(`payload too large for one record (${payload.length} bytes)`);

  const sender = opts.senderKeys ?? (await crypto.subtle.generateKey(ECDH, true, ['deriveBits']) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, ECDH, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, sender.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(payload, new Uint8Array([2])); // 0x02 = last record, no padding
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

function importVapidPrivate(keys: VapidKeys): Promise<CryptoKey> {
  const pub = b64urlDecode(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be a 65-byte uncompressed point');
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: keys.privateKey,
    x: b64urlEncode(pub.subarray(1, 33)),
    y: b64urlEncode(pub.subarray(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, ECDSA, false, ['sign']);
}

/** RFC 8292 `Authorization: vapid t=<JWT>, k=<public key>`; ES256 signatures from WebCrypto are already r‖s. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: keys.subject })));
  const input = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await importVapidPrivate(keys), enc.encode(input)));
  return `vapid t=${input}.${b64urlEncode(sig)}, k=${keys.publicKey}`;
}

export interface NotificationContent {
  title: string;
  body: string;
  /** URL opened on tap. */
  navigate: string;
  badge?: number;
  tag?: string;
}

/** Declarative Web Push message (WebKit): {"web_push": 8030, "notification": {...}}. */
export function declarativePayload(n: NotificationContent): Record<string, unknown> {
  const notification: Record<string, unknown> = { title: n.title, body: n.body, navigate: n.navigate };
  if (n.tag) notification.tag = n.tag;
  const msg: Record<string, unknown> = { web_push: 8030, notification };
  if (n.badge !== undefined) msg.app_badge = String(n.badge);
  return msg;
}

export interface PushResult {
  status: number;
  /** 404/410: the subscription is gone and should be deleted. */
  gone: boolean;
  ok: boolean;
}

export async function sendWebPush(
  target: PushTarget,
  message: unknown,
  keys: VapidKeys,
  opts: { ttlSec?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string; fetch?: typeof fetch } = {},
): Promise<PushResult> {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), target);
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(target.endpoint, keys),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(opts.ttlSec ?? 6 * 3600),
    Urgency: opts.urgency ?? 'normal',
  };
  if (opts.topic) headers.Topic = opts.topic;
  const res = await (opts.fetch ?? fetch)(target.endpoint, { method: 'POST', headers, body });
  await res.body?.cancel();
  return { status: res.status, gone: res.status === 404 || res.status === 410, ok: res.status >= 200 && res.status < 300 };
}

/** One-off helper for setup: `npx deno eval "import('./supabase/functions/_shared/webpush.ts').then(async m => console.log(await m.generateVapidKeys()))"`. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d! };
}
