import { useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import { toLoginEmail } from '../lib/username'

export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setErr('')
    const { error } = await signIn(toLoginEmail(email), password)
    if (error) setErr(/invalid login/i.test(error.message) ? 'Wrong username or password.' : error.message)
    setBusy(false)
  }

  return (
    <div className="center-screen login-bg">
      <form className="card login" onSubmit={submit}>
        <img src="/logo.png" alt="Reshie Handicrafts" className="login-logo" />
        <h1>Reshie POS</h1>
        <p className="muted">Staff login</p>
        <label className="field">
          <span>Username</span>
          <input type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <p className="error">{err}</p>}
        <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}
