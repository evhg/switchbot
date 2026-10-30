// Zero-touch VAPID keys: generated once, stored through the service-role RPCs, reused afterwards.
import type { Db } from '../_shared/supabase.ts';
import { loadVapidKeys, vapidSubject } from '../_shared/vapid.ts';
import { b64urlDecode, vapidAuthorization } from '../_shared/webpush.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const noEnv = () => undefined;

/** In-memory stand-in for vapid_keys() / store_vapid_keys() with the SQL's format check and never-overwrite rule. */
function fakeDb(initial: { pub: string; priv: string } | null = null) {
  let vault = initial;
  const calls: string[] = [];
  const db = {
    rpc(name: string, args: Record<string, string> = {}) {
      calls.push(name);
      if (name === 'vapid_keys') return Promise.resolve({ data: [{ public_key: vault?.pub ?? null, private_key: vault?.priv ?? null }], error: null });
      if (name === 'store_vapid_keys') {
        if (!/^[A-Za-z0-9_-]{86,88}$/.test(args.p_public!) || !/^[A-Za-z0-9_-]{42,44}$/.test(args.p_private!)) {
          return Promise.resolve({ data: null, error: { message: 'bad VAPID key format' } });
        }
        vault ??= { pub: args.p_public!, priv: args.p_private! };
        return Promise.resolve({ data: vault.pub, error: null });
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  return { db: db as unknown as Db, calls, get vault() { return vault; } };
}

Deno.test('loadVapidKeys creates a valid pair once and reuses it', async () => {
  const f = fakeDb();
  assert((await loadVapidKeys(f.db, { create: false, env: noEnv })) === null, 'create:false must not create');
  const a = await loadVapidKeys(f.db, { env: noEnv });
  assert(a && a.created, 'first call creates');
  assert(b64urlDecode(a.publicKey).length === 65 && b64urlDecode(a.privateKey).length === 32, 'key sizes');
  const b = await loadVapidKeys(f.db, { env: noEnv });
  assert(b && !b.created && b.publicKey === a.publicKey && b.privateKey === a.privateKey, 'second call reuses');
  // The stored pair signs a JWT that verifies with the public key.
  const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/x', b, 1_800_000_000);
  const [, hdr, claims, sig] = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=/)!;
  const pub = await crypto.subtle.importKey('raw', b64urlDecode(b.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(sig!), new TextEncoder().encode(`${hdr}.${claims}`)), 'JWT verifies');
});

Deno.test('loadVapidKeys keeps the pair another worker stored first', async () => {
  const other = { pub: 'B'.repeat(87), priv: 'c'.repeat(43) };
  const f = fakeDb();
  // Simulate the race: the vault fills between our read and our store.
  const rpc = (f.db as unknown as { rpc: (n: string, a?: Record<string, string>) => Promise<unknown> }).rpc;
  let first = true;
  (f.db as unknown as { rpc: unknown }).rpc = (n: string, a?: Record<string, string>) => {
    if (n === 'store_vapid_keys' && first) {
      first = false;
      return rpc('store_vapid_keys', { p_public: other.pub, p_private: other.priv }).then(() => rpc(n, a));
    }
    return rpc(n, a);
  };
  const k = await loadVapidKeys(f.db, { env: noEnv });
  assert(k && k.publicKey === other.pub && k.privateKey === other.priv && !k.created, 'stored pair wins');
});

Deno.test('loadVapidKeys adopts VAPID_* secrets when Vault is empty', async () => {
  const f = fakeDb();
  const pub = 'B'.repeat(87), priv = 'd'.repeat(43);
  const k = await loadVapidKeys(f.db, { env: (n) => ({ VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv } as Record<string, string>)[n] });
  assert(k && k.created && f.vault?.pub === pub && f.vault?.priv === priv, 'adopted');
});

Deno.test('vapidSubject is an https origin or mailto', () => {
  const env = (o: Record<string, string>) => (n: string) => o[n];
  assert(vapidSubject(env({ APP_URL: 'https://sleep-lab-lac.vercel.app/some/path' })) === 'https://sleep-lab-lac.vercel.app', 'origin');
  assert(vapidSubject(env({ VAPID_SUBJECT: 'mailto:someone@example.com' })) === 'mailto:someone@example.com', 'explicit subject');
  assert(vapidSubject(env({ VAPID_SUBJECT: 'nonsense', APP_URL: 'http://localhost:3000' })).startsWith('https://'), 'default');
});
