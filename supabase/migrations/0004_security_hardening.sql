-- Security and performance advisor fixes (Supabase database linter), after 0001-0003 ran against a live project.
--
-- 0029 authenticated_security_definer_function_executable: SECURITY DEFINER functions in `public` are callable
--   through /rest/v1/rpc. The membership helpers and the PWA write paths keep their definer bodies, but those now
--   live in the non-exposed `private` schema. `public` keeps thin SECURITY INVOKER wrappers with the same
--   signatures for the three RPCs the PWA calls; the membership helpers are no longer exposed at all.
-- 0008 rls_enabled_no_policy: the service-role-only tables get an explicit deny-all policy for anon and
--   authenticated, so the intent is visible (the service role bypasses RLS either way).
-- 0001 unindexed_foreign_keys: covering indexes for every foreign key.

grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------- membership helpers

create or replace function private.is_household_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members m where m.user_id = (select auth.uid()))
$$;

-- Owners and members may change things; 'viewer' is read-only.
create or replace function private.is_household_writer() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members m where m.user_id = (select auth.uid()) and m.role in ('owner', 'member'))
$$;

revoke all on function private.is_household_member() from public, anon;
revoke all on function private.is_household_writer() from public, anon;
grant execute on function private.is_household_member() to authenticated, service_role;
grant execute on function private.is_household_writer() to authenticated, service_role;

-- Re-point the read policies at the private helper.
do $$
declare
  t text;
begin
  foreach t in array array[
    'people', 'household_members', 'devices', 'readings', 'raw_switchbot', 'outdoor_readings', 'calibrations',
    'curves', 'nights', 'ac_commands', 'ac_state', 'events', 'raw_health', 'health_hr', 'health_hrv',
    'health_spo2', 'sleep_sessions', 'health_daily', 'reports', 'api_quota', 'api_quota_log', 'health_vitals_daily'
  ] loop
    execute format('drop policy if exists "household read" on public.%I', t);
    execute format('create policy "household read" on public.%I for select to authenticated using ((select private.is_household_member()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- PWA write paths

create or replace function private.set_night(
  p_date date,
  p_lights_out timestamptz default null,
  p_wake timestamptz default null,
  p_tags text[] default null,
  p_curve_id text default null,
  p_ac_enabled boolean default null
) returns public.nights
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.nights;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_date < (now() at time zone 'Asia/Bangkok')::date - 7 or p_date > (now() at time zone 'Asia/Bangkok')::date + 7 then
    raise exception 'date % is outside ±7 days of today', p_date using errcode = '22023';
  end if;
  update public.nights n set
    lights_out = coalesce(p_lights_out, n.lights_out),
    wake = coalesce(p_wake, n.wake),
    tags = coalesce(p_tags, n.tags),
    curve_id = coalesce(p_curve_id, n.curve_id),
    ac_enabled = coalesce(p_ac_enabled, n.ac_enabled),
    updated_at = now()
  where n.date = p_date
  returning * into v_row;
  if not found then
    if p_lights_out is null or p_wake is null then
      raise exception 'new night % needs lights_out and wake', p_date;
    end if;
    insert into public.nights (date, lights_out, wake, tags, curve_id, ac_enabled)
    values (p_date, p_lights_out, p_wake, coalesce(p_tags, '{}'),
            coalesce(p_curve_id, (select c.id from public.curves c where c.is_default)), coalesce(p_ac_enabled, true))
    returning * into v_row;
  end if;
  return v_row;
end $$;

create or replace function private.register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_household_member() then
    raise exception 'not a household member' using errcode = '42501';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values ((select auth.uid()), p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update set
    user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, failures = 0;
end $$;

create or replace function private.unregister_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions s where s.endpoint = p_endpoint and s.user_id = (select auth.uid())
$$;

revoke all on function private.set_night(date, timestamptz, timestamptz, text[], text, boolean) from public, anon;
revoke all on function private.register_push_subscription(text, text, text, text) from public, anon;
revoke all on function private.unregister_push_subscription(text) from public, anon;
grant execute on function private.set_night(date, timestamptz, timestamptz, text[], text, boolean) to authenticated;
grant execute on function private.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function private.unregister_push_subscription(text) to authenticated;

-- Public RPC names and signatures are unchanged; they now run as the caller and delegate.
create or replace function public.set_night(
  p_date date,
  p_lights_out timestamptz default null,
  p_wake timestamptz default null,
  p_tags text[] default null,
  p_curve_id text default null,
  p_ac_enabled boolean default null
) returns public.nights
language sql security invoker set search_path = '' as $$
  select * from private.set_night(p_date, p_lights_out, p_wake, p_tags, p_curve_id, p_ac_enabled)
$$;

create or replace function public.register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void
language sql security invoker set search_path = '' as $$
  select private.register_push_subscription(p_endpoint, p_p256dh, p_auth, p_user_agent)
$$;

create or replace function public.unregister_push_subscription(p_endpoint text) returns void
language sql security invoker set search_path = '' as $$
  select private.unregister_push_subscription(p_endpoint)
$$;

revoke all on function public.set_night(date, timestamptz, timestamptz, text[], text, boolean) from public, anon;
revoke all on function public.register_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.unregister_push_subscription(text) from public, anon;
grant execute on function public.set_night(date, timestamptz, timestamptz, text[], text, boolean) to authenticated;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.unregister_push_subscription(text) to authenticated;

-- The exposed membership helpers have no callers left (policies use the private ones).
drop function public.is_household_member();
drop function public.is_household_writer();

-- ---------------------------------------------------------------- service-role-only tables

create policy "service role only" on public.oauth_tokens for all to anon, authenticated using (false) with check (false);
create policy "service role only" on public.oauth_states for all to anon, authenticated using (false) with check (false);
create policy "service role only" on public.health_sync_jobs for all to anon, authenticated using (false) with check (false);

-- ---------------------------------------------------------------- foreign-key indexes

create index if not exists ac_state_last_command_id_idx on public.ac_state (last_command_id);
create index if not exists health_sync_jobs_person_id_idx on public.health_sync_jobs (person_id);
create index if not exists household_members_person_id_idx on public.household_members (person_id);
create index if not exists nights_curve_id_idx on public.nights (curve_id);
create index if not exists oauth_states_person_id_idx on public.oauth_states (person_id);
create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);
