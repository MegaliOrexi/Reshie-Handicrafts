import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { shopNo } from '../lib/shop'
import { STAFF_DOMAIN, displayLogin } from '../lib/username'

export default function Staff() {
  const { user } = useAuth()
  const [profiles, setProfiles] = useState([])
  const [shops, setShops] = useState([])
  const [links, setLinks] = useState([])
  const [err, setErr] = useState('')

  const load = async () => {
    const [p, s, l] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at'),
      supabase.from('shops').select('*').order('code'),
      supabase.from('profile_shops').select('*'),
    ])
    const e = p.error || s.error || l.error
    if (e) return setErr(e.message)
    setProfiles(p.data); setShops(s.data); setLinks(l.data)
  }
  useEffect(() => { load() }, [])

  const has = (pid, sid) => links.some((l) => l.profile_id === pid && l.shop_id === sid)
  const toggle = async (pid, sid) => {
    const q = has(pid, sid)
      ? supabase.from('profile_shops').delete().match({ profile_id: pid, shop_id: sid })
      : supabase.from('profile_shops').insert({ profile_id: pid, shop_id: sid })
    const { error } = await q
    if (error) setErr(error.message); else load()
  }
  const patch = async (pid, data) => {
    const { error } = await supabase.from('profiles').update(data).eq('id', pid)
    if (error) setErr(error.message); else load()
  }

  return (
    <div className="card">
      <h2>Staff</h2>
      <p className="muted">
        To add a cashier: Supabase → Authentication → Users → <b>Add user</b> → <b>Create new user</b>.
        For a short username like <b>ali</b>, enter the email <b>ali@{STAFF_DOMAIN}</b> (+ a password, min 6 characters, tick auto-confirm).
        They then log in with just <b>ali</b> and the password. They will appear here automatically — tick the shop(s) they may sell at.
        <br /><b>cashier</b> = sell only · <b>manager</b> = sell + manage items + reports for their ticked shop(s) · <b>owner</b> = everything, all shops.
      </p>
      {err && <p className="error">{err}</p>}
      <table className="table">
        <thead>
          <tr><th>Name</th><th>Login</th><th>Role</th>{shops.map((s) => <th key={s.id} className="c">{shopNo(s)}</th>)}<th>Active</th></tr>
        </thead>
        <tbody>
          {profiles.map((p) => {
            const me = p.id === user.id
            const owner = p.role === 'owner'
            return (
              <tr key={p.id} className={p.active ? '' : 'dim'}>
                <td><input className="inline" defaultValue={p.full_name || ''} onBlur={(e) => e.target.value !== (p.full_name || '') && patch(p.id, { full_name: e.target.value })} /></td>
                <td className="small">{displayLogin(p.email)}{me && ' (you)'}</td>
                <td>
                  <select value={p.role} disabled={me} onChange={(e) => patch(p.id, { role: e.target.value })}>
                    <option value="cashier">cashier</option>
                    <option value="manager">manager</option>
                    <option value="owner">owner</option>
                  </select>
                </td>
                {shops.map((s) => (
                  <td key={s.id} className="c">
                    {owner ? <span className="muted">all</span> : (
                      <input type="checkbox" checked={has(p.id, s.id)} onChange={() => toggle(p.id, s.id)} />
                    )}
                  </td>
                ))}
                <td><input type="checkbox" checked={p.active} disabled={me} onChange={() => patch(p.id, { active: !p.active })} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
