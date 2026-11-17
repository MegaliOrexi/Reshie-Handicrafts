import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { fmt, round2 } from '../lib/vat'
import { EgoalBadge } from './SalesHistory'
import { shopLabel } from '../lib/shop'

const todayUAE = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' })
const daysAgo = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' })
}

export default function Reports() {
  // Reports are per shop: only the shop selected at login (switch shop to see another).
  const { shop } = useAuth()
  const [from, setFrom] = useState(daysAgo(6))
  const [to, setTo] = useState(todayUAE())
  const [rows, setRows] = useState(null)
  const [egoal, setEgoal] = useState(null) // { sent, failed, pending, skipped, problems: [...] }
  const [retrying, setRetrying] = useState('')
  const [err, setErr] = useState('')
  const shopId = shop.id

  const load = async () => {
    setErr('')
    let q = supabase
      .from('cash_sessions')
      .select('*, shops(code, location, egoal_outlet_code), sales(payment_method, gross_total, net_total, vat_total)')
      .eq('shop_id', shopId)
      .gte('business_date', from).lte('business_date', to)
      .order('business_date', { ascending: false })
    const { data, error } = await q
    if (error) return setErr(error.message)
    setRows(
      data.map((cs) => {
        const t = cs.sales.reduce((a, s) => {
          a.count++; a.gross = round2(a.gross + Number(s.gross_total)); a.net = round2(a.net + Number(s.net_total)); a.vat = round2(a.vat + Number(s.vat_total))
          if (s.payment_method === 'cash') a.cash = round2(a.cash + Number(s.gross_total)); else a.card = round2(a.card + Number(s.gross_total))
          return a
        }, { count: 0, gross: 0, net: 0, vat: 0, cash: 0, card: 0 })
        const expected = round2(Number(cs.opening_cash) + t.cash)
        return { ...cs, t, expected, variance: cs.closing_cash == null ? null : round2(Number(cs.closing_cash) - expected) }
      }),
    )
    const eg = await supabase.from('sales')
      .select('id, receipt_no, created_at, gross_total, egoal_status, egoal_attempts, egoal_error, cash_sessions!inner(business_date)')
      .eq('shop_id', shopId)
      .gte('cash_sessions.business_date', from).lte('cash_sessions.business_date', to)
      .order('created_at', { ascending: false })
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
    let q = supabase.from('sales').select('receipt_no, created_at, payment_method, gross_total, net_total, vat_total, shops(code), profiles:cashier_id(email), sale_items(item_name, variation_code, qty, unit_price, line_gross, line_net, line_vat), cash_sessions!inner(business_date)')
      .eq('shop_id', shopId)
      .gte('cash_sessions.business_date', from).lte('cash_sessions.business_date', to).order('created_at')
    const { data, error } = await q
    if (error) return setErr(error.message)
    const head = ['business_date', 'shop', 'receipt_no', 'time', 'cashier', 'payment', 'item', 'code', 'qty', 'unit_price', 'line_gross', 'line_net', 'line_vat']
    const lines = [head.join(',')]
    for (const s of data) for (const li of s.sale_items) {
      lines.push([s.cash_sessions.business_date, s.shops.code, s.receipt_no, new Date(s.created_at).toISOString(), s.profiles?.email || '', s.payment_method,
        JSON.stringify(li.item_name), li.variation_code, li.qty, li.unit_price, li.line_gross, li.line_net, li.line_vat].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `reshie-${shop.code}-sales-${from}-to-${to}.csv`; a.click()
  }

  return (
    <div className="reports">
      <div className="card">
        <div className="row gap wrap between">
          <h2>Daily reports — {shopLabel(shop)}</h2>
          <div className="row gap wrap">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <button className="btn btn-ghost" onClick={exportCsv}>Export CSV</button>
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
          {egoal?.failed + egoal?.pending > 0 && <button className="btn btn-primary btn-sm" onClick={retryFailed}>Retry failed</button>}
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
