// Passkey (Face ID / Touch ID) sign-in for the app (migration 0033). JWT verification is off (config.toml): login
// needs no session, and register checks the caller's access token itself.
//   POST {"action":"register-options"}                      Bearer <access token>  → {challengeId, options}
//   POST {"action":"register-verify","challengeId","response","device"?}  Bearer   → {ok:true, id}
//   POST {"action":"login-options"}                                               → {challengeId, options}
//   POST {"action":"login-verify","challengeId","response"}                       → {email, token_hash}
// login-verify returns a one-time magic-link token (generated, never emailed) that the app redeems with
// supabase.auth.verifyOtp({token_hash, type:'magiclink'}). The relying party is cathnivore.com, so one passkey
// works on every subdomain the app is served from.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from 'npm:@simplewebauthn/server@13.3.0';
import { isoBase64URL } from 'npm:@simplewebauthn/server@13.3.0/helpers';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { serviceClient, type Db } from '../_shared/supabase.ts';

const RP_ID = 'cathnivore.com';
const RP_NAME = 'Jarvis';
const ORIGINS = ['https://jarvis.cathnivore.com', 'https://sleep.cathnivore.com'];
const CHALLENGE_TTL_MS = 5 * 60_000;

type Kind = 'register' | 'login';

async function userFromToken(req: Request, db: Db): Promise<{ id: string; email: string }> {
  const m = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new HttpError(401, 'sign in first');
  const { data, error } = await db.auth.getUser(m[1]!.trim());
  if (error || !data.user?.email) throw new HttpError(401, 'sign in first');
  return { id: data.user.id, email: data.user.email };
}

async function saveChallenge(db: Db, challenge: string, kind: Kind, userId: string | null): Promise<string> {
  const { data, error } = await db.from('passkey_challenges').insert({ challenge, kind, user_id: userId }).select('id').single();
  if (error || !data) throw new HttpError(500, error?.message ?? 'challenge not saved');
  return (data as { id: string }).id;
}

/** Takes a challenge once: it must exist, match the kind (and user), be unused and fresh. */
async function takeChallenge(db: Db, id: unknown, kind: Kind, userId: string | null): Promise<string> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'challengeId missing');
  const { data, error } = await db
    .from('passkey_challenges')
    .update({ used_at: new Date().toISOString() })
    .eq('id', id)
    .eq('kind', kind)
    .is('used_at', null)
    .gte('created_at', new Date(Date.now() - CHALLENGE_TTL_MS).toISOString())
    .select('challenge,user_id')
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  const row = data as { challenge: string; user_id: string | null } | null;
  if (!row || (userId !== null && row.user_id !== userId)) throw new HttpError(400, 'That took too long. Try again.');
  return row.challenge;
}

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  const db = serviceClient();
  const body = await readJson(req);

  switch (body.action) {
    case 'register-options': {
      const user = await userFromToken(req, db);
      const existing = await db.from('passkeys').select('id,transports').eq('user_id', user.id);
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: user.email,
        userDisplayName: user.email,
        userID: new TextEncoder().encode(user.id),
        attestationType: 'none',
        excludeCredentials: ((existing.data ?? []) as { id: string; transports: string[] }[]).map((c) => ({
          id: c.id,
          transports: c.transports as AuthenticatorTransport[],
        })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      });
      return json({ challengeId: await saveChallenge(db, options.challenge, 'register', user.id), options });
    }

    case 'register-verify': {
      const user = await userFromToken(req, db);
      const expectedChallenge = await takeChallenge(db, body.challengeId, 'register', user.id);
      let v;
      try {
        // deno-lint-ignore no-explicit-any
        v = await verifyRegistrationResponse({ response: body.response as any, expectedChallenge, expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: false });
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : 'passkey not accepted');
      }
      if (!v.verified || !v.registrationInfo) throw new HttpError(400, 'passkey not accepted');
      const c = v.registrationInfo.credential;
      const device = typeof body.device === 'string' ? body.device.slice(0, 40) : null;
      const { error } = await db.from('passkeys').upsert({
        id: c.id,
        user_id: user.id,
        public_key: isoBase64URL.fromBuffer(c.publicKey),
        counter: c.counter,
        transports: c.transports ?? [],
        device,
      });
      if (error) throw new HttpError(500, error.message);
      return json({ ok: true, id: c.id });
    }

    case 'login-options': {
      const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred', allowCredentials: [] });
      return json({ challengeId: await saveChallenge(db, options.challenge, 'login', null), options });
    }

    case 'login-verify': {
      const response = body.response as { id?: unknown } | undefined;
      if (!response || typeof response.id !== 'string') throw new HttpError(400, 'response missing');
      const expectedChallenge = await takeChallenge(db, body.challengeId, 'login', null);
      const found = await db.from('passkeys').select('id,user_id,public_key,counter,transports').eq('id', response.id).maybeSingle();
      if (found.error) throw new HttpError(500, found.error.message);
      const cred = found.data as { id: string; user_id: string; public_key: string; counter: number; transports: string[] } | null;
      if (!cred) throw new HttpError(404, 'This passkey isn’t known here any more. Sign in another way and add it again.');
      let v;
      try {
        v = await verifyAuthenticationResponse({
          // deno-lint-ignore no-explicit-any
          response: body.response as any,
          expectedChallenge,
          expectedOrigin: ORIGINS,
          expectedRPID: RP_ID,
          credential: { id: cred.id, publicKey: isoBase64URL.toBuffer(cred.public_key), counter: Number(cred.counter), transports: cred.transports as AuthenticatorTransport[] },
          requireUserVerification: false,
        });
      } catch (e) {
        throw new HttpError(401, e instanceof Error ? e.message : 'passkey not accepted');
      }
      if (!v.verified) throw new HttpError(401, 'passkey not accepted');
      await db.from('passkeys').update({ counter: v.authenticationInfo.newCounter, last_used_at: new Date().toISOString() }).eq('id', cred.id);

      const u = await db.auth.admin.getUserById(cred.user_id);
      const email = u.data.user?.email;
      if (u.error || !email) throw new HttpError(404, 'account not found');
      const link = await db.auth.admin.generateLink({ type: 'magiclink', email });
      const tokenHash = link.data?.properties?.hashed_token;
      if (link.error || !tokenHash) throw new HttpError(502, link.error?.message ?? 'no sign-in token');
      return json({ email, token_hash: tokenHash });
    }

    default:
      throw new HttpError(400, 'unknown action');
  }
});
