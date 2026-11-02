-- Locations from OwnTracks, home/away from them, the Map's settings, and the camera ticket key (2026-11-02).
--
-- Both iPhones run the OwnTracks app in HTTP mode and post to the `owntracks` Edge Function, authenticated with that
-- person's presence token (the same slp_… token as the Shortcut and the Mac; HTTP Basic password).
--
-- 1. public.locations: one row per fix (and per region enter/leave transition: event + region name in note). Household
--    members read (System › Location, the Map tab); only the service role (the function) inserts. (person_id, ts) is
--    unique, so the phone's retried queue stores nothing twice. Rows are never removed.
-- 2. household_settings: home_lat / home_lon / home_radius_m (the home circle the function judges home/away with),
--    maps_browser_key (Google Maps JavaScript API key, browser-restricted by HTTP referrer, so members may read it with
--    the settings row) and camera_ticket_required (the Live tab asks camera-ticket for a signed ticket before it embeds
--    the stream). Owners and members set them with set_home_location(), set_maps_browser_key() and
--    set_camera_ticket_required(), the same definer-in-private + invoker-wrapper pattern as set_camera_stream_url (0020).
-- 3. presence_events.via: which signal produced an event ('shortcut', 'owntracks', 'wifi', 'test', 'manual'; null on
--    rows written before this migration). source keeps its 0009 check ('shortcut' | 'manual' | 'test'): OwnTracks events
--    are stored as source 'shortcut' (= a phone signal for ac-curve's gate, which reads presence_latest regardless of
--    source) with via 'owntracks'. public.record_presence_for(person, state, via) (service role only) inserts an
--    event only when it differs from that person's latest state, in one statement under a per-person advisory lock.
-- 4. private.camera_ticket_key: the single Ed25519 key pair camera-ticket signs viewer tickets with (private half as a
--    JWK, public half as base64url of the raw 32 bytes; the Mac's ticket gate verifies with the public half).
--    public.camera_ticket_key() reads it, public.camera_ticket_key_init() stores a freshly generated pair unless one
--    exists and returns the stored one, so concurrent first calls converge on one key. Service role only.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

-- ---------------------------------------------------------------- 1. locations

create table if not exists public.locations (
  id bigint generated always as identity primary key,
  person_id text not null references public.people (id),
  ts timestamptz not null,
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  acc_m integer check (acc_m is null or acc_m >= 0),
  alt_m integer,
  vel_kmh integer check (vel_kmh is null or vel_kmh >= 0),
  cog integer check (cog is null or cog between 0 and 360),
  batt integer check (batt is null or batt between 0 and 100),
  conn text check (conn is null or conn in ('w', 'm', 'o')),
  ssid text check (ssid is null or length(ssid) <= 64),
  trigger text check (trigger is null or length(trigger) <= 8),
  regions text[],
  event text check (event is null or event in ('enter', 'leave')),
  note text check (note is null or length(note) <= 200),
  source text not null default 'owntracks' check (length(source) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (person_id, ts)
);
comment on table public.locations is
  'Location fixes per person from OwnTracks (owntracks Edge Function, service role). A row with event set is a region '
  'transition (enter/leave; the region name in note). Rows are never removed.';
comment on column public.locations.acc_m is 'Horizontal accuracy, metres (OwnTracks acc).';
comment on column public.locations.vel_kmh is 'Speed, km/h (OwnTracks vel).';
comment on column public.locations.cog is 'Course over ground, degrees 0..360 (OwnTracks cog).';
comment on column public.locations.batt is 'Phone battery, percent (OwnTracks batt).';
comment on column public.locations.conn is 'Connectivity: w = Wi-Fi, m = mobile data, o = offline (OwnTracks conn).';
comment on column public.locations.ssid is 'Wi-Fi network name when on Wi-Fi (OwnTracks SSID).';
comment on column public.locations.trigger is 'What made the phone report (OwnTracks t: p ping, c region, r report, u manual, t timer, v monitoring …).';
comment on column public.locations.regions is 'OwnTracks regions the phone was inside (inregions).';
comment on column public.locations.event is 'Region transition: enter or leave (the region name is in note); null for an ordinary fix.';

create index if not exists locations_person_ts on public.locations (person_id, ts desc);
create index if not exists locations_ts on public.locations (ts desc);

alter table public.locations enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'locations' and policyname = 'household read') then
    create policy "household read" on public.locations for select to authenticated
      using ((select private.is_household_member()));
  end if;
end $$;

revoke all on public.locations from public, anon, authenticated;
grant select on public.locations to authenticated;
grant all on public.locations to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------- 2. household settings: home, Maps key, camera lock

alter table public.household_settings add column if not exists home_lat double precision
  check (home_lat is null or home_lat between -90 and 90);
alter table public.household_settings add column if not exists home_lon double precision
  check (home_lon is null or home_lon between -180 and 180);
alter table public.household_settings add column if not exists home_radius_m integer default 150
  check (home_radius_m is null or home_radius_m between 30 and 2000);
alter table public.household_settings add column if not exists maps_browser_key text;
alter table public.household_settings add column if not exists camera_ticket_required boolean not null default false;

comment on column public.household_settings.home_lat is
  'Home point (WGS84) for home/away from OwnTracks fixes; null = not set (no home/away from fixes). Set with set_home_location().';
comment on column public.household_settings.home_lon is 'See home_lat.';
comment on column public.household_settings.home_radius_m is 'Radius of the home circle, metres (30..2000, default 150).';
comment on column public.household_settings.maps_browser_key is
  'Google Maps JavaScript API key for the Map tab. A browser key restricted by HTTP referrer (sleep.cathnivore.com), '
  'so household members may read it. Set with set_maps_browser_key(); null = the Map uses its built-in fallback.';
comment on column public.household_settings.camera_ticket_required is
  'true = the app fetches a signed ticket from camera-ticket and embeds the stream under <camera_stream_url>/t/<ticket>/; '
  'turn on only once the Mac''s ticket gate runs. Set with set_camera_ticket_required().';

-- Home point: both coordinates, or null lat/lon to clear it (the radius is kept). p_radius_m null = keep the radius.
create or replace function private.set_home_location(p_lat double precision, p_lon double precision, p_radius_m integer default 150)
returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.household_settings;
  v_clear boolean := p_lat is null or p_lon is null;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if not v_clear and (p_lat not between -90 and 90 or p_lon not between -180 and 180 or p_lat = 'NaN'::double precision or p_lon = 'NaN'::double precision) then
    raise exception 'home must be a valid latitude (-90..90) and longitude (-180..180)' using errcode = '22023';
  end if;
  if p_radius_m is not null and p_radius_m not between 30 and 2000 then
    raise exception 'home radius must be 30..2000 m' using errcode = '22023';
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set
    home_lat = case when v_clear then null else p_lat end,
    home_lon = case when v_clear then null else p_lon end,
    home_radius_m = coalesce(p_radius_m, s.home_radius_m, 150),
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_home_location(double precision, double precision, integer) from public, anon;
grant execute on function private.set_home_location(double precision, double precision, integer) to authenticated;

create or replace function public.set_home_location(p_lat double precision, p_lon double precision, p_radius_m integer default 150)
returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_home_location(p_lat, p_lon, p_radius_m)
$$;
revoke all on function public.set_home_location(double precision, double precision, integer) from public, anon;
grant execute on function public.set_home_location(double precision, double precision, integer) to authenticated;

-- Google Maps browser key: trimmed; null or empty clears it.
create or replace function private.set_maps_browser_key(p_key text) returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(coalesce(p_key, '')), '');
  v_row public.household_settings;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9_-]{20,100}$' then
    raise exception 'that does not look like a Google API key (20–100 letters, digits, _ or -)' using errcode = '22023';
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set
    maps_browser_key = v_key,
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_maps_browser_key(text) from public, anon;
grant execute on function private.set_maps_browser_key(text) to authenticated;

create or replace function public.set_maps_browser_key(p_key text) returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_maps_browser_key(p_key)
$$;
revoke all on function public.set_maps_browser_key(text) from public, anon;
grant execute on function public.set_maps_browser_key(text) to authenticated;

create or replace function private.set_camera_ticket_required(p_required boolean) returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.household_settings;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_required is null then
    raise exception 'p_required must be true or false' using errcode = '22023';
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set
    camera_ticket_required = p_required,
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_camera_ticket_required(boolean) from public, anon;
grant execute on function private.set_camera_ticket_required(boolean) to authenticated;

create or replace function public.set_camera_ticket_required(p_required boolean) returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_camera_ticket_required(p_required)
$$;
revoke all on function public.set_camera_ticket_required(boolean) from public, anon;
grant execute on function public.set_camera_ticket_required(boolean) to authenticated;

-- ---------------------------------------------------------------- 3. presence from other signals

alter table public.presence_events add column if not exists via text
  check (via is null or via in ('shortcut', 'owntracks', 'wifi', 'test', 'manual'));
comment on column public.presence_events.via is
  'Which signal produced the event: shortcut (iPhone Shortcut), owntracks (OwnTracks fix or home-region transition), '
  'wifi, test, manual; null on rows from before migration 0023 (see source). OwnTracks events have source ''shortcut''.';

-- Records a presence event for a person (no token: the caller already authenticated them) only when it changes that
-- person's latest state. Returns the inserted row, or no row when the state was already p_state.
create or replace function private.record_presence_for(p_person_id text, p_state text, p_via text)
returns table (person_id text, state text, at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if p_state is null or p_state not in ('home', 'away') then
    raise exception 'state must be home or away' using errcode = '22023';
  end if;
  if p_via is not null and p_via not in ('shortcut', 'owntracks', 'wifi', 'test', 'manual') then
    raise exception 'via must be shortcut, owntracks, wifi, test or manual' using errcode = '22023';
  end if;
  if not exists (select 1 from public.people p where p.id = p_person_id) then
    raise exception 'unknown person %', p_person_id using errcode = '22023';
  end if;
  -- Two requests from the same phone at once must not both insert the same change.
  perform pg_advisory_xact_lock(hashtext('sleeplab:presence:' || p_person_id));
  return query
    insert into public.presence_events (person_id, state, source, via)
    select p_person_id, p_state, 'shortcut', p_via
    where p_state is distinct from (
      select e.state from public.presence_events e
      where e.person_id = p_person_id
      order by e.at desc, e.id desc
      limit 1
    )
    returning presence_events.person_id, presence_events.state, presence_events.at;
end $$;
revoke all on function private.record_presence_for(text, text, text) from public, anon, authenticated;
grant execute on function private.record_presence_for(text, text, text) to service_role;

create or replace function public.record_presence_for(p_person_id text, p_state text, p_via text)
returns table (person_id text, state text, at timestamptz)
language sql security invoker set search_path = '' as $$
  select * from private.record_presence_for(p_person_id, p_state, p_via)
$$;
revoke all on function public.record_presence_for(text, text, text) from public, anon, authenticated;
grant execute on function public.record_presence_for(text, text, text) to service_role;

-- ---------------------------------------------------------------- 4. camera ticket signing key

create table if not exists private.camera_ticket_key (
  id integer primary key default 1 check (id = 1),
  private_jwk jsonb not null,
  public_raw text not null check (public_raw ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz not null default now()
);
comment on table private.camera_ticket_key is
  'The Ed25519 key pair camera-ticket signs viewer tickets with (one row). private_jwk: the private key as a JWK; '
  'public_raw: base64url (no padding) of the raw 32-byte public key, which the Mac''s ticket gate verifies with.';
alter table private.camera_ticket_key enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'private' and tablename = 'camera_ticket_key' and policyname = 'definer functions only') then
    create policy "definer functions only" on private.camera_ticket_key
      for all to anon, authenticated using (false) with check (false);
  end if;
end $$;
revoke all on private.camera_ticket_key from public, anon, authenticated;
grant all on private.camera_ticket_key to service_role;

create or replace function private.camera_ticket_key() returns table (private_jwk jsonb, public_raw text)
language sql stable security definer set search_path = '' as $$
  select k.private_jwk, k.public_raw from private.camera_ticket_key k where k.id = 1
$$;
revoke all on function private.camera_ticket_key() from public, anon, authenticated;
grant execute on function private.camera_ticket_key() to service_role;

create or replace function public.camera_ticket_key() returns table (private_jwk jsonb, public_raw text)
language sql stable security invoker set search_path = '' as $$
  select * from private.camera_ticket_key()
$$;
revoke all on function public.camera_ticket_key() from public, anon, authenticated;
grant execute on function public.camera_ticket_key() to service_role;

-- Stores the pair unless one exists; always returns the stored pair (the first writer wins).
create or replace function private.camera_ticket_key_init(p_private_jwk jsonb, p_public_raw text)
returns table (private_jwk jsonb, public_raw text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if p_private_jwk is null or jsonb_typeof(p_private_jwk) <> 'object' or p_private_jwk ->> 'kty' <> 'OKP'
     or p_private_jwk ->> 'crv' <> 'Ed25519' or p_private_jwk ->> 'd' is null then
    raise exception 'private key must be an Ed25519 JWK' using errcode = '22023';
  end if;
  if p_public_raw is null or p_public_raw !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'public key must be base64url of 32 bytes' using errcode = '22023';
  end if;
  insert into private.camera_ticket_key (id, private_jwk, public_raw) values (1, p_private_jwk, p_public_raw)
  on conflict (id) do nothing;
  return query select k.private_jwk, k.public_raw from private.camera_ticket_key k where k.id = 1;
end $$;
revoke all on function private.camera_ticket_key_init(jsonb, text) from public, anon, authenticated;
grant execute on function private.camera_ticket_key_init(jsonb, text) to service_role;

create or replace function public.camera_ticket_key_init(p_private_jwk jsonb, p_public_raw text)
returns table (private_jwk jsonb, public_raw text)
language sql security invoker set search_path = '' as $$
  select * from private.camera_ticket_key_init(p_private_jwk, p_public_raw)
$$;
revoke all on function public.camera_ticket_key_init(jsonb, text) from public, anon, authenticated;
grant execute on function public.camera_ticket_key_init(jsonb, text) to service_role;
