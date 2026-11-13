-- Entrance camera (2026-11-13): the Pan/Tilt Cam moves from the bedside table to the front entrance door.
--
-- The bedroom microphone was too weak to hear snoring, so the camera now watches the villa's entrance instead:
--   1. The night listener is switched off (household_settings.sound_mode = 'off'): there is nothing left to hear.
--   2. The live video is on (household_settings.live_video = true): the Live tab shows the entrance.
--   3. Every sighting the Mac's relay posts to camera-event (public.camera_events, camera 'entrance') pushes a notice:
--        Cath / Erik     "Erik at the front door (18:42)"  body: "Arriving" / "Leaving" when the relay says so
--                        (activity 'arrive' / 'leave'), else "Seen at the entrance"
--        unknown/person  "Someone at the front door (02:13)"  body: "A face Jarvis doesn't know" / "A person, no face seen"
--      At most one notice per person (or per stranger kind) per 10 minutes. Hidden rows and other cameras are ignored.
-- Pushes go through private.jarvis_push (0037), so they are logged in jarvis_notices (kind 'entrance').
-- Idempotent; no destructive statements.

update public.household_settings set sound_mode = 'off', live_video = true, updated_at = now() where id = 1;

create or replace function private.entrance_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_key text;
  v_time text := to_char(new.ts at time zone 'Asia/Bangkok', 'HH24:MI');
  v_title text;
  v_body text;
begin
  if new.hidden or new.camera <> 'entrance' then return new; end if;
  if new.ts < now() - interval '15 minutes' then return new; end if; -- backfills stay silent
  select p.name into v_name from public.people p where p.id = coalesce(new.person_id, new.label);
  v_key := 'entrance:' || coalesce(new.person_id, new.label);
  if exists (select 1 from public.jarvis_notices n where n.kind = v_key and n.sent_at > now() - interval '10 minutes') then
    return new;
  end if;
  if v_name is not null then
    v_title := v_name || ' at the front door (' || v_time || ')';
    v_body := case new.activity when 'arrive' then 'Arriving' when 'leave' then 'Leaving' else 'Seen at the entrance' end;
  else
    v_title := 'Someone at the front door (' || v_time || ')';
    v_body := case new.label when 'unknown' then 'A face Jarvis doesn’t know' when 'person' then 'A person, no face seen' else 'Guest: ' || new.label end;
  end if;
  perform private.jarvis_push(v_key, v_title, v_body);
  return new;
exception when others then
  raise warning 'entrance_notice: %', sqlerrm;
  return new;
end $$;
revoke all on function private.entrance_notice() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'entrance_notice' and tgrelid = 'public.camera_events'::regclass) then
    create trigger entrance_notice after insert on public.camera_events
      for each row execute function private.entrance_notice();
  end if;
end $$;
