-- =====================================================================
-- Migration 2026-11-26 — business day 06:00 → 05:59 UAE + "close yesterday before opening today"
-- Safe to re-run. (Already folded into schema.sql for fresh installs.)
-- =====================================================================

-- 1) Business date: sales after midnight (late weekend trading) stay on the evening's day.
create or replace function uae_today()
returns date language sql stable as $$
  select ((now() at time zone 'Asia/Dubai') - interval '6 hours')::date;
$$;

-- 2) A new day can only be opened once every earlier day of that shop is closed.
create or replace function cash_session_require_prev_closed()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_open date;
begin
  select business_date into v_open from cash_sessions
   where shop_id = new.shop_id and closed_at is null and business_date < new.business_date
   order by business_date limit 1;
  if found then
    raise exception 'previous day not closed: close % first', v_open;
  end if;
  return new;
end $$;

drop trigger if exists cash_session_prev_closed on cash_sessions;
create trigger cash_session_prev_closed before insert on cash_sessions
  for each row execute function cash_session_require_prev_closed();

-- 3) Daily / monthly emails run at 06:00 / 06:05 UAE (02:00 / 02:05 UTC), after the business day
--    has ended, so late-night sales are included. ("yesterday" at 06:00 = the business day just ended.)
select cron.alter_job(jobid, schedule := '0 2 * * *') from cron.job where jobname = 'daily-report';
select cron.alter_job(jobid, schedule := '5 2 * * *') from cron.job where jobname = 'monthly-report';
