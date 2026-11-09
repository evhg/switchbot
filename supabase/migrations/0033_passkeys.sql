-- Passkeys (Face ID / Touch ID) for signing in to the app without leaving it.
--
-- On iPhone, "Continue with Google" leaves the home-screen app for Safari, so the session often lands in the wrong
-- storage and the app asks again. A passkey is checked inside the app itself (WebAuthn), is synced by iCloud
-- Keychain to every browser and tab on the person's devices, and is bound to cathnivore.com, so it works on
-- jarvis.cathnivore.com and the old sleep.cathnivore.com alike.
--
-- The passkey Edge Function does all the work with the service key:
--   register  a signed-in user adds a passkey: its id, public key and counter go to public.passkeys
--   login     a passkey signature is checked against the stored public key; then the function asks Supabase Auth
--             for a one-time magic-link token for that user (no email is sent), which the app redeems (verifyOtp)
-- Challenges are single use (used_at) and expire after 5 minutes; old rows are harmless.

create table if not exists public.passkeys (
  id text primary key,                         -- credential id, base64url
  user_id uuid not null references auth.users (id) on delete cascade,
  public_key text not null,                    -- COSE public key, base64url
  counter bigint not null default 0,
  transports text[] not null default '{}',
  device text,                                 -- "iPhone", "Mac" … from the user agent at registration
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists passkeys_user_idx on public.passkeys (user_id);

alter table public.passkeys enable row level security;
-- People can list (System › General) their own passkeys; only the Edge Function writes.
create policy "own passkeys readable" on public.passkeys for select to authenticated using (user_id = auth.uid());
grant select on public.passkeys to authenticated;

create table if not exists public.passkey_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge text not null,
  kind text not null check (kind in ('register', 'login')),
  user_id uuid references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.passkey_challenges enable row level security;
-- No policies: service role only.

comment on table public.passkeys is 'WebAuthn passkeys for app sign-in (rp id cathnivore.com); written by the passkey Edge Function.';
comment on table public.passkey_challenges is 'Single-use WebAuthn challenges (5 min) for the passkey Edge Function.';
