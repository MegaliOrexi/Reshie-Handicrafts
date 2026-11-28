import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/AuthContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import ShopSelect from './pages/ShopSelect'
import Sell from './pages/Sell'
import DayClose from './pages/DayClose'
import Items from './pages/Items'
import Staff from './pages/Staff'
import Reports, { DailySummary } from './pages/Reports'
import Settings from './pages/Settings'
import SalesHistory from './pages/SalesHistory'

function Guard({ children, owner = false, manage = false, needShop = true }) {
  const { user, loading, shop, isOwner, canManage, error } = useAuth()
  if (loading) return <div className="center-screen"><div className="spinner" /></div>
  if (!user) return <Navigate to="/login" replace />
  if (error && needShop) return <Navigate to="/shop" replace /> // /shop itself shows the error
  if (owner && !isOwner) return <Navigate to="/" replace />
  if (manage && !canManage) return <Navigate to="/" replace />
  if (needShop && !shop) return <Navigate to="/shop" replace />
  return children
}

export default function App() {
  const { user, loading } = useAuth()
  if (loading) return <div className="center-screen"><div className="spinner" /></div>

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/shop" element={<Guard needShop={false}><ShopSelect /></Guard>} />
      <Route element={<Guard><Layout /></Guard>}>
        <Route path="/" element={<Sell />} />
        <Route path="/history" element={<SalesHistory />} />
        <Route path="/close" element={<DayClose />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/items" element={<Guard manage><Items /></Guard>} />
        <Route path="/staff" element={<Guard owner><Staff /></Guard>} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/daily" element={<Guard owner><DailySummary /></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
