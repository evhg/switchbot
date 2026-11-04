-- Device tokens: one token per device, not only one per person (2026-11-04).
--
-- Until now each person had exactly one presence token (private.presence_tokens, 0009/0010). Erik's Mac night listener
-- used Erik's token, so rotating that token for his phone's OwnTracks stopped the Mac the same evening. Now every
-- device that acts for a person (the Mac's night listener, a second phone, a camera script) can get its own token:
--
-- 1. private.device_tokens: id, person_id (whose device it acts for), label ("Night listener (Erik's Mac)"), kind
--    ('listener' | 'phone' | 'device'), token_hash (SHA-256 via private.presence_token_hash, exactly like presence
--    tokens; the plain token is never stored), created_at / created_by, last_used_at, revoked_at. RLS on, no access for
--    anon/authenticated (definer functions only), service_role all. Revoking sets revoked_at; rows are kept.
--    Same token format as presence tokens ("slp_" + 64 hex digits), so the Edge Functions' PRESENCE_TOKEN check and
--    every client keep working unchanged.
-- 2. private.presence_token_person(token) (0022; used by camera-event and night-sound through the public wrapper)
--    resolves the person from the person's presence token OR from a non-revoked device token of any kind, and notes
--    last_used_at on the device token (at most once a minute). It writes now, so it and the wrapper become volatile;
--    name, argument and return type are unchanged. New presence_token_person_kinds(token, kinds) does the same but
--    accepts only device tokens of the listed kinds (null = any); owntracks calls it with {phone,device}.
-- 3. public.record_presence(token, state, source) (0009; the `presence` function) also accepts non-revoked device
--    tokens of kind 'phone' or 'device' (e.g. a second phone's Shortcut). So a 'listener' token is refused by both
--    `presence` and owntracks (no home/away, no locations); camera-event and night-sound accept any kind.
--    source and via handling are unchanged.
-- 4. RPCs (definer in private + invoker wrapper in public; writers only, and only for the own person unless household
--    owner, the same rule as rotate_presence_token in 0010):
--    create_device_token(person, label, kind default 'listener') → (id, token): the plain token, returned once;
--    revoke_device_token(id) → boolean (true when it was revoked by this call);
--    list_device_tokens() → (id, person_id, label, kind, created_at, last_used_at, revoked_at), household members, no hashes.
--
-- Idempotent, and written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

create extension if not exists pgcrypto with schema extensions;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------- 1. the table

create table if not exists private.device_tokens (
  id bigint generated always as identity primary key,
  person_id text not null references public.people (id),
  label text not null check (char_length(label) between 1 and 60),
  kind text not null default 'device' check (kind in ('listener', 'phone', 'device')),
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  created_by uuid,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists device_tokens_person on private.device_tokens (person_id);

comment on table private.device_tokens is
  'Per-device tokens (slp_ + 64 hex, stored as SHA-256 only). Resolved by presence_token_person and, for kind phone/device, '
  'record_presence. Created/revoked with create_device_token / revoke_device_token (migration 0028).';

alter table private.device_tokens enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'private' and tablename = 'device_tokens' and policyname = 'definer functions only'
  ) then
    create policy "definer functions only" on private.device_tokens
      for all to anon, authenticated using (false) with check (false);
  end if;
end $$;
revoke all on private.device_tokens from public, anon, authenticated;
grant all on private.device_tokens to service_role;
grant usage, select on sequence private.device_tokens_id_seq to service_role;

-- ---------------------------------------------------------------- 2. token → person (camera-event, night-sound; owntracks by kind)

-- Kind-aware: p_kinds null = a device token of any kind; otherwise only device tokens whose kind is listed.
-- owntracks passes {phone,device}, so a night-listener token cannot post locations or home/away.
create or replace function private.presence_token_person_kinds(p_token text, p_kinds text[]) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_hash bytea := private.presence_token_hash(p_token);
  v_person text;
begin
  select t.person_id into v_person from private.presence_tokens t where t.token_hash = v_hash;
  if v_person is not null then
    return v_person;
  end if;
  -- A device token: note when it was last used, at most once a minute (the Mac asks every 60 s).
  update private.device_tokens d set last_used_at = now()
    where d.token_hash = v_hash and d.revoked_at is null
      and (p_kinds is null or d.kind = any (p_kinds))
      and (d.last_used_at is null or d.last_used_at < now() - interval '60 seconds')
    returning d.person_id into v_person;
  if v_person is null then
    select d.person_id into v_person from private.device_tokens d
      where d.token_hash = v_hash and d.revoked_at is null
        and (p_kinds is null or d.kind = any (p_kinds));
  end if;
  return v_person;
end $$;
revoke all on function private.presence_token_person_kinds(text, text[]) from public, anon, authenticated;
grant execute on function private.presence_token_person_kinds(text, text[]) to service_role;

create or replace function public.presence_token_person_kinds(p_token text, p_kinds text[]) returns text
language sql volatile security invoker set search_path = '' as $$
  select private.presence_token_person_kinds(p_token, p_kinds)
$$;
revoke all on function public.presence_token_person_kinds(text, text[]) from public, anon, authenticated;
grant execute on function public.presence_token_person_kinds(text, text[]) to service_role;

-- Any kind (camera-event, night-sound).
create or replace function private.presence_token_person(p_token text) returns text
language sql volatile security definer set search_path = '' as $$
  select private.presence_token_person_kinds(p_token, null)
$$;
revoke all on function private.presence_token_person(text) from public, anon, authenticated;
grant execute on function private.presence_token_person(text) to service_role;

create or replace function public.presence_token_person(p_token text) returns text
language sql volatile security invoker set search_path = '' as $$
  select private.presence_token_person(p_token)
$$;
revoke all on function public.presence_token_person(text) from public, anon, authenticated;
grant execute on function public.presence_token_person(text) to service_role;

-- ---------------------------------------------------------------- 3. record_presence also takes phone/device tokens

-- Called by the `presence` Edge Function (service role). Unknown or revoked token → no row (the function answers 401).
create or replace function public.record_presence(p_token text, p_state text, p_source text default 'shortcut')
returns table (person_id text, state text, at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_person text;
begin
  if p_state not in ('home', 'away') then
    raise exception 'state must be home or away' using errcode = '22023';
  end if;
  update private.presence_tokens t set last_used_at = now()
    where t.token_hash = private.presence_token_hash(p_token)
    returning t.person_id into v_person;
  if v_person is null then
    update private.device_tokens d set last_used_at = now()
      where d.token_hash = private.presence_token_hash(p_token)
        and d.revoked_at is null
        and d.kind in ('phone', 'device')
      returning d.person_id into v_person;
  end if;
  if v_person is null then
    return;
  end if;
  return query
    insert into public.presence_events (person_id, state, source)
    values (v_person, p_state, case when p_source in ('shortcut', 'manual', 'test') then p_source else 'shortcut' end)
    returning presence_events.person_id, presence_events.state, presence_events.at;
end $$;
revoke all on function public.record_presence(text, text, text) from public, anon, authenticated;
grant execute on function public.record_presence(text, text, text) to service_role;

-- ---------------------------------------------------------------- 4. create / revoke / list

-- Writers only; the own person (household_members.person_id) or any person as the household owner (as in 0010).
create or replace function private.may_manage_person_tokens(p_person_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_household_writer() and exists (
    select 1 from public.household_members m
    where m.user_id = (select auth.uid()) and (m.role = 'owner' or m.person_id = p_person_id)
  )
$$;
revoke all on function private.may_manage_person_tokens(text) from public, anon;
grant execute on function private.may_manage_person_tokens(text) to authenticated;

-- Creates a device token and returns it once ("slp_" + 64 hex digits, 256 random bits); only its hash is stored.
create or replace function private.create_device_token(p_person_id text, p_label text, p_kind text default 'listener')
returns table (id bigint, token text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_token text := 'slp_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_label text := btrim(coalesce(p_label, ''));
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'listener');
  v_id bigint;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.people p where p.id = p_person_id) then
    raise exception 'unknown person %', p_person_id using errcode = '22023';
  end if;
  if not private.may_manage_person_tokens(p_person_id) then
    raise exception 'not allowed: only the own person or the household owner can create this token' using errcode = '42501';
  end if;
  if char_length(v_label) < 1 or char_length(v_label) > 60 then
    raise exception 'label must be 1 to 60 characters' using errcode = '22023';
  end if;
  if v_kind not in ('listener', 'phone', 'device') then
    raise exception 'kind must be listener, phone or device' using errcode = '22023';
  end if;
  insert into private.device_tokens (person_id, label, kind, token_hash, created_by)
  values (p_person_id, v_label, v_kind, private.presence_token_hash(v_token), (select auth.uid()))
  returning device_tokens.id into v_id;
  return query select v_id, v_token;
end $$;
revoke all on function private.create_device_token(text, text, text) from public, anon;
grant execute on function private.create_device_token(text, text, text) to authenticated;

create or replace function public.create_device_token(p_person_id text, p_label text, p_kind text default 'listener')
returns table (id bigint, token text)
language sql security invoker set search_path = '' as $$
  select * from private.create_device_token(p_person_id, p_label, p_kind)
$$;
revoke all on function public.create_device_token(text, text, text) from public, anon;
grant execute on function public.create_device_token(text, text, text) to authenticated;

-- Stops a device token at once (sets revoked_at; the row stays for the list). True when this call revoked it.
create or replace function private.revoke_device_token(p_id bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_person text;
  v_revoked timestamptz;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  select d.person_id, d.revoked_at into v_person, v_revoked from private.device_tokens d where d.id = p_id;
  if v_person is null then
    raise exception 'unknown device token %', p_id using errcode = '22023';
  end if;
  if not private.may_manage_person_tokens(v_person) then
    raise exception 'not allowed: only the own person or the household owner can revoke this token' using errcode = '42501';
  end if;
  if v_revoked is not null then
    return false;
  end if;
  update private.device_tokens d set revoked_at = now() where d.id = p_id and d.revoked_at is null;
  return found;
end $$;
revoke all on function private.revoke_device_token(bigint) from public, anon;
grant execute on function private.revoke_device_token(bigint) to authenticated;

create or replace function public.revoke_device_token(p_id bigint) returns boolean
language sql security invoker set search_path = '' as $$
  select private.revoke_device_token(p_id)
$$;
revoke all on function public.revoke_device_token(bigint) from public, anon;
grant execute on function public.revoke_device_token(bigint) to authenticated;

-- All device tokens of the household (never the hash): working ones first, newest first.
create or replace function private.list_device_tokens()
returns table (id bigint, person_id text, label text, kind text, created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not private.is_household_member() then
    raise exception 'not a household member' using errcode = '42501';
  end if;
  return query
    select d.id, d.person_id, d.label, d.kind, d.created_at, d.last_used_at, d.revoked_at
    from private.device_tokens d
    order by (d.revoked_at is not null), d.created_at desc;
end $$;
revoke all on function private.list_device_tokens() from public, anon;
grant execute on function private.list_device_tokens() to authenticated;

create or replace function public.list_device_tokens()
returns table (id bigint, person_id text, label text, kind text, created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select * from private.list_device_tokens()
$$;
revoke all on function public.list_device_tokens() from public, anon;
grant execute on function public.list_device_tokens() to authenticated;
