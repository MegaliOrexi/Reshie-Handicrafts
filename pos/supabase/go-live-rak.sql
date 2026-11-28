-- =====================================================================
-- Go-live 2026-11-28 — clear RAK (Al Hamra FF62) test data before switching it to eGoal LIVE.
-- RAK only: other shops, items, staff, api_logs (eGoal UAT history) are kept.
-- Backup taken first: Storage → backups/2026/11/28.json
-- =====================================================================
begin;

create temp table _rak on commit drop as select id from shops where code = 'RAK';

delete from sale_items   where sale_id in (select id from sales where shop_id in (select id from _rak));
delete from sales        where shop_id in (select id from _rak);
delete from cash_sessions where shop_id in (select id from _rak);
delete from egoal_exports where shop_id in (select id from _rak);
delete from event_logs    where shop_id in (select id from _rak);
update receipt_counters set last_seq = 0 where shop_id in (select id from _rak);   -- next receipt: RAK-000001

commit;
