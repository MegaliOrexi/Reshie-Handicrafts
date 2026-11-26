#!/usr/bin/env node
// Bulk-send historical DAILY totals to eGoal as dummy invoices (for UAT sign-off).
//
// Input: a tenant sales report CSV with one row per day and only the day's NET sales:
//     Transaction_date,Net_Sales
//     2026-10-01T00:00:00,747.62
//
// For each day the script invents a few dummy invoices (times, cash/card, qty) whose
// trans_net_sales add up EXACTLY to that day's Net_Sales, adds 5% VAT, and builds one eGoal
// day body (its own transaction_date + transactions[]). All day bodies go into ONE JSON
// array and are sent in ONE API hit for the whole month (eGoal accepts an array of days).
// --per-day sends one hit per day instead.
//
// Dummy data is deterministic (seeded by unit + date), so re-running produces the same
// invoice numbers — eGoal rejects duplicate invoice_no, which protects against double sends.
//
//   npm run egoal:bulk -- "Tenant_Sales_Report OCT HAMRA MALL.csv"                 # DRY RUN: build + validate + write JSON
//   npm run egoal:bulk -- "Tenant_Sales_Report OCT HAMRA MALL.csv" --day 2026-10-01 --send   # send ONE day first (test)
//   npm run egoal:bulk -- "Tenant_Sales_Report OCT HAMRA MALL.csv" --send          # send the whole month in ONE hit
//
// Options:
//   --unit FF62|G-085|G-050   eGoal unit (default FF62 = Al Hamra Mall)
//   --day YYYY-MM-DD          only this day
//   --send                    actually POST (default is dry run)
//   --direct                  POST straight to eGoal UAT with EGOAL_API_KEY instead of via our egoal-gateway
//   --live                    with --direct: use the LIVE url (only after eGoal sign-off!)
//   --per-day                 one API hit per day instead of one hit for the whole array

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toEgoalBody, validateEgoalBody, EGOAL_URLS } from '../supabase/functions/_shared/egoal.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const UNITS = {
  'FF62':  { concessionaire_code: 'ALDAR', outlet_code: 'FF62',  tenant_code: 't0005527', mall_code: 'alhamra' },
  'G-085': { concessionaire_code: 'ALDAR', outlet_code: 'G-085', tenant_code: 't0001202', mall_code: 'cmsouk' },
  'G-050': { concessionaire_code: 'ALDAR', outlet_code: 'G-050', tenant_code: 't0005525', mall_code: 'cmsouk' },
}

// ---- args ----------------------------------------------------------------
// PowerShell strips the `--` in `npm run x -- --send`, so npm swallows the flags as its own
// config and exposes them as npm_config_<name> env vars. Accept both forms.
const args = process.argv.slice(2)
const npmFlag = (name) => { const v = process.env[`npm_config_${name.replace(/-/g, '_')}`]; return v !== undefined && v !== '' && v !== 'false' ? v : undefined }
const flag = (name) => args.includes(`--${name}`) || npmFlag(name) !== undefined
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : npmFlag(name) }
const send = flag('send')
const direct = flag('direct')
const live = flag('live')
const perDay = flag('per-day')
const unit = (opt('unit') || 'FF62').toUpperCase()
const onlyDay = opt('day')
const valued = new Set([opt('unit'), opt('day')])
const file = args.find((a) => !a.startsWith('--') && !valued.has(a))
if (!file) { console.error('usage: npm run egoal:bulk -- <report.csv> [--unit FF62] [--day YYYY-MM-DD] [--send] [--direct]'); process.exit(1) }
if (!UNITS[unit]) { console.error(`unknown unit ${unit} (use ${Object.keys(UNITS).join(', ')})`); process.exit(1) }

// ---- helpers ---------------------------------------------------------------
function loadEnv(f) {
  const out = {}
  if (!existsSync(f)) return out
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

// Small seeded PRNG (mulberry32) so dummy data is reproducible.
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 3432918353), h = (h << 13) | (h >>> 19)
  let a = h >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))

/** Split a day's NET (in fils) into dummy invoices; their nets sum exactly to the input. */
function dummyInvoices(date, netFils) {
  const r = rng(`${unit}|${date}`)
  const MIN = 2000 // at least 20.00 AED net per invoice
  let n = Math.max(1, Math.min(8, Math.round(netFils / 25000) + randInt(r, -1, 1)))
  n = Math.max(1, Math.min(n, Math.floor(netFils / MIN) || 1))

  // random weights → allocate fils above the minimum, last one takes the remainder
  const weights = Array.from({ length: n }, () => 0.3 + r())
  const wsum = weights.reduce((a, b) => a + b, 0)
  const spare = netFils - MIN * n
  const nets = weights.map((w) => (n === 1 ? netFils : MIN + Math.floor((spare * w) / wsum)))
  nets[n - 1] += netFils - nets.reduce((a, b) => a + b, 0)

  // spread times between 10:00 and 22:00, sorted
  const secs = Array.from({ length: n }, () => randInt(r, 10 * 3600, 22 * 3600 - 1)).sort((a, b) => a - b)
  const hms = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, '0')).join(':')
  const ymd = date.replaceAll('-', '')

  return nets.map((net, i) => {
    const vat = Math.round(net * 0.05)
    return {
      receipt_no: `${unit}-${ymd}-${String(i + 1).padStart(2, '0')}`,
      at: `${date}T${hms(secs[i])}+04:00`,
      payment: r() < 0.55 ? 'card' : 'cash',
      qty: randInt(r, 1, 3),
      net: net / 100,
      vat: vat / 100,
      gross: (net + vat) / 100,
    }
  })
}

// ---- parse CSV ---------------------------------------------------------------
const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
const head = lines.shift().split(',').map((h) => h.trim().toLowerCase())
const iDate = head.indexOf('transaction_date'), iNet = head.indexOf('net_sales')
if (iDate < 0 || iNet < 0) { console.error('CSV needs columns Transaction_date,Net_Sales'); process.exit(1) }

const todayUae = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10)
const errors = [], skipped = [], days = []
lines.forEach((line, k) => {
  const cols = line.split(',')
  const date = (cols[iDate] || '').trim().slice(0, 10)
  const netFils = Math.round(Number((cols[iNet] || '').trim()) * 100)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errors.push(`line ${k + 2}: bad date "${cols[iDate]}"`)
  if (!Number.isFinite(netFils) || netFils < 0) return errors.push(`line ${k + 2}: bad Net_Sales "${cols[iNet]}"`)
  if (date > todayUae) return errors.push(`line ${k + 2}: ${date} is in the future`)
  if (onlyDay && date !== onlyDay) return
  if (netFils === 0) return skipped.push(date)
  const body = toEgoalBody({ business_date: date, egoal: UNITS[unit], sales: dummyInvoices(date, netFils) })
  const problems = validateEgoalBody(body)
  if (Math.round(body.net_sales * 100) !== netFils) problems.push(`net ${body.net_sales} != CSV ${netFils / 100}`)
  days.push({ date, body, problems })
})
if (errors.length) { console.error(`✗ ${errors.length} problem(s):\n  ${errors.join('\n  ')}`); process.exit(1) }
if (!days.length) { console.error('nothing to send (check --day)'); process.exit(1) }
const bad = days.filter((d) => d.problems.length)
if (bad.length) { for (const d of bad) console.error(`✗ ${d.date}: ${d.problems.join('; ')}`); process.exit(1) }

// ---- write bodies ------------------------------------------------------------
const outDir = join(process.cwd(), 'egoal-out', 'bulk')
mkdirSync(outDir, { recursive: true })
for (const d of days) writeFileSync(join(outDir, `${unit}_${d.date}.json`), JSON.stringify(d.body, null, 2))
const tag = onlyDay || `${days[0].date}_to_${days.at(-1).date}`
writeFileSync(join(outDir, `${unit}_${tag}_ALL.json`), JSON.stringify(days.map((d) => d.body), null, 2))

const tot = (k) => days.reduce((t, d) => t + Math.round(d.body[k] * 100), 0) / 100
console.log(`✓ ${unit}: ${days.length} day(s), ${days.reduce((t, d) => t + d.body.transaction_count, 0)} dummy invoice(s) — all valid`)
for (const d of days) console.log(`  ${d.date}  ${String(d.body.transaction_count).padStart(2)} inv   net ${d.body.net_sales.toFixed(2).padStart(9)}   vat ${d.body.tax_amount.toFixed(2).padStart(7)}   gross ${d.body.gross_amount.toFixed(2).padStart(9)}`)
console.log(`  TOTAL         net ${tot('net_sales').toFixed(2).padStart(9)}   vat ${tot('tax_amount').toFixed(2).padStart(7)}   gross ${tot('gross_amount').toFixed(2).padStart(9)}`)
if (skipped.length) console.log(`  (skipped zero-sales days: ${skipped.join(', ')})`)
console.log(`Bodies written to ${outDir}`)

if (!send) { console.log('\nDRY RUN — nothing sent. Add --send (try --day <date> first).'); process.exit(0) }

// ---- send ------------------------------------------------------------------
const env = { ...loadEnv(join(root, '.env')), ...loadEnv(join(root, 'supabase/functions/.env')), ...process.env }
let post
if (direct) {
  const url = live ? EGOAL_URLS.live : EGOAL_URLS.uat
  if (!env.EGOAL_API_KEY) { console.error('✗ EGOAL_API_KEY missing (supabase/functions/.env)'); process.exit(1) }
  console.log(`\nSending DIRECT to eGoal ${live ? 'LIVE' : 'UAT'}: ${url}`)
  post = async (body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.EGOAL_API_KEY }, body: JSON.stringify(body) })
    const text = await res.text()
    return { ok: res.ok, info: `HTTP ${res.status} ${text.slice(0, 300)}` }
  }
} else {
  const base = `${env.VITE_SUPABASE_URL || env.SUPABASE_URL}/functions/v1/egoal-gateway`
  const tok = await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.GATEWAY_CLIENT_EMAIL, password: env.GATEWAY_CLIENT_PASSWORD }),
  })
  const tj = await tok.json().catch(() => ({}))
  if (!tok.ok || !tj.access_token) { console.error(`✗ gateway token failed (HTTP ${tok.status}): ${tj.error ?? 'no token'} — try --direct`); process.exit(1) }
  console.log(`\nSending via egoal-gateway (${base})`)
  post = async (body) => {
    const res = await fetch(`${base}/sales`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tj.access_token}` }, body: JSON.stringify(body) })
    const j = await res.json().catch(() => ({}))
    return { ok: res.ok && j.ok, info: `${(j.egoal_env || '?').toUpperCase()} HTTP ${j.egoal_status ?? res.status}${j.stub ? ' (STUB — nothing sent)' : ''} ${j.error ?? (j.errors || []).join('; ')}` }
  }
}

if (!perDay) {
  const all = days.map((d) => d.body)
  const inv = all.reduce((t, b) => t + b.transaction_count, 0)
  try {
    const r = await post(all)
    console.log(`${r.ok ? '✓' : '✗'} ONE hit: ${all.length} day(s), ${inv} inv, gross ${tot('gross_amount').toFixed(2)} → ${r.info}`)
    process.exit(r.ok ? 0 : 1)
  } catch (e) {
    console.log(`✗ ONE hit → ${e.message}`)
    process.exit(1)
  }
}

let ok = 0
for (const d of days) {
  try {
    const r = await post(d.body)
    if (r.ok) ok++
    console.log(`${r.ok ? '✓' : '✗'} ${d.date} (${d.body.transaction_count} inv, gross ${d.body.gross_amount.toFixed(2)}) → ${r.info}`)
  } catch (e) {
    console.log(`✗ ${d.date} → ${e.message}`)
  }
  await new Promise((r) => setTimeout(r, 400))
}
console.log(`\n${ok}/${days.length} day(s) accepted.`)
process.exit(ok === days.length ? 0 : 1)
