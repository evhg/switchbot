-- Housekeeping at 03:17 ICT (20:17 UTC): the 1-min jobs add ~1,700 cron.job_run_details rows per day.
-- Run once from Supabase Dashboard > SQL Editor (cron.schedule replaces a job with the same name).
select cron.schedule('sleeplab-housekeeping', '17 20 * * *', $$
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  delete from public.oauth_states where created_at < now() - interval '1 day';
  delete from public.api_quota_log where ts < now() - interval '60 days';
  delete from public.health_sync_jobs where done_at < now() - interval '14 days';
$$);
