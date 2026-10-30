-- Night analysis results + zero-touch Web Push keys (2026-10-30).
--
-- 1. public.night_metrics: one row per night (ICT wake date), written by the night-analysis step (Edge Functions
--    night-analysis and nightly-report, both via _shared/analysis.ts). Room metrics are computed from CLEANED readings
--    (core cleanRoomReadings: frozen temp/RH stretches and cached snapshots removed, gaps measured) over lights-out − 2 h
--    → max(12:00, wake + 2 h). Re-running a night upserts the same row (idempotent). Household members read it.
-- 2. VAPID key pair for Web Push, generated inside the backend (push-admin / the first push) with WebCrypto and kept
--    in Vault (`vapid_public_key`, `vapid_private_key`). store_vapid_keys() writes them once (never overwrites) and
--    copies the PUBLIC key to household_settings.vapid_public_key, which members can read. vapid_keys() returns both,
--    service_role only, so the private key never leaves the database / functions.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- 1. night_metrics

create table if not exists public.night_metrics (
  date date primary key references public.nights (date) on update cascade,
  computed_at timestamptz not null default now(),
  analysis_version integer not null default 1,
  curve_id text,
  lights_out timestamptz not null,
  wake timestamptz not null,
  window_from timestamptz not null,
  window_to timestamptz not null,
  -- room metrics over lights-out → wake (core RoomNightMetrics; null where the night had too little data)
  sleep_air_score integer,
  co2_mean integer,
  co2_p95 integer,
  co2_max integer,
  minutes_co2_over_1000 integer,
  minutes_co2_over_1500 integer,
  temp_mean real,
  temp_early_mean real,
  minutes_temp_in_target integer,
  minutes_temp_over_24 integer,
  rh_mean real,
  minutes_rh_over_60 integer,
  minutes_rh_in_band integer,
  -- morning CO2 decay (core fitDecayAch) after both left the room
  ach_morning real,
  ach_r2 real,
  ach_baseline_ppm real,
  decay_start timestamptz,
  decay_end timestamptz,
  decay_from text,                      -- 'room_empty' (detected departure) | 'wake'
  -- data quality
  coverage_pct real,                    -- lights-out → wake minutes with a clean reading, %
  frozen_minutes integer not null default 0,
  frozen_night_minutes integer not null default 0,
  gap_minutes integer not null default 0,
  gap_night_minutes integer not null default 0,
  invalid_co2_count integer not null default 0,
  flags text[] not null default '{}',   -- frozen_temp_rh, frozen_all, gap_*, low_coverage, no_room_data, invalid_co2,
                                        -- no_morning_decay, manual_night (no live aircon command), no_health_data
  quality jsonb not null default '{}',  -- full RoomDataQuality (frozen stretches, gaps; ISO times)
  room jsonb not null default '{}',     -- RoomNightMetrics as computed
  events_count integer not null default 0,
  ac_commands integer not null default 0,
  live_ac_commands integer not null default 0,
  people_count integer not null default 0
);
comment on table public.night_metrics is
  'Per-night room analysis from cleaned readings (lights-out - 2 h .. noon): metrics, morning ACH and data-quality '
  'flags. Written by night-analysis / nightly-report (service role), idempotent per date.';

alter table public.night_metrics enable row level security;
create policy "household read" on public.night_metrics for select to authenticated
  using ((select private.is_household_member()));
revoke all on public.night_metrics from public, anon, authenticated;
grant select on public.night_metrics to authenticated;
grant all on public.night_metrics to service_role;

-- ---------------------------------------------------------------- 2. VAPID keys

alter table public.household_settings add column if not exists vapid_public_key text;
comment on column public.household_settings.vapid_public_key is
  'Web Push applicationServerKey (base64url, 65-byte uncompressed P-256 point). Copied here by store_vapid_keys(); '
  'the private half lives only in Vault.';

-- Stores a freshly generated pair unless one exists; always returns the public key that is in effect.
create or replace function public.store_vapid_keys(p_public text, p_private text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_pub text;
begin
  perform pg_advisory_xact_lock(hashtext('sleeplab:vapid'));
  select ds.decrypted_secret into v_pub from vault.decrypted_secrets ds where ds.name = 'vapid_public_key' limit 1;
  if v_pub is null then
    if p_public !~ '^[A-Za-z0-9_-]{86,88}$' or p_private !~ '^[A-Za-z0-9_-]{42,44}$' then
      raise exception 'bad VAPID key format' using errcode = '22023';
    end if;
    perform vault.create_secret(p_private, 'vapid_private_key', 'Web Push VAPID private key (P-256 d, base64url). Migration 0016.');
    perform vault.create_secret(p_public, 'vapid_public_key', 'Web Push VAPID public key (base64url). Migration 0016.');
    v_pub := p_public;
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings set vapid_public_key = v_pub where id = 1 and vapid_public_key is distinct from v_pub;
  return v_pub;
end $$;
revoke all on function public.store_vapid_keys(text, text) from public, anon, authenticated;
grant execute on function public.store_vapid_keys(text, text) to service_role;

create or replace function public.vapid_keys() returns table (public_key text, private_key text)
language sql stable security definer set search_path = '' as $$
  select
    (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = 'vapid_public_key' limit 1),
    (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = 'vapid_private_key' limit 1)
$$;
revoke all on function public.vapid_keys() from public, anon, authenticated;
grant execute on function public.vapid_keys() to service_role;
