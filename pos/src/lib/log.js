// Client-side event log (event_logs table). Fire-and-forget: never blocks or
// breaks the UI, tiny payload (3G-friendly). Server-side events (receipt
// generated, day opened/closed, eGoal, emails) are logged by the database /
// Edge Functions themselves.
import { supabase } from './supabase'

export function logEvent(event, { shopId = null, ref = null, message = null, data = null, level = 'info' } = {}) {
  supabase.auth.getSession().then(({ data: s }) => {
    const uid = s?.session?.user?.id
    if (!uid) return
    return supabase.from('event_logs').insert({ event, level, shop_id: shopId, actor_id: uid, ref, message, data })
  }).then((res) => {
    if (res?.error) console.warn('[log]', res.error.message)
  }).catch(() => { /* ignore */ })
}
