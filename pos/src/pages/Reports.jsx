import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { fmt, round2 } from '../lib/vat'
import { EgoalBadge } from './SalesHistory'
import { shopLabel } from '../lib/shop'

// Business day runs 06:00 → 05:59 UAE (UTC+4, no DST) — same as the server's uae_today().
const daysAgo = (n) => new Date(Date.now() + (4 - 6) * 3600_000 - n * 86400_000).toISOString().slice(0, 10)
const todayUAE = () => daysAgo(0)
// First day of the month, n months back (UAE business date)
const monthStart = (n = 0) => {
  const [y, m] = todayUAE().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 10)
}
// CSV time column in UAE local time, e.g. 2026-11-28 19:22:05
const uaeStamp = (iso) => new Date(new Date(iso).getTime() + 4 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')

// Supabase returns at most 1000 rows per request — page through so long ranges (e.g. 3 months) are complete.
const fetchAll = async (build) => {
  const out = []
  for (let i = 0; ; i += 1000) {
    const { data, error } = await build().range(i, i + 999)
    if (error) return { data: null, error }
    out.push(...data)
    if (data.length < 1000) return { data: out, error: null }
  }
}

// Every sale (with its lines) for one shop + business-date range, oldest first.
const fetchSaleLines = (shopId, from, to) => fetchAll(() => supabase.from('sales')
  .select('id, receipt_no, created_at, payment_method, gross_total, net_total, vat_total, shops(code), profiles:cashier_id(email), sale_items(item_name, variation_code, note, qty, unit_price, line_gross, line_net, line_vat), cash_sessions!inner(business_date)')
  .eq('shop_id', shopId)
  .gte('cash_sessions.business_date', from).lte('cash_sessions.business_date', to)
  .order('created_at').order('id'))

const downloadCsv = (data, shop, from, to, tag = '') => {
  const head = ['business_date', 'shop', 'receipt_no', 'time_uae', 'cashier', 'payment', 'item', 'code', 'note', 'qty', 'unit_price', 'line_gross', 'line_net', 'line_vat']
  const lines = [head.join(',')]
  for (const s of data) for (const li of s.sale_items) {
    lines.push([s.cash_sessions.business_date, s.shops.code, s.receipt_no, uaeStamp(s.created_at), s.profiles?.email || '', s.payment_method,
      JSON.stringify(li.item_name), li.variation_code, JSON.stringify(li.note || ''), li.qty, li.unit_price, li.line_gross, li.line_net, li.line_vat].join(','))
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `reshie-${shop.code}-sales${tag}-${from}-to-${to}.csv`; a.click()
}

const sumSales = (list) => list.reduce((a, s) => {
  const g = Number(s.gross_total)
  a.count++; a.gross = round2(a.gross + g); a.net = round2(a.net + Number(s.net_total)); a.vat = round2(a.vat + Number(s.vat_total))
  if (s.payment_method === 'cash') a.cash = round2(a.cash + g); else a.card = round2(a.card + g)
  return a
}, { count: 0, gross: 0, net: 0, vat: 0, cash: 0, card: 0 })

const PAY_LABEL = { all: 'Cash + card', cash: 'Cash only', card: 'Card only' }

// Reports (all roles): every sale for the shop selected at login, grouped by business day,
// filterable by date range and cash/card. RLS scopes cashiers/managers to their own shop(s).
export default function Reports() {
  const { shop } = useAuth()
  const [from, setFrom] = useState(daysAgo(6))
  const [to, setTo] = useState(todayUAE())
  const [pay, setPay] = useState('all') // all | cash | card
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let live = true
    setErr(''); setData(null)
    fetchSaleLines(shop.id, from, to).then(({ data, error }) => { if (live) error ? setErr(error.message) : setData(data) })
    return () => { live = false }
  }, [from, to, shop.id])

  const presets = [
    ['Today', todayUAE(), todayUAE()],
    ['Last 7 days', daysAgo(6), todayUAE()],
    ['This month', monthStart(0), todayUAE()],
    ['Last 3 months', monthStart(2), todayUAE()],
  ]

  const shown = (data || []).filter((s) => pay === 'all' || s.payment_method === pay)
  const all = sumSales(data || [])
  const tot = sumSales(shown)
  // Group by business day, newest day first; sales within a day stay in time order.
  const byDay = new Map()
  for (const s of shown) {
    const d = s.cash_sessions.business_date
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push(s)
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))

  return (
    <div className="reports">
      <div className="card">
        <div className="row gap wrap between">
          <h2>Sales — {shopLabel(shop)} <span className="print-only muted small">({from} to {to} · {PAY_LABEL[pay]})</span></h2>
          <div className="row gap wrap">
            <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
            <button className="btn btn-ghost" disabled={!data} onClick={() => downloadCsv(shown, shop, from, to, pay === 'all' ? '' : `-${pay}`)}>Export CSV</button>
            <button className="btn btn-ghost" onClick={() => window.print()}>Print</button>
          </div>
        </div>
        <div className="row gap wrap no-print" style={{ marginTop: 8 }}>
          {presets.map(([label, f, t]) => (
            <button key={label} className={`btn btn-sm ${from === f && to === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setFrom(f); setTo(t) }}>{label}</button>
          ))}
        </div>
        <div className="seg no-print" style={{ marginTop: 10, maxWidth: 420 }}>
          {[['all', 'All'], ['cash', 'Cash'], ['card', 'Card']].map(([k, label]) => (
            <button key={k} className={pay === k ? 'on' : ''} onClick={() => setPay(k)}>{label}</button>
          ))}
        </div>
        {err && <p className="error">{err}</p>}
        {data && (
          <div className="stats">
            <div className="stat"><span>Sales</span><b>{tot.count}</b></div>
            <div className="stat"><span>Cash</span><b>{fmt(all.cash)}</b></div>
            <div className="stat"><span>Card</span><b>{fmt(all.card)}</b></div>
            <div className="stat"><span>Net</span><b>{fmt(tot.net)}</b></div>
            <div className="stat"><span>VAT 5%</span><b>{fmt(tot.vat)}</b></div>
            <div className="stat strong"><span>Total · {PAY_LABEL[pay]}</span><b>{fmt(tot.gross)}</b></div>
          </div>
        )}
      </div>

      {!data && !err && <div className="spinner" />}
      {data && days.length === 0 && <div className="card"><p className="muted">No sales in this range.</p></div>}
      {days.map(([date, sales]) => {
        const t = sumSales(sales)
        return (
          <div className="card" key={date}>
            <div className="row gap wrap between">
              <h3>{date}</h3>
              <span className="muted small">{t.count} sale(s) · cash {t.cash.toFixed(2)} · card {t.card.toFixed(2)} · <b>total {fmt(t.gross)}</b></span>
            </div>
            <table className="table">
              <thead><tr><th>Receipt</th><th>Time</th><th>Items</th><th>Pay</th><th className="r">Net</th><th className="r">VAT</th><th className="r">Total</th></tr></thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.receipt_no}</b></td>
                    <td>{uaeStamp(s.created_at).slice(11, 16)}</td>
                    <td className="small">{s.sale_items.map((i) => `${i.item_name}${i.note ? ` (${i.note})` : ''} ${i.variation_code} ×${i.qty}`).join(', ')}</td>
                    <td>{s.payment_method}</td>
                    <td className="r">{Number(s.net_total).toFixed(2)}</td>
                    <td className="r">{Number(s.vat_total).toFixed(2)}</td>
                    <td className="r"><b>{Number(s.gross_total).toFixed(2)}</b></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th colSpan={4}>Day total</th><th className="r">{t.net.toFixed(2)}</th><th className="r">{t.vat.toFixed(2)}</th><th className="r">{fmt(t.gross)}</th></tr>
              </tfoot>
            </table>
          </div>
        )
      })}
    </div>
  )
}

// Daily summary (owner only): per business day totals, opening/closing cash reconciliation and eGoal uploads.
export function DailySummary() {
  // Per shop: only the shop selected at login (switch shop to see another).
  const { shop, isOwner } = useAuth()
  const [from, setFrom] = useState(daysAgo(6))
  const [to, setTo] = useState(todayUAE())
  const [rows, setRows] = useState(null)
  const [egoal, setEgoal] = useState(null) // { sent, failed, pending, skipped, problems: [...] }
  const [retrying, setRetrying] = useState('')
  const [err, setErr] = useState('')
  const shopId = shop.id

  const load = async () => {
    setErr('')
    const { data, error } = await supabase
      .from('cash_sessions')
      .select('*, shops(code, location, egoal_outlet_code), sales(payment_method, gross_total, net_total, vat_total)')
      .eq('shop_id', shopId)
      .gte('business_date', from).lte('business_date', to)
      .order('business_date', { ascending: false })
    if (error) return setErr(error.message)
    setRows(
      data.map((cs) => {
        const t = sumSales(cs.sales)
        const expected = round2(Number(cs.opening_cash) + t.cash)
        return { ...cs, t, expected, variance: cs.closing_cash == null ? null : round2(Number(cs.closing_cash) - expected) }
      }),
    )
    const eg = await fetchAll(() => supabase.from('sales')
      .select('id, receipt_no, created_at, gross_total, egoal_status, egoal_attempts, egoal_error, cash_sessions!inner(business_date)')
      .eq('shop_id', shopId)
      .gte('cash_sessions.business_date', from).lte('cash_sessions.business_date', to)
      .order('created_at', { ascending: false }).order('id'))
    if (eg.error) return setErr(eg.error.message)
    const count = (st) => eg.data.filter((s) => s.egoal_status === st).length
    setEgoal({
      sent: count('sent'), failed: count('failed'), skipped: count('skipped'),
      pending: count('pending') + count('sending'),
      problems: eg.data.filter((s) => s.egoal_status !== 'sent' && s.egoal_status !== 'skipped'),
    })
  }

  const retryFailed = async () => {
    setRetrying('Sending…')
    const { data, error } = await supabase.functions.invoke('egoal-export', { body: { shop_id: shopId } })
    if (error) setRetrying(`Retry failed: ${error.message}`)
    else {
      const ok = (data?.results || []).filter((r) => r.egoal_status === 'sent').length
      setRetrying(`${ok} of ${data?.processed ?? 0} sale(s) uploaded.`)
    }
    load()
  }
  useEffect(() => { load() }, [from, to, shopId])

  const grand = rows?.reduce((a, r) => ({
    count: a.count + r.t.count, gross: round2(a.gross + r.t.gross), net: round2(a.net + r.t.net), vat: round2(a.vat + r.t.vat), cash: round2(a.cash + r.t.cash), card: round2(a.card + r.t.card),
  }), { count: 0, gross: 0, net: 0, vat: 0, cash: 0, card: 0 })

  const exportCsv = async () => {
    const { data, error } = await fetchSaleLines(shopId, from, to)
    if (error) return setErr(error.message)
    downloadCsv(data, shop, from, to)
  }

  return (
    <div className="reports">
      <div className="card">
        <div className="row gap wrap between">
          <h2>Daily summary — {shopLabel(shop)} <span className="print-only muted small">({from} to {to})</span></h2>
          <div className="row gap wrap">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <button className="btn btn-ghost" onClick={exportCsv}>Export CSV</button>
            <button className="btn btn-ghost" onClick={() => window.print()}>Print</button>
          </div>
        </div>
        {err && <p className="error">{err}</p>}
        {!rows ? <div className="spinner" /> : (
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Shop</th><th className="r">Sales</th><th className="r">Net</th><th className="r">VAT</th><th className="r">Total</th><th className="r">Cash</th><th className="r">Card</th><th className="r">Open</th><th className="r">Expected</th><th className="r">Counted</th><th className="r">Var.</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.business_date}</td>
                  <td>{shopLabel(r.shops)}</td>
                  <td className="r">{r.t.count}</td>
                  <td className="r">{r.t.net.toFixed(2)}</td>
                  <td className="r">{r.t.vat.toFixed(2)}</td>
                  <td className="r"><b>{r.t.gross.toFixed(2)}</b></td>
                  <td className="r">{r.t.cash.toFixed(2)}</td>
                  <td className="r">{r.t.card.toFixed(2)}</td>
                  <td className="r">{Number(r.opening_cash).toFixed(2)}</td>
                  <td className="r">{r.expected.toFixed(2)}</td>
                  <td className="r">{r.closing_cash == null ? '—' : Number(r.closing_cash).toFixed(2)}</td>
                  <td className={`r ${r.variance ? 'warn' : ''}`}>{r.variance == null ? '—' : r.variance.toFixed(2)}</td>
                  <td>{r.closed_at ? <span className="badge badge-ok">closed</span> : <span className="badge badge-gold">open</span>}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={13} className="muted">No sessions in this range.</td></tr>}
            </tbody>
            {grand && rows.length > 0 && (
              <tfoot>
                <tr><th>Total</th><th></th><th className="r">{grand.count}</th><th className="r">{grand.net.toFixed(2)}</th><th className="r">{grand.vat.toFixed(2)}</th><th className="r">{fmt(grand.gross)}</th><th className="r">{grand.cash.toFixed(2)}</th><th className="r">{grand.card.toFixed(2)}</th><th colSpan={5}></th></tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      <div className="card">
        <div className="row gap wrap between">
          <h2>eGoal uploads — {shopLabel(shop)}</h2>
          {isOwner && egoal?.failed + egoal?.pending > 0 && <button className="btn btn-primary btn-sm" onClick={retryFailed}>Retry failed</button>}
        </div>
        <p className="muted">Each sale is sent to eGoal the moment it is confirmed. Failed ones are retried automatically every 10 minutes.</p>
        {retrying && <p className="muted">{retrying}</p>}
        {!egoal ? <div className="spinner" /> : (
          <>
            <p>
              <span className="badge badge-ok">{egoal.sent} sent</span>{' '}
              <span className={`badge ${egoal.failed ? 'badge-bad' : ''}`}>{egoal.failed} failed</span>{' '}
              <span className="badge badge-gold">{egoal.pending} pending</span>
              {egoal.skipped > 0 && <> <span className="badge">{egoal.skipped} skipped</span></>}
            </p>
            {egoal.problems.length > 0 && (
              <table className="table">
                <thead><tr><th>Receipt</th><th>Date</th><th className="r">Total</th><th>Status</th><th className="r">Tries</th><th>Error</th></tr></thead>
                <tbody>
                  {egoal.problems.map((s) => (
                    <tr key={s.id}><td><b>{s.receipt_no}</b></td><td>{s.cash_sessions.business_date}</td><td className="r">{fmt(s.gross_total)}</td>
                      <td><EgoalBadge sale={s} /></td><td className="r">{s.egoal_attempts}</td><td className="small">{s.egoal_error || ''}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  )
}
