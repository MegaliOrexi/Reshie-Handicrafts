import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '../lib/AuthContext'
import { getTodaySession, localBusinessDate, openDay } from '../lib/session'
import { CloseScreen } from '../pages/DayClose'
import { fmt } from '../lib/vat'
import { shopLabel } from '../lib/shop'

/**
 * The "open the day" gate. Renders children only when today's cash session
 * exists for the selected shop. Otherwise:
 *   - if an earlier day was never closed → its close screen first ("close yesterday first"),
 *   - then the opening-cash form.
 * A business day runs 06:00 → 05:59 UAE (late weekend sales after midnight stay on the evening's
 * day). The gate re-checks every minute, so at 06:00 an open till switches by itself.
 * Children receive { session, today, refresh } via render-prop.
 */
export default function DayGate({ children }) {
  const { shop, user } = useAuth()
  const [state, setState] = useState({ loading: true, session: null, unclosed: null, today: null, error: '' })
  const [cash, setCash] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: '' }))
    try {
      const { today, session, unclosed } = await getTodaySession(shop.id)
      setState({ loading: false, session, unclosed, today, error: '' })
    } catch (e) {
      setState({ loading: false, session: null, unclosed: null, today: null, error: e.message })
    }
  }, [shop.id])

  useEffect(() => { refresh() }, [refresh])

  // Business-day roll-over (06:00 UAE): re-check so a till left open switches to the new day.
  useEffect(() => {
    const t = setInterval(() => {
      if (state.today && localBusinessDate() !== state.today) refresh()
    }, 60_000)
    return () => clearInterval(t)
  }, [state.today, refresh])

  const submit = async (e) => {
    e.preventDefault()
    const amount = Number(cash)
    if (!Number.isFinite(amount) || amount < 0) return
    setBusy(true)
    try {
      await openDay({ shopId: shop.id, userId: user.id, openingCash: amount })
      await refresh()
    } catch (err) {
      // Someone else may have opened it in the meantime, or an earlier day is still open — reload
      const m = String(err.message)
      if (m.includes('duplicate') || m.includes('previous day not closed')) await refresh()
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

  if (!state.session && state.unclosed) {
    return (
      <div>
        <div className="card narrow gate">
          <div className="gate-icon">🔒</div>
          <h2>Close {state.unclosed.business_date} first</h2>
          <p className="muted">The previous day for {shopLabel(shop)} was never closed. Count the drawer and close it below — then you can open today ({state.today}).</p>
        </div>
        <CloseScreen session={state.unclosed} refresh={refresh} />
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
