import { useState } from 'react'
import { useAuth } from '../lib/AuthContext'

export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setErr('')
    const { error } = await signIn(email.trim(), password)
    if (error) setErr(error.message)
    setBusy(false)
  }

  return (
    <div className="center-screen login-bg">
      <form className="card login" onSubmit={submit}>
        <img src="/logo.png" alt="Reshie Handicrafts" className="login-logo" />
        <h1>Reshie POS</h1>
        <p className="muted">Staff login</p>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
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
