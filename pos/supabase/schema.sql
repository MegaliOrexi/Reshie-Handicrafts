-- =====================================================================
-- Reshie Handicrafts POS — schema v1
-- Run this whole file once in Supabase → SQL Editor.
-- Safe to re-run: everything is IF NOT EXISTS / CREATE OR REPLACE.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
do $$ begin
  create type user_role as enum ('owner', 'cashier');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_method as enum ('cash', 'card');
exception when duplicate_object then null; end $$;

do $$ begin
  create type export_status as enum ('pending', 'sent', 'failed');
exception when duplicate_object then null; end $$;
-- 'skipped' = shop has no eGoal codes (e.g. a mall that is not on eGoal)
alter type export_status add value if not exists 'skipped';

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists shops (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,              -- RAK (Al Hamra FF62) / AUH (WTC G-085) / AUH2 (WTC G-050)
  name        text not null,
  location    text not null,
  trn         text,                              -- Tax Registration Number (placeholder until provided)
  address     text,
  phone       text,
  receipt_footer text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
-- eGoal (Aldar mall sales reporting) identifiers -- all four are issued by eGoal.
-- Leave NULL for shops whose mall is not on eGoal: their export is marked 'skipped'.
alter table shops add column if not exists egoal_concessionaire_code text;
alter table shops add column if not exists egoal_outlet_code         text;
alter table shops add column if not exists egoal_tenant_code         text;
alter table shops add column if not exists egoal_mall_code           text;

create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        user_role not null default 'cashier',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Cashier <-> shop assignment (owners are implicitly assigned to all shops)
create table if not exists profile_shops (
  profile_id  uuid not null references profiles(id) on delete cascade,
  shop_id     uuid not null references shops(id) on delete cascade,
  primary key (profile_id, shop_id)
);

create table if not exists items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  category    text,
  sort_order  int not null default 100,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists cash_sessions (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references shops(id),
  business_date  date not null,
  opening_cash   numeric(12,2) not null check (opening_cash >= 0),
  opened_by      uuid not null references profiles(id),
  opened_at      timestamptz not null default now(),
  closing_cash   numeric(12,2) check (closing_cash >= 0),
  closed_by      uuid references profiles(id),
  closed_at      timestamptz,
  closing_note   text,
  unique (shop_id, business_date)
);

create table if not exists sales (
  id              uuid primary key default gen_random_uuid(),
  client_ref      uuid not null unique,          -- idempotency key for retry-on-submit
  shop_id         uuid not null references shops(id),
  session_id      uuid not null references cash_sessions(id),
  cashier_id      uuid not null references profiles(id),
  receipt_no      text not null unique,          -- e.g. RAK-000123
  receipt_seq     int  not null,
  payment_method  payment_method not null,
  gross_total     numeric(12,2) not null,
  net_total       numeric(12,2) not null,
  vat_total       numeric(12,2) not null,
  created_at      timestamptz not null default now()
);
create index if not exists sales_shop_created_idx on sales(shop_id, created_at desc);
create index if not exists sales_session_idx on sales(session_id);

create table if not exists sale_items (
  id              uuid primary key default gen_random_uuid(),
  sale_id         uuid not null references sales(id) on delete cascade,
  item_id         uuid not null references items(id),
  item_name       text not null,                 -- snapshot, in case the item is renamed later
  variation_code  text not null check (variation_code ~ '^[A-Z]+$'),
  qty             int not null check (qty > 0),
  unit_price      numeric(12,2) not null check (unit_price >= 0),   -- gross, VAT-inclusive
  line_gross      numeric(12,2) not null,
  line_net        numeric(12,2) not null,
  line_vat        numeric(12,2) not null
);
create index if not exists sale_items_sale_idx on sale_items(sale_id);

create table if not exists egoal_exports (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references shops(id),
  business_date  date not null,
  payload        jsonb not null,
  status         export_status not null default 'pending',
  attempts       int not null default 0,
  last_error     text,
  sent_at        timestamptz,
  created_at     timestamptz not null default now(),
  unique (shop_id, business_date)
);

-- Per-shop receipt counters
create table if not exists receipt_counters (
  shop_id  uuid primary key references shops(id),
  last_seq int not null default 0
);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function current_role_of(uid uuid)
returns user_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = uid and active;
$$;

create or replace function is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(current_role_of(auth.uid()) = 'owner', false);
$$;

create or replace function can_access_shop(p_shop uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_owner()
      or exists (select 1 from profile_shops ps
                 where ps.profile_id = auth.uid() and ps.shop_id = p_shop);
$$;

-- Business date in UAE time
create or replace function uae_today()
returns date language sql stable as $$
  select (now() at time zone 'Asia/Dubai')::date;
$$;

-- Auto-create a profile row whenever a user signs up / is invited
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill profiles for users created before this schema was run
insert into profiles (id, email, full_name)
select id, email, coalesce(raw_user_meta_data->>'full_name', split_part(email, '@', 1))
  from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- create_sale: atomic sale + lines + receipt number. Idempotent on client_ref.
-- p_items: [{ "item_id": uuid, "variation_code": "ABC", "qty": 1, "unit_price": 150.00 }]
-- ---------------------------------------------------------------------
create or replace function create_sale(
  p_client_ref uuid,
  p_shop_id uuid,
  p_payment_method payment_method,
  p_items jsonb
) returns sales
language plpgsql security definer set search_path = public as $$
declare
  v_session  cash_sessions%rowtype;
  v_sale     sales%rowtype;
  v_seq      int;
  v_shop     shops%rowtype;
  v_line     jsonb;
  v_item     items%rowtype;
  v_qty      int;
  v_price    numeric(12,2);
  v_gross    numeric(12,2);
  v_net      numeric(12,2);
  v_vat      numeric(12,2);
  v_sum_gross numeric(12,2) := 0;
  v_sum_net   numeric(12,2) := 0;
  v_sum_vat   numeric(12,2) := 0;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not can_access_shop(p_shop_id) then raise exception 'no access to this shop'; end if;

  -- Idempotency: if this client_ref already exists, return the existing sale
  select * into v_sale from sales where client_ref = p_client_ref;
  if found then return v_sale; end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'sale has no items';
  end if;

  -- The gate: today's cash session must exist and be open
  select * into v_session from cash_sessions
   where shop_id = p_shop_id and business_date = uae_today();
  if not found then raise exception 'day not opened: enter opening cash first'; end if;
  if v_session.closed_at is not null then raise exception 'day already closed'; end if;

  select * into v_shop from shops where id = p_shop_id;

  -- Next receipt number for this shop (row lock serialises concurrent sales)
  insert into receipt_counters (shop_id) values (p_shop_id) on conflict do nothing;
  update receipt_counters set last_seq = last_seq + 1
   where shop_id = p_shop_id returning last_seq into v_seq;

  insert into sales (client_ref, shop_id, session_id, cashier_id, receipt_no, receipt_seq,
                     payment_method, gross_total, net_total, vat_total)
  values (p_client_ref, p_shop_id, v_session.id, auth.uid(),
          v_shop.code || '-' || lpad(v_seq::text, 6, '0'), v_seq,
          p_payment_method, 0, 0, 0)
  returning * into v_sale;

  for v_line in select * from jsonb_array_elements(p_items) loop
    select * into v_item from items where id = (v_line->>'item_id')::uuid and active;
    if not found then raise exception 'unknown or inactive item'; end if;

    v_qty   := (v_line->>'qty')::int;
    v_price := round((v_line->>'unit_price')::numeric, 2);
    if v_qty is null or v_qty < 1 then raise exception 'qty must be >= 1'; end if;
    if v_price is null or v_price < 0 then raise exception 'invalid price'; end if;

    v_gross := round(v_price * v_qty, 2);
    v_net   := round(v_gross / 1.05, 2);
    v_vat   := v_gross - v_net;

    insert into sale_items (sale_id, item_id, item_name, variation_code, qty, unit_price,
                            line_gross, line_net, line_vat)
    values (v_sale.id, v_item.id, v_item.name, upper(v_line->>'variation_code'), v_qty, v_price,
            v_gross, v_net, v_vat);

    v_sum_gross := v_sum_gross + v_gross;
    v_sum_net   := v_sum_net + v_net;
    v_sum_vat   := v_sum_vat + v_vat;
  end loop;

  update sales set gross_total = v_sum_gross, net_total = v_sum_net, vat_total = v_sum_vat
   where id = v_sale.id returning * into v_sale;

  -- Log every receipt generated
  insert into event_logs (event, shop_id, actor_id, ref, message, data)
  values ('receipt.created', p_shop_id, auth.uid(), v_sale.receipt_no,
          'Receipt ' || v_sale.receipt_no || ' generated',
          jsonb_build_object('sale_id', v_sale.id, 'client_ref', p_client_ref,
                             'payment_method', v_sale.payment_method, 'gross', v_sale.gross_total,
                             'net', v_sale.net_total, 'vat', v_sale.vat_total,
                             'lines', jsonb_array_length(p_items)));

  return v_sale;
end $$;

-- ---------------------------------------------------------------------
-- Day totals for a session (used by the Day Close screen and reports)
-- ---------------------------------------------------------------------
create or replace function session_summary(p_session_id uuid)
returns table (
  sales_count bigint, gross_total numeric, net_total numeric, vat_total numeric,
  cash_total numeric, card_total numeric, items_sold bigint
) language sql stable security definer set search_path = public as $$
  select count(s.id),
         coalesce(sum(s.gross_total),0), coalesce(sum(s.net_total),0), coalesce(sum(s.vat_total),0),
         coalesce(sum(s.gross_total) filter (where s.payment_method='cash'),0),
         coalesce(sum(s.gross_total) filter (where s.payment_method='card'),0),
         coalesce((select sum(qty) from sale_items si join sales s2 on s2.id=si.sale_id where s2.session_id=p_session_id),0)
    from sales s
   where s.session_id = p_session_id
     and (select can_access_shop(cs.shop_id) from cash_sessions cs where cs.id = p_session_id);
$$;

-- ---------------------------------------------------------------------
-- Build the eGoal payload for one shop/day and store it (status=pending).
-- The egoal-export Edge Function picks up pending rows and sends them via egoal-gateway.
-- ---------------------------------------------------------------------
create or replace function build_egoal_export(p_shop_id uuid, p_date date)
returns egoal_exports
language plpgsql security definer set search_path = public as $$
declare
  v_payload jsonb;
  v_row egoal_exports%rowtype;
begin
  select jsonb_build_object(
    'shop', jsonb_build_object('code', sh.code, 'name', sh.name, 'trn', sh.trn),
    'egoal', jsonb_build_object(
        'concessionaire_code', sh.egoal_concessionaire_code, 'outlet_code', sh.egoal_outlet_code,
        'tenant_code', sh.egoal_tenant_code, 'mall_code', sh.egoal_mall_code),
    'business_date', p_date,
    'opening_cash', cs.opening_cash,
    'closing_cash', cs.closing_cash,
    'totals', (select jsonb_build_object(
        'sales_count', count(*), 'gross', coalesce(sum(gross_total),0),
        'net', coalesce(sum(net_total),0), 'vat', coalesce(sum(vat_total),0),
        'cash', coalesce(sum(gross_total) filter (where payment_method='cash'),0),
        'card', coalesce(sum(gross_total) filter (where payment_method='card'),0))
       from sales where session_id = cs.id),
    'sales', coalesce((select jsonb_agg(jsonb_build_object(
        'receipt_no', s.receipt_no, 'at', s.created_at, 'payment', s.payment_method,
        'gross', s.gross_total, 'net', s.net_total, 'vat', s.vat_total,
        'qty', (select coalesce(sum(si.qty),0) from sale_items si where si.sale_id = s.id),
        'items', (select jsonb_agg(jsonb_build_object(
            'item', si.item_name, 'code', si.variation_code, 'qty', si.qty,
            'unit_price', si.unit_price, 'gross', si.line_gross, 'net', si.line_net, 'vat', si.line_vat))
          from sale_items si where si.sale_id = s.id)) order by s.receipt_seq)
       from sales s where s.session_id = cs.id), '[]'::jsonb)
  ) into v_payload
  from shops sh
  left join cash_sessions cs on cs.shop_id = sh.id and cs.business_date = p_date
  where sh.id = p_shop_id;

  insert into egoal_exports (shop_id, business_date, payload)
  values (p_shop_id, p_date, v_payload)
  on conflict (shop_id, business_date) do update
    set payload = excluded.payload, status = 'pending'
  returning * into v_row;
  return v_row;
end $$;

-- Build exports for every active shop for a given date (default: yesterday UAE)
create or replace function build_all_egoal_exports(p_date date default uae_today() - 1)
returns setof egoal_exports language sql security definer set search_path = public as $$
  select e.* from shops s, lateral build_egoal_export(s.id, p_date) e where s.active;
$$;

-- ---------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------
alter table shops            enable row level security;
alter table profiles         enable row level security;
alter table profile_shops    enable row level security;
alter table items            enable row level security;
alter table cash_sessions    enable row level security;
alter table sales            enable row level security;
alter table sale_items       enable row level security;
alter table egoal_exports    enable row level security;
alter table receipt_counters enable row level security;

-- shops: everyone logged in can read; owner edits
drop policy if exists shops_read   on shops;
drop policy if exists shops_owner  on shops;
create policy shops_read  on shops for select to authenticated using (true);
create policy shops_owner on shops for all    to authenticated using (is_owner()) with check (is_owner());

-- profiles: see own row; owner sees/edits all
drop policy if exists profiles_self  on profiles;
drop policy if exists profiles_owner on profiles;
create policy profiles_self  on profiles for select to authenticated using (id = auth.uid());
create policy profiles_owner on profiles for all    to authenticated using (is_owner()) with check (is_owner());

drop policy if exists profile_shops_self  on profile_shops;
drop policy if exists profile_shops_owner on profile_shops;
create policy profile_shops_self  on profile_shops for select to authenticated using (profile_id = auth.uid());
create policy profile_shops_owner on profile_shops for all    to authenticated using (is_owner()) with check (is_owner());

-- items: everyone reads; owner manages
drop policy if exists items_read  on items;
drop policy if exists items_owner on items;
create policy items_read  on items for select to authenticated using (true);
create policy items_owner on items for all    to authenticated using (is_owner()) with check (is_owner());

-- cash_sessions: staff of that shop can read + open + close
drop policy if exists cs_select on cash_sessions;
drop policy if exists cs_insert on cash_sessions;
drop policy if exists cs_update on cash_sessions;
create policy cs_select on cash_sessions for select to authenticated using (can_access_shop(shop_id));
create policy cs_insert on cash_sessions for insert to authenticated
  with check (can_access_shop(shop_id) and opened_by = auth.uid() and business_date = uae_today());
create policy cs_update on cash_sessions for update to authenticated
  using (can_access_shop(shop_id)) with check (can_access_shop(shop_id));

-- sales / sale_items: read for shop staff. Writes ONLY through create_sale().
drop policy if exists sales_select on sales;
create policy sales_select on sales for select to authenticated using (can_access_shop(shop_id));

drop policy if exists sale_items_select on sale_items;
create policy sale_items_select on sale_items for select to authenticated
  using (exists (select 1 from sales s where s.id = sale_id and can_access_shop(s.shop_id)));

-- egoal_exports: owner only
drop policy if exists egoal_owner on egoal_exports;
create policy egoal_owner on egoal_exports for all to authenticated using (is_owner()) with check (is_owner());

-- receipt_counters: no direct access (only via create_sale which is security definer)

-- ---------------------------------------------------------------------
-- Grants (functions callable by logged-in users)
-- ---------------------------------------------------------------------
grant execute on function create_sale(uuid, uuid, payment_method, jsonb) to authenticated;
grant execute on function session_summary(uuid) to authenticated;
grant execute on function is_owner() to authenticated;
grant execute on function can_access_shop(uuid) to authenticated;
grant execute on function uae_today() to authenticated;
revoke execute on function build_egoal_export(uuid, date) from public, anon, authenticated;
revoke execute on function build_all_egoal_exports(date) from public, anon, authenticated;
grant  execute on function build_egoal_export(uuid, date) to service_role;
grant  execute on function build_all_egoal_exports(date) to service_role;


-- =====================================================================
-- Logging + API gateway clients
-- =====================================================================
-- event_logs: business/audit events (receipts generated/printed, day open/close,
--             eGoal export results, emails sent, logins, ...)
create table if not exists event_logs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  level       text not null default 'info' check (level in ('info', 'warn', 'error')),
  event       text not null,                  -- e.g. receipt.created, receipt.printed, day.closed, email.sent
  shop_id     uuid references shops(id),
  actor_id    uuid references profiles(id),
  ref         text,                           -- receipt_no / export id / outlet+date ...
  message     text,
  data        jsonb
);
create index if not exists event_logs_created_idx on event_logs(created_at desc);
create index if not exists event_logs_event_idx   on event_logs(event, created_at desc);
create index if not exists event_logs_ref_idx     on event_logs(ref);

-- api_logs: every HTTP request + response through the gateway, and every
-- outbound call (eGoal, email provider). Secrets are redacted before insert.
create table if not exists api_logs (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  correlation_id   uuid,                      -- ties an inbound gateway call to its outbound eGoal call
  direction        text not null check (direction in ('inbound', 'outbound')),
  service          text not null,             -- gateway.token | gateway.sales | egoal | email
  method           text,
  url              text,
  request_headers  jsonb,
  request_body     jsonb,
  response_status  int,
  response_body    jsonb,
  duration_ms      int,
  error            text,
  client_id        uuid,
  ref              text
);
create index if not exists api_logs_created_idx on api_logs(created_at desc);
create index if not exists api_logs_corr_idx    on api_logs(correlation_id);

-- api_clients: email + password logins for the eGoal gateway's /token endpoint.
-- Passwords are bcrypt-hashed (pgcrypto). Locked for 15 min after 5 bad attempts.
create table if not exists api_clients (
  id               uuid primary key default gen_random_uuid(),
  email            text not null unique,
  password_hash    text not null,
  active           boolean not null default true,
  failed_attempts  int not null default 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz not null default now()
);

create extension if not exists pgcrypto with schema extensions;

-- Create (or reset the password of) a gateway client. Run in the SQL editor:
--   select create_api_client('egoal-export@reshiehandicrafts.com', '<long random password>');
create or replace function create_api_client(p_email text, p_password text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if length(coalesce(p_password, '')) < 16 then raise exception 'password must be at least 16 characters'; end if;
  insert into api_clients (email, password_hash)
  values (lower(trim(p_email)), crypt(p_password, gen_salt('bf', 10)))
  on conflict (email) do update
    set password_hash = excluded.password_hash, active = true, failed_attempts = 0, locked_until = null
  returning id into v_id;
  return v_id;
end $$;

-- Returns the client id on success, null on bad credentials / locked / inactive.
create or replace function verify_api_client(p_email text, p_password text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_c api_clients%rowtype;
begin
  select * into v_c from api_clients where email = lower(trim(p_email)) for update;
  if not found or not v_c.active then return null; end if;
  if v_c.locked_until is not null and v_c.locked_until > now() then return null; end if;
  if v_c.password_hash = crypt(p_password, v_c.password_hash) then
    update api_clients set failed_attempts = 0, locked_until = null, last_login_at = now() where id = v_c.id;
    return v_c.id;
  end if;
  update api_clients
     set failed_attempts = failed_attempts + 1,
         locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' end
   where id = v_c.id;
  return null;
end $$;

-- Day opened / closed -> event_logs
create or replace function log_cash_session()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into event_logs (event, shop_id, actor_id, ref, message, data)
    values ('day.opened', new.shop_id, new.opened_by, new.business_date::text,
            'Day opened with ' || new.opening_cash || ' AED',
            jsonb_build_object('session_id', new.id, 'opening_cash', new.opening_cash));
  elsif old.closed_at is null and new.closed_at is not null then
    insert into event_logs (event, shop_id, actor_id, ref, message, data)
    values ('day.closed', new.shop_id, coalesce(new.closed_by, auth.uid()), new.business_date::text,
            'Day closed with ' || coalesce(new.closing_cash::text, '?') || ' AED',
            jsonb_build_object('session_id', new.id, 'opening_cash', new.opening_cash,
                               'closing_cash', new.closing_cash, 'note', new.closing_note));
  end if;
  return new;
end $$;

drop trigger if exists cash_session_log on cash_sessions;
create trigger cash_session_log after insert or update on cash_sessions
  for each row execute function log_cash_session();

alter table event_logs  enable row level security;
alter table api_logs    enable row level security;
alter table api_clients enable row level security;   -- no policies: service role only

-- event_logs: owner reads everything; staff may add their own client-side events
-- (receipt printed, login, ...) for shops they can access. Nobody edits/deletes logs.
drop policy if exists event_logs_owner_read on event_logs;
drop policy if exists event_logs_insert     on event_logs;
create policy event_logs_owner_read on event_logs for select to authenticated using (is_owner());
create policy event_logs_insert on event_logs for insert to authenticated
  with check (actor_id = auth.uid() and (shop_id is null or can_access_shop(shop_id)));

drop policy if exists api_logs_owner_read on api_logs;
create policy api_logs_owner_read on api_logs for select to authenticated using (is_owner());

revoke execute on function create_api_client(text, text) from public, anon, authenticated;
revoke execute on function verify_api_client(text, text) from public, anon, authenticated;
grant  execute on function verify_api_client(text, text) to service_role;

-- =====================================================================
-- eGoal: real-time, one upload per sale
-- Every confirmed sale is sent to eGoal on its own (one invoice per request, header totals = that
-- invoice). The till calls egoal-export with {sale_id} right after create_sale; a pg_cron job
-- re-runs egoal-export every 10 minutes to retry anything pending/failed (signal blips, eGoal down).
-- (egoal_exports above = the old once-a-night batch; kept for history, no longer written.)
-- =====================================================================
alter table sales add column if not exists egoal_status     text not null default 'pending'
  check (egoal_status in ('pending', 'sending', 'sent', 'failed', 'skipped'));
alter table sales add column if not exists egoal_attempts   int not null default 0;
alter table sales add column if not exists egoal_claimed_at timestamptz;
alter table sales add column if not exists egoal_sent_at    timestamptz;
alter table sales add column if not exists egoal_error      text;
create index if not exists sales_egoal_due_idx on sales(egoal_status, created_at)
  where egoal_status in ('pending', 'sending', 'failed');

-- Sales already uploaded by the old nightly batch must not be re-sent (safe to re-run).
update sales s set egoal_status = e.status::text, egoal_sent_at = e.sent_at, egoal_error = 'sent in nightly batch'
  from cash_sessions cs, egoal_exports e
 where s.egoal_status = 'pending' and cs.id = s.session_id
   and e.shop_id = s.shop_id and e.business_date = cs.business_date and e.status::text in ('sent', 'skipped');  -- ::text: enum value may be added in this same run

-- Atomically claim sales to send, so the till and the retry job never post the same sale twice.
--   p_sale_id given  → that one sale (if not already sent/skipped)
--   p_shop_id given  → every failed/pending sale of that shop (owner "Retry" button; ignores attempt cap)
--   neither          → retry job: pending older than 2 min, failed with < p_max_attempts tries,
--                      and 'sending' claims older than 5 min (a sender that crashed mid-way)
create or replace function claim_egoal_sales(
  p_sale_id uuid default null, p_shop_id uuid default null, p_max_attempts int default 10, p_limit int default 200
) returns setof sales
language sql security definer set search_path = public as $$
  update sales s set egoal_status = 'sending', egoal_claimed_at = now()
   where s.id in (
     select id from sales
      where case
              when p_sale_id is not null then id = p_sale_id
                   and (egoal_status in ('pending', 'failed')
                        or (egoal_status = 'sending' and egoal_claimed_at < now() - interval '5 minutes'))
              when p_shop_id is not null then shop_id = p_shop_id
                   and (egoal_status in ('pending', 'failed')
                        or (egoal_status = 'sending' and egoal_claimed_at < now() - interval '5 minutes'))
              else (egoal_status = 'pending' and created_at < now() - interval '2 minutes')
                or (egoal_status = 'failed' and egoal_attempts < p_max_attempts)
                or (egoal_status = 'sending' and egoal_claimed_at < now() - interval '5 minutes')
            end
      order by created_at
      limit p_limit
      for update skip locked)
  returning s.*;
$$;

-- Internal payload (same shape as build_egoal_export) holding just one sale.
create or replace function egoal_sale_payload(p_sale_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'shop', jsonb_build_object('code', sh.code, 'name', sh.name),
    'egoal', jsonb_build_object(
        'concessionaire_code', sh.egoal_concessionaire_code, 'outlet_code', sh.egoal_outlet_code,
        'tenant_code', sh.egoal_tenant_code, 'mall_code', sh.egoal_mall_code),
    'business_date', cs.business_date,
    'sales', jsonb_build_array(jsonb_build_object(
        'receipt_no', s.receipt_no, 'at', s.created_at, 'payment', s.payment_method,
        'gross', s.gross_total, 'net', s.net_total, 'vat', s.vat_total,
        'qty', (select coalesce(sum(si.qty), 0) from sale_items si where si.sale_id = s.id))))
  from sales s
  join shops sh on sh.id = s.shop_id
  join cash_sessions cs on cs.id = s.session_id
  where s.id = p_sale_id;
$$;

revoke execute on function claim_egoal_sales(uuid, uuid, int, int) from public, anon, authenticated;
revoke execute on function egoal_sale_payload(uuid) from public, anon, authenticated;
grant  execute on function claim_egoal_sales(uuid, uuid, int, int) to service_role;
grant  execute on function egoal_sale_payload(uuid) to service_role;

-- ---------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------
-- Shops = the three eGoal (Aldar) units, trading as Reshie Antiques & Gifts.
insert into shops (code, name, location, trn, address, phone) values
  ('RAK', 'Reshie Antiques & Gifts - Al Hamra Mall FF62', 'Al Hamra Mall, Ras Al Khaimah',      'TRN-PENDING', 'Unit FF62, Al Hamra Mall, Ras Al Khaimah, UAE',       '+971 50 626 3796'),
  ('AUH', 'Reshie Antiques & Gifts - WTC Souq G-085',     'World Trade Centre Souq, Abu Dhabi', 'TRN-PENDING', 'Unit G-085, World Trade Centre Souk, Abu Dhabi, UAE', '+971 50 626 3796'),
  ('AUH2','Reshie Antiques & Gifts - WTC Souq G-050',     'World Trade Centre Souq, Abu Dhabi', 'TRN-PENDING', 'Unit G-050, World Trade Centre Souk, Abu Dhabi, UAE', '+971 50 626 3796')
on conflict (code) do nothing;

-- If an older seed already ran: apply the current names/addresses, and retire Sharjah
-- (deactivated, not deleted, so any history stays intact; inactive shops are hidden + not exported).
update shops set name = 'Reshie Antiques & Gifts - Al Hamra Mall FF62', location = 'Al Hamra Mall, Ras Al Khaimah',
                 address = 'Unit FF62, Al Hamra Mall, Ras Al Khaimah, UAE' where code = 'RAK';
update shops set name = 'Reshie Antiques & Gifts - WTC Souq G-085', location = 'World Trade Centre Souq, Abu Dhabi',
                 address = 'Unit G-085, World Trade Centre Souk, Abu Dhabi, UAE' where code = 'AUH';
update shops set active = false where code = 'SHJ';

-- eGoal (Aldar) unit codes — issued by eGoal 2026-11. Not secret (the x-api-key is, and lives in
-- Supabase secrets).
update shops set egoal_concessionaire_code = 'ALDAR', egoal_outlet_code = 'FF62',
                 egoal_tenant_code = 't0005527', egoal_mall_code = 'alhamra'  where code = 'RAK';
update shops set egoal_concessionaire_code = 'ALDAR', egoal_outlet_code = 'G-085',
                 egoal_tenant_code = 't0001202', egoal_mall_code = 'cmsouk'   where code = 'AUH';
update shops set egoal_concessionaire_code = 'ALDAR', egoal_outlet_code = 'G-050',
                 egoal_tenant_code = 't0005525', egoal_mall_code = 'cmsouk'   where code = 'AUH2';

insert into items (name, category, sort_order) values
  ('Shawl',        'Textiles', 10),
  ('Pashmina',     'Textiles', 20),
  ('Shawl & Wrap', 'Textiles', 30),
  ('Kaftan',       'Clothing', 40),
  ('Carpet',       'Carpets',  50),
  ('Table Cover',  'Home',     60),
  ('Silk Stool',   'Home',     70),
  ('Souvenir',     'Gifts',    80)
on conflict (name) do nothing;

-- =====================================================================
-- AFTER RUNNING: make yourself the owner.
--   1. Supabase → Authentication → Users → "Add user" (email + password, auto-confirm).
--   2. Run:  update profiles set role = 'owner' where email = 'you@example.com';
-- Cashiers: add them as users in Supabase Auth, then assign shops in the
-- POS (Owner → Staff), or by SQL:
--   insert into profile_shops select p.id, s.id from profiles p, shops s
--    where p.email = 'cashier@example.com' and s.code = 'RAK';
-- =====================================================================
