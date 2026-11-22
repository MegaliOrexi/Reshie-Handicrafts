import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { displayLogin } from '../lib/username'
import { logEvent } from '../lib/log'
import { shopLabel } from '../lib/shop'

export default function ShopSelect() {
  const { shops, setShop, profile, signOut, error, refreshProfile } = useAuth()
  const nav = useNavigate()

  const pick = (s) => { setShop(s); logEvent('shop.selected', { shopId: s.id, ref: s.code }); nav('/') }

  return (
    <div className="center-screen login-bg">
      <div className="card shop-select">
        <img src="/logo.png" alt="" className="login-logo" />
        <h1>Select shop</h1>
        <p className="muted">Signed in as <b>{profile?.full_name || displayLogin(profile?.email)}</b></p>
        {error && <p className="error">{error}</p>}
        {!error && shops.length === 0 && (
          <p className="error">No shop is assigned to your account yet. Ask the owner to assign you a shop (Owner → Staff).</p>
        )}
        <div className="shop-grid">
          {shops.map((s) => (
            <button key={s.id} className="shop-card" onClick={() => pick(s)}>
              <div className="shop-code">{shopLabel(s)}</div>
              <div className="shop-loc">{s.location}</div>
            </button>
          ))}
        </div>
        <div className="row gap">
          <button className="btn btn-ghost" onClick={refreshProfile}>Refresh</button>
          <button className="btn btn-ghost" onClick={signOut}>Log out</button>
        </div>
      </div>
    </div>
  )
}
