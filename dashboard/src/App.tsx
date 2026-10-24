import type { ReactNode } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { AppShell } from './components/AppShell'
import { Landing } from './pages/Landing'
import { SignIn } from './pages/SignIn'
import { Apps } from './pages/Apps'
import { AppDetail } from './pages/AppDetail'
import { Backups } from './pages/Backups'
import { Settings } from './pages/Settings'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const location = useLocation()
  if (!user) return <Navigate to="/signin" replace state={{ from: location.pathname }} />
  return children
}

function NotFound() {
  return (
    <div className="py-24 text-center">
      <p className="text-sm font-medium text-blue-700">404</p>
      <h1 className="mt-2 text-2xl font-semibold">Page not found</h1>
      <Link to="/apps" className="mt-4 inline-block text-sm font-medium text-blue-700 hover:text-blue-800">
        Go to apps
      </Link>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/signin" element={<SignIn />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route path="/apps" element={<Apps />} />
            <Route path="/apps/:appId" element={<AppDetail />} />
            <Route path="/backups" element={<Backups />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
