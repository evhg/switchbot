// Web Push opt-in for the morning report. iOS only allows it in the Home Screen app and from a user tap.
// The applicationServerKey (VAPID public key) comes from, in order: NEXT_PUBLIC_VAPID_PUBLIC_KEY (build-time override),
// household_settings.vapid_public_key (members can read it; migration 0016), then GET <functions>/push-admin, which
// returns {"publicKey"} and creates the key pair on first use. With none of them the toggle says push isn't ready yet.
import { functionsUrl, pushSubscribe, supabaseClient, supabaseConfigured } from './data/supabase.ts';

const KEY_RE = /^[A-Za-z0-9_-]{86,88}$/;
const valid = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k.trim());

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

let keyPromise: Promise<string | null> | null = null;

/** The VAPID public key, or null when the backend hasn't published one (cached per page load; a miss is retried). */
export function resolveVapidKey(): Promise<string | null> {
  keyPromise ??= (async () => {
    const env = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (valid(env)) return env.trim();
    if (!supabaseConfigured()) return null;
    try {
      const { data } = await supabaseClient().from('household_settings').select('vapid_public_key').eq('id', 1).maybeSingle();
      const k = (data as { vapid_public_key?: unknown } | null)?.vapid_public_key;
      if (valid(k)) return k.trim();
    } catch {
      /* column not there yet: try the function */
    }
    try {
      const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
      const res = await fetch(`${functionsUrl()}/push-admin`, { headers: anon ? { apikey: anon, Authorization: `Bearer ${anon}` } : {} });
      if (res.ok) {
        const j = (await res.json()) as { publicKey?: unknown };
        if (valid(j.publicKey)) return j.publicKey.trim();
      }
    } catch {
      /* offline or not deployed */
    }
    return null;
  })();
  const p = keyPromise;
  p.then((k) => {
    if (!k && keyPromise === p) keyPromise = null;
  });
  return p;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sameKey = (sub: PushSubscription, key: string) => {
  const k = sub.options?.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k);
  const b = b64urlToBytes(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

/** Whether this device already holds a push subscription (null when push isn't supported here). */
export async function pushSubscribed(): Promise<boolean | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(reg && (await reg.pushManager.getSubscription()));
}

/** Asks for permission, subscribes with the backend's VAPID key and stores the subscription (register_push_subscription). */
export async function enablePush(): Promise<{ ok: boolean; text: string }> {
  if (!pushSupported()) return { ok: false, text: 'Push needs the Home Screen app (iOS 16.4+) or a desktop browser.' };
  const key = await resolveVapidKey();
  if (!key) return { ok: false, text: 'Notifications aren’t ready yet: the backend hasn’t published its push key. Try again later.' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, text: 'Notifications are blocked for this app. Allow them in the browser or iPhone settings.' };
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with an older key would never receive anything: replace it.
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
  const err = await pushSubscribe(sub.toJSON(), navigator.userAgent);
  return err ? { ok: false, text: err } : { ok: true, text: 'Morning report notifications are on for this device.' };
}

/** Removes this device's subscription (and tells the backend, best effort). */
export async function disablePush(): Promise<string> {
  if (!pushSupported()) return 'Off.';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => false);
    if (supabaseConfigured()) await supabaseClient().rpc('unregister_push_subscription', { p_endpoint: endpoint }).then(() => undefined, () => undefined);
  }
  return 'Morning report notifications are off for this device.';
}
