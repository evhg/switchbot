-- Night sounds: snoring and other noises in the bedroom, only while the household sleeps (2026-11-03).
--
-- The SwitchBot Pan/Tilt Cam now stands on Cath's bedside table (window side), pointed at the wall. The live video is
-- turned off; Erik's Mac only listens: while the night-sound Edge Function says so (tonight's lights-out − 15 min until
-- the aircon's scheduled OFF at wake + 30 min, not paused, not away, not turned off), it classifies the camera's
-- audio locally (YAMNet AudioSet classes) and posts per-minute summaries and discrete events. No continuous audio is
-- stored; short clips (~10 s) of notable moments, never speech, are uploaded through signed URLs.
--
-- 1. public.sound_minutes: one row per listened minute (loudness, seconds of snoring / speech / cough, top classes).
--    Primary key (camera, ts): a retried batch stores nothing twice.
-- 2. public.sound_events: discrete moments (snore run start, loud, cough, speech, other) with an optional clip in the
--    private bucket 'night-sounds' (clip_path = object name without the bucket, '<night>/<YYYYMMDDTHHMMSS[.mmm]Z>_<kind>.m4a').
--    (camera, ts, kind) is unique. Rows are never removed: hidden = true takes one out of the app (owners and members
--    may set it); the function clears clip_path once the clip passed its 14-day retention and its object is gone.
-- 3. household_settings: sound_mode ('auto' | 'off'), sound_paused_until, sound_clips, live_video (the Live tab shows
--    the video player only when true; default false = video off). Writers change them with set_sound_settings(),
--    pause_sound_until() and set_live_video(), the definer-in-private + invoker-wrapper pattern of 0020/0023.
-- 4. Storage bucket 'night-sounds' (private, audio only, 2 MB): household members read (signed URLs in the app);
--    uploads only through service-role signed upload URLs (no insert policy for authenticated).
--
-- camera_events (0022) is left as it is.
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

-- ---------------------------------------------------------------- 1. sound_minutes

create table if not exists public.sound_minutes (
  camera text not null default 'bedroom' check (length(camera) between 1 and 40),
  ts timestamptz not null,
  night_date date not null,
  db_avg real check (db_avg is null or db_avg between -120 and 20),
  db_max real check (db_max is null or db_max between -120 and 20),
  db_floor real check (db_floor is null or db_floor between -120 and 20),
  snore_s smallint not null default 0 check (snore_s between 0 and 60),
  snore_prob real check (snore_prob is null or snore_prob between 0 and 1),
  speech_s smallint not null default 0 check (speech_s between 0 and 60),
  cough_s smallint not null default 0 check (cough_s between 0 and 60),
  classes jsonb not null default '{}'::jsonb check (jsonb_typeof(classes) = 'object'),
  n smallint not null default 0 check (n >= 0),
  created_at timestamptz not null default now(),
  primary key (camera, ts)
);
comment on table public.sound_minutes is
  'One row per minute the Mac listened (night-sound Edge Function, service role), only inside the night''s listen '
  'window (lights-out − 15 min → wake + 30 min). night_date = the wake (morning) date, like nights.date.';
comment on column public.sound_minutes.ts is 'Start of the minute.';
comment on column public.sound_minutes.db_avg is 'Mean frame level, dBFS (the camera''s mic, uncalibrated).';
comment on column public.sound_minutes.db_max is 'Loudest frame, dBFS.';
comment on column public.sound_minutes.db_floor is '10th percentile of the frame levels: the room''s quiet floor, dBFS.';
comment on column public.sound_minutes.snore_s is 'Seconds of the minute classified as snoring (0..60).';
comment on column public.sound_minutes.snore_prob is 'Mean snoring score over the minute (0..1).';
comment on column public.sound_minutes.classes is 'Top (≤ 5) YAMNet classes of the minute: {"Snoring": 22, "Breathing": 9, …} (seconds).';
comment on column public.sound_minutes.n is 'Classifier frames (0.975 s each) in the minute.';

create index if not exists sound_minutes_night_ts on public.sound_minutes (night_date, ts);
create index if not exists sound_minutes_ts on public.sound_minutes (ts desc);

alter table public.sound_minutes enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sound_minutes' and policyname = 'household read') then
    create policy "household read" on public.sound_minutes for select to authenticated
      using ((select private.is_household_member()));
  end if;
end $$;

revoke all on public.sound_minutes from public, anon, authenticated;
grant select on public.sound_minutes to authenticated;
grant all on public.sound_minutes to service_role;

-- ---------------------------------------------------------------- 2. sound_events

create table if not exists public.sound_events (
  id bigint generated always as identity primary key,
  camera text not null default 'bedroom' check (length(camera) between 1 and 40),
  ts timestamptz not null,
  night_date date not null,
  duration_s real check (duration_s is null or duration_s between 0 and 3600),
  kind text not null check (kind in ('snore', 'loud', 'cough', 'speech', 'other')),
  label text check (label is null or length(label) between 1 and 80),
  peak_db real check (peak_db is null or peak_db between -120 and 20),
  score real check (score is null or score between 0 and 1),
  clip_path text check (clip_path is null or length(clip_path) between 1 and 200),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  unique (camera, ts, kind)
);
comment on table public.sound_events is
  'Discrete night sounds from the Mac (night-sound, service role), only inside the listen window. kind: snore (start '
  'of a snoring run), loud (≥ 15 dB above the quiet floor), cough, speech (never clipped), other (Dog, Vehicle, Door '
  '…). hidden = true takes a row out of the app (rows are never removed).';
comment on column public.sound_events.label is 'YAMNet class name (e.g. Snoring, Cough, Dog, Door).';
comment on column public.sound_events.peak_db is 'Loudest frame of the event, dBFS.';
comment on column public.sound_events.score is 'Classifier score of the label, 0..1.';
comment on column public.sound_events.clip_path is
  'Object name in the private Storage bucket ''night-sounds'' (no bucket prefix): <night>/<YYYYMMDDTHHMMSS[.mmm]Z>_<kind>.m4a. '
  'Reserved by night-sound when it hands out the signed upload URL (the object may still be missing if the Mac''s '
  'upload failed); set back to null once the clip is older than 14 days and its object is gone.';

create index if not exists sound_events_night_ts on public.sound_events (night_date, ts);
create index if not exists sound_events_clips on public.sound_events (ts) where clip_path is not null;

alter table public.sound_events enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sound_events' and policyname = 'household read') then
    create policy "household read" on public.sound_events for select to authenticated
      using ((select private.is_household_member()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sound_events' and policyname = 'writers hide') then
    create policy "writers hide" on public.sound_events for update to authenticated
      using ((select private.is_household_writer()))
      with check ((select private.is_household_writer()));
  end if;
end $$;

revoke all on public.sound_events from public, anon, authenticated;
grant select on public.sound_events to authenticated;
grant update (hidden) on public.sound_events to authenticated;
grant all on public.sound_events to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------- 3. household settings

alter table public.household_settings add column if not exists sound_mode text not null default 'auto'
  check (sound_mode in ('auto', 'off'));
alter table public.household_settings add column if not exists sound_paused_until timestamptz;
alter table public.household_settings add column if not exists sound_clips boolean not null default true;
alter table public.household_settings add column if not exists live_video boolean not null default false;

comment on column public.household_settings.sound_mode is
  'Night sounds: auto = the Mac listens during the night''s listen window (lights-out − 15 min → wake + 30 min, not '
  'away); off = never. Set with set_sound_settings().';
comment on column public.household_settings.sound_paused_until is
  'Night sounds paused until this moment ("Pause tonight"); null or past = not paused. Set with pause_sound_until().';
comment on column public.household_settings.sound_clips is
  'true = night-sound hands out upload URLs for ~10 s clips of notable moments (never speech; ≤ 40 per night, kept 14 days).';
comment on column public.household_settings.live_video is
  'true = the Live tab shows the camera''s video player. Default false: video off, the camera only listens at night. '
  'Set with set_live_video().';

-- Listening mode and/or clips (null = keep).
create or replace function private.set_sound_settings(p_mode text default null, p_clips boolean default null)
returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.household_settings;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_mode is not null and p_mode not in ('auto', 'off') then
    raise exception 'sound mode must be auto or off' using errcode = '22023';
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set
    sound_mode = coalesce(p_mode, s.sound_mode),
    sound_clips = coalesce(p_clips, s.sound_clips),
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_sound_settings(text, boolean) from public, anon;
grant execute on function private.set_sound_settings(text, boolean) to authenticated;

create or replace function public.set_sound_settings(p_mode text default null, p_clips boolean default null)
returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_sound_settings(p_mode, p_clips)
$$;
revoke all on function public.set_sound_settings(text, boolean) from public, anon;
grant execute on function public.set_sound_settings(text, boolean) to authenticated;

-- Pause until a moment (at most 7 days ahead); null resumes.
create or replace function private.pause_sound_until(p_until timestamptz) returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.household_settings;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_until is not null and p_until > now() + interval '7 days' then
    raise exception 'pause at most 7 days ahead' using errcode = '22023';
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set
    sound_paused_until = case when p_until is null or p_until <= now() then null else p_until end,
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.pause_sound_until(timestamptz) from public, anon;
grant execute on function private.pause_sound_until(timestamptz) to authenticated;

create or replace function public.pause_sound_until(p_until timestamptz) returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.pause_sound_until(p_until)
$$;
revoke all on function public.pause_sound_until(timestamptz) from public, anon;
grant execute on function public.pause_sound_until(timestamptz) to authenticated;

create or replace function private.set_live_video(p_on boolean) returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.household_settings;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'p_on must be true or false' using errcode = '22023';
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set
    live_video = p_on,
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_live_video(boolean) from public, anon;
grant execute on function private.set_live_video(boolean) to authenticated;

create or replace function public.set_live_video(p_on boolean) returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_live_video(p_on)
$$;
revoke all on function public.set_live_video(boolean) from public, anon;
grant execute on function public.set_live_video(boolean) to authenticated;

-- ---------------------------------------------------------------- 4. Storage bucket 'night-sounds'

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('night-sounds', 'night-sounds', false, 2097152, array['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg', 'audio/webm'])
on conflict (id) do nothing;

-- Members read (the app makes signed URLs). No insert/update policy for authenticated: the Mac uploads through
-- signed upload URLs the function creates with the service role, which bypasses RLS.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'night sounds read') then
    create policy "night sounds read" on storage.objects for select to authenticated
      using (bucket_id = 'night-sounds' and (select private.is_household_member()));
  end if;
end $$;
