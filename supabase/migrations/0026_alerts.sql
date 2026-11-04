-- Phone alerts from the app (2026-11-04): replaces the hourly chat check with Web Push from the alerts Edge Function.
--
-- 1. public.battery_log: one row per band sync that reported a battery level (person_id, ts, level). Filled by a
--    trigger on public.band_sync (AFTER INSERT OR UPDATE): the tracker's batteryLevel in band_sync.devices, stamped
--    with that device's lastSyncTime (else band_sync.device_last_sync_at). Primary key (person_id, ts): a sync that
--    reports the same reading again stores nothing. The trigger never fails the band_sync write. Existing band_sync
--    rows are copied in once.
-- 2. public.alert_state: one row per alert key (battery:<person>, stale:<person>, listener), written by the alerts
--    function (service role): last_sent_at and data (the dedupe state: the discharge cycle, the staleness episode,
--    the night; plus the text sent).
-- 3. household_settings.alerts jsonb: {"battery":true,"stale_sync":true,"listener":true}; set_alerts(p jsonb) merges
--    the given keys (booleans only), the definer-in-private + invoker-wrapper pattern of 0020/0023/0024.
-- 4. pg_cron: the alerts function every 15 min (05, 20, 35, 50: just after the hourly band sync at xx:45).
--
-- Members read everything here; only the function (service role) and set_alerts() write.
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

-- ---------------------------------------------------------------- 1. battery_log

create table if not exists public.battery_log (
  person_id text not null references public.people (id),
  ts timestamptz not null,
  level smallint not null check (level between 0 and 100),
  created_at timestamptz not null default now(),
  primary key (person_id, ts)
);
comment on table public.battery_log is
  'Fitbit battery readings, one per band sync that reported a level (trigger on band_sync). ts = the device''s '
  'lastSyncTime (when the band reported the level), else band_sync.device_last_sync_at. Read by the alerts function '
  '(drain rate, hours left) and System › Alerts.';

alter table public.battery_log enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'battery_log' and policyname = 'household read') then
    create policy "household read" on public.battery_log for select to authenticated
      using ((select private.is_household_member()));
  end if;
end $$;

revoke all on public.battery_log from public, anon, authenticated;
grant select on public.battery_log to authenticated;
grant all on public.battery_log to service_role;

-- The battery reading in a band_sync row: the TRACKER's batteryLevel (else the first numeric one), 0..100, with its
-- device's lastSyncTime (else the row's device_last_sync_at). No row when there is no level or no time.
create or replace function private.band_battery(p_devices jsonb, p_fallback timestamptz)
returns table (ts timestamptz, level smallint)
language plpgsql stable set search_path = '' as $$
declare
  v_level numeric;
  v_ts timestamptz;
  v_raw text;
begin
  if p_devices is null or jsonb_typeof(p_devices) <> 'array' then
    return;
  end if;
  select (d->>'batteryLevel')::numeric, d->>'lastSyncTime'
    into v_level, v_raw
  from jsonb_array_elements(p_devices) d
  where jsonb_typeof(d) = 'object'
    and jsonb_typeof(d->'batteryLevel') in ('number', 'string')
    and (d->>'batteryLevel') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$'
  order by (d->>'deviceType' = 'TRACKER') desc nulls last
  limit 1;
  if v_level is null or v_level < 0 or v_level > 100 then
    return;
  end if;
  begin
    v_ts := nullif(v_raw, '')::timestamptz;
  exception when others then
    v_ts := null;
  end;
  v_ts := coalesce(v_ts, p_fallback);
  if v_ts is null then
    return;
  end if;
  return query select v_ts, round(v_level)::smallint;
end $$;
revoke all on function private.band_battery(jsonb, timestamptz) from public, anon, authenticated;

create or replace function private.band_sync_battery_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    insert into public.battery_log (person_id, ts, level)
    select new.person_id, b.ts, b.level
    from private.band_battery(new.devices, new.device_last_sync_at) b
    on conflict (person_id, ts) do nothing;
  exception when others then
    -- Never fail the band_sync write over the log.
    raise warning 'battery_log: %', sqlerrm;
  end;
  return new;
end $$;
revoke all on function private.band_sync_battery_log() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'band_sync_battery_log' and tgrelid = 'public.band_sync'::regclass) then
    create trigger band_sync_battery_log after insert or update on public.band_sync
      for each row execute function private.band_sync_battery_log();
  end if;
end $$;

insert into public.battery_log (person_id, ts, level)
select s.person_id, b.ts, b.level
from public.band_sync s
cross join lateral private.band_battery(s.devices, s.device_last_sync_at) b
on conflict (person_id, ts) do nothing;

-- ---------------------------------------------------------------- 2. alert_state

create table if not exists public.alert_state (
  key text primary key check (key ~ '^[a-z_]+(:[a-z0-9_-]+)?$' and length(key) <= 60),
  last_sent_at timestamptz,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);
comment on table public.alert_state is
  'Dedupe state of the phone alerts (alerts Edge Function, service role). Keys: battery:<person> (data.cycle = the '
  'discharge cycle already alerted), stale:<person> (data.seen_at = the staleness episode already alerted), listener '
  '(data.night = the night already alerted), listener_watch (data.since / data.night = when the current "should be '
  'listening" stretch began; not an alert). data.title / data.body = the last push sent.';

alter table public.alert_state enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'alert_state' and policyname = 'household read') then
    create policy "household read" on public.alert_state for select to authenticated
      using ((select private.is_household_member()));
  end if;
end $$;

revoke all on public.alert_state from public, anon, authenticated;
grant select on public.alert_state to authenticated;
grant all on public.alert_state to service_role;

-- ---------------------------------------------------------------- 3. household settings

alter table public.household_settings add column if not exists alerts jsonb not null
  default '{"battery":true,"stale_sync":true,"listener":true}'::jsonb
  check (jsonb_typeof(alerts) = 'object');
comment on column public.household_settings.alerts is
  'Phone alerts on/off: battery (charge your Fitbit), stale_sync (a band hasn''t synced for 6 h), listener (the night '
  'listener stopped). A missing key counts as on. Set with set_alerts().';

-- Merges the given keys into household_settings.alerts. Only battery / stale_sync / listener, booleans only.
create or replace function private.set_alerts(p jsonb) returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.household_settings;
  v_key text;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'alerts must be an object' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p) loop
    if v_key not in ('battery', 'stale_sync', 'listener') then
      raise exception 'unknown alert: %', v_key using errcode = '22023';
    end if;
    if jsonb_typeof(p->v_key) <> 'boolean' then
      raise exception 'alert % must be true or false', v_key using errcode = '22023';
    end if;
  end loop;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set
    alerts = coalesce(s.alerts, '{}'::jsonb) || p,
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_alerts(jsonb) from public, anon;
grant execute on function private.set_alerts(jsonb) to authenticated;

create or replace function public.set_alerts(p jsonb) returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_alerts(p)
$$;
revoke all on function public.set_alerts(jsonb) from public, anon;
grant execute on function public.set_alerts(jsonb) to authenticated;

-- ---------------------------------------------------------------- 4. pg_cron

-- cron.schedule replaces the job of the same name. ICT minutes = UTC minutes.
select cron.schedule('sleeplab-alerts', '5,20,35,50 * * * *',
  $$select private.invoke_edge_function('alerts', '{}', 60000)$$);
