-- Door clips (2026-11-14): "who was at the door?" Brief from the Mac session: ~/sleep-lab-home/face/JARVIS-door-clips.md.
--
-- An unknown face at the entrance now comes with a short MP4 clip and a face snapshot per person, so Cath or Erik can
-- say in the app who it was; the name goes back to the Mac, which learns the face.
--
-- 1. camera_events.clip_path  object name in the private bucket 'door-clips' (YYYY-MM-DD/<id>.mp4), or null
--    camera_events.people     [{"faces": ["11","14"], "snapshot": "YYYY-MM-DD/<id>-p0.jpg", "label": null}, …]
--                             one entry per person in the pass (the Mac's unnamed-face ids); label set once named
-- 2. Storage bucket 'door-clips' (private, mp4 + jpeg, 2 MB): household members read (signed URLs in the app); the
--    camera-event function hands the Mac signed upload URLs and deletes the objects once everyone in the pass is
--    named or forgotten, or after 14 days.
-- 3. public.face_names: one row per name chosen in the app (event, person index, faces, label, chosen_by, applied_at).
--    name_door_face(p_event_id, p_person, p_label) → household writers; label 'a' | 'b' | guest name | 'forget'.
--    A pass with a single person takes the label (and person_id for a/b); camera-event GET ?names=1 serves the
--    unapplied rows to the Mac, which POSTs {"namesApplied": [ids]} back.
-- Idempotent; no destructive statements.

alter table public.camera_events add column if not exists clip_path text;
alter table public.camera_events add column if not exists people jsonb;
comment on column public.camera_events.clip_path is 'Door clip in the private bucket door-clips (YYYY-MM-DD/<id>.mp4); null when none or deleted.';
comment on column public.camera_events.people is 'Unknown pass: [{faces: [mac face ids], snapshot: object name, label: null | a | b | guest | forget}], one per person.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('door-clips', 'door-clips', false, 2097152, array['video/mp4', 'image/jpeg'])
on conflict (id) do nothing;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'door clips read') then
    create policy "door clips read" on storage.objects for select to authenticated
      using (bucket_id = 'door-clips' and (select private.is_household_member()));
  end if;
end $$;

create table if not exists public.face_names (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.camera_events (id),
  person_index integer not null check (person_index between 0 and 20),
  faces text[] not null,
  label text not null check (label = 'forget' or label ~ '^[a-z][a-z0-9_-]{0,39}$'),
  chosen_by uuid,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
create index if not exists face_names_unapplied on public.face_names (id) where applied_at is null;
comment on table public.face_names is 'Names chosen in the app for unknown door faces; served to the Mac (camera-event GET ?names=1) until applied.';
alter table public.face_names enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'face_names' and policyname = 'household read') then
    create policy "household read" on public.face_names for select to authenticated using ((select private.is_household_member()));
  end if;
end $$;
revoke all on public.face_names from public, anon, authenticated;
grant select on public.face_names to authenticated;
grant all on public.face_names to service_role;

create or replace function private.name_door_face(p_event_id bigint, p_person integer, p_label text)
returns public.camera_events
language plpgsql security definer set search_path = '' as $$
declare
  v_ev public.camera_events;
  v_label text := lower(btrim(coalesce(p_label, '')));
  v_faces text[];
  v_people jsonb;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if v_label <> 'forget' and v_label !~ '^[a-z][a-z0-9_-]{0,39}$' then
    raise exception 'a name is lower-case letters, digits, - or _ (at most 40)' using errcode = '22023';
  end if;
  select * into v_ev from public.camera_events e where e.id = p_event_id for update;
  if not found then raise exception 'no such door event' using errcode = '22023'; end if;
  v_people := coalesce(v_ev.people, '[]'::jsonb);
  if p_person < 0 or p_person >= jsonb_array_length(v_people) then
    raise exception 'no such person in this pass' using errcode = '22023';
  end if;
  select coalesce(array_agg(f), '{}') into v_faces from jsonb_array_elements_text(v_people -> p_person -> 'faces') f;
  insert into public.face_names (event_id, person_index, faces, label, chosen_by)
  values (p_event_id, p_person, v_faces, v_label, (select auth.uid()));
  v_people := jsonb_set(v_people, array[p_person::text, 'label'], to_jsonb(v_label));
  update public.camera_events e set
    people = v_people,
    label = case when jsonb_array_length(v_people) = 1 and v_label <> 'forget' then v_label else e.label end,
    person_id = case when jsonb_array_length(v_people) = 1 and v_label in (select p.id from public.people p) then v_label else e.person_id end
  where e.id = p_event_id
  returning * into v_ev;
  return v_ev;
end $$;
revoke all on function private.name_door_face(bigint, integer, text) from public, anon;
grant execute on function private.name_door_face(bigint, integer, text) to authenticated;

create or replace function public.name_door_face(p_event_id bigint, p_person integer, p_label text)
returns public.camera_events
language sql security invoker set search_path = '' as $$
  select * from private.name_door_face(p_event_id, p_person, p_label)
$$;
revoke all on function public.name_door_face(bigint, integer, text) from public, anon;
grant execute on function public.name_door_face(bigint, integer, text) to authenticated;
