// Web Push VAPID keys, zero-touch: generated inside the backend with WebCrypto the first time they are needed and
// kept in Vault (migration 0016: store_vapid_keys / vapid_keys, service_role only). The public key is also copied to
// household_settings.vapid_public_key (member-readable) and served by GET /functions/v1/push-admin.
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY function secrets, when set and Vault is still empty, are adopted into Vault so
// there is one source of truth.
import { optEnv } from './env.ts';
import type { Db } from './supabase.ts';
import { generateVapidKeys, type VapidKeys } from './webpush.ts';

const DEFAULT_SUBJECT = 'https://sleep-lab-lac.vercel.app';

/** RFC 8292 `sub`: VAPID_SUBJECT, else the app's https origin (mailto: or https: are both valid). */
type EnvGet = (name: string) => string | undefined;

export function vapidSubject(getEnv: EnvGet = optEnv): string {
  const s = getEnv('VAPID_SUBJECT');
  if (s && /^(mailto:|https:)/.test(s)) return s;
  const app = getEnv('APP_URL') ?? '';
  return /^https:/.test(app) ? new URL(app).origin : DEFAULT_SUBJECT;
}

async function readVault(db: Db): Promise<{ publicKey: string; privateKey: string } | null> {
  const { data, error } = await db.rpc('vapid_keys');
  if (error) throw new Error(`vapid_keys: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { public_key: string | null; private_key: string | null } | null;
  return row?.public_key && row.private_key ? { publicKey: row.public_key, privateKey: row.private_key } : null;
}

/**
 * The VAPID key pair in effect. With `create` (default true) a missing pair is created (or adopted from the
 * VAPID_* secrets) and stored; concurrent creators are serialised in store_vapid_keys and the stored pair wins.
 */
export async function loadVapidKeys(db: Db, opts: { create?: boolean; env?: EnvGet } = {}): Promise<(VapidKeys & { created: boolean }) | null> {
  const getEnv = opts.env ?? optEnv;
  let keys = await readVault(db);
  let created = false;
  if (!keys) {
    if (opts.create === false) return null;
    const envPub = getEnv('VAPID_PUBLIC_KEY');
    const envPriv = getEnv('VAPID_PRIVATE_KEY');
    const fresh = envPub && envPriv ? { publicKey: envPub, privateKey: envPriv } : await generateVapidKeys();
    const { error } = await db.rpc('store_vapid_keys', { p_public: fresh.publicKey, p_private: fresh.privateKey });
    if (error) throw new Error(`store_vapid_keys: ${error.message}`);
    keys = await readVault(db);
    if (!keys) throw new Error('VAPID keys missing after store');
    created = keys.publicKey === fresh.publicKey;
  }
  return { ...keys, subject: vapidSubject(getEnv), created };
}
