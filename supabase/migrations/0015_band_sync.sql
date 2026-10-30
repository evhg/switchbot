-- Fitbit band sync status per person (decided 2026-10-30), for the System › Google Health and Presence pages and,
-- later, the presence gate.
--
-- 1. public.band_sync: one row per person, written by google-health-sync (service role) after every run.
--      last_sync_at         when google-health-sync last ran for this person (any outcome)
--      last_sync_ok         whether every data type of that run succeeded
--      last_error           the run's errors, if any (first 1000 characters)
--      device_last_sync_at  newest pairedDevices[].lastSyncTime: when the band last synced to the phone app.
--                           Null until the API returns it (pairedDevices may need a scope this app doesn't request).
--      newest_point_at      newest wearable data point seen (heart rate, HRV, SpO2, steps); only moves forward.
--      devices              pairedDevices as returned (deviceType, batteryLevel, lastSyncTime, ...)
--      last_manual_sync_at  last "Sync now" from the PWA; google-health-sync allows one per 2 min per person.
--    PRESENCE HINT (not a gate yet): a band that synced recently was near its phone, and the phones are at home most
--    days. A gate can read greatest(device_last_sync_at, newest_point_at) per person; it says nothing about *where*
--    the phone was, so it is a hint only. Nothing switches the aircon on it.
-- 2. pg_cron: an hourly light sync (last 6 h of samples, 2 days of sleep/daily types) so band_sync stays fresh during
--    the day. The 07:20-09:20, 10:30 and 14:00 ICT full syncs from 0002 stay as they are.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

create table if not exists public.band_sync (
  person_id text primary key references public.people (id),
  last_sync_at timestamptz,
  last_sync_ok boolean,
  last_error text,
  device_last_sync_at timestamptz,
  newest_point_at timestamptz,
  devices jsonb not null default '[]',
  last_manual_sync_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table public.band_sync is
  'Fitbit band sync status per person, written by google-health-sync. Presence hint: greatest(device_last_sync_at, '
  'newest_point_at) is when the band last reached Google; it is not a location.';

alter table public.band_sync enable row level security;
create policy "household read" on public.band_sync for select to authenticated
  using ((select private.is_household_member()));
revoke all on public.band_sync from public, anon, authenticated;
grant select on public.band_sync to authenticated;
grant all on public.band_sync to service_role;

insert into public.band_sync (person_id)
select p.id from public.people p
on conflict (person_id) do nothing;

-- ---------------------------------------------------------------- 2. hourly light sync (ICT xx:45 = UTC xx:45)

select cron.schedule('sleeplab-health-sync-hourly', '45 * * * *',
  $$select private.invoke_edge_function('google-health-sync', '{"mode":"full","hours":6,"sleepDays":2}', 60000)$$);
