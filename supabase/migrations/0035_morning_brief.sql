-- Morning brief (2026-11-11): one short push at 09:20 ICT, built in the database.
--
-- The full morning report (nightly-report) waits until both bands have synced or wake + 4 h, so it usually lands
-- around noon. The brief goes out at 09:20 with what is known by then:
--   Title  "Good morning · Wed 11 Nov"
--   Body   Slept: Cath 8h56 · Erik 8h49
--          Room: 20.5 °C, CO₂ peak 1,001 ppm · air 72
--          Yesterday: Cath 536 steps · Erik 5,027
--          Walk 10–15 min after breakfast.
-- Lines with no data are left out. Nothing is sent while an active away period covers today.
-- It is sent through the push-admin Edge Function ("test" action: title + body to every push subscription), so no
-- new function has to be deployed. Every brief is kept in public.morning_briefs (household read) for the app.
--
--   private.morning_brief(p_date)       → (title, body) for that ICT date, no side effects
--   private.send_morning_brief(p_date)  stores the brief and pushes it (once a day; returns the pg_net request id)
--   cron 'jarvis-morning-brief'         20 2 * * * (02:20 UTC = 09:20 ICT)
-- Idempotent; no destructive statements.

create table if not exists public.morning_briefs (
  date date primary key,
  title text not null,
  body text not null,
  sent_at timestamptz,
  request_id bigint,
  created_at timestamptz not null default now()
);
comment on table public.morning_briefs is 'The 09:20 morning brief push, one row per ICT date (private.send_morning_brief).';
alter table public.morning_briefs enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'morning_briefs' and policyname = 'household read') then
    create policy "household read" on public.morning_briefs for select to authenticated using ((select private.is_household_member()));
  end if;
end $$;
revoke all on public.morning_briefs from public, anon, authenticated;
grant select on public.morning_briefs to authenticated;
grant all on public.morning_briefs to service_role;

create or replace function private.morning_brief(p_date date)
returns table (title text, body text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_lines text[] := '{}';
  v_slept text;
  v_steps text;
  v_room text;
  v_m record;
begin
  -- Sleep: time from falling asleep to waking, per person, for the night that ended this morning.
  select string_agg(p.name || ' ' || floor(extract(epoch from (s.end_ts - s.start_ts)) / 3600)::int || 'h'
           || lpad((floor(extract(epoch from (s.end_ts - s.start_ts)) / 60)::int % 60)::text, 2, '0'), ' · ' order by p.id)
    into v_slept
  from public.people p
  join lateral (
    select ss.start_ts, ss.end_ts from public.sleep_sessions ss
    where ss.person_id = p.id
      and (ss.end_ts at time zone 'Asia/Bangkok')::date = p_date
      and ss.end_ts - ss.start_ts > interval '3 hours'
    order by ss.end_ts desc limit 1
  ) s on true;
  if v_slept is not null then v_lines := v_lines || ('Slept: ' || v_slept); end if;

  -- Room: night_metrics when the analysis has run, else the raw readings of 22:00–08:00.
  select m.temp_mean, m.co2_max, m.sleep_air_score into v_m from public.night_metrics m where m.date = p_date;
  if found and v_m.temp_mean is not null then
    v_room := round(v_m.temp_mean::numeric, 1) || ' °C, CO₂ peak ' || to_char(v_m.co2_max, 'FM9,999') || ' ppm'
      || coalesce(' · air ' || round(v_m.sleep_air_score::numeric)::text, '');
  else
    select round(avg(r.temp_c)::numeric, 1) || ' °C, CO₂ peak ' || to_char(max(r.co2), 'FM9,999') || ' ppm'
      into v_room
    from public.readings r
    where r.ts >= ((p_date - 1) + time '22:00') at time zone 'Asia/Bangkok'
      and r.ts < (p_date + time '08:00') at time zone 'Asia/Bangkok'
      and r.co2 is not null;
  end if;
  if v_room is not null then v_lines := v_lines || ('Room: ' || v_room); end if;

  -- Steps yesterday.
  select string_agg(p.name || ' ' || to_char(h.steps, 'FM999,999') || case when p.id = (select min(id) from public.people) then ' steps' else '' end, ' · ' order by p.id)
    into v_steps
  from public.people p join public.health_vitals_daily h on h.person_id = p.id and h.date = p_date - 1 and h.steps is not null;
  if v_steps is not null then v_lines := v_lines || ('Yesterday: ' || v_steps); end if;

  v_lines := v_lines || 'Walk 10–15 min after breakfast.'::text;
  title := 'Good morning · ' || to_char(p_date, 'Dy FMDD Mon');
  body := array_to_string(v_lines, E'\n');
  return next;
end $$;
revoke all on function private.morning_brief(date) from public, anon, authenticated;

create or replace function private.send_morning_brief(p_date date default ((now() at time zone 'Asia/Bangkok')::date))
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_title text;
  v_body text;
  v_req bigint;
begin
  if exists (select 1 from public.morning_briefs b where b.date = p_date and b.sent_at is not null) then
    return null;
  end if;
  if exists (select 1 from public.away_periods a where a.active and p_date between a.from_date and a.to_date) then
    return null;
  end if;
  select mb.title, mb.body into v_title, v_body from private.morning_brief(p_date) mb;
  v_req := private.invoke_edge_function('push-admin', jsonb_build_object('action', 'test', 'title', v_title, 'body', left(v_body, 200)), 15000);
  insert into public.morning_briefs (date, title, body, sent_at, request_id)
  values (p_date, v_title, v_body, now(), v_req)
  on conflict (date) do update set title = excluded.title, body = excluded.body, sent_at = excluded.sent_at, request_id = excluded.request_id;
  return v_req;
end $$;
revoke all on function private.send_morning_brief(date) from public, anon, authenticated;

select cron.schedule('jarvis-morning-brief', '20 2 * * *', $$select private.send_morning_brief()$$);
