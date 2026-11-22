import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import DayGate from '../components/DayGate'
import { supabase } from '../lib/supabase'
import { cachedItems, fetchItems } from '../lib/items'
import { cartTotals, splitVat, fmt, round2 } from '../lib/vat'
import { withRetry } from '../lib/retry'
import { buildReceipt } from '../lib/receipt'
import { printReceipt, browserPrint } from '../lib/print'
import { getSettings } from '../lib/settings'

const LETTERS = /^[A-Z]*$/
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

export default function Sell() {
  return <DayGate>{({ session }) => <SellScreen session={session} />}</DayGate>
}

function SellScreen({ session }) {
  const { shop, user, profile } = useAuth()
  const [items, setItems] = useState(cachedItems())
  const [cart, setCart] = useState([])
  const [payment, setPayment] = useState('cash')
  const [status, setStatus] = useState({ busy: false, msg: '', error: '' })
  const [done, setDone] = useState(null) // { sale, items, html }
  const clientRef = useRef(newId())

  // Line being edited
  const [line, setLine] = useState({ item_id: '', unit_price: '', variation_code: '', qty: 1 })
  const itemRef = useRef(null)
  const priceRef = useRef(null)

  useEffect(() => {
    fetchItems().then(setItems).catch(() => { /* keep cache */ })
  }, [])

  useEffect(() => {
    if (!line.item_id && items.length) setLine((l) => ({ ...l, item_id: items[0].id }))
  }, [items, line.item_id])

  const totals = useMemo(() => cartTotals(cart), [cart])
  const closed = !!session.closed_at

  const lineValid =
    line.item_id && Number(line.unit_price) > 0 && LETTERS.test(line.variation_code) && line.variation_code.length > 0 && Number(line.qty) >= 1

  const addLine = (e) => {
    e?.preventDefault()
    if (!lineValid) return
    const item = items.find((i) => i.id === line.item_id)
    setCart((c) => [
      ...c,
      { key: newId(), item_id: item.id, item_name: item.name, unit_price: round2(line.unit_price), variation_code: line.variation_code, qty: Number(line.qty) },
    ])
    setLine((l) => ({ ...l, unit_price: '', variation_code: '', qty: 1 }))
    priceRef.current?.focus()
  }

  const removeLine = (key) => setCart((c) => c.filter((l) => l.key !== key))

  const onCode = (v) => {
    const up = v.toUpperCase().replace(/[^A-Z]/g, '')
    setLine((l) => ({ ...l, variation_code: up }))
  }

  const confirmSale = async () => {
    if (!cart.length || status.busy) return
    setStatus({ busy: true, msg: 'Saving sale…', error: '' })
    const payload = {
      p_client_ref: clientRef.current,
      p_shop_id: shop.id,
      p_payment_method: payment,
      p_items: cart.map((l) => ({ item_id: l.item_id, variation_code: l.variation_code, qty: l.qty, unit_price: l.unit_price })),
    }
    try {
      const sale = await withRetry(async () => {
        const { data, error } = await supabase.rpc('create_sale', payload)
        if (error) throw error
        return data
      })
      // Send this sale to eGoal now, in the background — never blocks the receipt. If it doesn't get
      // through (3G blip, eGoal down) the server retries it every 10 minutes.
      supabase.functions.invoke('egoal-export', { body: { sale_id: sale.id } }).catch(() => {})
      const { data: saleItems } = await supabase.from('sale_items').select('*').eq('sale_id', sale.id).order('id')
      const receipt = buildReceipt({ sale, items: saleItems || [], shop, cashierName: profile?.full_name || profile?.email })
      setDone({ sale, items: saleItems || [], receipt })
      setCart([])
      clientRef.current = newId()
      setStatus({ busy: false, msg: '', error: '' })
      if (getSettings().autoPrint) {
        const { via } = await printReceipt(receipt, { shopId: shop.id, receiptNo: sale.receipt_no })
        setStatus({ busy: false, msg: via === 'qz' || via === 'rawbt' ? 'Receipt sent to printer.' : 'Used browser print.', error: '' })
      }
    } catch (err) {
      setStatus({ busy: false, msg: '', error: humanError(err) })
    }
  }

  if (done) {
    return (
      <div className="sell-done">
        <div className="card narrow center">
          <div className="done-icon">✓</div>
          <h2>Sale complete</h2>
          <p className="receipt-no">{done.sale.receipt_no}</p>
          <p className="big">{fmt(done.sale.gross_total)} · {done.sale.payment_method.toUpperCase()}</p>
          {status.msg && <p className="muted">{status.msg}</p>}
          <div className="row gap center">
            <button className="btn btn-ghost" onClick={() => printReceipt(done.receipt, { shopId: shop.id, receiptNo: done.sale.receipt_no, reprint: true })}>Print again</button>
            <button className="btn btn-ghost" onClick={() => browserPrint(done.receipt, { shopId: shop.id, receiptNo: done.sale.receipt_no, reprint: true })}>Browser print</button>
          </div>
          <button className="btn btn-primary btn-lg" autoFocus onClick={() => { setDone(null); setStatus({ busy: false, msg: '', error: '' }) }}>
            New sale
          </button>
        </div>
        <div className="card receipt-preview">
          <iframe title="receipt" srcDoc={done.receipt.html} />
        </div>
      </div>
    )
  }

  return (
    <div className="sell">
      <section className="card">
        <h2>Add item</h2>
        {closed && <p className="error">Today's session is closed. No more sales can be recorded for {session.business_date}.</p>}
        <form className="line-form" onSubmit={addLine}>
          <label className="field">
            <span>Item type</span>
            <select ref={itemRef} value={line.item_id} onChange={(e) => setLine({ ...line, item_id: e.target.value })} disabled={closed}>
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Bargained price (AED, incl. VAT)</span>
            <input
              ref={priceRef} type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00"
              value={line.unit_price} onChange={(e) => setLine({ ...line, unit_price: e.target.value })} disabled={closed}
            />
          </label>
          <label className="field">
            <span>Variation code (letters)</span>
            <input
              type="text" autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false}
              name={`vc-${clientRef.current}`}
              className="code-input" placeholder="e.g. ABKZ" value={line.variation_code}
              onChange={(e) => onCode(e.target.value)} disabled={closed}
            />
          </label>
          <label className="field field-qty">
            <span>Qty</span>
            <input type="number" min="1" step="1" value={line.qty} onChange={(e) => setLine({ ...line, qty: e.target.value })} disabled={closed} />
          </label>
          <button className="btn btn-primary" disabled={!lineValid || closed}>Add</button>
        </form>
        {line.unit_price !== '' && Number(line.unit_price) > 0 && (
          <p className="muted small">
            Line: {fmt(Number(line.unit_price) * Number(line.qty || 1))} → net {fmt(splitVat(Number(line.unit_price) * Number(line.qty || 1)).net)} + VAT {fmt(splitVat(Number(line.unit_price) * Number(line.qty || 1)).vat)}
          </p>
        )}
      </section>

      <section className="card cart">
        <h2>Cart <span className="muted">({totals.qty} item{totals.qty === 1 ? '' : 's'})</span></h2>
        {cart.length === 0 ? (
          <p className="muted empty">No items yet. Add the first item above.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Item</th><th className="r">Qty × Price</th><th className="r">Total</th><th></th></tr>
            </thead>
            <tbody>
              {cart.map((l) => (
                <tr key={l.key}>
                  <td className="cart-item"><b>{l.item_name}</b><code className="code">{l.variation_code}</code></td>
                  <td className="r nowrap">{l.qty} × {l.unit_price.toFixed(2)}</td>
                  <td className="r nowrap"><b>{round2(l.unit_price * l.qty).toFixed(2)}</b></td>
                  <td className="r"><button className="btn btn-ghost btn-sm" onClick={() => removeLine(l.key)} title="Remove">✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="totals">
          <div><span>Net (excl. VAT)</span><b>{fmt(totals.net)}</b></div>
          <div><span>VAT 5%</span><b>{fmt(totals.vat)}</b></div>
          <div className="grand"><span>Total</span><b>{fmt(totals.gross)}</b></div>
        </div>

        <div className="pay">
          <div className="seg">
            <button className={payment === 'cash' ? 'on' : ''} onClick={() => setPayment('cash')} type="button">💵 Cash</button>
            <button className={payment === 'card' ? 'on' : ''} onClick={() => setPayment('card')} type="button">💳 Card</button>
          </div>
          <button className="btn btn-primary btn-lg" disabled={!cart.length || status.busy || closed} onClick={confirmSale}>
            {status.busy ? status.msg : `Confirm ${payment} sale · ${fmt(totals.gross)}`}
          </button>
          {status.error && <p className="error">{status.error}</p>}
        </div>
      </section>
    </div>
  )
}

function humanError(err) {
  const m = String(err?.message || err)
  if (m.includes('day not opened')) return 'The day is not open yet. Enter opening cash first.'
  if (m.includes('day already closed')) return 'The day has been closed. No more sales today.'
  if (m.toLowerCase().includes('fetch')) return 'No connection. The sale was NOT saved — check the internet and press Confirm again.'
  return m
}
