-- =====================================================================
-- Scheduled jobs (run AFTER schema.sql, and AFTER deploying the Edge Functions)
-- Requires: Database → Extensions → enable  pg_cron  and  pg_net
-- Replace <PROJECT_REF> and <SERVICE_ROLE_KEY> below. The service_role key
-- lives ONLY here (Supabase SQL editor) / in Supabase secrets — never in git.
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) Every 10 minutes — eGoal RETRY job. Each sale is already sent to eGoal by the till the moment
--    it is confirmed; this picks up anything that didn't make it (pending > 2 min, failed < 10 tries).
select cron.unschedule('egoal-export') where exists (select 1 from cron.job where jobname = 'egoal-export');
select cron.schedule('egoal-export', '*/10 * * * *', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/egoal-export',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);

-- 2) 01:00 UAE (21:00 UTC) — free nightly backup to Storage bucket "backups"
select cron.unschedule('nightly-backup') where exists (select 1 from cron.job where jobname = 'nightly-backup');
select cron.schedule('nightly-backup', '0 21 * * *', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/nightly-backup',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);

-- 3) 06:00 UAE (02:00 UTC) — daily sales email, one per shop, for the business day that just ended
--    (a business day runs 06:00 → 05:59 UAE, so late weekend sales after midnight are included)
select cron.unschedule('daily-report') where exists (select 1 from cron.job where jobname = 'daily-report');
select cron.schedule('daily-report', '0 2 * * *', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/daily-report',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);

-- 4) 06:05 UAE (02:05 UTC) every morning — monthly sales email, one per shop. The function only sends on
--    the 1st (UAE date) and reports the whole previous month; on other days it does nothing.
select cron.unschedule('monthly-report') where exists (select 1 from cron.job where jobname = 'monthly-report');
select cron.schedule('monthly-report', '5 2 * * *', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/daily-report',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
    body    := '{"period":"month"}'::jsonb
  );
$$);
