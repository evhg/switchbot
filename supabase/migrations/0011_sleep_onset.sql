-- Sleep onset (decided 2026-10-29): bed at 22:00 every day, asleep around 23:00, up around 08:30.
--
-- 1. curves: 'one-beep-v2' (mirrors DEFAULT_CURVE in packages/core/src/curve.ts) becomes the default. Same shape as
--    one-beep-v1, but the sleep phases (deep, middle = THE warming step, late, wake) are anchored to the night's
--    expected sleep onset ("anchor":"sleepOnset") instead of lights-out: precool 21:30, nothing at 22:00 or 23:00,
--    the one command while asleep at onset + 4 h 30 (03:30), OFF at wake + 30 (09:00). Nights stored with
--    'one-beep-v1' or 'default-v1' keep their curve and behave exactly as before.
-- 2. nights.sleep_onset: expected sleep onset, nullable. null = lights-out + 60 min (23:00 for a 22:00 lights-out).
--    ac-curve fills it for new nights from the watches' recent main sleeps when there is enough data
--    (core typicalSleepOnset); the PWA edits it next to the wake time with set_sleep_onset().
-- 3. Default wake 08:30 (was 06:30) where SQL creates a night (set_presence_override), and upcoming nights that were
--    created automatically and never edited move to 08:30 and the new curve.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

-- ---------------------------------------------------------------- 1. the onset-anchored one-beep curve

update public.curves set is_default = false where is_default and id <> 'one-beep-v2';

insert into public.curves (id, name, phases, min_c, max_c, is_default) values (
  'one-beep-v2',
  'One beep, from sleep onset (default)',
  '[{"name":"precool","startMin":-30,"targetC":19,"fan":"auto"},
    {"name":"onset","startMin":0,"targetC":19,"fan":"auto"},
    {"name":"deep","startMin":30,"targetC":19,"fan":"auto","anchor":"sleepOnset"},
    {"name":"middle","startMin":270,"targetC":21,"fan":"auto","anchor":"sleepOnset"},
    {"name":"late","startMin":360,"targetC":21,"fan":"auto","anchor":"sleepOnset"},
    {"name":"wake","startMin":570,"targetC":21,"fan":"auto","anchor":"sleepOnset"}]'::jsonb,
  17, 24, true
)
on conflict (id) do update set
  name = excluded.name, phases = excluded.phases, min_c = excluded.min_c, max_c = excluded.max_c, is_default = true;

update public.curves set name = 'One beep (v1, from lights-out)' where id = 'one-beep-v1';

-- ---------------------------------------------------------------- 2. nights.sleep_onset

alter table public.nights add column if not exists sleep_onset timestamptz;
alter table public.nights add constraint nights_sleep_onset_range
  check (sleep_onset is null or (sleep_onset >= lights_out and sleep_onset <= lights_out + interval '3 hours')) not valid;
comment on column public.nights.sleep_onset is
  'Expected sleep onset (bed at lights_out, asleep at sleep_onset). null = lights_out + 60 min. Curves whose phases have '
  '"anchor":"sleepOnset" (one-beep-v2) count those phases from it. Set from the watches for new nights, or in the app.';

-- Owner/member: set (or clear with null) the expected sleep onset of a night (yesterday … 7 days ahead). Creates the
-- night with the default schedule (22:00 → 08:30 ICT, default curve) when it does not exist yet.
create or replace function private.set_sleep_onset(p_date date, p_sleep_onset timestamptz) returns public.nights
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.nights;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_date < (now() at time zone 'Asia/Bangkok')::date - 1 or p_date > (now() at time zone 'Asia/Bangkok')::date + 7 then
    raise exception 'date % is outside yesterday … 7 days ahead', p_date using errcode = '22023';
  end if;
  insert into public.nights (date, lights_out, wake, curve_id)
  values (p_date, ((p_date - 1)::text || ' 22:00:00+07')::timestamptz, (p_date::text || ' 08:30:00+07')::timestamptz,
          (select c.id from public.curves c where c.is_default))
  on conflict (date) do nothing;
  select * into v_row from public.nights n where n.date = p_date;
  if p_sleep_onset is not null and (p_sleep_onset < v_row.lights_out or p_sleep_onset > v_row.lights_out + interval '3 hours') then
    raise exception 'sleep onset must be between lights out and 3 h later' using errcode = '22023';
  end if;
  update public.nights n set sleep_onset = p_sleep_onset, updated_at = now()
    where n.date = p_date
    returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_sleep_onset(date, timestamptz) from public, anon;
grant execute on function private.set_sleep_onset(date, timestamptz) to authenticated;

create or replace function public.set_sleep_onset(p_date date, p_sleep_onset timestamptz) returns public.nights
language sql security invoker set search_path = '' as $$
  select * from private.set_sleep_onset(p_date, p_sleep_onset)
$$;
revoke all on function public.set_sleep_onset(date, timestamptz) from public, anon;
grant execute on function public.set_sleep_onset(date, timestamptz) to authenticated;

-- ---------------------------------------------------------------- 3. default wake 08:30

-- Same as 0009 apart from the default wake (08:30).
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
  values (p_date, ((p_date - 1)::text || ' 22:00:00+07')::timestamptz, (p_date::text || ' 08:30:00+07')::timestamptz,
          (select c.id from public.curves c where c.is_default))
  on conflict (date) do nothing;
  update public.nights n set presence_override = p_state, updated_at = now()
    where n.date = p_date
    returning * into v_row;
  return v_row;
end $$;

-- Auto-created, never-edited upcoming nights move to the 08:30 wake. Upcoming real nights still on one-beep-v1 whose
-- warming step (lights-out + 4 h 30) is still more than 30 min away follow the new default curve, tonight included:
-- nothing is sent at lights-out or sleep onset under either curve, so a switch before the warming step only moves it
-- (02:30 → 03:30). The stored lights-out / wake are kept (the orchestrator and the app set them).
update public.nights n set
  wake = (n.date::text || ' 08:30:00+07')::timestamptz
where n.date >= (now() at time zone 'Asia/Bangkok')::date
  and not n.is_sim
  and n.updated_at = n.created_at
  and n.lights_out > now() + interval '30 minutes';

update public.nights n set
  curve_id = 'one-beep-v2'
where n.date >= (now() at time zone 'Asia/Bangkok')::date
  and not n.is_sim
  and n.curve_id = 'one-beep-v1'
  and n.lights_out + interval '4 hours' > now();
