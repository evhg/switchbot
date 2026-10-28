-- Daily vitals for the Today dashboard: one row per person and local (ICT) calendar date, parsed by the core
-- Google Health parsers in google-health-sync. health_daily keeps the raw daily payloads; this table holds the
-- numbers the app reads, so the PWA doesn't have to dig through jsonb.
--
-- Keying: steps are the total for `date` itself; resting HR and daily HRV are Google's values for `date`, which
-- Google computes from the main sleep that ended that morning. A night with wake date D therefore reads steps
-- from D - 1 (the day leading into the night) and resting HR / HRV from D.
-- Each sync upserts only the columns it knows (steps and the daily types arrive separately), so a column is
-- null until its source has been synced.

create table public.health_vitals_daily (
  person_id text not null references public.people (id),
  date date not null,
  -- Total steps for the local day (sum of 1-min intervals, google-wearables).
  steps integer check (steps >= 0),
  -- daily-resting-heart-rate.beatsPerMinute
  resting_hr numeric(5, 1) check (resting_hr between 20 and 200),
  -- daily-resting-heart-rate metadata: WITH_SLEEP / ONLY_WITH_AWAKE_DATA
  resting_hr_method text,
  -- daily-heart-rate-variability.averageHeartRateVariabilityMilliseconds
  hrv_daily_ms numeric(6, 1) check (hrv_daily_ms > 0),
  -- daily-heart-rate-variability.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds
  deep_rmssd_ms numeric(6, 1) check (deep_rmssd_ms > 0),
  updated_at timestamptz not null default now(),
  primary key (person_id, date)
);

-- Readable by every household member; written only by the service role (which bypasses RLS).
alter table public.health_vitals_daily enable row level security;
create policy "household read" on public.health_vitals_daily for select to authenticated
  using ((select public.is_household_member()));

revoke all on public.health_vitals_daily from anon, authenticated;
grant select on public.health_vitals_daily to authenticated;
grant all on public.health_vitals_daily to service_role;
