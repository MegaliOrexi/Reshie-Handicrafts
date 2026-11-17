#!/usr/bin/env node
// Send historical / test sales to eGoal through OUR gateway (token → /sales).
// Uses the exact same mapping + validation as the nightly job (_shared/egoal.ts),
// and every call is logged in api_logs + emailed on failure by the gateway.
//
//   npm run egoal:send -- data.csv              # DRY RUN (default): validate + write bodies to ./egoal-out
//   npm run egoal:send -- data.csv --send       # actually POST (to whatever EGOAL_ENV the gateway has: uat)
//
// CSV columns (header row required; extra columns ignored):
//   unit        FF62 | G-085 | G-050                      (required)
//   date        YYYY-MM-DD (UAE business date)           (required)
//   gross       amount paid, VAT-inclusive, AED          (required)
//   time        HH:mm or HH:mm:ss                        (optional, default 12:00:00)
//   invoice_no  unique receipt no                        (optional, default TEST-<unit>-<date>-<n>)
//   payment     cash | card                              (optional, default cash)
//   qty         items on the invoice                     (optional, default 1)
//
// Credentials: GATEWAY_CLIENT_EMAIL / GATEWAY_CLIENT_PASSWORD from supabase/functions/.env,
// Supabase URL from pos/.env (VITE_SUPABASE_URL). Override with env vars of the same names.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toEgoalBody, validateEgoalBody } from '../supabase/functions/_shared/egoal.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// eGoal units (issued by eGoal; not secret)
const UNITS = {
  'FF62':  { concessionaire_code: 'ALDAR', outlet_code: 'FF62',  tenant_code: 't0005527', mall_code: 'alhamra' },
  'G-085': { concessionaire_code: 'ALDAR', outlet_code: 'G-085', tenant_code: 't0001202', mall_code: 'cmsouk' },
  'G-050': { concessionaire_code: 'ALDAR', outlet_code: 'G-050', tenant_code: 't0005525', mall_code: 'cmsouk' },
}

function loadEnv(file) {
  const out = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

function parseCsv(text) {
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((x) => x.trim() !== '')) rows.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x.trim() !== '')) rows.push(row)
  const [head, ...body] = rows
  const keys = head.map((h) => h.trim().toLowerCase())
  return body.map((r, i) => ({ _line: i + 2, ...Object.fromEntries(keys.map((k, j) => [k, (r[j] ?? '').trim()])) }))
}

// Same VAT split as create_sale(): net = round(gross / 1.05, 2), vat = gross − net
const fils = (n) => Math.round(Number(n) * 100)
function split(gross) {
  const g = fils(gross)
  const n = Math.round(g / 1.05)
  return { gross: g / 100, net: n / 100, vat: (g - n) / 100 }
}

const args = process.argv.slice(2)
const send = args.includes('--send')
const file = args.find((a) => !a.startsWith('--'))
if (!file) {
  console.error('usage: npm run egoal:send -- <data.csv> [--send]')
  process.exit(1)
}

// ---- parse + group ---------------------------------------------------
const errors = []
const groups = new Map() // "unit|date" -> sales[]
const todayUae = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10)
for (const r of parseCsv(readFileSync(file, 'utf8'))) {
  const unit = (r.unit || '').toUpperCase()
  if (!UNITS[unit]) { errors.push(`line ${r._line}: unknown unit "${r.unit}" (use ${Object.keys(UNITS).join(', ')})`); continue }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) { errors.push(`line ${r._line}: date must be YYYY-MM-DD`); continue }
  if (r.date > todayUae) { errors.push(`line ${r._line}: date ${r.date} is in the future`); continue }
  if (!(Number(r.gross) >= 0) || r.gross === '') { errors.push(`line ${r._line}: gross must be a number >= 0`); continue }
  let time = r.time || '12:00:00'
  if (/^\d{1,2}:\d{2}$/.test(time)) time += ':00'
  if (!/^([01]?\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) { errors.push(`line ${r._line}: time must be HH:mm[:ss]`); continue }
  time = time.padStart(8, '0')
  const payment = (r.payment || 'cash').toLowerCase()
  if (payment !== 'cash' && payment !== 'card') { errors.push(`line ${r._line}: payment must be cash or card`); continue }
  const key = `${unit}|${r.date}`
  if (!groups.has(key)) groups.set(key, [])
  const list = groups.get(key)
  list.push({
    receipt_no: r.invoice_no || `TEST-${unit}-${r.date}-${String(list.length + 1).padStart(3, '0')}`,
    at: `${r.date}T${time}+04:00`,
    payment,
    qty: Math.max(1, parseInt(r.qty || '1', 10) || 1),
    ...split(r.gross),
  })
}
if (errors.length) {
  console.error(`✗ ${errors.length} problem(s) in ${file}:\n  ` + errors.join('\n  '))
  process.exit(1)
}

// ---- build + validate (same code as production) ------------------------
const days = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, sales]) => {
  const [unit, date] = key.split('|')
  const body = toEgoalBody({ business_date: date, egoal: UNITS[unit], sales })
  return { unit, date, body, problems: validateEgoalBody(body) }
})
const bad = days.filter((d) => d.problems.length)
if (bad.length) {
  for (const d of bad) console.error(`✗ ${d.unit} ${d.date}: ${d.problems.join('; ')}`)
  process.exit(1)
}

const outDir = join(process.cwd(), 'egoal-out')
mkdirSync(outDir, { recursive: true })
for (const d of days) writeFileSync(join(outDir, `${d.unit}_${d.date}.json`), JSON.stringify(d.body, null, 2))
console.log(`✓ ${days.length} unit-day(s), ${days.reduce((t, d) => t + d.body.transaction_count, 0)} invoice(s) valid. Bodies written to ${outDir}`)
for (const d of days) console.log(`  ${d.unit.padEnd(6)} ${d.date}  ${String(d.body.transaction_count).padStart(3)} inv  gross ${d.body.gross_amount.toFixed(2)}`)

if (!send) {
  console.log('\nDRY RUN — nothing sent. Re-run with --send to post through the gateway.')
  process.exit(0)
}

// ---- send through our gateway -------------------------------------------
const env = { ...loadEnv(join(root, '.env')), ...loadEnv(join(root, 'supabase/functions/.env')), ...process.env }
const base = `${env.VITE_SUPABASE_URL || env.SUPABASE_URL}/functions/v1/egoal-gateway`
const tok = await fetch(`${base}/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.GATEWAY_CLIENT_EMAIL, password: env.GATEWAY_CLIENT_PASSWORD }),
})
const tj = await tok.json().catch(() => ({}))
if (!tok.ok || !tj.access_token) {
  console.error(`✗ token failed (HTTP ${tok.status}): ${tj.error ?? 'no token'} — is egoal-gateway deployed and create_api_client() run?`)
  process.exit(1)
}

let ok = 0
for (const d of days) {
  const res = await fetch(`${base}/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tj.access_token}` },
    body: JSON.stringify(d.body),
  })
  const j = await res.json().catch(() => ({}))
  if (res.ok && j.ok) {
    ok++
    console.log(`✓ ${d.unit} ${d.date} → ${(j.egoal_env || '?').toUpperCase()} HTTP ${j.egoal_status ?? '-'}${j.stub ? ' (STUB — nothing sent)' : ''}`)
  } else {
    console.error(`✗ ${d.unit} ${d.date} → HTTP ${res.status}: ${j.error ?? (j.errors || []).join('; ')} (correlation ${j.correlation_id})`)
  }
  await new Promise((r) => setTimeout(r, 300))
}
console.log(`\n${ok}/${days.length} unit-day(s) accepted.`)
process.exit(ok === days.length ? 0 : 1)
