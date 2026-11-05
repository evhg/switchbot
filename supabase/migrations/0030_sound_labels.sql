-- Sound labels: the household tells the Mac what really was snoring (2026-11-05, "build 2").
--
-- The bedroom camera's microphone is very quiet (about −68 dBFS, floor −71) and YAMNet often calls real snoring
-- "Whale vocalization", "Animal", "Music" or quiet "Speech", so the Mac listener misses it. Under every clip the app now
-- shows "Snoring" / "Not snoring" (with an optional Cath / Erik / ? after "Snoring"). The night-sound Edge Function
-- hands the labelled events back to the Mac (GET "calibration"), and the Mac retunes its snore rule from them every
-- evening. To have something to label, the Mac also sends short clips of borderline sounds (events with
-- "uncertain": true), at most household_settings.sound_uncertain_clips a night (default 8; 0 = off), on top of the
-- 40 ordinary clips and the 20 sleep-talk clips.
--
-- 1. public.sound_labels: one label per sound event (event_id primary key → a re-label replaces the old one).
--    label: snore | not_snore | speech | other; who: a (Cath) | b (Erik) | both | unknown, or null.
--    Household members read; owners and members write only through label_sound_event() (upsert); service role all.
-- 2. sound_events.uncertain (boolean, default false): the Mac's borderline sounds, clipped from their own allowance.
-- 3. household_settings.sound_uncertain_clips (0..40, default 8) + set_sound_uncertain_clips(p_n).
-- RPCs use the definer-in-private + invoker-wrapper pattern of 0020/0023/0024/0029.
-- Idempotent (if not exists / create or replace / guarded policies and constraints). No destructive statements.

-- ---------------------------------------------------------------- 1. sound_labels

create table if not exists public.sound_labels (
  event_id bigint primary key references public.sound_events (id),
  label text not null check (label in ('snore', 'not_snore', 'speech', 'other')),
  who text check (who is null or who in ('a', 'b', 'both', 'unknown')),
  labelled_by uuid,
  labelled_at timestamptz not null default now()
);
comment on table public.sound_labels is
  'A person''s verdict on one sound event (the "Snoring" / "Not snoring" buttons under each clip). The night-sound '
  'function returns the latest 200 to the Mac (GET calibration), which tunes its snore rule from them. A label beats '
  'the detector in the app''s snoring minutes. Written with label_sound_event().';
comment on column public.sound_labels.label is 'snore | not_snore | speech (sleep talk) | other.';
comment on column public.sound_labels.who is 'Who snored, for label snore: a (Cath), b (Erik), both, unknown; null = not said.';
comment on column public.sound_labels.labelled_by is 'auth.uid() of the person who labelled it last.';

create index if not exists sound_labels_labelled_at on public.sound_labels (labelled_at desc);

alter table public.sound_labels enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sound_labels' and policyname = 'household read') then
    create policy "household read" on public.sound_labels for select to authenticated
      using ((select private.is_household_member()));
  end if;
end $$;

revoke all on public.sound_labels from public, anon, authenticated;
grant select on public.sound_labels to authenticated;
grant all on public.sound_labels to service_role;

-- Label (or re-label) one event. Returns the stored row.
create or replace function private.label_sound_event(p_event_id bigint, p_label text, p_who text default null)
returns public.sound_labels
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.sound_labels;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_label is null or p_label not in ('snore', 'not_snore', 'speech', 'other') then
    raise exception 'label must be snore, not_snore, speech or other' using errcode = '22023';
  end if;
  if p_who is not null and p_who not in ('a', 'b', 'both', 'unknown') then
    raise exception 'who must be a, b, both or unknown' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sound_events e where e.id = p_event_id) then
    raise exception 'no such sound event' using errcode = '22023';
  end if;
  insert into public.sound_labels as l (event_id, label, who, labelled_by, labelled_at)
  values (p_event_id, p_label, case when p_label = 'snore' then p_who else null end, (select auth.uid()), now())
  on conflict (event_id) do update set
    label = excluded.label,
    who = excluded.who,
    labelled_by = excluded.labelled_by,
    labelled_at = excluded.labelled_at
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.label_sound_event(bigint, text, text) from public, anon;
grant execute on function private.label_sound_event(bigint, text, text) to authenticated;

create or replace function public.label_sound_event(p_event_id bigint, p_label text, p_who text default null)
returns public.sound_labels
language sql security invoker set search_path = '' as $$
  select * from private.label_sound_event(p_event_id, p_label, p_who)
$$;
revoke all on function public.label_sound_event(bigint, text, text) from public, anon;
grant execute on function public.label_sound_event(bigint, text, text) to authenticated;

-- ---------------------------------------------------------------- 2. sound_events.uncertain

alter table public.sound_events add column if not exists uncertain boolean not null default false;
comment on column public.sound_events.uncertain is
  'true = a borderline sound the Mac was unsure about (e.g. YAMNet "Whale vocalization", "Music", quiet "Speech"), '
  'sent so the household can label it. Its clip comes from household_settings.sound_uncertain_clips, not the 40.';

-- ---------------------------------------------------------------- 3. household settings

alter table public.household_settings add column if not exists sound_uncertain_clips integer not null default 8;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'household_settings_sound_uncertain_clips_range' and conrelid = 'public.household_settings'::regclass) then
    alter table public.household_settings add constraint household_settings_sound_uncertain_clips_range
      check (sound_uncertain_clips between 0 and 40);
  end if;
end $$;
comment on column public.household_settings.sound_uncertain_clips is
  'At most this many clips of borderline sounds a night (events with uncertain = true), for labelling; 0 = off. '
  'Separate from the 40 ordinary and 20 sleep-talk clips. Set with set_sound_uncertain_clips().';

create or replace function private.set_sound_uncertain_clips(p_n integer) returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.household_settings;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_n is null or p_n < 0 or p_n > 40 then
    raise exception 'borderline clips per night must be 0 to 40' using errcode = '22023';
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set
    sound_uncertain_clips = p_n,
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_sound_uncertain_clips(integer) from public, anon;
grant execute on function private.set_sound_uncertain_clips(integer) to authenticated;

create or replace function public.set_sound_uncertain_clips(p_n integer) returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_sound_uncertain_clips(p_n)
$$;
revoke all on function public.set_sound_uncertain_clips(integer) from public, anon;
grant execute on function public.set_sound_uncertain_clips(integer) to authenticated;
