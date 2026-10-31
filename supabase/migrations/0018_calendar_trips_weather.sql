-- Calendar trips → away nights, and outdoor weather (2026-10-31).
--
-- 1. public.away_periods gets a source marker. Manual rows (the app's "Add", the Bangkok seed) keep source 'manual'
--    and are never touched by the sync. calendar-sync writes source 'calendar' rows:
--      external_id  'cal:<first evening>' (one row per household trip; the upsert key with source)
--      in_calendar  true while the calendars still show the trip; false once it is gone (the sync then also sets
--                   active = false: a soft flag, rows are never removed)
--      synced_at    last sync that saw (or retired) the row
--    A calendar row switched off in the app ("Remove": active = false, in_calendar still true) stays off, also when the
--    trip later vanishes and reappears (only active rows are retired), and a trip overlapping it under a new first
--    evening is not added either; only a row the sync itself retired comes back when the trip reappears. A trip
--    entirely inside an active manual period is not added (no duplicate of the Bangkok entry).
-- 2. public.sync_calendar_away_periods(ranges, cutoff): the household's away ranges (every connected person away, see
--    core householdAwayRanges) → upsert + retire, in one transaction. Service role only. Rows that ended before
--    `cutoff` (tonight's evening) are history and stay as they are.
-- 3. public.outdoor_readings.source (exists since 0001; added here only if missing): 'open_meteo' or 'google_weather'
--    from weather-poll, besides 'manual' / 'sim'.
-- 4. pg_cron: calendar-sync hourly at :23, weather-poll every 15 min at :07/:22/:37/:52 (UTC; jittered off :00).
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

-- ---------------------------------------------------------------- 1. away_periods source

alter table public.away_periods add column if not exists source text not null default 'manual';
alter table public.away_periods add column if not exists external_id text;
alter table public.away_periods add column if not exists in_calendar boolean;
alter table public.away_periods add column if not exists synced_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'away_periods_source_check' and conrelid = 'public.away_periods'::regclass) then
    alter table public.away_periods add constraint away_periods_source_check check (source in ('manual', 'calendar'));
  end if;
end $$;

-- NULL external_ids (every manual row) never conflict with each other.
create unique index if not exists away_periods_source_external on public.away_periods (source, external_id);

comment on column public.away_periods.source is
  '''manual'' (the app, SQL seeds) or ''calendar'' (calendar-sync, from both Google Calendars). The sync only touches calendar rows.';
comment on column public.away_periods.external_id is
  'calendar rows: ''cal:<first evening>'', the upsert key together with source. Null for manual rows.';
comment on column public.away_periods.in_calendar is
  'calendar rows: false once the trip is no longer in the calendars (the sync then sets active = false). Null for manual rows.';

-- ---------------------------------------------------------------- 2. sync RPC (service role)

create or replace function public.sync_calendar_away_periods(p_ranges jsonb, p_cutoff date)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ext text;
  v_keep text[] := '{}';
  v_new boolean;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_retired integer := 0;
  r record;
begin
  if p_cutoff is null then
    raise exception 'cutoff date required' using errcode = '22023';
  end if;
  for r in
    select (x ->> 'from')::date as from_date, (x ->> 'to')::date as to_date, nullif(btrim(coalesce(x ->> 'note', '')), '') as note
    from jsonb_array_elements(coalesce(p_ranges, '[]'::jsonb)) as x
  loop
    if r.from_date is null or r.to_date is null or r.to_date < r.from_date or r.to_date - r.from_date > 366 or r.to_date < p_cutoff then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_ext := 'cal:' || r.from_date::text;
    v_keep := v_keep || v_ext;
    if not exists (select 1 from public.away_periods c where c.source = 'calendar' and c.external_id = v_ext)
       and exists (
         select 1 from public.away_periods m
         where (m.source = 'manual' and m.active and m.from_date <= r.from_date and m.to_date >= r.to_date)
            -- Removed in the app (not retired by the sync): a shifted first evening must not bring the trip back.
            or (m.source = 'calendar' and not m.active and m.in_calendar and m.from_date <= r.to_date and m.to_date >= r.from_date)
       ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into public.away_periods as a (from_date, to_date, note, source, external_id, in_calendar, synced_at)
    values (r.from_date, r.to_date, r.note, 'calendar', v_ext, true, now())
    on conflict (source, external_id) do update set
      to_date = excluded.to_date,
      note = excluded.note,
      in_calendar = true,
      synced_at = now(),
      -- Revive only what the sync retired; a calendar row removed in the app stays off.
      active = case when a.in_calendar = false then true else a.active end,
      updated_at = case
        when (a.to_date, a.note, a.in_calendar) is distinct from (excluded.to_date, excluded.note, true) then now()
        else a.updated_at
      end
    returning (xmax = 0) into v_new;
    if v_new then v_inserted := v_inserted + 1; else v_updated := v_updated + 1; end if;
  end loop;

  update public.away_periods a
     set active = false, in_calendar = false, synced_at = now(), updated_at = now()
   where a.source = 'calendar'
     and a.active
     and a.in_calendar is distinct from false
     and a.to_date >= p_cutoff
     and a.external_id <> all (v_keep);
  get diagnostics v_retired = row_count;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped, 'retired', v_retired);
end $$;
revoke all on function public.sync_calendar_away_periods(jsonb, date) from public, anon, authenticated;
grant execute on function public.sync_calendar_away_periods(jsonb, date) to service_role;

-- ---------------------------------------------------------------- 3. outdoor_readings source

alter table public.outdoor_readings add column if not exists source text not null default 'manual';
comment on column public.outdoor_readings.source is
  '''open_meteo'' / ''google_weather'' (weather-poll, every 15 min), ''manual'' or ''sim'' (seed).';

-- ---------------------------------------------------------------- 4. schedules

-- Trips in both Google Calendars → away_periods (14 days back for the outbound leg of a trip under way, 45 ahead).
select cron.schedule('sleeplab-calendar-sync', '23 * * * *',
  $$select private.invoke_edge_function('calendar-sync', '{}', 60000)$$);

-- Outdoor temperature / RH for Phuket (Open-Meteo, or Google Weather once GOOGLE_WEATHER_API_KEY is set).
select cron.schedule('sleeplab-weather-poll', '7-59/15 * * * *',
  $$select private.invoke_edge_function('weather-poll', '{}', 30000)$$);
