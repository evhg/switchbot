import { b64urlDecode, b64urlEncode, generateTicketKey, importTicketPrivateKey, importTicketPublicKey, signTicket, ticketPayload, verifyTicket, TICKET_TTL_S } from '../_shared/ticket.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const NOW_S = Date.parse('2026-11-02T14:00:00+07:00') / 1000;
const SUB = '6f1c2a5e-0000-4000-8000-000000000001';

async function keys() {
  const k = await generateTicketKey();
  // Round-trip through storage: JWK for the private half, raw base64url for the public half.
  const priv = await importTicketPrivateKey(JSON.parse(JSON.stringify(k.privateJwk)));
  const pub = await importTicketPublicKey(k.publicRaw);
  return { k, priv, pub };
}

Deno.test('ticket: key format', async () => {
  const { k } = await keys();
  assert(/^[A-Za-z0-9_-]{43}$/.test(k.publicRaw), k.publicRaw);
  assert(k.privateJwk.kty === 'OKP' && k.privateJwk.crv === 'Ed25519' && typeof k.privateJwk.d === 'string', 'jwk');
  assert(b64urlDecode(k.publicRaw).length === 32, '32 bytes');
});

Deno.test('ticket: sign → verify round trip, documented layout', async () => {
  const { priv, pub } = await keys();
  const t = await signTicket(priv, ticketPayload(SUB, NOW_S));
  const [p1, p2] = t.split('.');
  assert(p1 && p2 && !t.includes('='), t);
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p1)));
  assert(payload.sub === SUB && payload.aud === 'camera' && payload.exp - payload.iat === TICKET_TTL_S, JSON.stringify(payload));
  assert(b64urlDecode(p2).length === 64, 'sig 64 bytes');
  // The signature covers the ASCII bytes of part 1: check with WebCrypto directly, as the Mac would.
  assert(await crypto.subtle.verify({ name: 'Ed25519' }, pub, b64urlDecode(p2), new TextEncoder().encode(p1)), 'raw verify');
  const r = await verifyTicket(t, pub, NOW_S + 60);
  assert(r.ok && r.payload.sub === SUB, JSON.stringify(r));
});

Deno.test('ticket: expiry, tamper, wrong key, junk', async () => {
  const { priv, pub } = await keys();
  const t = await signTicket(priv, ticketPayload(SUB, NOW_S));
  const expired = await verifyTicket(t, pub, NOW_S + TICKET_TTL_S);
  assert(!expired.ok && expired.reason === 'expired', JSON.stringify(expired));
  const early = await verifyTicket(t, pub, NOW_S - 3600);
  assert(!early.ok && early.reason === 'not_yet_valid', JSON.stringify(early));

  const [p1, p2] = t.split('.') as [string, string];
  const forged = b64urlEncode(new TextEncoder().encode(JSON.stringify({ sub: SUB, iat: NOW_S, exp: NOW_S + 10 * 365 * 86400, aud: 'camera' })));
  const r1 = await verifyTicket(`${forged}.${p2}`, pub, NOW_S);
  assert(!r1.ok && r1.reason === 'signature', JSON.stringify(r1));
  const flipped = p2.slice(0, 10) + (p2[10] === 'A' ? 'B' : 'A') + p2.slice(11);
  const r2 = await verifyTicket(`${p1}.${flipped}`, pub, NOW_S);
  assert(!r2.ok && r2.reason === 'signature', JSON.stringify(r2));

  const other = await keys();
  const r3 = await verifyTicket(t, other.pub, NOW_S);
  assert(!r3.ok && r3.reason === 'signature', JSON.stringify(r3));

  const wrongAud = await signTicket(priv, { ...ticketPayload(SUB, NOW_S), aud: 'mic' as 'camera' });
  const r4 = await verifyTicket(wrongAud, pub, NOW_S);
  assert(!r4.ok && r4.reason === 'audience', JSON.stringify(r4));

  for (const junk of ['', 'abc', `${p1}.${p2}.x`, `${p1}.@@`, `${p1}=.${p2}`, 'a'.repeat(2000)]) {
    const r = await verifyTicket(junk, pub, NOW_S);
    assert(!r.ok, junk);
  }
});
