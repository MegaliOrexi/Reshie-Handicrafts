// Cash session (open-the-day gate) helpers
import { supabase } from './supabase'

export async function uaeToday() {
  const { data, error } = await supabase.rpc('uae_today')
  if (error) throw error
  return data
}

/** Business date (06:00 → 05:59 UAE), computed locally — only used to notice the roll-over;
 *  the server's uae_today() stays the source of truth. */
export function localBusinessDate() {
  return new Date(Date.now() + 4 * 3600_000 - 6 * 3600_000).toISOString().slice(0, 10)
}

/** Today's session, plus the oldest EARLIER day that was never closed (must be closed first). */
export async function getTodaySession(shopId) {
  const today = await uaeToday()
  const [cur, prev] = await Promise.all([
    supabase.from('cash_sessions').select('*').eq('shop_id', shopId).eq('business_date', today).maybeSingle(),
    supabase.from('cash_sessions').select('*').eq('shop_id', shopId).lt('business_date', today)
      .is('closed_at', null).order('business_date').limit(1).maybeSingle(),
  ])
  if (cur.error) throw cur.error
  if (prev.error) throw prev.error
  return { today, session: cur.data, unclosed: prev.data }
}

export async function openDay({ shopId, userId, openingCash }) {
  const today = await uaeToday()
  const { data, error } = await supabase
    .from('cash_sessions')
    .insert({ shop_id: shopId, business_date: today, opening_cash: openingCash, opened_by: userId })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function closeDay({ sessionId, userId, closingCash, note }) {
  const { data, error } = await supabase
    .from('cash_sessions')
    .update({ closing_cash: closingCash, closed_by: userId, closed_at: new Date().toISOString(), closing_note: note || null })
    .eq('id', sessionId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function sessionSummary(sessionId) {
  const { data, error } = await supabase.rpc('session_summary', { p_session_id: sessionId })
  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}
