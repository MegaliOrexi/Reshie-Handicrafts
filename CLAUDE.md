# CLAUDE.md — Reshie Handicrafts

Guidance for Claude Code (and humans) working in this repo. Read this first.

---

## 1. What this repo contains

Two distinct things that share one brand and (eventually) one domain:

1. **Public marketing site** — *already built, do not break it.*
   - Plain static **HTML / CSS / JS**. No build step, no framework, no backend.
   - Files: [index.html](index.html), [css/style.css](css/style.css), [js/main.js](js/main.js), [images/](images/).
   - Contact form uses **EmailJS** (client-side only).
   - Currently deployed on **Vercel** (git history also shows an older GitHub Pages setup + custom domain).

2. **POS Terminal** — *v1 built* in [pos/](pos/) (see [pos/README.md](pos/README.md) for setup/deploy).
   - A point-of-sale app for staff in the physical shops.
   - A separate, login-protected app. **Not** part of the static marketing site.

> The marketing site stays exactly as it is. The POS is bolted on as a separate app under the same brand/domain (planned at `pos.reshiehandicrafts.com`). We never risk the working public site to build the POS.

---

## 2. POS — what it does (business flow)

1. **Login** — staff authenticate.
2. **Shop selection** — choose one of the three shops (see §6).
3. **Open the day** — staff must enter the day's **opening cash holdings** before anything else. Selling stays **locked** until this "cash session" exists for that shop + date. A **business day runs 06:00 → 05:59 UAE** (`uae_today()`), so late weekend sales after midnight stay on the evening's day. If an earlier day was never closed, the till shows **its close screen first**; a DB trigger blocks opening a new day until every earlier day is closed.
4. **Sell** — for each line item the cashier:
   - picks an **item type** (Shawl, Kaftan, Carpet, …),
   - types the **bargained price** (final amount, **VAT included** — there are no fixed prices, everything is negotiated),
   - types a **variation code** (letters only) — a private internal tag identifying *which* specific variation was sold (there are thousands of variations),
   - sets **quantity**.
5. **Pay** — choose **Cash** or **Card**, confirm.
6. **Receipt** — generate receipt with VAT breakdown + shop details, print it (see §8).
7. **Store** — every sale is written to the database (per shop, per session).
8. **Day close** — totals + cash reconciliation.
9. **eGoal** — every sale is sent to the "eGoal" platform the moment it's confirmed (see §9).
10. **Emails** — eGoal failure alerts; daily sales email per shop at midnight; monthly email per shop on the 1st.

---

## 3. Architecture

```
reshiehandicrafts.com         →  static marketing site (unchanged)
pos.reshiehandicrafts.com     →  POS app (Vite + React static build)
                                    │  reads config from .env (Supabase URL + anon key)
                                    ▼
                               Supabase
                                 - Postgres (Row-Level Security by shop + role)
                                 - Auth (owner / cashier)
                                 - Storage (future: backups, Excel import)
                                 - Edge Function + cron (nightly eGoal export + backup)
                                    │
                                    ▼
                               egoal-gateway (our token API, logs, failure emails) → eGoal (Aldar)
```

**Supabase is the backend (database/auth/functions). The frontend host is separate** — these are two different things. The frontend is a static bundle; it can live on Vercel, Cloudflare Pages, or GitHub Pages.

---

## 4. Tech stack

- **Frontend:** Vite + React, compiled to static files. Lives in [pos/](pos/).
- **Supabase JS client** for auth + data.
- **Backend:** Supabase (Postgres + Auth + RLS + Storage + Edge Functions).
- **Printing:** QZ Tray (unsigned/free) with a browser-print fallback.
- **Config:** Supabase URL + anon key come from a `.env` file (never hard-coded). The `service_role`/secret key must **never** appear in frontend code or git.

### 3G-friendly, online-only (for now)
Offline mode is **explicitly out of scope** for v1 (may revisit later). Internet is assumed available but **slow (~3G)**, so:
- keep the item list cached client-side so selection is instant,
- keep write payloads small,
- add a **simple retry** on sale submit so a signal blip doesn't lose a sale (this is light resilience, *not* a full offline store).

---

## 5. Decisions log (with rationale — don't re-litigate without reason)

| Decision | Choice | Why |
|---|---|---|
| Where the POS lives | Separate login-protected app, same domain | Marketing site is static and can't host a POS; keep them decoupled |
| Backend | **Supabase** (free tier to start) | Postgres fits relational sales data; auth + RLS + storage built in; free tier never pauses with daily use |
| Frontend host | **Vercel for now** | User keeps Vercel until they "go commercial" (aware Vercel Hobby is technically non-commercial; Pro is $20/mo). Can move to Cloudflare/GitHub Pages (free, commercial-OK) later |
| Backups | **DIY free nightly export** first | Supabase free tier has no backups. Avoid the $25/mo Pro plan until the user decides backups are worth it |
| Offline | **Dropped for v1** | User will ensure stable (if slow) internet; revisit later |
| Printing | **QZ Tray unsigned (free)** | Silent-ish thermal printing; user accepts the occasional trust pop-up to avoid paying for a signing cert |
| Prices | **No fixed prices; bargained per sale; VAT-inclusive** | Business runs on bargaining |
| Variation code | **Letters-only, typed fresh each sale, NO autocomplete** | Many codes are very similar — autocomplete would cause wrong selections |
| Items | Simple list of **types** (Shawl, Kaftan, Carpet, …), owner-managed, **no price stored** | Pricing is per-sale/bargained |
| Roles | **Owner + cashier**, enforced via RLS | Owner manages items/sees all shops/reports/closes day; cashier sells only at assigned shop |
| Manager role (2026-11-22) | **Manager** = cashier + add/hide items + view/print Reports, assigned shop(s) only | Shop lead without full owner access. Items list is shared by all shops. eGoal "Retry failed" stays owner-only |
| Line details (2026-11-22) | Optional free-text `sale_items.note` (≤120 chars, e.g. "stoned") | Shown on receipt, Today list, CSV, daily email. Not sent to eGoal (eGoal takes invoice totals only) |
| Business day | **06:00 → 05:59 UAE; close previous day before opening a new one** | Shops trade past midnight on weekends; no auto-close (user, 2026-11-26) |
| Excel import | **Deferred** | v1 seeds/manages a simple item list directly; bulk Excel import can come later |

### Cost summary
- **$0/month is realistic for a long time.** Supabase free tier (500 MB DB holds years of these small sale rows; won't pause because the shops use it daily) + free static hosting.
- Vercel Hobby is technically **non-commercial**; Vercel Pro is **$20/mo**. The free, commercial-OK alternatives are **Cloudflare Pages** or **GitHub Pages**.
- The only cost worth budgeting later: **Supabase Pro ($25/mo)** for automatic daily backups — deferred by the DIY nightly export.

---

## 6. The shops (= the three eGoal / Aldar units)

- **RAK** — Al Hamra Mall, Ras Al Khaimah — unit **FF62** (eGoal mall `alhamra`)
- **AUH** — World Trade Centre Souq, Abu Dhabi — unit **G-085** (eGoal mall `cmsouk`)
- **AUH2** — World Trade Centre Souq, Abu Dhabi — unit **G-050** (eGoal mall `cmsouk`)

WTC is two eGoal units → two POS shops, each with its own day/cash/receipts. **Sharjah (Central Souq) was removed from the POS** on 2026-11-17 (deactivated in `schema.sql`, not deleted). The marketing site's shop list is unchanged.

Business name on receipts is per shop (`shops.legal_name`): **RAK = Reshie Nov. & Gifts LLC**; AUH/AUH2 = **Reshie Antiques & Gifts**. The legal name is the receipt title (no "Reshie Handicrafts" brand line), followed by one address line (`shops.address`, falling back to `location`).
Contact: reshiehandicrafts@gmail.com · +971 50 626 3796 · @reshiehandicrafts

---

## 7. Data model (v1, Postgres / Supabase)

- **`shops`** — RAK, AUH, AUH2 (code, name, location, TRN, `egoal_*` codes).
- **`profiles`** — users, linked to Supabase Auth; `role` = `owner` | `manager` | `cashier`; assigned shop(s).
- **`items`** — product *types*. Fields: name, category, active. **No price.**
- **`cash_sessions`** — one per shop per business date. opening_cash, opened_by, opened_at, closing_cash, closed_at. **The gate that unlocks selling.**
- **`sales`** — shop_id, session_id, cashier_id, receipt_no, payment_method (`cash` | `card`), gross_total, net_total, vat_total, created_at.
- **`sale_items`** — sale_id, item_id, **variation_code** (letters only), optional **note** (free text), qty, unit_price (gross/VAT-incl), line_gross, line_net, line_vat.
- **`egoal_exports`** — one row per shop per day: payload, status, sent_at (audit trail).
- **`event_logs`** / **`api_logs`** — audit events and HTTP request/response logs (owner-read-only).
- **`api_clients`** — email + bcrypt password logins for the gateway's `/token` endpoint.

**Row-Level Security:** cashiers can only read/write rows for their assigned shop; owners can access all shops. Enforced in the DB, not just the UI.

---

## 8. VAT & receipts

Prices entered are **VAT-inclusive (UAE 5%)**. For each line and the order total, compute and show:
- **Net** = gross ÷ 1.05
- **VAT 5%** = gross − net
- **Total** = gross (what the customer pays)

Receipt must show: business name, shop name + location, **TRN** (per shop — to be provided; placeholder until then), date/time, receipt number, cashier, each line (item + variation code + qty + price), the net / VAT / total breakdown, and cash-or-card.

**Printing:** build the receipt as HTML, print via **QZ Tray** (unsigned/free; occasional trust pop-up is acceptable). Fall back to the browser print dialog if QZ Tray isn't running.

---

## 9. eGoal integration

eGoal is **Aldar's mall sales-reporting platform** (a tenant lease obligation). API: `POST .../v2api/api[/uat]/salestransactioninvoice` with header totals + invoices (`x-api-key` auth). **We post ONE SALE PER REQUEST, in real time** (user decision 2026-11-17): the till calls `egoal-export {sale_id}` after `create_sale`; status lives on `sales.egoal_status`; pg_cron retries every 10 min (max 10; any business date, not just today); owner can "Retry failed" in Reports. `claim_egoal_sales` row-locks to prevent double posting. eGoal docs don't define repeat posts for the same unit+day — verify in UAT. (`egoal_exports` = old nightly batch, kept for history.) Header totals must equal the invoice sums exactly (adapter sums in fils). Shops without eGoal codes in `shops.egoal_*` are marked `skipped`. Mapping + HTTP client live only in `pos/supabase/functions/_shared/egoal.ts`. **eGoal credentials live in Supabase secrets, never in the frontend.** **Per-shop go-live:** `EGOAL_ENV` is the default; outlets in `EGOAL_LIVE_OUTLETS` go LIVE (currently `FF62` = RAK, since 2026-11-28; AUH/AUH2 still UAT). Test tools (`egoal:bulk`, `egoal:send`) send `X-Egoal-Env: uat` so test data can't reach LIVE (`egoal:bulk --live` overrides).

Flow: `egoal-export` (cron) → our **`egoal-gateway`** (`/token`: email+password from `api_clients` → our HS256 JWT; `/sales`: Bearer JWT → validates → eGoal). Every gateway request/response and every outbound call is logged in **`api_logs`** (secrets redacted); business events (receipt created/printed, day open/close, logins, exports, emails) go to **`event_logs`**.

**Emails** (Resend, `_shared/email.ts`) go to `ALERT_EMAIL_TO` (default reshiehandicrafts@gmail.com): till uploads alert once when the **same invoice fails 3 times** and once more when it hits 10 and retries stop (egoal-export sends `X-Alert: off` so the gateway doesn't email each failure; other gateway callers still get per-failure emails, de-duped 1/shop/day/hour); `daily-report` at **06:00 UAE** (after the business day ends) — **one email per shop** with every invoice of the day; and on the **1st at 06:05 UAE** — one email per shop for the previous month.

**Reports are per shop**: the Reports page shows only the shop selected at login (RLS also scopes cashiers to their shops).

---

## 10. Build order (v1)

1. **Foundations** — Supabase project, schema + RLS SQL, seed the 3 shops, scaffold the Vite+React app, create first owner login.
2. **Auth + shop selection.**
3. **Open-the-day gate** (opening cash).
4. **Item list** (seed Shawl/Kaftan/Carpet/Pashmina/Shawl & Wrap/Table Cover/Silk Stool/Souvenir; owner can edit).
5. **Selling + receipt** (cart, bargained price, letters-only code, cash/card, VAT breakdown, QZ print).
6. **Store sales** + light 3G retry.
7. **Day close + daily totals/reports.**
8. **eGoal adapter stub** + **free nightly backup export.**

---

## 11. Open items / waiting on the user

- [x] **Supabase Project URL + anon (publishable) key** — received 2026-11-14, wired in `pos/.env` (git-ignored).
- [ ] **Run `pos/supabase/schema.sql`** in the Supabase SQL editor, create the owner user, set role = owner (see pos/README.md §1).
- [ ] **Deploy** POS to Vercel (Root Directory = `pos`) + subdomain `pos.reshienoveltiesandgifts.com` (DNS at Namecheap). **Note:** the live domain is `reshienoveltiesandgifts.com` (GitHub Pages); `reshiehandicrafts.com` does not resolve.
- [x] **Scheduled jobs** — done 2026-11-26, fixed 2026-11-28 (placeholders had never been filled; jobs now auth with `X-Cron-Secret` = Vault `cron_secret` = `CRON_SECRET` secret, via `cron_call()`): pg_cron + pg_net enabled, `backups` bucket created, `cron.sql` run (egoal-export every 10 min, nightly-backup, daily-report, monthly-report).
- [x] **TRN** — received 2026-11-22: `100304794900003` (one company TRN, all shops; set in `schema.sql`).
- [ ] **OK on the receipt header** (drafted from the site; user to tweak).
- [ ] **QZ Tray install** on a test shop PC + the **printer's name** (to test real printing).
- [x] **eGoal API docs** — received 2026-11-15 (Aldar invoice-wise sales API: https://aldar.egoalprime.com/apidocsv3/option2.html). Implemented in `pos/supabase/functions/_shared/egoal.ts`.
- [x] **Email** (done 2026-11-26): Resend account + verified `reshienoveltiesandgifts.com` DNS (Namecheap); set `RESEND_API_KEY` / `EMAIL_FROM`. Alert address confirmed 2026-11-26: `reshiehandicrafts@gmail.com` (old misspelling `reshiehandcrafts@` removed from POS).
- [ ] **Gateway**: `supabase secrets set --env-file supabase/functions/.env` + `select create_api_client(...)` with the password from that file.
- [x] **eGoal credentials** — received 2026-11-17. Key in `pos/supabase/functions/.env` (git-ignored); unit codes seeded in `schema.sql`. **`EGOAL_ENV=uat` — UAT only until eGoal signs off.**
- [x] **UAT data**: October sent for FF62, G-050, G-085 (`egoal:bulk`); FF62 verified against eGoal's UAT export (73/73 invoices, 0 diffs).
- [x] **RAK live** 2026-11-28: test data cleared (`pos/supabase/go-live-rak.sql`, backup `backups/2026/11/28.json`), `EGOAL_LIVE_OUTLETS=FF62`.
- [ ] **AUH / AUH2 live** later: clear their test data the same way, add `G-085,G-050` to `EGOAL_LIVE_OUTLETS`.
- [x] **Printing** — working via **RawBT** (Android) on test devices (`pos/src/lib/print.js`); QZ Tray remains the desktop option.

---

## 12. Conventions / guardrails

- **Never touch the static marketing site's behavior** while building the POS. They are independent.
- **No secrets in git or frontend.** Only the Supabase URL + anon key go in the frontend (`.env`). `service_role`/secret key and eGoal credentials stay in Supabase secrets.
- **Enforce roles in the database (RLS)**, not just in the UI.
- Keep the POS **lightweight for 3G**: small payloads, cached item list, retry-on-submit.
- Variation codes: **letters only, no autocomplete.**
- Prices are **VAT-inclusive**; always show the net / VAT / total breakdown.
