import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '../lib/AuthContext'
import { getTodaySession, openDay } from '../lib/session'
import { fmt } from '../lib/vat'
import { shopLabel } from '../lib/shop'

/**
 * The "open the day" gate. Renders children only when today's cash session
 * exists for the selected shop. Otherwise shows the opening-cash form.
 * Children receive { session, today, refresh } via render-prop.
 */
export default function DayGate({ children }) {
  const { shop, user } = useAuth()
  const [state, setState] = useState({ loading: true, session: null, today: null, error: '' })
  const [cash, setCash] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: '' }))
    try {
      const { today, session } = await getTodaySession(shop.id)
      setState({ loading: false, session, today, error: '' })
    } catch (e) {
      setState({ loading: false, session: null, today: null, error: e.message })
    }
  }, [shop.id])

  useEffect(() => { refresh() }, [refresh])

  const submit = async (e) => {
    e.preventDefault()
    const amount = Number(cash)
    if (!Number.isFinite(amount) || amount < 0) return
    setBusy(true)
    try {
      await openDay({ shopId: shop.id, userId: user.id, openingCash: amount })
      await refresh()
    } catch (err) {
      // Someone else may have opened it in the meantime — just reload
      if (String(err.message).includes('duplicate')) await refresh()
      else setState((s) => ({ ...s, error: err.message }))
    } finally {
      setBusy(false)
    }
  }

  if (state.loading) return <div className="center-screen"><div className="spinner" /></div>

  if (state.error && !state.session) {
    return (
      <div className="card narrow">
        <h2>Could not load today's session</h2>
        <p className="error">{state.error}</p>
        <button className="btn btn-primary" onClick={refresh}>Retry</button>
      </div>
    )
  }

  if (!state.session) {
    return (
      <div className="card narrow gate">
        <div className="gate-icon">🔒</div>
        <h2>Open the day — {shopLabel(shop)}</h2>
        <p className="muted">Business date <b>{state.today}</b>. Count the cash in the drawer and enter it below. Selling stays locked until this is done.</p>
        <form onSubmit={submit}>
          <label className="field">
            <span>Opening cash (AED)</span>
            <input
              type="number" inputMode="decimal" min="0" step="0.01" autoFocus required
              value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00"
              className="input-xl"
            />
          </label>
          {cash !== '' && <p className="muted">= {fmt(cash)}</p>}
          <button className="btn btn-primary btn-lg" disabled={busy || cash === ''}>
            {busy ? 'Opening…' : 'Open the day & unlock selling'}
          </button>
        </form>
      </div>
    )
  }

  return children({ session: state.session, today: state.today, refresh })
}
