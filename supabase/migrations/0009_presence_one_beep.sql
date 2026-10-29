-- One beep per night, 22:00 bedtime, and "pre-cool only when someone is home" (decided 2026-10-29).
--
-- 1. curves: 'one-beep-v1' (mirrors DEFAULT_CURVE in packages/core/src/curve.ts) becomes the default curve.
--    'default-v1' stays for nights that were stored with it.
-- 2. nights: a per-night presence override ('home' / 'away', set from the PWA with set_presence_override) and the
--    pre-cool gate's last decision (precool_status / precool_reason / precool_at, written by ac-curve), so the app
--    can show e.g. "Pre-cool skipped: nobody home (no presence signal)".
-- 3. presence_events: "arrived home" / "left home" from each person's iPhone Shortcuts automation, posted to the
--    `presence` Edge Function with a per-person token. Household members read; only the service role writes.
-- 4. private.presence_tokens: one token per person, stored only as a SHA-256 hash (same idea as household_claims).
--    A signed-in owner/member creates or rotates it with public.rotate_presence_token(person), which returns the plain
--    token exactly once. public.record_presence() (service_role only) checks a token and stores the event.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

create extension if not exists pgcrypto with schema extensions;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------- 1. the one-beep curve

update public.curves set is_default = false where is_default and id <> 'one-beep-v1';

insert into public.curves (id, name, phases, min_c, max_c, is_default) values (
  'one-beep-v1',
  'One beep (default)',
  '[{"name":"precool","startMin":-30,"targetC":19,"fan":"auto"},
    {"name":"onset","startMin":0,"targetC":19,"fan":"auto"},
    {"name":"deep","startMin":30,"targetC":19,"fan":"auto"},
    {"name":"middle","startMin":270,"targetC":21,"fan":"auto"},
    {"name":"late","startMin":360,"targetC":21,"fan":"auto"},
    {"name":"wake","startMin":510,"targetC":21,"fan":"auto"}]'::jsonb,
  17, 24, true
)
on conflict (id) do update set
  name = excluded.name, phases = excluded.phases, min_c = excluded.min_c, max_c = excluded.max_c, is_default = true;

-- ---------------------------------------------------------------- 2. nights: override + pre-cool gate

alter table public.nights add column if not exists presence_override text
  check (presence_override in ('home', 'away'));
alter table public.nights add column if not exists precool_status text
  check (precool_status in ('started', 'waiting', 'skipped', 'away', 'override'));
alter table public.nights add column if not exists precool_reason text;
alter table public.nights add column if not exists precool_at timestamptz;

comment on column public.nights.presence_override is
  'Manual "Home tonight" / "Away tonight" from the PWA. home = pre-cool even without a presence signal; away = AC stays off.';
comment on column public.nights.precool_status is
  'Last decision of the ac-curve presence gate: started (someone home, AC on), waiting (nobody home yet, retried until '
  'lights-out + 3 h), skipped (nobody came home in time), away (marked away), override (home tonight by hand).';

-- Upcoming nights that were created automatically and never edited follow the new defaults (22:00, one-beep curve).
update public.nights n set
  lights_out = ((n.date - 1)::text || ' 22:00:00+07')::timestamptz,
  curve_id = 'one-beep-v1'
where n.date >= (now() at time zone 'Asia/Bangkok')::date
  and not n.is_sim
  and n.updated_at = n.created_at
  and n.lights_out > now() + interval '30 minutes';

-- ---------------------------------------------------------------- 3. presence events

create table if not exists public.presence_events (
  id bigint generated always as identity primary key,
  person_id text not null references public.people (id),
  state text not null check (state in ('home', 'away')),
  at timestamptz not null default now(),
  source text not null default 'shortcut' check (source in ('shortcut', 'manual', 'test'))
);
create index if not exists presence_events_person_at on public.presence_events (person_id, at desc);

alter table public.presence_events enable row level security;
create policy "household read" on public.presence_events for select to authenticated
  using ((select private.is_household_member()));
revoke all on public.presence_events from public, anon, authenticated;
grant select on public.presence_events to authenticated;
grant all on public.presence_events to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Latest event per person (security_invoker: RLS of presence_events applies).
create or replace view public.presence_latest with (security_invoker = true) as
select distinct on (e.person_id) e.person_id, e.state, e.at, e.source
from public.presence_events e
order by e.person_id, e.at desc;
revoke all on public.presence_latest from public, anon, authenticated;
grant select on public.presence_latest to authenticated, service_role;

-- ---------------------------------------------------------------- 4. per-person tokens (hash only)

create table if not exists private.presence_tokens (
  person_id text primary key references public.people (id),
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  created_by uuid,
  last_used_at timestamptz
);
alter table private.presence_tokens enable row level security;
create policy "definer functions only" on private.presence_tokens
  for all to anon, authenticated using (false) with check (false);
revoke all on private.presence_tokens from public, anon, authenticated;
grant all on private.presence_tokens to service_role;

create or replace function private.presence_token_hash(p_token text) returns bytea
language sql immutable set search_path = '' as $$
  select extensions.digest(btrim(coalesce(p_token, '')), 'sha256')
$$;
revoke all on function private.presence_token_hash(text) from public, anon, authenticated;

-- Creates or replaces the person's token and returns it once ("slp_" + 64 hex digits, 256 random bits).
-- The previous token stops working immediately.
create or replace function private.rotate_presence_token(p_person_id text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_token text := 'slp_' || encode(extensions.gen_random_bytes(32), 'hex');
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.people p where p.id = p_person_id) then
    raise exception 'unknown person %', p_person_id using errcode = '22023';
  end if;
  insert into private.presence_tokens (person_id, token_hash, created_at, created_by, last_used_at)
  values (p_person_id, private.presence_token_hash(v_token), now(), (select auth.uid()), null)
  on conflict (person_id) do update set
    token_hash = excluded.token_hash, created_at = excluded.created_at, created_by = excluded.created_by, last_used_at = null;
  return v_token;
end $$;
revoke all on function private.rotate_presence_token(text) from public, anon;
grant execute on function private.rotate_presence_token(text) to authenticated;

create or replace function public.rotate_presence_token(p_person_id text) returns text
language sql security invoker set search_path = '' as $$
  select private.rotate_presence_token(p_person_id)
$$;
revoke all on function public.rotate_presence_token(text) from public, anon;
grant execute on function public.rotate_presence_token(text) to authenticated;

-- Which people have a token, and when it was created / last used (never the hash).
create or replace function private.presence_token_status()
returns table (person_id text, created_at timestamptz, last_used_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not private.is_household_member() then
    raise exception 'not a household member' using errcode = '42501';
  end if;
  return query select t.person_id, t.created_at, t.last_used_at from private.presence_tokens t order by t.person_id;
end $$;
revoke all on function private.presence_token_status() from public, anon;
grant execute on function private.presence_token_status() to authenticated;

create or replace function public.presence_token_status()
returns table (person_id text, created_at timestamptz, last_used_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select * from private.presence_token_status()
$$;
revoke all on function public.presence_token_status() from public, anon;
grant execute on function public.presence_token_status() to authenticated;

-- Called by the `presence` Edge Function (service role). Unknown token → no row (the function answers 401).
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
    return;
  end if;
  return query
    insert into public.presence_events (person_id, state, source)
    values (v_person, p_state, case when p_source in ('shortcut', 'manual', 'test') then p_source else 'shortcut' end)
    returning presence_events.person_id, presence_events.state, presence_events.at;
end $$;
revoke all on function public.record_presence(text, text, text) from public, anon, authenticated;
grant execute on function public.record_presence(text, text, text) to service_role;

-- ---------------------------------------------------------------- 5. "Home tonight" / "Away tonight"

-- p_state: 'home', 'away', or null (back to automatic). Creates the night with the default schedule
-- (22:00 → 06:30 ICT, default curve) when it does not exist yet.
create or replace function private.set_presence_override(p_date date, p_state text) returns public.nights
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.nights;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_state is not null and p_state not in ('home', 'away') then
    raise exception 'state must be home, away or null' using errcode = '22023';
  end if;
  if p_date < (now() at time zone 'Asia/Bangkok')::date - 1 or p_date > (now() at time zone 'Asia/Bangkok')::date + 7 then
    raise exception 'date % is outside yesterday … 7 days ahead', p_date using errcode = '22023';
  end if;
  insert into public.nights (date, lights_out, wake, curve_id)
  values (p_date, ((p_date - 1)::text || ' 22:00:00+07')::timestamptz, (p_date::text || ' 06:30:00+07')::timestamptz,
          (select c.id from public.curves c where c.is_default))
  on conflict (date) do nothing;
  update public.nights n set presence_override = p_state, updated_at = now()
    where n.date = p_date
    returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_presence_override(date, text) from public, anon;
grant execute on function private.set_presence_override(date, text) to authenticated;

create or replace function public.set_presence_override(p_date date, p_state text) returns public.nights
language sql security invoker set search_path = '' as $$
  select * from private.set_presence_override(p_date, p_state)
$$;
revoke all on function public.set_presence_override(date, text) from public, anon;
grant execute on function public.set_presence_override(date, text) to authenticated;
