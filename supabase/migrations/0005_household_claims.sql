-- Household seed + one-time claim codes, so the two people can bind their own accounts to their person rows
-- without the owner looking up auth user ids.
--
-- Flow (docs/BACKEND.md, "Household and sign-in"):
--   1. The owner invites both email addresses (Dashboard > Authentication > Users > Invite user). Public sign-ups
--      stay off; the PWA signs in with shouldCreateUser = false.
--   2. The owner creates one code per person in the SQL editor (the code is shown once, only a hash is stored):
--        select private.create_household_claim('a', 'owner');
--        select private.create_household_claim('b', 'member');
--   3. Each person signs in at /signin, lands on "Almost there", and enters their code. public.claim_household()
--      inserts their household_members row and burns the code.
--
-- Codes carry 96 random bits, expire after 7 days by default, are single use, and a person can be bound to only
-- one account. Creating a new code for a person revokes that person's older unused codes.

create extension if not exists pgcrypto with schema extensions;

grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------- people (the household)
-- Only the two person rows; no readings or other simulated data.

insert into public.people (id, name, color_key) values
  ('a', 'You', 'personA'),
  ('b', 'Erik', 'personB')
on conflict (id) do nothing;

-- ---------------------------------------------------------------- claim codes

create table if not exists private.household_claims (
  id uuid primary key default gen_random_uuid(),
  code_hash bytea not null unique,
  person_id text not null references public.people (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  claimed_by uuid references auth.users (id) on delete set null,
  claimed_at timestamptz
);
create index if not exists household_claims_person_id_idx on private.household_claims (person_id);
create index if not exists household_claims_claimed_by_idx on private.household_claims (claimed_by);
alter table private.household_claims enable row level security;
revoke all on private.household_claims from public, anon, authenticated;
grant all on private.household_claims to service_role;

-- Codes are compared case-insensitively and without separators, so "7F3A-..." and "7f3a..." both work.
create or replace function private.household_claim_hash(p_code text) returns bytea
language sql immutable set search_path = '' as $$
  select extensions.digest(lower(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'sha256')
$$;
revoke all on function private.household_claim_hash(text) from public, anon, authenticated;

-- Owner-only (SQL editor / service role). Returns the code once, formatted as 6 groups of 4 hex digits.
create or replace function private.create_household_claim(
  p_person_id text,
  p_role text default 'member',
  p_valid_for interval default interval '7 days'
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_raw text := encode(extensions.gen_random_bytes(12), 'hex');
begin
  if not exists (select 1 from public.people p where p.id = p_person_id) then
    raise exception 'unknown person %', p_person_id using errcode = '22023';
  end if;
  if exists (select 1 from public.household_members m where m.person_id = p_person_id) then
    raise exception 'person % is already linked to an account', p_person_id using errcode = '23505';
  end if;
  update private.household_claims c set revoked_at = now()
    where c.person_id = p_person_id and c.claimed_at is null and c.revoked_at is null;
  insert into private.household_claims (code_hash, person_id, role, expires_at)
    values (private.household_claim_hash(v_raw), p_person_id, p_role, now() + p_valid_for);
  return upper(regexp_replace(v_raw, '(.{4})(?!$)', '\1-', 'g'));
end $$;
revoke all on function private.create_household_claim(text, text, interval) from public, anon, authenticated;
grant execute on function private.create_household_claim(text, text, interval) to service_role;

-- Called by the signed-in user. Idempotent for an existing member (returns their row).
create or replace function private.claim_household(p_code text)
returns table (person_id text, role text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_claim private.household_claims;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if exists (select 1 from public.household_members m where m.user_id = v_uid) then
    return query select m.person_id, m.role from public.household_members m where m.user_id = v_uid;
    return;
  end if;
  select * into v_claim from private.household_claims c
    where c.code_hash = private.household_claim_hash(p_code)
      and c.claimed_at is null and c.revoked_at is null and c.expires_at > now()
    for update;
  if not found then
    raise exception 'invalid or expired code' using errcode = '22023';
  end if;
  if exists (select 1 from public.household_members m where m.person_id = v_claim.person_id) then
    raise exception 'this person is already linked to another account' using errcode = '23505';
  end if;
  insert into public.household_members (user_id, person_id, role) values (v_uid, v_claim.person_id, v_claim.role);
  update private.household_claims c set claimed_by = v_uid, claimed_at = now() where c.id = v_claim.id;
  return query select v_claim.person_id, v_claim.role;
end $$;
revoke all on function private.claim_household(text) from public, anon;
grant execute on function private.claim_household(text) to authenticated;

-- Exposed RPC: SECURITY INVOKER wrapper (same pattern as 0004), so nothing definer lives in `public`.
create or replace function public.claim_household(p_code text)
returns table (person_id text, role text)
language sql security invoker set search_path = '' as $$
  select * from private.claim_household(p_code)
$$;
revoke all on function public.claim_household(text) from public, anon;
grant execute on function public.claim_household(text) to authenticated;
