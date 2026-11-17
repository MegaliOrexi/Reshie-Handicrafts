# Reshie POS

Point-of-sale app for the Reshie Antiques & Gifts shops: RAK = Al Hamra FF62, AUH = WTC Souq G-085, AUH2 = WTC Souq G-050.
Vite + React frontend, Supabase backend. See the root `CLAUDE.md` for the full design.

## 1. One-time Supabase setup (owner)

1. **Run the schema** — Supabase dashboard → *SQL Editor* → paste all of
   [`supabase/schema.sql`](supabase/schema.sql) → Run. Creates tables, Row-Level
   Security, the `create_sale` function, and seeds the 3 shops + 8 item types.
   Safe to re-run.
2. **Create your owner login** — *Authentication → Users → Add user*
   (email + password, tick "Auto Confirm"). Then in the SQL editor:
   ```sql
   update profiles set role = 'owner' where email = 'you@example.com';
   ```
3. **Add cashiers** the same way (Add user). Then log in to the POS as owner →
   **Staff** → tick which shop(s) each cashier may sell at.
4. **TRN numbers** — until you provide them, receipts print `TRN-PENDING`. Update with:
   ```sql
   update shops set trn = '100xxxxxxxxxxxx' where code = 'RAK';
   ```
   (Shop name / address / receipt footer can also be edited in the `shops` table.)

## 2. Run locally

```bash
cd pos
cp .env.example .env     # already filled in for this project
npm install
npm run dev              # http://localhost:5173
```

`.env` holds only the Supabase URL and the **publishable (anon)** key. Never put the
`service_role` key in this folder or in git.

## 3. Deploy (pos.reshiehandicrafts.com)

The marketing site and the POS are **separate** deployments from the same repo.

**Vercel:** New Project → import this repo → set **Root Directory = `pos`** →
framework Vite → add env vars `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` →
Deploy. Then add the domain `pos.reshiehandicrafts.com` (CNAME to Vercel).
`vercel.json` already rewrites all routes to `index.html` for the SPA router.

Also add `https://pos.reshiehandicrafts.com` to Supabase → *Authentication → URL
Configuration → Site URL / Redirect URLs*.

## 4. eGoal (real-time), emails, scheduled jobs, logs

All run as Supabase Edge Functions; the scheduled ones are triggered by `pg_cron`.

```
Till: sale confirmed ─▶ egoal-export {sale_id} ──(email+password)──▶ egoal-gateway /token ──▶ JWT
pg_cron every 10 min ─▶ egoal-export {}  (retry)  ──(Bearer JWT)───▶ egoal-gateway /sales ──(x-api-key)──▶ eGoal
Owner "Retry failed" ─▶ egoal-export {shop_id}           │ logs every request/response → api_logs
                                                         └ emails failed uploads → ALERT_EMAIL_TO (max 1/shop/hour)
pg_cron 00:00 UAE ─▶ daily-report {}              ── one email PER SHOP: yesterday's invoices (+ CSV)
pg_cron 00:05 UAE ─▶ daily-report {period:month}  ── on the 1st only: one email PER SHOP for last month (+ CSV)
pg_cron 01:00 UAE ─▶ nightly-backup               ── JSON dump of every table to Storage
```

**One upload per sale.** Each sale is posted to eGoal on its own (one invoice; header totals = that
invoice) the moment it is confirmed. Its result is stored on the sale (`sales.egoal_status`:
pending → sent / failed / skipped) and shown on *Today* and *Reports*. Anything that didn't get
through (signal blip, eGoal down) is retried every 10 minutes, up to 10 tries; after that the owner
presses **Retry failed** in Reports. A row lock (`claim_egoal_sales`) stops a sale being posted twice.

> ⚠ eGoal's docs don't say how several posts for the same unit + day are treated. **Check in UAT**
> that two sales on one day both show up in eGoal (not just the last one) before going live.

### 4.1 Deploy

```bash
npm i -g supabase            # Supabase CLI
supabase login
supabase link --project-ref ossziefzhpqktzosailc
supabase functions deploy egoal-gateway  --no-verify-jwt   # verifies OUR token itself
supabase functions deploy egoal-export   --no-verify-jwt   # checks the caller itself (till JWT / service key)
supabase functions deploy daily-report   --no-verify-jwt
supabase functions deploy nightly-backup --no-verify-jwt
```

Then:
1. *Storage* → create a **private** bucket named `backups`.
2. *Database → Extensions* → enable `pg_cron` and `pg_net`.
3. Edit [`supabase/cron.sql`](supabase/cron.sql): replace `<PROJECT_REF>` and
   `<SERVICE_ROLE_KEY>`, run it in the SQL editor.

### 4.2 Gateway login (email + password → bearer token)

Create the login the nightly job uses (SQL editor; password ≥ 16 chars, stored bcrypt-hashed):
```sql
select create_api_client('egoal-export@reshiehandicrafts.com', '<long random password>');
```
Calling the gateway yourself:
```bash
curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/egoal-gateway/token \
     -H "Content-Type: application/json" -d '{"email":"...","password":"..."}'
# → {"access_token":"eyJ…","token_type":"Bearer","expires_in":3600}
curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/egoal-gateway/sales \
     -H "Authorization: Bearer eyJ…" -H "Content-Type: application/json" -d @day.json
```
5 wrong passwords lock that login for 15 minutes.

### 4.3 Secrets

All Edge Function secrets are in **`supabase/functions/.env`** (git-ignored, already filled in
with the eGoal key, a generated `GATEWAY_JWT_SECRET` and gateway password). Upload them:
```bash
cd pos
supabase secrets set --env-file supabase/functions/.env
```
Then create the matching gateway login (SQL editor) — use the `GATEWAY_CLIENT_EMAIL` /
`GATEWAY_CLIENT_PASSWORD` values from that file:
```sql
select create_api_client('egoal-export@reshiehandicrafts.com', '<GATEWAY_CLIENT_PASSWORD>');
```
- **eGoal:** `EGOAL_ENV=uat` (connected to UAT only). Both URLs are built in
  ([`_shared/egoal.ts`](supabase/functions/_shared/egoal.ts)); going live is one line —
  `supabase secrets set EGOAL_ENV=live` — **only after eGoal signs off on UAT**.
  `EGOAL_ENV=stub` validates + logs without sending. The key is the same for UAT and LIVE.
- **Email (Resend, free 3,000/month):** sign up at resend.com, add the domain
  `reshiehandicrafts.com` and put the DNS records it shows in Vercel → Domains → DNS, then fill
  `RESEND_API_KEY` (and `EMAIL_FROM=Reshie POS <pos@reshiehandicrafts.com>`) and re-upload.
  Until the domain is verified, `onboarding@resend.dev` only delivers to the address the Resend
  account was registered with. Without `RESEND_API_KEY` emails are skipped (logged as `email.skipped`).

### 4.4 eGoal units

Implements Aldar's **Invoice-wise Sales API**. Units (codes seeded by `schema.sql`):

| POS shop | eGoal unit | Tenant code | Mall code |
|---|---|---|---|
| RAK  — Al Hamra Mall FF62 | FF62  | t0005527 | alhamra |
| AUH  — WTC Souq G-085     | G-085 | t0001202 | cmsouk |
| AUH2 — WTC Souq G-050     | G-050 | t0005525 | cmsouk |

Concessionaire code is `ALDAR` for all. Failed uploads are emailed (request + eGoal response
attached; at most one email per shop per day per hour) and retried every 10 minutes (max 10).
Re-send by hand: owner → Reports → **Retry failed**, or POST `{"shop_id":"<uuid>"}` /
`{"sale_id":"<uuid>"}` to `egoal-export` with the service-role key.

Reports by hand (service-role key, to `daily-report`): `{"date":"YYYY-MM-DD"}`,
`{"period":"month","month":"YYYY-MM"}`, optionally `"shop":"RAK"` for one shop.

### 4.4a Sending test / historical data (UAT sign-off: last 1 month)

eGoal asked for at least the last month of sales posted to UAT. Put it in a CSV
(template: [`scripts/egoal-test-data.example.csv`](scripts/egoal-test-data.example.csv)):
`unit,date,time,invoice_no,gross,payment,qty` — `unit` = FF62 / G-085 / G-050, `gross` is
VAT-inclusive; net/VAT are split exactly like the POS does.
```bash
cd pos
npm run egoal:send -- my-month.csv           # dry run: validates, writes bodies to egoal-out/
npm run egoal:send -- my-month.csv --send    # posts each unit-day via the gateway → UAT
```
It goes through `/token` → `/sales` like the nightly job, so every call is logged in
`api_logs` and failures are emailed. eGoal hasn't said how it handles a day posted twice —
don't re-send a day that was accepted unless they confirm it replaces.

### 4.5 What gets logged

| Table | What |
|---|---|
| `event_logs` | `receipt.created` (every receipt, from `create_sale`), `receipt.printed` / `receipt.reprinted` (QZ or browser), `day.opened` / `day.closed`, `auth.login` / `auth.logout`, `shop.selected`, `egoal.sale.sent/failed/skipped`, `egoal.failed`, `egoal.token_failed`, `gateway.login_failed`, `email.sent/failed/skipped`, `report.daily_sent`, `report.monthly_sent` |
| `api_logs` | every gateway request + response (`gateway.token`, `gateway.sales`), every outbound eGoal call, every email API call. `correlation_id` links a gateway call to its eGoal call. Passwords, tokens and API keys are redacted. |

Both are owner-read-only (RLS) and included in the nightly backup.
Backups land in Storage as `backups/YYYY/MM/DD.json` (every table, full dump).

## 5. Printing (QZ Tray)

1. Install **QZ Tray** (free, qz.io/download) on each shop PC and keep it running.
2. In the POS → **Printer** → pick the receipt printer, paper width, "Print test receipt".
3. First print shows QZ's "untrusted site" prompt → *Allow* (remember). This is the
   accepted trade-off for not buying a signing certificate.
4. If QZ Tray isn't running, the POS falls back to the browser's print dialog.

## 6. Daily flow for cashiers

1. Log in → pick shop.
2. **Open the day**: enter cash in drawer. Selling is locked until then.
3. **Sell**: item type → bargained price (VAT-inclusive) → variation code
   (letters only, typed fresh each time, no autocomplete) → qty → Add.
   Cash or Card → Confirm → receipt prints.
4. **Today** tab: list of today's receipts, reprint.
5. **Day Close**: enter counted cash; app shows expected vs counted and the variance.
   Closing locks further sales for that day.

Owner extras: **Reports** (per shop/day totals, variance, CSV export, eGoal export
status), **Items** (add/rename/hide item types), **Staff** (roles, shop assignment).

## Folder map

```
pos/
  src/
    lib/        supabase client, VAT maths, retry, printing, receipt HTML, auth context
    pages/      Login, ShopSelect, Sell, SalesHistory, DayClose, Items, Staff, Reports, Settings
    components/ Layout (nav), DayGate (open-the-day lock)
  supabase/
    schema.sql           tables + RLS + functions + seed  (run in SQL editor)
    cron.sql             pg_cron schedules (eGoal retry, daily + monthly report, backup)
    functions/_shared/         eGoal mapping + client, email (Resend), JWT, logging
    functions/egoal-gateway/   our API: /token (email+password → JWT), /sales (→ eGoal)
    functions/egoal-export/    sends each sale to eGoal via the gateway (till + 10-min retry)
    functions/daily-report/    daily (midnight) + monthly (1st) sales email, one per shop
    functions/nightly-backup/  nightly JSON dump to Storage
    functions/.env             Edge Function secrets (git-ignored)
  scripts/egoal-send.mjs       send test/historical CSV sales to eGoal via the gateway
```
