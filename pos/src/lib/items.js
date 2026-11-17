// Item list with a client-side cache so selection is instant on 3G.
import { supabase } from './supabase'

const KEY = 'reshie-pos-items'

export function cachedItems() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]')
  } catch {
    return []
  }
}

export async function fetchItems({ includeInactive = false } = {}) {
  let q = supabase.from('items').select('*').order('sort_order').order('name')
  if (!includeInactive) q = q.eq('active', true)
  const { data, error } = await q
  if (error) throw error
  if (!includeInactive) {
    try { localStorage.setItem(KEY, JSON.stringify(data)) } catch { /* ignore */ }
  }
  return data
}
