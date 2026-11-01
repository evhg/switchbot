-- Food camera, app secrets from Vault, and the camera stream URL (2026-11-01).
--
-- 1. public.app_secret(name): an app-level API key from Vault, for the Edge Functions (service role only). Only the
--    names on the allow-list are readable: 'google_weather_api_key' (weather-poll) and 'gemini_api_key' (food-photo).
--    The definer body lives in `private` (not exposed); the public wrapper runs as the caller, and only service_role
--    may execute either, like vapid_keys() (0016) and switchbot_webhook_secret() (0008).
-- 2. public.meals: one row per food photo. food-photo (Edge Function) asks Gemini for the dishes and their nutrition,
--    writes the row with the service role, then best-effort logs it to that person's Google Health nutrition log
--    (google_status / google_point / google_error). Rows are never removed: `hidden` = true takes one out of the app.
--    Household members read; owners and members insert and edit their own person's meals (the owner: anyone's).
-- 3. Storage bucket 'meals' (private): photos at meals/<person_id>/<file>. Household members read every photo; owners
--    and members upload under their own person (the owner: under anyone).
-- 4. household_settings.camera_stream_url: public go2rtc URL of the bedroom camera (served from Erik's Mac). Members
--    read it with the settings row; owners and members set it with set_camera_stream_url().
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

-- ---------------------------------------------------------------- 1. app secrets (service role)

create or replace function private.app_secret(p_name text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_value text;
begin
  if p_name is null or p_name not in ('google_weather_api_key', 'gemini_api_key') then
    raise exception 'secret % is not readable through app_secret()', coalesce(p_name, 'null') using errcode = '42501';
  end if;
  select ds.decrypted_secret into v_value from vault.decrypted_secrets ds where ds.name = p_name limit 1;
  return v_value;
end $$;
revoke all on function private.app_secret(text) from public, anon, authenticated;
grant execute on function private.app_secret(text) to service_role;

create or replace function public.app_secret(p_name text) returns text
language sql stable security invoker set search_path = '' as $$
  select private.app_secret(p_name)
$$;
revoke all on function public.app_secret(text) from public, anon, authenticated;
grant execute on function public.app_secret(text) to service_role;

-- ---------------------------------------------------------------- membership helper

-- Owner: any person; member: only the person their account is linked to; viewer: nobody.
create or replace function private.can_write_person(p_person_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.household_members m
    where m.user_id = (select auth.uid())
      and (m.role = 'owner' or (m.role = 'member' and m.person_id = p_person_id))
  )
$$;
revoke all on function private.can_write_person(text) from public, anon;
grant execute on function private.can_write_person(text) to authenticated, service_role;

-- ---------------------------------------------------------------- 2. meals

create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  person_id text not null references public.people (id),
  taken_at timestamptz not null default now(),
  meal_type text not null default 'snack' check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  photo_path text,
  note text,
  title text,
  kcal numeric,
  protein_g numeric,
  carbs_g numeric,
  fat_g numeric,
  fiber_g numeric,
  sugar_g numeric,
  items jsonb not null default '[]',
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  model text,
  raw jsonb,
  google_status text,
  google_point text,
  google_error text,
  google_synced_at timestamptz,
  hidden boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.meals is
  'Food photos analysed by food-photo (Gemini). Totals are the sums of items (grams, kcal and macros per item). '
  'hidden = true takes a meal out of the app (rows are never removed). google_status: null (not tried), ok, pending '
  '(long-running operation not done yet), error, no_token, removed (hidden and taken out of Google Health).';
comment on column public.meals.photo_path is 'Object name in the private Storage bucket ''meals'': <person_id>/<file>.';
comment on column public.meals.items is 'Per-item breakdown: [{name, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g}].';
comment on column public.meals.raw is 'Model output as returned (after JSON parsing), plus the model''s notes; for audits and re-parsing.';
comment on column public.meals.google_point is 'Google Health data point name users/me/dataTypes/nutrition-log/dataPoints/<id> of the last successful write.';

create index if not exists meals_person_taken on public.meals (person_id, taken_at desc);
create index if not exists meals_taken on public.meals (taken_at desc) where not hidden;

alter table public.meals enable row level security;
create policy "household read" on public.meals for select to authenticated
  using ((select private.is_household_member()));
create policy "writers insert own person" on public.meals for insert to authenticated
  with check ((select private.is_household_writer()) and private.can_write_person(person_id));
create policy "writers update own person" on public.meals for update to authenticated
  using ((select private.is_household_writer()) and private.can_write_person(person_id))
  with check ((select private.is_household_writer()) and private.can_write_person(person_id));

revoke all on public.meals from public, anon, authenticated;
grant select on public.meals to authenticated;
-- The app may correct what it shows; model output, Google sync state and authorship stay with the service role.
grant insert (person_id, taken_at, meal_type, photo_path, note, title, kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, items, hidden)
  on public.meals to authenticated;
grant update (taken_at, meal_type, note, title, kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, items, hidden, updated_at)
  on public.meals to authenticated;
grant all on public.meals to service_role;

-- ---------------------------------------------------------------- 3. Storage bucket 'meals'

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meals', 'meals', false, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

-- Object names are <person_id>/<file>; the first folder must be a known person. Qualified as objects.name: inside the
-- people subquery a bare `name` would bind to people.name.
create policy "meals photos read" on storage.objects for select to authenticated
  using (bucket_id = 'meals' and (select private.is_household_member()));
create policy "meals photos upload" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'meals'
    and (select private.is_household_writer())
    and exists (select 1 from public.people p where p.id = (storage.foldername(objects.name))[1])
    and private.can_write_person((storage.foldername(objects.name))[1])
  );

-- ---------------------------------------------------------------- 4. camera stream URL

alter table public.household_settings add column if not exists camera_stream_url text;
comment on column public.household_settings.camera_stream_url is
  'Public go2rtc URL of the bedroom camera (from Erik''s Mac), https only. Set with set_camera_stream_url(); null = no camera.';

create or replace function private.set_camera_stream_url(p_url text) returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
  v_row public.household_settings;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if v_url is not null and (v_url !~ '^https://[^\s/]+' or length(v_url) > 500) then
    raise exception 'camera stream URL must start with https:// (at most 500 characters)' using errcode = '22023';
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set
    camera_stream_url = v_url,
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_camera_stream_url(text) from public, anon;
grant execute on function private.set_camera_stream_url(text) to authenticated;

create or replace function public.set_camera_stream_url(p_url text) returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_camera_stream_url(p_url)
$$;
revoke all on function public.set_camera_stream_url(text) from public, anon;
grant execute on function public.set_camera_stream_url(text) to authenticated;
