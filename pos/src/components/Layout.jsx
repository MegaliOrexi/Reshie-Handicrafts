import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { displayLogin } from '../lib/username'
import { shopLabel } from '../lib/shop'

export default function Layout() {
  const { profile, shop, isOwner, canManage, signOut, shops } = useAuth()
  const nav = useNavigate()

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/logo.png" alt="" />
          <div>
            <div className="brand-name">Reshie POS</div>
            <div className="brand-shop">{shop && shopLabel(shop)} · {shop?.location}</div>
          </div>
        </div>
        <nav className="nav">
          <NavLink to="/" end>Sell</NavLink>
          <NavLink to="/history">Today</NavLink>
          <NavLink to="/close">Day Close</NavLink>
          {canManage && <NavLink to="/reports">Reports</NavLink>}
          {canManage && <NavLink to="/items">Items</NavLink>}
          {isOwner && <NavLink to="/staff">Staff</NavLink>}
          <NavLink to="/settings">Printer</NavLink>
        </nav>
        <div className="user">
          <span className="user-name">{profile?.full_name || displayLogin(profile?.email)}</span>
          <span className={`badge ${canManage ? 'badge-gold' : ''}`}>{profile?.role}</span>
          {shops.length > 1 && (
            <button className="btn btn-ghost btn-sm" onClick={() => nav('/shop')}>Switch shop</button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={signOut}>Log out</button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
