-- Steady 18.5 °C and a live switch in the database (decided 2026-10-30, after the first real night).
--
-- 1. curves: 'steady-18-5-v1' (mirrors DEFAULT_CURVE in packages/core/src/curve.ts) becomes the default: pre-cool at
--    lights-out − 30 min (21:30) to 18.5 °C with fan auto, every later phase 18.5 °C, so NO command at lights-out,
--    at sleep onset or while asleep (the household does not want the room to warm while either of them may still be in
--    deep sleep, and the watches' sleep stages are not live during the night). OFF at wake + 30 (09:00). Nights stored
--    with 'one-beep-v2', 'one-beep-v1' or 'default-v1' keep their curve; upcoming real nights move to the new one.
-- 2. ac_state.bias_c = −2 for the discovered aircon when nothing is stored yet: on the first real night the aircon at
--    17 °C held the bed at 18.5–19.9 °C (bed ≈ setpoint + 2), so 18.5 °C needs set 17 (round(18.5 − 2)), not the
--    untuned default's 18.
-- 3. public.household_settings (one row, id = 1): ac_live (false = ac-curve only logs dry-run commands) and
--    default_presence ('home' = the household counts as home unless away; 'unknown' = wait for a phone signal or
--    "Home tonight"). Household members read it; owners and members change it with set_household_settings().
--    ac-curve sends real IR only when ac_live is true AND the DRY_RUN function secret does not force a dry run.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

-- ---------------------------------------------------------------- 1. the steady curve

update public.curves set is_default = false where is_default and id <> 'steady-18-5-v1';

insert into public.curves (id, name, phases, min_c, max_c, is_default) values (
  'steady-18-5-v1',
  'Steady 18.5 °C (default)',
  '[{"name":"precool","startMin":-30,"targetC":18.5,"fan":"auto"},
    {"name":"onset","startMin":0,"targetC":18.5,"fan":"auto"},
    {"name":"deep","startMin":30,"targetC":18.5,"fan":"auto"},
    {"name":"middle","startMin":270,"targetC":18.5,"fan":"auto"},
    {"name":"late","startMin":360,"targetC":18.5,"fan":"auto"},
    {"name":"wake","startMin":630,"targetC":18.5,"fan":"auto"}]'::jsonb,
  16, 24, true
)
on conflict (id) do update set
  name = excluded.name, phases = excluded.phases, min_c = excluded.min_c, max_c = excluded.max_c, is_default = true;

update public.curves set name = 'One beep, from sleep onset (v2)' where id = 'one-beep-v2';

-- Upcoming real nights whose pre-cool has not started yet follow the new default (tonight included).
update public.nights n set
  curve_id = 'steady-18-5-v1'
where n.date >= (now() at time zone 'Asia/Bangkok')::date
  and not n.is_sim
  and n.curve_id in ('one-beep-v2', 'one-beep-v1')
  and n.lights_out - interval '30 minutes' > now();

-- ---------------------------------------------------------------- 2. the measured bias

insert into public.ac_state (device_id, bias_c)
select d.device_id, -2
from public.devices d
where d.kind = 'ac' and d.meta ->> 'discovered' = 'true'
on conflict (device_id) do update set bias_c = excluded.bias_c
  where public.ac_state.bias_c is null;

-- ---------------------------------------------------------------- 3. household settings

create table if not exists public.household_settings (
  id smallint primary key default 1 check (id = 1),
  ac_live boolean not null default false,
  default_presence text not null default 'unknown' check (default_presence in ('home', 'unknown')),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.household_settings is
  'One row (id = 1). ac_live: ac-curve sends real IR commands only when true (and the DRY_RUN secret does not force a '
  'dry run). default_presence: home = the household is home unless an away period, "Away tonight"/travel, or every '
  'phone saying away within 12 h; unknown = wait for a phone signal or "Home tonight".';

insert into public.household_settings (id) values (1) on conflict (id) do nothing;

alter table public.household_settings enable row level security;
create policy "household read" on public.household_settings for select to authenticated
  using ((select private.is_household_member()));
revoke all on public.household_settings from public, anon, authenticated;
grant select on public.household_settings to authenticated;
grant all on public.household_settings to service_role;

-- Owner/member: change one or both settings (null = keep).
create or replace function private.set_household_settings(p_ac_live boolean default null, p_default_presence text default null)
returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.household_settings;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_default_presence is not null and p_default_presence not in ('home', 'unknown') then
    raise exception 'default_presence must be home or unknown' using errcode = '22023';
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set
    ac_live = coalesce(p_ac_live, s.ac_live),
    default_presence = coalesce(p_default_presence, s.default_presence),
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_household_settings(boolean, text) from public, anon;
grant execute on function private.set_household_settings(boolean, text) to authenticated;

create or replace function public.set_household_settings(p_ac_live boolean default null, p_default_presence text default null)
returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_household_settings(p_ac_live, p_default_presence)
$$;
revoke all on function public.set_household_settings(boolean, text) from public, anon;
grant execute on function public.set_household_settings(boolean, text) to authenticated;
