-- =====================================================================
-- Scheduled jobs (run AFTER schema.sql, and AFTER deploying the Edge Functions). Safe to re-run.
-- Requires: Database → Extensions → enable  pg_cron  and  pg_net  (Vault is on by default).
--
-- Auth: each job sends  X-Cron-Secret  = the Vault secret "cron_secret", which must equal the
-- CRON_SECRET Edge Function secret (supabase/functions/.env). No service_role key is needed.
-- One-time, in the SQL editor (value from supabase/functions/.env — never commit it):
--     select vault.create_secret('<CRON_SECRET value>', 'cron_secret');
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper: POST to one of our Edge Functions with the cron secret.
create or replace function cron_call(p_function text, p_body jsonb default '{}'::jsonb)
returns bigint language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url     := 'https://ossziefzhpqktzosailc.supabase.co/functions/v1/' || p_function,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body    := p_body,
    timeout_milliseconds := 60000
  );
$$;
revoke execute on function cron_call(text, jsonb) from public, anon, authenticated;

-- 1) Every 10 minutes — eGoal RETRY job. Each sale is already sent to eGoal by the till the moment
--    it is confirmed; this picks up anything that didn't make it (pending > 2 min, failed < 10 tries).
select cron.unschedule('egoal-export') where exists (select 1 from cron.job where jobname = 'egoal-export');
select cron.schedule('egoal-export', '*/10 * * * *', $$ select cron_call('egoal-export'); $$);

-- 2) 01:00 UAE (21:00 UTC) — free nightly backup to Storage bucket "backups"
select cron.unschedule('nightly-backup') where exists (select 1 from cron.job where jobname = 'nightly-backup');
select cron.schedule('nightly-backup', '0 21 * * *', $$ select cron_call('nightly-backup'); $$);

-- 3) 06:00 UAE (02:00 UTC) — daily sales email, one per shop, for the business day that just ended
--    (a business day runs 06:00 → 05:59 UAE, so late weekend sales after midnight are included)
select cron.unschedule('daily-report') where exists (select 1 from cron.job where jobname = 'daily-report');
select cron.schedule('daily-report', '0 2 * * *', $$ select cron_call('daily-report'); $$);

-- 4) 06:05 UAE (02:05 UTC) every morning — monthly sales email, one per shop. The function only sends on
--    the 1st (UAE date) and reports the whole previous month; on other days it does nothing.
select cron.unschedule('monthly-report') where exists (select 1 from cron.job where jobname = 'monthly-report');
select cron.schedule('monthly-report', '5 2 * * *', $$ select cron_call('daily-report', '{"period":"month"}'::jsonb); $$);
