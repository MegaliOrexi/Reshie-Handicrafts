import { useEffect, useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import DayGate from '../components/DayGate'
import { closeDay, sessionSummary } from '../lib/session'
import { fmt, round2 } from '../lib/vat'
import { shopLabel } from '../lib/shop'

export default function DayClose() {
  return <DayGate>{({ session, refresh }) => <CloseScreen session={session} refresh={refresh} />}</DayGate>
}

export function CloseScreen({ session, refresh }) {
  const { user, shop } = useAuth()
  const [sum, setSum] = useState(null)
  const [closing, setClosing] = useState(session.closing_cash ?? '')
  const [note, setNote] = useState(session.closing_note ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    sessionSummary(session.id).then(setSum).catch((e) => setErr(e.message))
  }, [session.id])

  const expectedCash = sum ? round2(Number(session.opening_cash) + Number(sum.cash_total)) : null
  const variance = closing !== '' && expectedCash !== null ? round2(Number(closing) - expectedCash) : null
  const isClosed = !!session.closed_at

  const submit = async (e) => {
    e.preventDefault()
    if (!confirm) { setConfirm(true); return }
    setBusy(true); setErr('')
    try {
      await closeDay({ sessionId: session.id, userId: user.id, closingCash: Number(closing), note })
      await refresh()
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false); setConfirm(false)
    }
  }

  return (
    <div className="dayclose">
      <div className="card">
        <h2>Day close — {shopLabel(shop)} · {session.business_date}</h2>
        {isClosed && <p className="ok">Closed at {new Date(session.closed_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai' })}.</p>}
        {!sum ? <div className="spinner" /> : (
          <div className="stats">
            <Stat label="Sales" value={sum.sales_count} />
            <Stat label="Items sold" value={sum.items_sold} />
            <Stat label="Net" value={fmt(sum.net_total)} />
            <Stat label="VAT 5%" value={fmt(sum.vat_total)} />
            <Stat label="Total" value={fmt(sum.gross_total)} strong />
            <Stat label="Cash sales" value={fmt(sum.cash_total)} />
            <Stat label="Card sales" value={fmt(sum.card_total)} />
          </div>
        )}
      </div>

      <form className="card" onSubmit={submit}>
        <h2>Cash reconciliation</h2>
        <div className="recon">
          <div><span>Opening cash</span><b>{fmt(session.opening_cash)}</b></div>
          <div><span>+ Cash sales</span><b>{sum ? fmt(sum.cash_total) : '…'}</b></div>
          <div className="grand"><span>= Expected in drawer</span><b>{expectedCash !== null ? fmt(expectedCash) : '…'}</b></div>
        </div>
        <label className="field">
          <span>Counted closing cash (AED)</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" required className="input-xl"
            value={closing} onChange={(e) => { setClosing(e.target.value); setConfirm(false) }} disabled={isClosed} />
        </label>
        {variance !== null && (
          <p className={variance === 0 ? 'ok' : 'warn'}>
            {variance === 0 ? 'Drawer balances exactly.' : `${variance > 0 ? 'Over' : 'Short'} by ${fmt(Math.abs(variance))}`}
          </p>
        )}
        <label className="field">
          <span>Note (optional)</span>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={isClosed} placeholder="e.g. AED 50 petty cash taken for supplies" />
        </label>
        {err && <p className="error">{err}</p>}
        {!isClosed && (
          <button className={`btn btn-lg ${confirm ? 'btn-danger' : 'btn-primary'}`} disabled={busy || closing === '' || !sum}>
            {busy ? 'Closing…' : confirm ? `Yes, close ${session.business_date} (no more sales on it)` : 'Close the day'}
          </button>
        )}
        {confirm && !busy && <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>}
      </form>
    </div>
  )
}

function Stat({ label, value, strong }) {
  return (
    <div className={`stat ${strong ? 'strong' : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}
