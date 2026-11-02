// Signed viewer tickets for the camera stream (the Mac's ticket gate in front of go2rtc only serves a request whose
// URL carries a valid ticket, once household_settings.camera_ticket_required is on; migration 0023):
//   GET  /functions/v1/camera-ticket   → {"alg":"Ed25519","publicKey":"<base64url raw 32 bytes>","format":…,"payload":…}
//        public, no auth: what the Mac needs to verify tickets. Creates the household key pair on first use.
//   POST /functions/v1/camera-ticket
//        Authorization: Bearer <the signed-in user's Supabase access token>
//        → {"ticket":"<b64url(payload)>.<b64url(sig)>","exp":"<ISO>","ttlS":43200}
//        401 without a valid user token, 403 when the user is not in public.household_members (any role may watch).
// The exact ticket format and the verify recipe are in _shared/ticket.ts and docs/BACKEND.md ("Camera ticket").
// The key pair lives in private.camera_ticket_key (camera_ticket_key() / camera_ticket_key_init(), service role); the
// first caller generates it with WebCrypto and camera_ticket_key_init() keeps whichever pair was stored first, so
// concurrent first calls agree on one key. JWT verification is off: the function checks the user token itself.
import { HttpError, json, serve } from '../_shared/http.ts';
import { type Db, serviceClient } from '../_shared/supabase.ts';
import { generateTicketKey, importTicketPrivateKey, signTicket, ticketPayload, TICKET_AUD, TICKET_TTL_S } from '../_shared/ticket.ts';

interface StoredKey {
  privateKey: CryptoKey;
  publicRaw: string;
}

let cached: StoredKey | null = null;

async function ticketKey(db: Db): Promise<StoredKey> {
  if (cached) return cached;
  const got = await db.rpc('camera_ticket_key');
  if (got.error) throw new Error(`camera_ticket_key: ${got.error.message}`);
  let row = (got.data as { private_jwk: JsonWebKey; public_raw: string }[] | null)?.[0] ?? null;
  if (!row) {
    const fresh = await generateTicketKey();
    const init = await db.rpc('camera_ticket_key_init', { p_private_jwk: fresh.privateJwk, p_public_raw: fresh.publicRaw });
    if (init.error) throw new Error(`camera_ticket_key_init: ${init.error.message}`);
    row = (init.data as { private_jwk: JsonWebKey; public_raw: string }[] | null)?.[0] ?? null;
    if (!row) throw new Error('camera_ticket_key_init returned no key');
    console.log('camera-ticket: key pair ready');
  }
  cached = { privateKey: await importTicketPrivateKey(row.private_jwk), publicRaw: row.public_raw };
  return cached;
}

serve(async (req) => {
  const db = serviceClient();
  if (req.method === 'GET') {
    const k = await ticketKey(db).catch((e) => {
      console.error(e);
      throw new HttpError(500, 'internal');
    });
    return json({
      alg: 'Ed25519',
      publicKey: k.publicRaw,
      format: '<b64url(payload)>.<b64url(sig)>',
      payload: { sub: '<user uuid>', exp: '<epoch s>', iat: '<epoch s>', aud: TICKET_AUD },
      ttlS: TICKET_TTL_S,
    }, 200, { 'Cache-Control': 'public, max-age=300' });
  }
  if (req.method !== 'POST') return json({ error: 'GET (public key) or POST with Authorization: Bearer <access token>' }, 405);

  const tok = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
  // Presence tokens are not user sessions; don't send them to the auth server.
  if (!tok || tok.startsWith('slp_') || tok.length > 4096) throw new HttpError(401, 'unauthorized');
  const { data, error } = await db.auth.getUser(tok);
  if (error || !data.user) throw new HttpError(401, 'unauthorized');
  const m = await db.from('household_members').select('user_id').eq('user_id', data.user.id).maybeSingle();
  if (m.error) {
    console.error('household_members', m.error.message);
    return json({ error: 'internal' }, 500);
  }
  if (!m.data) throw new HttpError(403, 'not a household member');

  const k = await ticketKey(db).catch((e) => {
    console.error(e);
    throw new HttpError(500, 'internal');
  });
  const payload = ticketPayload(data.user.id, Date.now() / 1000);
  const ticket = await signTicket(k.privateKey, payload);
  return json({ ticket, exp: new Date(payload.exp * 1000).toISOString(), ttlS: TICKET_TTL_S }, 200, { 'Cache-Control': 'no-store' });
});
