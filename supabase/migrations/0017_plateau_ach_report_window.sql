-- Overnight ventilation estimate + longer morning-report window (2026-10-30).
--
-- 1. night_metrics.ach_plateau*: ventilation from the end-of-night CO2 level (core plateauAch, last 90 min before
--    wake). kind 'plateau' = CO2 had levelled off (< 5 ppm/h); 'upper_bound' = still rising, true value is lower.
--    One shared figure for the occupancy detector, the report and the app when there is no morning decay.
-- 2. nightly-report cron: every 15 min 06:00-18:45 ICT (was 06:00-14:45), so sleep that syncs in the afternoon (hourly
--    health sync at :45) still regenerates that morning's report, even after it is final.
--
-- Written without destructive statements.

alter table public.night_metrics add column if not exists ach_plateau real;
alter table public.night_metrics add column if not exists ach_plateau_kind text;
alter table public.night_metrics add column if not exists ach_plateau_ppm integer;
comment on column public.night_metrics.ach_plateau is
  'Overnight ACH from the end-of-night CO2 level (two sleepers, 120 m3). See ach_plateau_kind.';
comment on column public.night_metrics.ach_plateau_kind is
  '''plateau'' (CO2 levelled off) or ''upper_bound'' (CO2 still rising at wake: true ACH is lower).';

select cron.schedule('sleeplab-nightly-report', '*/15 0-11,23 * * *',
  $$select private.invoke_edge_function('nightly-report', '{"auto":true}', 120000)$$);
