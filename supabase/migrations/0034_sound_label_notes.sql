-- Sound labels, part 2 (2026-11-11): say what a sound was, not only "not snoring".
--
-- Under each clip, after "Not snoring", the app asks "What was it?" (Bird · Alarm clock · Noise · Movement · Other)
-- and offers a free description ("gecko on the wall", "Erik's phone buzzing"). Both are stored on the label row; the
-- label itself stays snore | not_snore | speech | other, so the Mac's calibration contract (GET calibration) is unchanged.
--
--   sound_labels.category  short tag, ≤ 40 chars (bird, alarm, noise, movement, other …), or null
--   sound_labels.note      free text, ≤ 500 chars, or null
--   set_sound_note(p_event_id, p_category, p_note)  owner/member; upserts the row (a new row gets label 'not_snore'),
--                                                   empty strings clear the fields
-- Idempotent; no destructive statements.

alter table public.sound_labels add column if not exists category text;
alter table public.sound_labels add column if not exists note text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sound_labels_category_len' and conrelid = 'public.sound_labels'::regclass) then
    alter table public.sound_labels add constraint sound_labels_category_len check (category is null or char_length(category) <= 40);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sound_labels_note_len' and conrelid = 'public.sound_labels'::regclass) then
    alter table public.sound_labels add constraint sound_labels_note_len check (note is null or char_length(note) <= 500);
  end if;
end $$;
comment on column public.sound_labels.category is 'What the sound was, as a short tag (bird, alarm, noise, movement, other …); null = not said.';
comment on column public.sound_labels.note is 'Free description of the sound, typed under the clip; null = none.';

create or replace function private.set_sound_note(p_event_id bigint, p_category text, p_note text)
returns public.sound_labels
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.sound_labels;
  v_cat text := nullif(btrim(lower(coalesce(p_category, ''))), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if v_cat is not null and char_length(v_cat) > 40 then
    raise exception 'category is at most 40 characters' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'description is at most 500 characters' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sound_events e where e.id = p_event_id) then
    raise exception 'no such sound event' using errcode = '22023';
  end if;
  insert into public.sound_labels as l (event_id, label, who, category, note, labelled_by, labelled_at)
  values (p_event_id, 'not_snore', null, v_cat, v_note, (select auth.uid()), now())
  on conflict (event_id) do update set
    category = excluded.category,
    note = excluded.note,
    labelled_by = excluded.labelled_by,
    labelled_at = excluded.labelled_at
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_sound_note(bigint, text, text) from public, anon;
grant execute on function private.set_sound_note(bigint, text, text) to authenticated;

create or replace function public.set_sound_note(p_event_id bigint, p_category text, p_note text)
returns public.sound_labels
language sql security invoker set search_path = '' as $$
  select * from private.set_sound_note(p_event_id, p_category, p_note)
$$;
revoke all on function public.set_sound_note(bigint, text, text) from public, anon;
grant execute on function public.set_sound_note(bigint, text, text) to authenticated;
