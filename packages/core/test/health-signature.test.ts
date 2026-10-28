import { describe, expect, it } from 'vitest';
import {
  checkGoogleHealthAuthorization,
  derToP1363,
  importTinkKey,
  isGoogleHealthVerification,
  parseGoogleHealthNotifications,
  verifyGoogleHealthSignature,
  type TinkKeyset,
} from '../src/index.ts';

// Test-side helpers (independent of the implementation).
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function derInt(x: Uint8Array): Uint8Array {
  let i = 0;
  while (i < x.length - 1 && x[i] === 0) i++;
  let v = x.subarray(i);
  if (v[0]! & 0x80) v = Uint8Array.from([0, ...v]);
  return Uint8Array.from([0x02, v.length, ...v]);
}
function p1363ToDer(sig: Uint8Array): Uint8Array {
  const body = [...derInt(sig.subarray(0, 32)), ...derInt(sig.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}
const field = (n: number, bytes: Uint8Array) => [(n << 3) | 2, bytes.length, ...bytes];

async function makeKeyset(keyId: number) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)); // 04 || x || y
  const x = Uint8Array.from([0, ...raw.subarray(1, 33)]); // Tink stores signed big-endian with a leading 0
  const y = Uint8Array.from([0, ...raw.subarray(33)]);
  const params = Uint8Array.from([0x08, 3, 0x10, 2, 0x18, 2]); // SHA256, NIST_P256, DER
  const proto = Uint8Array.from([0x08, 0, ...field(2, params), ...field(3, x), ...field(4, y)]);
  const keyset: TinkKeyset = {
    primaryKeyId: keyId,
    key: [{ keyData: { typeUrl: 'type.googleapis.com/google.crypto.tink.EcdsaPublicKey', value: b64(proto), keyMaterialType: 'ASYMMETRIC_PUBLIC' }, status: 'ENABLED', keyId, outputPrefixType: 'TINK' }],
  };
  const sign = async (body: string, id = keyId) => {
    const p1363 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(body)));
    const prefix = [1, (id >>> 24) & 255, (id >>> 16) & 255, (id >>> 8) & 255, id & 255];
    return { tink: b64(Uint8Array.from([...prefix, ...p1363ToDer(p1363)])), p1363 };
  };
  return { keyset, sign, publicKey: kp.publicKey };
}

const BODY = '[{"data":{"version":"1","healthUserId":"h1","operation":"UPSERT","dataType":"sleep","intervals":[]}}]';

describe('verifyGoogleHealthSignature', () => {
  it('verifies a Tink-prefixed DER signature against a Tink keyset', async () => {
    const { keyset, sign } = await makeKeyset(2280854714); // > 2^31 to exercise unsigned keyId parsing
    const { tink } = await sign(BODY);
    expect(await verifyGoogleHealthSignature(BODY, tink, keyset)).toBe(true);
    expect(await verifyGoogleHealthSignature(new TextEncoder().encode(BODY), tink, keyset)).toBe(true);
  });

  it('rejects tampered bodies, wrong key ids, garbage and missing headers', async () => {
    const { keyset, sign } = await makeKeyset(1083906037);
    const { tink } = await sign(BODY);
    expect(await verifyGoogleHealthSignature(BODY + ' ', tink, keyset)).toBe(false);
    expect(await verifyGoogleHealthSignature(BODY, (await sign(BODY, 42)).tink, keyset)).toBe(false);
    expect(await verifyGoogleHealthSignature(BODY, 'not base64!!', keyset)).toBe(false);
    expect(await verifyGoogleHealthSignature(BODY, null, keyset)).toBe(false);
  });

  it('picks the right key from a multi-key keyset', async () => {
    const a = await makeKeyset(111);
    const b = await makeKeyset(222);
    const merged: TinkKeyset = { key: [...a.keyset.key, ...b.keyset.key] };
    expect(await verifyGoogleHealthSignature(BODY, (await b.sign(BODY)).tink, merged)).toBe(true);
  });

  it('accepts a JWK public key with raw or prefixed signatures', async () => {
    const { sign, publicKey } = await makeKeyset(7);
    const jwk = await crypto.subtle.exportKey('jwk', publicKey);
    const { tink, p1363 } = await sign(BODY);
    expect(await verifyGoogleHealthSignature(BODY, tink, jwk)).toBe(true);
    expect(await verifyGoogleHealthSignature(BODY, b64(p1363), jwk)).toBe(true);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64(spki)}\n-----END PUBLIC KEY-----`;
    expect(await verifyGoogleHealthSignature(BODY, tink, pem)).toBe(true);
  });

  it('imports a key from Google\'s published keyset', async () => {
    // Copied from https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json on 2026-10-28.
    const google: TinkKeyset = {
      primaryKeyId: 2280854714,
      key: [
        {
          keyData: {
            typeUrl: 'type.googleapis.com/google.crypto.tink.EcdsaPublicKey',
            value: 'EgYIAxACGAIaIQCIzcy8t+sL9L+sRQoMi137RNzNZNwhrmX2GFMXI8bNyiIhAO5YZDWEqK4ZVheKzZTEi0MZ1ylp0R/7wpBFsZZ1NuhF',
            keyMaterialType: 'ASYMMETRIC_PUBLIC',
          },
          status: 'ENABLED',
          keyId: 2280854714,
          outputPrefixType: 'TINK',
        },
      ],
    };
    const parsed = await importTinkKey(google.key[0]!);
    expect(parsed).toMatchObject({ keyId: 2280854714, prefix: 'TINK', encoding: 2 });
    expect(parsed!.key.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    const { sign } = await makeKeyset(2280854714);
    expect(await verifyGoogleHealthSignature(BODY, (await sign(BODY)).tink, google)).toBe(false);
  });

  it('derToP1363 pads short integers', () => {
    const r = new Uint8Array(32).fill(1);
    r[0] = 0;
    const s = new Uint8Array(32).fill(0xff);
    const der = p1363ToDer(Uint8Array.from([...r, ...s]));
    expect(derToP1363(der)).toEqual(Uint8Array.from([...r, ...s]));
    expect(derToP1363(Uint8Array.from([1, 2, 3]))).toBeNull();
  });
});

describe('webhook helpers', () => {
  it('checks the shared-secret Authorization header', () => {
    expect(checkGoogleHealthAuthorization('Bearer s3cret', 'Bearer s3cret')).toBe(true);
    expect(checkGoogleHealthAuthorization('Bearer s3cret', 's3cret')).toBe(true);
    expect(checkGoogleHealthAuthorization('Bearer nope', 's3cret')).toBe(false);
    expect(checkGoogleHealthAuthorization(null, 's3cret')).toBe(false);
    expect(checkGoogleHealthAuthorization('x', '')).toBe(false);
  });

  it('parses notifications and verification pings', () => {
    expect(isGoogleHealthVerification({ type: 'verification' })).toBe(true);
    expect(isGoogleHealthVerification(JSON.parse(BODY))).toBe(false);
    expect(parseGoogleHealthNotifications(JSON.parse(BODY))).toEqual([{ version: '1', healthUserId: 'h1', operation: 'UPSERT', dataType: 'sleep', intervals: [] }]);
    expect(parseGoogleHealthNotifications({ data: { dataType: 'heart-rate', intervals: [{}] } })).toHaveLength(1);
    expect(parseGoogleHealthNotifications([{ nope: 1 }])).toEqual([]);
  });
});
