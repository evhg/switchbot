-- Away periods (decided 2026-10-30): the household is home every night by default, except planned trips.
--
-- public.away_periods: one row per trip. from_date / to_date are EVENING dates, inclusive: the calendar days on which
-- nobody goes to bed at home. A night (keyed by its wake date D, lights-out on the evening of D − 1) is away when
-- D − 1 is in from_date … to_date. ac-curve then keeps the aircon off all night (like "Away tonight"). "Home tonight"
-- in the app still wins for a single night (a cancelled trip).
-- Rows are never removed: set_away_period_active(id, false) switches one off.
-- Household members read; owners and members add / switch off with the RPCs below.
--
-- Seed: Bangkok, evenings of 5 and 6 Nov 2026 (nights ending 6 and 7 Nov). Assumption: they are back to sleep at home
-- on the evening of 7 Nov (night ending 8 Nov), so the 21:30 pre-cool on 7 Nov runs.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

create table if not exists public.away_periods (
  id bigint generated always as identity primary key,
  from_date date not null,
  to_date date not null,
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  constraint away_periods_range check (to_date >= from_date and to_date - from_date <= 366)
);
comment on table public.away_periods is
  'Planned trips. from_date/to_date: evening dates (inclusive) on which nobody sleeps at home; the night ending on '
  'D is away when D - 1 is in range. active = false switches a row off (rows are never removed).';
create index if not exists away_periods_active_range on public.away_periods (from_date, to_date) where active;

alter table public.away_periods enable row level security;
create policy "household read" on public.away_periods for select to authenticated
  using ((select private.is_household_member()));
revoke all on public.away_periods from public, anon, authenticated;
grant select on public.away_periods to authenticated;
grant all on public.away_periods to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function private.add_away_period(p_from date, p_to date, p_note text default null)
returns public.away_periods
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.away_periods;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'away period needs from ≤ to' using errcode = '22023';
  end if;
  if p_to - p_from > 366 then
    raise exception 'away period longer than a year' using errcode = '22023';
  end if;
  insert into public.away_periods (from_date, to_date, note, created_by)
  values (p_from, p_to, nullif(btrim(coalesce(p_note, '')), ''), (select auth.uid()))
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.add_away_period(date, date, text) from public, anon;
grant execute on function private.add_away_period(date, date, text) to authenticated;

create or replace function public.add_away_period(p_from date, p_to date, p_note text default null)
returns public.away_periods
language sql security invoker set search_path = '' as $$
  select * from private.add_away_period(p_from, p_to, p_note)
$$;
revoke all on function public.add_away_period(date, date, text) from public, anon;
grant execute on function public.add_away_period(date, date, text) to authenticated;

-- Switch an away period off (or back on). "Remove" in the app.
create or replace function private.set_away_period_active(p_id bigint, p_active boolean)
returns public.away_periods
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.away_periods;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  update public.away_periods a set active = coalesce(p_active, false), updated_at = now()
    where a.id = p_id
    returning * into v_row;
  if v_row.id is null then
    raise exception 'unknown away period %', p_id using errcode = '22023';
  end if;
  return v_row;
end $$;
revoke all on function private.set_away_period_active(bigint, boolean) from public, anon;
grant execute on function private.set_away_period_active(bigint, boolean) to authenticated;

create or replace function public.set_away_period_active(p_id bigint, p_active boolean)
returns public.away_periods
language sql security invoker set search_path = '' as $$
  select * from private.set_away_period_active(p_id, p_active)
$$;
revoke all on function public.set_away_period_active(bigint, boolean) from public, anon;
grant execute on function public.set_away_period_active(bigint, boolean) to authenticated;

-- Seed: Bangkok 5–7 Nov 2026 (away the evenings of 5 and 6 Nov; home again the evening of 7 Nov).
insert into public.away_periods (from_date, to_date, note)
select date '2026-11-05', date '2026-11-06', 'Bangkok'
where not exists (select 1 from public.away_periods a where a.note = 'Bangkok' and a.from_date = date '2026-11-05');
