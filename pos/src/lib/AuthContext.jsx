import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from './supabase'
import { logEvent } from './log'

const AuthCtx = createContext(null)
const SHOP_KEY = 'reshie-pos-shop'

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = loading
  const [profile, setProfile] = useState(null)
  const [shops, setShops] = useState([])
  const [shop, setShopState] = useState(null)
  const [error, setError] = useState('')

  const loadProfile = useCallback(async (user) => {
    if (!user) {
      setProfile(null); setShops([]); setShopState(null)
      return
    }
    const [{ data: prof, error: pErr }, { data: allShops }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
      supabase.from('shops').select('*').eq('active', true).order('code'),
    ])
    if (pErr) { setError(pErr.message); return }
    if (!prof) {
      setError('Your login exists but has no staff profile yet. Ask the owner to run the schema / set up your account.')
      return
    }
    if (!prof.active) { setError('This account has been deactivated.'); return }

    let allowed = allShops || []
    if (prof.role !== 'owner') { // cashiers + managers: assigned shops only
      const { data: links } = await supabase.from('profile_shops').select('shop_id').eq('profile_id', user.id)
      const ids = new Set((links || []).map((l) => l.shop_id))
      allowed = allowed.filter((s) => ids.has(s.id))
    }
    setProfile(prof)
    setShops(allowed)

    // Restore last-used shop on this device if still allowed
    const savedId = localStorage.getItem(SHOP_KEY)
    const saved = allowed.find((s) => s.id === savedId)
    setShopState(saved || (allowed.length === 1 ? allowed[0] : null))
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      loadProfile(data.session?.user)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s)
      setError('')
      loadProfile(s?.user)
    })
    return () => sub.subscription.unsubscribe()
  }, [loadProfile])

  const setShop = (s) => {
    setShopState(s)
    if (s) localStorage.setItem(SHOP_KEY, s.id)
    else localStorage.removeItem(SHOP_KEY)
  }

  const signIn = async (email, password) => {
    const res = await supabase.auth.signInWithPassword({ email, password })
    if (!res.error) logEvent('auth.login', { ref: email })
    return res
  }
  const signOut = async () => {
    // Log before signing out (needs the session for RLS); give it a moment on 3G
    logEvent('auth.logout', { shopId: shop?.id ?? null })
    await new Promise((r) => setTimeout(r, 300))
    await supabase.auth.signOut()
    setShop(null)
  }

  const value = {
    session, user: session?.user || null, profile, shops, shop, setShop, signIn, signOut, error,
    isOwner: profile?.role === 'owner',
    isManager: profile?.role === 'manager',
    // owner or manager: Items + Reports (a manager only ever sees their own shop(s))
    canManage: profile?.role === 'owner' || profile?.role === 'manager',
    loading: session === undefined || (session && !profile && !error),
    refreshProfile: () => loadProfile(session?.user),
  }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export const useAuth = () => useContext(AuthCtx)
