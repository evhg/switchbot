-- Pregnancy (2026-11-14): Cath is about 6 months pregnant (week ~26 on 14 Nov 2026). Resting HR normally rises
-- 10–20 bpm and HRV falls through pregnancy, so the "resting HR up / HRV down" heads-ups would fire for her all the
-- time and mean nothing. household_prefs 'pregnancy' = {"person":"a","until":"2027-05-31"} (due ~mid Feb 2027, plus
-- recovery); while it covers the date, health_flags() and weekly_health() skip those warnings for that person.
-- Idempotent; no destructive statements.

insert into public.household_prefs (key, value) values ('pregnancy', '{"person":"a","until":"2027-05-31"}')
on conflict (key) do update set value = excluded.value, updated_at = now();

create or replace function private.pregnant(p_person text, p_date date) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (h.value->>'person') = p_person and p_date <= (h.value->>'until')::date
                   from public.household_prefs h where h.key = 'pregnancy'), false)
$$;
revoke all on function private.pregnant(text, date) from public, anon, authenticated;

-- Skip the warnings while pregnant (patches the 0037 definitions in place).
do $$
declare d text;
begin
  select pg_get_functiondef('private.health_flags(date)'::regprocedure) into d;
  if position('private.pregnant' in d) = 0 then
    d := replace(d, 'where b.n >= 10 and', 'where b.n >= 10 and not private.pregnant(t.person_id, p_date) and');
    execute d;
  end if;
  select pg_get_functiondef('private.weekly_health(date)'::regprocedure) into d;
  if position('private.pregnant' in d) = 0 then
    d := replace(d, 'v_arrow := case', 'v_arrow := case when private.pregnant(r.id, p_date) then ''''');
    execute d;
  end if;
end $$;
