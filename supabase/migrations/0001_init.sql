-- Bedroom Sleep Lab: core schema.
-- Conventions (see packages/core/src/types.ts): timestamps are timestamptz (UTC); a night is keyed by the
-- ICT (UTC+7) calendar date of the wake-up morning. Edge Functions write with the service role; the PWA reads
-- as an authenticated household member under RLS. Writes from the PWA go through the security-definer RPCs
-- at the bottom of this file.

create extension if not exists supabase_vault;  -- enabled by default on Supabase; provides vault.secrets

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------- household & people

create table public.people (
  id text primary key,                         -- matches Person.id / PersonNight.personId ('a', 'b')
  name text not null,
  color_key text not null default 'personA',
  google_health_user_id text unique,           -- healthUserId from /users/me/identity; maps webhook notifications
  created_at timestamptz not null default now()
);

create table public.household_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  person_id text references public.people (id) on delete set null,
  role text not null default 'member' check (role in ('owner', 'member', 'viewer')),
  created_at timestamptz not null default now()
);

create table public.devices (
  device_id text primary key,                  -- SwitchBot deviceId (BLE devices: MAC without colons, upper case)
  kind text not null check (kind in ('meter', 'ac', 'hub', 'camera', 'sim', 'other')),
  name text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- room

create table public.readings (
  device_id text not null,
  ts timestamptz not null,                     -- floored to the minute by the writers, so webhook + poll dedupe
  temp_c real not null,
  rh real not null,
  co2 integer not null,
  source text not null check (source in ('webhook', 'poll', 'ble', 'sim', 'manual')),
  inserted_at timestamptz not null default now(),
  primary key (device_id, ts)
);
create index readings_ts_brin on public.readings using brin (ts);

-- Every SwitchBot webhook body, unchanged (append-only). Used to measure webhook cadence and lag in week 1.
create table public.raw_switchbot (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  device_mac text,
  event_type text,
  time_of_sample bigint,
  payload jsonb not null
);
create index raw_switchbot_received_brin on public.raw_switchbot using brin (received_at);

create table public.outdoor_readings (
  ts timestamptz primary key,
  temp_c real not null,
  rh real not null,
  source text not null default 'manual'
);

create table public.calibrations (
  id bigint generated always as identity primary key,
  device_id text not null,
  ts timestamptz not null default now(),
  kind text not null check (kind in ('co2_outdoor', 'co2_offset', 'temp_offset', 'rh_offset', 'other')),
  value real,
  detail jsonb not null default '{}',
  notes text
);

-- ---------------------------------------------------------------- curves, nights, aircon

create table public.curves (
  id text primary key,
  name text not null,
  phases jsonb not null check (jsonb_typeof(phases) = 'array'),   -- CurvePhase[]
  min_c real not null,
  max_c real not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  check (min_c < max_c)
);
create unique index curves_single_default on public.curves (is_default) where is_default;

-- Mirrors DEFAULT_CURVE in packages/core/src/curve.ts.
insert into public.curves (id, name, phases, min_c, max_c, is_default) values (
  'default-v1',
  'Cool & deep (default)',
  '[{"name":"precool","startMin":-90,"targetC":20.5},
    {"name":"onset","startMin":0,"targetC":20},
    {"name":"deep","startMin":40,"targetC":19},
    {"name":"middle","startMin":240,"targetC":19,"ramp":true},
    {"name":"late","startMin":360,"targetC":21.5},
    {"name":"wake","startMin":450,"targetC":22}]'::jsonb,
  17, 24, true
);

create table public.nights (
  date date primary key,                       -- ICT wake date
  lights_out timestamptz not null,
  wake timestamptz not null,
  curve_id text references public.curves (id) on update cascade,
  tags text[] not null default '{}',           -- TagKey[]
  ac_enabled boolean not null default true,
  is_sim boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (wake > lights_out)
);

create table public.ac_commands (
  id bigint generated always as identity primary key,
  device_id text not null,
  night_date date references public.nights (date) on delete set null,
  ts timestamptz not null,
  state jsonb not null,                        -- AcState
  via text not null check (via in ('setAll', 'customize')),
  button text,
  reason text not null,
  landed boolean,                              -- null = not evaluated yet
  dry_run boolean not null default false,
  sent_ok boolean,
  error text,
  created_at timestamptz not null default now(),
  unique (device_id, ts)
);
create index ac_commands_night on public.ac_commands (night_date);

-- One row per AC: what we last commanded (IR is open loop, so this is an assumption, not a reading).
create table public.ac_state (
  device_id text primary key,
  state jsonb,                                 -- AcState
  via text check (via in ('setAll', 'customize')),
  button text,
  last_command_id bigint references public.ac_commands (id) on delete set null,
  remote jsonb,                                -- RemoteProfile; null = DEFAULT_REMOTE
  bias_c real,                                 -- prior setpoint bias (ControllerInput.biasC); null = controller default
  failures integer not null default 0,         -- consecutive failed sends (backoff; reset by a successful send)
  last_attempt_at timestamptz,                 -- last send attempt, successful or not
  updated_at timestamptz not null default now()
);

create table public.events (
  id bigint generated always as identity primary key,
  night_date date,
  kind text not null check (kind in ('shower', 'door_open', 'in_bed', 'both_in_bed', 'out_of_bed', 'room_empty', 'ac_missed', 'calibration')),
  start_ts timestamptz not null,
  end_ts timestamptz,
  confidence real not null default 1 check (confidence >= 0 and confidence <= 1),
  detail jsonb not null default '{}',
  source text not null default 'detector' check (source in ('detector', 'manual', 'sim_truth', 'controller')),
  created_at timestamptz not null default now()
);
create index events_night on public.events (night_date, kind);
create index events_start on public.events (start_ts);

-- ---------------------------------------------------------------- body (Google Health API v4)

-- Append-only archive of what Google returned. Never updated or deleted (trigger below), so reprocessed
-- nights show up as new versions (new update_time). High-frequency types (heart-rate) are stored as hourly
-- chunks of the unchanged points, keyed by content hash; see supabase/functions/google-health-sync.
create table public.raw_health (
  id bigint generated always as identity primary key,
  person_id text not null references public.people (id),
  data_type text not null,
  point_key text not null,
  payload jsonb not null,
  update_time timestamptz,
  data_source jsonb,
  fetched_at timestamptz not null default now(),
  constraint raw_health_version_unique unique nulls not distinct (person_id, data_type, point_key, update_time)
);
create index raw_health_person_type on public.raw_health (person_id, data_type, fetched_at desc);

create function private.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create trigger raw_health_append_only before update or delete on public.raw_health
  for each row execute function private.forbid_change();

-- Derived layers, rebuilt from raw_health or from the API at any time.
create table public.health_hr (
  person_id text not null references public.people (id),
  ts timestamptz not null,                     -- minute bucket
  bpm real not null,                           -- mean of the samples in the minute
  bpm_min smallint,
  n smallint not null default 1,
  primary key (person_id, ts)
);
create index health_hr_ts_brin on public.health_hr using brin (ts);

create table public.health_hrv (
  person_id text not null references public.people (id),
  ts timestamptz not null,
  rmssd_ms real not null,
  primary key (person_id, ts)
);

create table public.health_spo2 (
  person_id text not null references public.people (id),
  ts timestamptz not null,
  pct real not null,
  primary key (person_id, ts)
);

create table public.sleep_sessions (
  person_id text not null references public.people (id),
  start_ts timestamptz not null,
  end_ts timestamptz not null,
  stages jsonb not null default '[]',          -- StageSegment[] (epoch ms)
  update_time timestamptz,
  source text not null default 'google' check (source in ('google', 'sim', 'own')),
  fetched_at timestamptz not null default now(),
  primary key (person_id, start_ts)
);
create index sleep_sessions_end on public.sleep_sessions (person_id, end_ts desc);

-- daily-* types (resting HR, daily HRV, sleep temperature derivations, respiratory rate, ...): latest version.
create table public.health_daily (
  person_id text not null references public.people (id),
  data_type text not null,
  date date not null,
  value jsonb not null,
  update_time timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (person_id, data_type, date)
);

create table public.health_sync_jobs (
  id bigint generated always as identity primary key,
  person_id text references public.people (id) on delete cascade,
  data_types text[] not null default '{}',
  intervals jsonb,
  reason text not null default 'webhook',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  done_at timestamptz,
  error text
);
create index health_sync_jobs_pending on public.health_sync_jobs (created_at) where done_at is null;

-- ---------------------------------------------------------------- reports & push

create table public.reports (
  date date primary key,
  report jsonb not null,                       -- NightReport
  rule_report jsonb,                           -- the deterministic report the coach text is grounded in
  generated_by text not null check (generated_by in ('rules', 'claude')),
  model text,
  people_count integer not null default 0,     -- people with body data when generated (late sync → regenerate)
  pushed_at timestamptz,                       -- when the morning push went out (null = not yet)
  final boolean not null default false,        -- regenerated after the morning CO2 decay window (achMorning)
  created_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failures integer not null default 0
);

-- ---------------------------------------------------------------- secrets, OAuth, quotas

create table public.oauth_tokens (
  person_id text primary key references public.people (id) on delete cascade,
  provider text not null default 'google',
  refresh_token_secret_id uuid,
  scopes text[] not null default '{}',
  health_user_id text,
  needs_reconsent boolean not null default false,
  last_error text,
  last_sync_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on column public.oauth_tokens.refresh_token_secret_id is
  'Id of the refresh token in Supabase Vault (vault.secrets, encrypted at rest). The token is never stored in a '
  'plain column; write it with store_google_refresh_token() and read it with get_google_refresh_token(), both service_role only.';

create table public.oauth_states (
  state text primary key,
  person_id text not null references public.people (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.api_quota (
  api text not null,                           -- 'switchbot' | 'google_health' | 'anthropic'
  day date not null,                           -- UTC day (SwitchBot reset time is undocumented)
  used integer not null default 0,
  server_remaining integer,
  updated_at timestamptz not null default now(),
  primary key (api, day)
);

create table public.api_quota_log (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  api text not null,
  fn text,
  calls integer not null default 0,
  used_today integer,
  server_remaining integer,
  status text,
  note text
);
create index api_quota_log_ts on public.api_quota_log (ts desc);

-- ---------------------------------------------------------------- views & read helpers

-- Latest reading per registered device (lateral lookup uses the primary key).
create view public.latest_readings with (security_invoker = true) as
select d.device_id, d.kind, d.name, r.ts, r.temp_c, r.rh, r.co2, r.source
from public.devices d
cross join lateral (
  select x.ts, x.temp_c, x.rh, x.co2, x.source
  from public.readings x
  where x.device_id = d.device_id
  order by x.ts desc
  limit 1
) r;

-- 5-minute rollup. Convenient for ad-hoc queries; for time ranges prefer readings_buckets(), which filters
-- on ts before grouping and so uses the indexes.
create view public.readings_5min with (security_invoker = true) as
select
  device_id,
  date_bin('5 minutes', ts, timestamptz '2000-01-01 00:00:00+00') as bucket,
  avg(temp_c)::real as temp_c,
  avg(rh)::real as rh,
  round(avg(co2))::integer as co2,
  max(co2) as co2_max,
  min(co2) as co2_min,
  count(*)::integer as n
from public.readings
group by 1, 2;

create function public.readings_buckets(
  p_from timestamptz,
  p_to timestamptz,
  p_minutes integer default 5,
  p_device_id text default null
) returns table (device_id text, bucket timestamptz, temp_c real, rh real, co2 integer, co2_max integer, n integer)
language sql stable security invoker set search_path = '' as $$
  select r.device_id,
         date_bin(make_interval(mins => greatest(p_minutes, 1)), r.ts, timestamptz '2000-01-01 00:00:00+00') as bucket,
         avg(r.temp_c)::real, avg(r.rh)::real, round(avg(r.co2))::integer, max(r.co2), count(*)::integer
  from public.readings r
  where r.ts >= p_from and r.ts < p_to
    and (p_device_id is null or r.device_id = p_device_id)
  group by 1, 2
  order by 1, 2
$$;

-- ---------------------------------------------------------------- functions (security definer)

create function public.is_household_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members m where m.user_id = (select auth.uid()))
$$;

-- Owners and members may change things; 'viewer' (e.g. family in Phase 3) is read-only.
create function public.is_household_writer() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members m where m.user_id = (select auth.uid()) and m.role in ('owner', 'member'))
$$;

create function public.store_google_refresh_token(
  p_person_id text,
  p_refresh_token text,
  p_scopes text[] default '{}',
  p_health_user_id text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := 'google_refresh_token_' || p_person_id;
  v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = v_name;
  if v_id is null then
    v_id := vault.create_secret(p_refresh_token, v_name, 'Google Health refresh token for person ' || p_person_id);
  else
    perform vault.update_secret(v_id, p_refresh_token);
  end if;
  insert into public.oauth_tokens as t (person_id, refresh_token_secret_id, scopes, health_user_id, needs_reconsent, last_error, updated_at)
  values (p_person_id, v_id, coalesce(p_scopes, '{}'), p_health_user_id, false, null, now())
  on conflict (person_id) do update set
    refresh_token_secret_id = excluded.refresh_token_secret_id,
    scopes = excluded.scopes,
    health_user_id = coalesce(excluded.health_user_id, t.health_user_id),
    needs_reconsent = false,
    last_error = null,
    updated_at = now();
end $$;

create function public.get_google_refresh_token(p_person_id text) returns text
language sql stable security definer set search_path = '' as $$
  select ds.decrypted_secret
  from public.oauth_tokens t
  join vault.decrypted_secrets ds on ds.id = t.refresh_token_secret_id
  where t.person_id = p_person_id
$$;

-- Atomic per-day counter shared by concurrent Edge Function invocations. Returns the new total.
create function public.bump_api_quota(p_api text, p_day date, p_calls integer, p_server_remaining integer default null)
returns integer
language sql security definer set search_path = '' as $$
  insert into public.api_quota as q (api, day, used, server_remaining, updated_at)
  values (p_api, p_day, greatest(p_calls, 0), p_server_remaining, now())
  on conflict (api, day) do update set
    used = q.used + excluded.used,
    server_remaining = coalesce(excluded.server_remaining, q.server_remaining),
    updated_at = now()
  returning used
$$;

-- Claims pending jobs (and ones stuck for 15 min) without double-processing.
create function public.claim_health_sync_jobs(p_limit integer default 20)
returns setof public.health_sync_jobs
language sql security definer set search_path = '' as $$
  update public.health_sync_jobs j set started_at = now()
  where j.id in (
    select p.id from public.health_sync_jobs p
    where p.done_at is null and (p.started_at is null or p.started_at < now() - interval '15 minutes')
    order by p.created_at
    limit p_limit
    for update skip locked
  )
  returning j.*
$$;

-- PWA write paths (authenticated household members only).
create function public.set_night(
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
  if not public.is_household_writer() then
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

create function public.register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_household_member() then
    raise exception 'not a household member' using errcode = '42501';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values ((select auth.uid()), p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update set
    user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, failures = 0;
end $$;

create function public.unregister_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions s where s.endpoint = p_endpoint and s.user_id = (select auth.uid())
$$;

-- ---------------------------------------------------------------- RLS

-- Readable by every household member; written only by the service role (which bypasses RLS).
do $$
declare
  t text;
begin
  foreach t in array array[
    'people', 'household_members', 'devices', 'readings', 'raw_switchbot', 'outdoor_readings', 'calibrations',
    'curves', 'nights', 'ac_commands', 'ac_state', 'events', 'raw_health', 'health_hr', 'health_hrv',
    'health_spo2', 'sleep_sessions', 'health_daily', 'reports', 'api_quota', 'api_quota_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "household read" on public.%I for select to authenticated using ((select public.is_household_member()))', t);
  end loop;
end $$;

alter table public.push_subscriptions enable row level security;
create policy "own subscriptions" on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

-- Service role only: no policies at all.
alter table public.oauth_tokens enable row level security;
alter table public.oauth_states enable row level security;
alter table public.health_sync_jobs enable row level security;

-- ---------------------------------------------------------------- grants
-- Supabase stops granting Data API access to new tables by default (from 2026-10-30), and older projects
-- granted everything to anon. Be explicit either way.

grant usage on schema public to anon, authenticated, service_role;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant select on
  public.people, public.household_members, public.devices, public.readings, public.raw_switchbot,
  public.outdoor_readings, public.calibrations, public.curves, public.nights, public.ac_commands,
  public.ac_state, public.events, public.raw_health, public.health_hr, public.health_hrv, public.health_spo2,
  public.sleep_sessions, public.health_daily, public.reports, public.api_quota, public.api_quota_log,
  public.push_subscriptions, public.latest_readings, public.readings_5min
to authenticated;

grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

grant execute on function public.is_household_member() to authenticated, service_role;
grant execute on function public.is_household_writer() to authenticated, service_role;
grant execute on function public.readings_buckets(timestamptz, timestamptz, integer, text) to authenticated, service_role;
grant execute on function public.set_night(date, timestamptz, timestamptz, text[], text, boolean) to authenticated;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.unregister_push_subscription(text) to authenticated;
grant execute on function public.store_google_refresh_token(text, text, text[], text) to service_role;
grant execute on function public.get_google_refresh_token(text) to service_role;
grant execute on function public.bump_api_quota(text, date, integer, integer) to service_role;
grant execute on function public.claim_health_sync_jobs(integer) to service_role;
