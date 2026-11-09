'use client';
/**
 * Passkeys (Face ID / Touch ID) for signing in without leaving the app (supabase/functions/passkey, migration 0033).
 *
 *   addPasskey()        signed in: creates a passkey for this account (synced by iCloud Keychain / Google Password
 *                       Manager to every browser, tab and home-screen app on the person's devices)
 *   signInWithPasskey() signed out: Face ID → the function checks the signature and hands back a one-time sign-in
 *                       token, redeemed here with verifyOtp, so the session is created in this very tab or app
 *
 * The passkey belongs to cathnivore.com, so it works on jarvis.cathnivore.com and sleep.cathnivore.com.
 */
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import { functionsUrl, supabaseClient, supabaseConfigured } from './data/supabase.ts';

export const passkeysSupported = (): boolean => typeof window !== 'undefined' && supabaseConfigured() && browserSupportsWebAuthn();

async function call(body: Record<string, unknown>, accessToken?: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${functionsUrl()}/passkey`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `passkey ${r.status}`);
  return j;
}

/** A short device name for the list in System › General. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Browser';
}

/** The person cancelled the Face ID sheet (or it timed out): not an error worth showing. */
function cancelled(e: unknown): boolean {
  return (e instanceof WebAuthnError && e.code === 'ERROR_CEREMONY_ABORTED') || (e instanceof Error && e.name === 'NotAllowedError');
}

/** Adds a passkey to the signed-in account. Null on success (or cancel), else a message. */
export async function addPasskey(): Promise<string | null> {
  const { data } = await supabaseClient().auth.getSession();
  const token = data.session?.access_token;
  if (!token) return 'Sign in first.';
  try {
    const { challengeId, options } = await call({ action: 'register-options' }, token);
    const response = await startRegistration({ optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'] });
    await call({ action: 'register-verify', challengeId, response, device: deviceName() }, token);
    return null;
  } catch (e) {
    if (e instanceof Error && e.name === 'InvalidStateError') return 'This device already has a passkey for your account.';
    if (cancelled(e)) return 'cancelled';
    return e instanceof Error ? e.message : String(e);
  }
}

/** Face ID sign-in. Null on success (the session is set), 'cancelled', or a message. */
export async function signInWithPasskey(): Promise<string | null> {
  try {
    const { challengeId, options } = await call({ action: 'login-options' });
    const response = await startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
    const res = await call({ action: 'login-verify', challengeId, response });
    if (typeof res.token_hash !== 'string') return 'No sign-in token came back.';
    const { error } = await supabaseClient().auth.verifyOtp({ token_hash: res.token_hash, type: 'magiclink' });
    return error ? error.message : null;
  } catch (e) {
    if (cancelled(e)) return 'cancelled';
    return e instanceof Error ? e.message : String(e);
  }
}

export interface PasskeyRow {
  id: string;
  device: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** This account's passkeys (RLS: own rows only). */
export async function listPasskeys(): Promise<PasskeyRow[]> {
  const { data, error } = await supabaseClient().from('passkeys').select('id,device,created_at,last_used_at').order('created_at');
  if (error) throw new Error(error.message);
  return (data ?? []) as PasskeyRow[];
}
