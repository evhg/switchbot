-- Jarvis, 2026-11-11: away/home notices, household-wide app preferences, health trends.
--
-- 1. public.jarvis_notices: every push Jarvis sends from the database (kind, title, body), for history and rate limits.
--    private.jarvis_push(kind, title, body) sends through push-admin ("test" action → every subscription) and logs it.
-- 2. Away / home notices (villa autopilot): a trigger on presence_events. When a person whose phone decides presence
--    (household_settings.presence_people, else everyone) changes state, one push:
--      away → "Left home 14:05 · Jarvis keeps the aircon off tonight until you're back."
--      home → "Welcome home (18:40) · tonight's aircon plan runs as usual."
--    At most one per 20 min, and only when the state really changed. (The aircon itself was already presence-gated:
--    ac-curve does not start the night while nobody is home, and pre-cools when a phone says home.)
-- 3. public.household_prefs: small shared settings the app used to keep per device (the aircon filter's last clean,
--    the CO₂ meter's outdoor checks). Members read and write (key, value jsonb).
-- 4. Health trends:
--    private.health_flags(date) → a heads-up line when someone's resting HR is ≥ 5 bpm above their 28-day usual and
--      HRV ≥ 20 % below it ("Erik: resting HR 70 (usual 64), HRV 17 ms (usual 23): take it easy, maybe coming down
--      with something."). The morning brief carries it.
--    private.weekly_health(date) → title/body comparing the last 7 days with the 28 before: sleep, resting HR, HRV,
--      steps per person. Sent Sundays 09:40 ICT (cron 'jarvis-weekly-health'), kept in jarvis_notices.
-- Idempotent; no destructive statements.

-- ---------------------------------------------------------------- 1. notices + push helper

create table if not exists public.jarvis_notices (
  id bigint generated always as identity primary key,
  kind text not null,
  title text not null,
  body text not null,
  request_id bigint,
  sent_at timestamptz not null default now()
);
create index if not exists jarvis_notices_kind_sent on public.jarvis_notices (kind, sent_at desc);
comment on table public.jarvis_notices is 'Pushes Jarvis sent from the database (presence, weekly health …), newest last.';
alter table public.jarvis_notices enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'jarvis_notices' and policyname = 'household read') then
    create policy "household read" on public.jarvis_notices for select to authenticated using ((select private.is_household_member()));
  end if;
end $$;
revoke all on public.jarvis_notices from public, anon, authenticated;
grant select on public.jarvis_notices to authenticated;
grant all on public.jarvis_notices to service_role;

create or replace function private.jarvis_push(p_kind text, p_title text, p_body text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_req bigint;
begin
  v_req := private.invoke_edge_function('push-admin', jsonb_build_object('action', 'test', 'title', left(p_title, 80), 'body', left(p_body, 200)), 15000);
  insert into public.jarvis_notices (kind, title, body, request_id) values (p_kind, p_title, p_body, v_req);
  return v_req;
end $$;
revoke all on function private.jarvis_push(text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- 2. away / home notices

create or replace function private.presence_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_follow text[];
  v_prev text;
  v_time text := to_char(new.at at time zone 'Asia/Bangkok', 'HH24:MI');
begin
  select s.presence_people into v_follow from public.household_settings s where s.id = 1;
  if v_follow is not null and cardinality(v_follow) > 0 and not (new.person_id = any (v_follow)) then
    return new;
  end if;
  select e.state into v_prev from public.presence_events e
  where e.person_id = new.person_id and e.at < new.at
  order by e.at desc limit 1;
  if v_prev is not distinct from new.state then return new; end if;
  if exists (select 1 from public.jarvis_notices n where n.kind = 'presence' and n.sent_at > now() - interval '20 minutes') then
    return new;
  end if;
  if new.state = 'away' then
    perform private.jarvis_push('presence', 'Left home ' || v_time, 'Jarvis keeps the aircon off tonight until you’re back.');
  elsif new.state = 'home' then
    perform private.jarvis_push('presence', 'Welcome home (' || v_time || ')', 'Tonight’s aircon plan runs as usual.');
  end if;
  return new;
exception when others then
  raise warning 'presence_notice: %', sqlerrm;
  return new;
end $$;
revoke all on function private.presence_notice() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'presence_notice' and tgrelid = 'public.presence_events'::regclass) then
    create trigger presence_notice after insert on public.presence_events
      for each row execute function private.presence_notice();
  end if;
end $$;

-- ---------------------------------------------------------------- 3. household prefs

create table if not exists public.household_prefs (
  key text primary key check (key ~ '^[a-zA-Z0-9_.-]{1,64}$'),
  value jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.household_prefs is 'Small app settings shared by the household (filterCleaned, calibrations …); members read and write.';
alter table public.household_prefs enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'household_prefs' and policyname = 'household read') then
    create policy "household read" on public.household_prefs for select to authenticated using ((select private.is_household_member()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'household_prefs' and policyname = 'household write') then
    create policy "household write" on public.household_prefs for insert to authenticated with check ((select private.is_household_writer()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'household_prefs' and policyname = 'household update') then
    create policy "household update" on public.household_prefs for update to authenticated using ((select private.is_household_writer())) with check ((select private.is_household_writer()));
  end if;
end $$;
revoke all on public.household_prefs from public, anon, authenticated;
grant select, insert, update on public.household_prefs to authenticated;
grant all on public.household_prefs to service_role;

-- ---------------------------------------------------------------- 4. health trends

create or replace function private.health_flags(p_date date)
returns text
language sql stable security definer set search_path = '' as $$
  with base as (
    select h.person_id, avg(h.resting_hr) rhr, avg(h.hrv_daily_ms) hrv, count(*) n
    from public.health_vitals_daily h
    where h.date between p_date - 29 and p_date - 2
    group by h.person_id
  ), today as (
    select h.person_id, h.resting_hr rhr, h.hrv_daily_ms hrv
    from public.health_vitals_daily h
    where h.date = p_date
  )
  select string_agg(
           p.name || ': resting HR ' || round(t.rhr) || ' (usual ' || round(b.rhr) || '), HRV ' || round(t.hrv) || ' ms (usual '
           || round(b.hrv) || '): take it easy, maybe coming down with something.', E'\n' order by p.id)
  from today t join base b using (person_id) join public.people p on p.id = t.person_id
  where b.n >= 10 and t.rhr >= b.rhr + 5 and t.hrv <= b.hrv * 0.8
$$;
revoke all on function private.health_flags(date) from public, anon, authenticated;

create or replace function private.weekly_health(p_date date)
returns table (title text, body text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_lines text[] := '{}';
  r record;
  v_arrow text;
begin
  for r in
    with v as (
      select h.person_id,
             avg(h.steps) filter (where h.date between p_date - 7 and p_date - 1) steps7,
             avg(h.steps) filter (where h.date between p_date - 35 and p_date - 8) steps28,
             avg(h.resting_hr) filter (where h.date between p_date - 7 and p_date - 1) rhr7,
             avg(h.resting_hr) filter (where h.date between p_date - 35 and p_date - 8) rhr28,
             avg(h.hrv_daily_ms) filter (where h.date between p_date - 7 and p_date - 1) hrv7,
             avg(h.hrv_daily_ms) filter (where h.date between p_date - 35 and p_date - 8) hrv28
      from public.health_vitals_daily h
      where h.date between p_date - 35 and p_date - 1
      group by h.person_id
    ), s as (
      select ss.person_id,
             avg(extract(epoch from ss.end_ts - ss.start_ts) / 3600) filter (where (ss.end_ts at time zone 'Asia/Bangkok')::date between p_date - 7 and p_date - 1) sleep7,
             avg(extract(epoch from ss.end_ts - ss.start_ts) / 3600) filter (where (ss.end_ts at time zone 'Asia/Bangkok')::date between p_date - 35 and p_date - 8) sleep28
      from public.sleep_sessions ss
      where ss.end_ts - ss.start_ts > interval '3 hours' and (ss.end_ts at time zone 'Asia/Bangkok')::date between p_date - 35 and p_date - 1
      group by ss.person_id
    )
    select p.id, p.name, v.*, s.sleep7, s.sleep28
    from public.people p left join v on v.person_id = p.id left join s on s.person_id = p.id
    order by p.id
  loop
    if r.steps7 is null and r.sleep7 is null then continue; end if;
    v_arrow := case
      when r.rhr7 is not null and r.rhr28 is not null and r.rhr7 >= r.rhr28 + 3 then ' ⚠ resting HR up'
      when r.hrv7 is not null and r.hrv28 is not null and r.hrv7 <= r.hrv28 * 0.85 then ' ⚠ HRV down'
      else '' end;
    v_lines := v_lines || (
      r.name || ': sleep ' || coalesce(to_char(r.sleep7, 'FM90.0') || 'h', '–')
      || coalesce(' (' || to_char(r.sleep7 - r.sleep28, 'FMSG0.0') || ')', '')
      || ' · ' || coalesce(to_char(r.steps7, 'FM999,999'), '–') || ' steps/day'
      || coalesce(' (' || to_char(r.steps7 - r.steps28, 'FMSG999,999') || ')', '')
      || ' · RHR ' || coalesce(round(r.rhr7)::text, '–') || ' · HRV ' || coalesce(round(r.hrv7)::text, '–') || v_arrow);
  end loop;
  title := 'Your week · vs the month before';
  body := coalesce(nullif(array_to_string(v_lines, E'\n'), ''), 'Not enough band data this week.');
  return next;
end $$;
revoke all on function private.weekly_health(date) from public, anon, authenticated;

create or replace function private.send_weekly_health() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_title text;
  v_body text;
begin
  select w.title, w.body into v_title, v_body from private.weekly_health((now() at time zone 'Asia/Bangkok')::date) w;
  return private.jarvis_push('weekly_health', v_title, v_body);
end $$;
revoke all on function private.send_weekly_health() from public, anon, authenticated;

select cron.schedule('jarvis-weekly-health', '40 2 * * 0', $$select private.send_weekly_health()$$);

-- The morning brief carries the health heads-up (0035's function, with one more line).
create or replace function private.morning_brief(p_date date)
returns table (title text, body text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_lines text[] := '{}';
  v_slept text;
  v_steps text;
  v_room text;
  v_flags text;
  v_m record;
begin
  v_flags := private.health_flags(p_date);
  if v_flags is not null then v_lines := v_lines || v_flags; end if;

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
