import { useEffect, useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import DayGate from '../components/DayGate'
import { supabase } from '../lib/supabase'
import { fmt } from '../lib/vat'
import { buildReceipt } from '../lib/receipt'
import { printReceipt } from '../lib/print'

export default function SalesHistory() {
  return <DayGate>{({ session }) => <List session={session} />}</DayGate>
}

function List({ session }) {
  const { shop, profile } = useAuth()
  const [sales, setSales] = useState(null)
  const [err, setErr] = useState('')

  const load = async () => {
    const { data, error } = await supabase
      .from('sales')
      .select('*, sale_items(*), profiles:cashier_id(full_name, email)')
      .eq('session_id', session.id)
      .order('receipt_seq', { ascending: false })
    if (error) setErr(error.message)
    else setSales(data)
  }
  useEffect(() => { load() }, [session.id])

  // Re-send one failed sale to eGoal now (the server would also retry it every 10 minutes).
  const [resending, setResending] = useState({})
  const resend = async (s) => {
    setResending((r) => ({ ...r, [s.id]: true }))
    const { data, error } = await supabase.functions.invoke('egoal-export', { body: { sale_id: s.id } })
    setResending((r) => ({ ...r, [s.id]: false }))
    const res = (data?.results || [])[0]
    if (error || !res) alert(`Resend failed: ${error?.message || data?.error || 'sale is already being sent — refresh in a moment'}`)
    else if (res.egoal_status !== 'sent') alert(`eGoal still failing: ${res.egoal_error || res.egoal_status}`)
    load()
  }

  const reprint = (s) => {
    // Cashiers can only read their own profile row, so another cashier's name may be hidden by RLS
    const receipt = buildReceipt({ sale: s, items: s.sale_items, shop, cashierName: s.profiles?.full_name || s.profiles?.email || (s.cashier_id === profile?.id ? profile?.email : 'Staff') })
    printReceipt(receipt, { shopId: shop.id, receiptNo: s.receipt_no, reprint: true })
  }

  if (err) return <p className="error">{err}</p>
  if (!sales) return <div className="spinner" />

  return (
    <div className="card">
      <div className="row between">
        <h2>Today's sales — {session.business_date}</h2>
        <button className="btn btn-ghost btn-sm" onClick={load}>Refresh</button>
      </div>
      {sales.length === 0 ? <p className="muted">No sales yet today.</p> : (
        <table className="table">
          <thead><tr><th>Receipt</th><th>Time</th><th>Items</th><th>Pay</th><th className="r">Net</th><th className="r">VAT</th><th className="r">Total</th><th>eGoal</th><th></th></tr></thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.id}>
                <td><b>{s.receipt_no}</b></td>
                <td>{new Date(s.created_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit' })}</td>
                <td className="small">{s.sale_items.map((i) => `${i.item_name} ${i.variation_code} ×${i.qty}`).join(', ')}</td>
                <td>{s.payment_method}</td>
                <td className="r">{Number(s.net_total).toFixed(2)}</td>
                <td className="r">{Number(s.vat_total).toFixed(2)}</td>
                <td className="r"><b>{fmt(s.gross_total)}</b></td>
                <td>
                  <EgoalBadge sale={s} />
                  {s.egoal_status === 'failed' && (
                    <button className="btn btn-primary btn-sm" style={{ marginLeft: 6 }} disabled={resending[s.id]} onClick={() => resend(s)}>
                      {resending[s.id] ? 'Sending…' : 'Resend'}
                    </button>
                  )}
                </td>
                <td className="r"><button className="btn btn-ghost btn-sm" onClick={() => reprint(s)}>Reprint</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function EgoalBadge({ sale }) {
  const st = sale.egoal_status || 'pending'
  const cls = st === 'sent' ? 'badge-ok' : st === 'failed' ? 'badge-bad' : st === 'skipped' ? '' : 'badge-gold'
  return <span className={`badge ${cls}`} title={sale.egoal_error || ''}>{st === 'sending' ? 'pending' : st}</span>
}
