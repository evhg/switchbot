// Web Push opt-in for the morning report. iOS only allows it in the Home Screen app and from a user tap.
import { pushSubscribe } from './data/supabase.ts';

export const pushKey = () => process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Asks for permission, subscribes with the VAPID key and stores the subscription via register_push_subscription. */
export async function enablePush(): Promise<string> {
  if (!pushSupported()) return 'Push needs the Home Screen app (iOS 16.4+) or a desktop browser.';
  const key = pushKey();
  if (!key) return 'Set NEXT_PUBLIC_VAPID_PUBLIC_KEY (same value as the VAPID_PUBLIC_KEY function secret).';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'Notifications are blocked for this app.';
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) }));
  const err = await pushSubscribe(sub.toJSON(), navigator.userAgent);
  return err ?? 'Morning report notifications are on for this device.';
}
