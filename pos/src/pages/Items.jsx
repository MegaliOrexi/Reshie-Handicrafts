import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchItems } from '../lib/items'

export default function Items() {
  const [items, setItems] = useState([])
  const [err, setErr] = useState('')
  const [form, setForm] = useState({ name: '', category: '' })

  const load = () => fetchItems({ includeInactive: true }).then(setItems).then(() => fetchItems()).catch((e) => setErr(e.message))
  useEffect(() => { load() }, [])

  const add = async (e) => {
    e.preventDefault()
    const name = form.name.trim()
    if (!name) return
    const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order), 0)
    const { error } = await supabase.from('items').insert({ name, category: form.category.trim() || null, sort_order: maxOrder + 10 })
    if (error) return setErr(error.message)
    setForm({ name: '', category: '' })
    load()
  }

  const update = async (id, patch) => {
    const { error } = await supabase.from('items').update(patch).eq('id', id)
    if (error) setErr(error.message)
    else load()
  }

  const move = async (idx, dir) => {
    const a = items[idx], b = items[idx + dir]
    if (!b) return
    await supabase.from('items').update({ sort_order: b.sort_order }).eq('id', a.id)
    await supabase.from('items').update({ sort_order: a.sort_order }).eq('id', b.id)
    load()
  }

  return (
    <div className="card">
      <h2>Item types</h2>
      <p className="muted">These are the product types cashiers pick from. No prices are stored — every price is bargained at the till.</p>
      <form className="row gap wrap" onSubmit={add}>
        <input placeholder="New item type (e.g. Cushion Cover)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input placeholder="Category (optional)" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        <button className="btn btn-primary">Add item</button>
      </form>
      {err && <p className="error">{err}</p>}
      <table className="table">
        <thead><tr><th></th><th>Name</th><th>Category</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.id} className={it.active ? '' : 'dim'}>
              <td className="nowrap">
                <button className="btn btn-ghost btn-sm" onClick={() => move(idx, -1)} disabled={idx === 0}>↑</button>
                <button className="btn btn-ghost btn-sm" onClick={() => move(idx, 1)} disabled={idx === items.length - 1}>↓</button>
              </td>
              <td><InlineEdit value={it.name} onSave={(v) => update(it.id, { name: v })} /></td>
              <td><InlineEdit value={it.category || ''} onSave={(v) => update(it.id, { category: v || null })} placeholder="—" /></td>
              <td>{it.active ? <span className="badge badge-ok">active</span> : <span className="badge">hidden</span>}</td>
              <td className="r"><button className="btn btn-ghost btn-sm" onClick={() => update(it.id, { active: !it.active })}>{it.active ? 'Hide' : 'Show'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InlineEdit({ value, onSave, placeholder }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <input className="inline" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() !== value && onSave(v.trim())}
      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
  )
}
