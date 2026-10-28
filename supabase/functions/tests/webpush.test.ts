// Round-trip tests for the Web Push crypto, with an independent RFC 8291 decrypt as the user agent.
import { b64urlDecode, b64urlEncode, declarativePayload, encryptPayload, generateVapidKeys, sendWebPush, vapidAuthorization } from '../_shared/webpush.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const enc = new TextEncoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, len: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

async function userAgent() {
  const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, pub, auth, target: { endpoint: 'https://push.example.net/abc', p256dh: b64urlEncode(pub), auth: b64urlEncode(auth) } };
}

async function decrypt(body: Uint8Array<ArrayBuffer>, ua: Awaited<ReturnType<typeof userAgent>>): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20]!;
  const asPub = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  assert(rs === 4096 && idlen === 65, 'header');
  const asKey = await crypto.subtle.importKey('raw', asPub, ECDH, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.kp.privateKey, 256));
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...ua.pub, ...asPub]);
  const ikm = await hkdf(ua.auth, secret, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  assert(plain[plain.length - 1] === 2, 'last-record delimiter');
  return new TextDecoder().decode(plain.subarray(0, plain.length - 1));
}

Deno.test('encryptPayload round-trips through an RFC 8291 decrypt', async () => {
  const ua = await userAgent();
  const msg = JSON.stringify(declarativePayload({ title: 'Last night', body: 'Cool and steady 🌙', navigate: 'https://x/night/2026-10-28' }));
  const body = await encryptPayload(enc.encode(msg), ua.target);
  assert((await decrypt(body, ua)) === msg, 'decrypted payload differs');
});

Deno.test('encryptPayload rejects oversize payloads and bad keys', async () => {
  const ua = await userAgent();
  let threw = false;
  try {
    await encryptPayload(new Uint8Array(5000), ua.target);
  } catch {
    threw = true;
  }
  assert(threw, 'oversize payload accepted');
  threw = false;
  try {
    await encryptPayload(enc.encode('x'), { p256dh: 'AAAA', auth: ua.target.auth });
  } catch {
    threw = true;
  }
  assert(threw, 'bad p256dh accepted');
});

Deno.test('VAPID JWT verifies with the public key and targets the push origin', async () => {
  const keys = { ...(await generateVapidKeys()), subject: 'mailto:test@example.com' };
  const h = await vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH/abc', keys, 1_800_000_000);
  const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert(m, `header shape: ${h}`);
  const [, hdr, claims, sig, k] = m;
  assert(k === keys.publicKey, 'k');
  const c = JSON.parse(new TextDecoder().decode(b64urlDecode(claims!)));
  assert(c.aud === 'https://web.push.apple.com' && c.exp === 1_800_000_000 + 43_200 && c.sub === keys.subject, 'claims');
  const pub = await crypto.subtle.importKey('raw', b64urlDecode(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(sig!), enc.encode(`${hdr}.${claims}`));
  assert(ok, 'signature does not verify');
});

Deno.test('sendWebPush sets push headers and flags gone subscriptions', async () => {
  const ua = await userAgent();
  const keys = { ...(await generateVapidKeys()), subject: 'mailto:test@example.com' };
  let seen: { url: string; init?: RequestInit } | null = null;
  const fake = ((url: string, init?: RequestInit) => {
    seen = { url, init };
    return Promise.resolve(new Response(null, { status: 410 }));
  }) as typeof fetch;
  const r = await sendWebPush(ua.target, { hello: 1 }, keys, { fetch: fake, topic: 'report' });
  assert(r.gone && !r.ok && r.status === 410, 'result');
  const h = (seen!.init!.headers ?? {}) as Record<string, string>;
  assert(h['Content-Encoding'] === 'aes128gcm' && h.TTL === '21600' && h.Topic === 'report' && h.Authorization!.startsWith('vapid t='), 'headers');
  assert((await decrypt(seen!.init!.body as Uint8Array<ArrayBuffer>, ua)) === '{"hello":1}', 'body');
});

Deno.test('encryptPayload matches the RFC 8291 Appendix A example', async () => {
  const asPub = b64urlDecode('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const jwk = { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', x: b64urlEncode(asPub.subarray(1, 33)), y: b64urlEncode(asPub.subarray(33)), ext: true };
  const senderKeys = {
    privateKey: await crypto.subtle.importKey('jwk', jwk, ECDH, true, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', asPub, ECDH, true, []),
  };
  const body = await encryptPayload(
    b64urlDecode('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { salt: b64urlDecode('DGv6ra1nlYgDCS1FRnbzlw'), senderKeys },
  );
  assert(
    b64urlEncode(body) ===
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    'RFC 8291 vector mismatch',
  );
});
