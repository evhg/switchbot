-- Camera activity from the Mac relay (2026-11-02).
--
-- Erik's always-on Mac runs face recognition locally on the living-room camera (Pan/Tilt Cam via go2rtc), for
-- enrolled and consenting people only, and posts sightings to the `camera-event` Edge Function. Only labels arrive
-- here: no image, face embedding or other biometric data is ever sent to or stored by the backend.
--
-- 1. public.camera_events: one row per sighting. label = a household person id ('a', 'b'; person_id is set), a named
--    guest label (only someone who agreed to be enrolled), 'unknown' (a face that matched nobody) or 'person' (a body,
--    no face). activity = the Mac's zone name ('desk', 'sofa', 'kitchen', 'dining' …). Household members read; only
--    the service role (the function) inserts. Rows are never removed: `hidden` = true takes one out of the app (owners
--    and members may set it). (camera, ts, label) is unique, so a retried upload stores nothing twice.
-- 2. public.camera_alerts: the last time each alert kind was pushed. public.claim_camera_alert(kind, window_min) claims
--    the slot atomically, so the "unknown person while nobody is home" push fires at most once per window. Service
--    role only.
-- 3. public.presence_token_person(token): which person a presence token belongs to (or null), for camera-event's auth.
--    Unlike record_presence() it records nothing and leaves last_used_at alone, so System › Presence keeps showing when
--    each phone's Shortcut last ran. Service role only.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

-- ---------------------------------------------------------------- 1. camera_events

create table if not exists public.camera_events (
  id bigint generated always as identity primary key,
  ts timestamptz not null,
  camera text not null default 'living' check (length(camera) between 1 and 40),
  label text not null check (length(label) between 1 and 40),
  person_id text references public.people (id),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  activity text check (activity is null or length(activity) between 1 and 40),
  duration_s integer check (duration_s is null or (duration_s >= 0 and duration_s <= 86400)),
  thumb_path text,
  source text not null default 'mac-relay' check (length(source) between 1 and 40),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  unique (camera, ts, label)
);
comment on table public.camera_events is
  'Sightings posted by the Mac relay (camera-event). Labels only, never biometric data. label: a household person id '
  '(person_id set), a consenting guest''s label, ''unknown'' (face matched nobody) or ''person'' (body, no face). '
  'hidden = true takes a row out of the app (rows are never removed).';
comment on column public.camera_events.activity is 'Zone name from the Mac (desk, sofa, kitchen, dining …), or null.';
comment on column public.camera_events.duration_s is 'How long the sighting lasted, seconds, when the Mac reports it.';
comment on column public.camera_events.thumb_path is 'Optional Storage path of a thumbnail. Unused: the relay sends no images.';

create index if not exists camera_events_ts on public.camera_events (ts desc);
create index if not exists camera_events_person_ts on public.camera_events (person_id, ts);

alter table public.camera_events enable row level security;
create policy "household read" on public.camera_events for select to authenticated
  using ((select private.is_household_member()));
create policy "writers hide" on public.camera_events for update to authenticated
  using ((select private.is_household_writer()))
  with check ((select private.is_household_writer()));

revoke all on public.camera_events from public, anon, authenticated;
grant select on public.camera_events to authenticated;
grant update (hidden) on public.camera_events to authenticated;
grant all on public.camera_events to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------- 2. alert de-dup

create table if not exists public.camera_alerts (
  kind text primary key check (length(kind) between 1 and 40),
  last_sent_at timestamptz not null,
  last_event_ts timestamptz,
  sent_count integer not null default 1
);
comment on table public.camera_alerts is
  'Last push per alert kind (''unknown'': unknown person while nobody is home). Claimed with claim_camera_alert().';

alter table public.camera_alerts enable row level security;
create policy "service role only" on public.camera_alerts
  for all to anon, authenticated using (false) with check (false);
revoke all on public.camera_alerts from public, anon, authenticated;
grant all on public.camera_alerts to service_role;

-- True when the caller may send the alert now (and records it): no earlier push of this kind, or the last one is at
-- least p_window_min minutes old. One statement, so two concurrent uploads can't both win.
create or replace function public.claim_camera_alert(p_kind text, p_window_min integer default 30, p_event_ts timestamptz default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
begin
  insert into public.camera_alerts as a (kind, last_sent_at, last_event_ts, sent_count)
  values (p_kind, now(), p_event_ts, 1)
  on conflict (kind) do update set
    last_sent_at = excluded.last_sent_at,
    last_event_ts = excluded.last_event_ts,
    sent_count = a.sent_count + 1
  where a.last_sent_at <= now() - make_interval(mins => greatest(coalesce(p_window_min, 30), 1))
  returning a.kind into v_kind;
  return v_kind is not null;
end $$;
revoke all on function public.claim_camera_alert(text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_camera_alert(text, integer, timestamptz) to service_role;

-- ---------------------------------------------------------------- 3. token check without recording presence

create or replace function private.presence_token_person(p_token text) returns text
language sql stable security definer set search_path = '' as $$
  select t.person_id from private.presence_tokens t
  where t.token_hash = private.presence_token_hash(p_token)
$$;
revoke all on function private.presence_token_person(text) from public, anon, authenticated;
grant execute on function private.presence_token_person(text) to service_role;

create or replace function public.presence_token_person(p_token text) returns text
language sql stable security invoker set search_path = '' as $$
  select private.presence_token_person(p_token)
$$;
revoke all on function public.presence_token_person(text) from public, anon, authenticated;
grant execute on function public.presence_token_person(text) to service_role;
