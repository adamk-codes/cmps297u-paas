import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { Activity, ChevronDown, Grip, History, LogOut, Menu, SlidersHorizontal, UserRound, Wallet, X } from 'lucide-react'
import { api, usingMock } from '../api'
import { useAsync } from '../lib/hooks'
import { useAuth } from '../lib/auth'
import { cx, Logo } from './ui'

const nav = [
  { to: '/apps', label: 'Apps', icon: Grip },
  { to: '/backups', label: 'Backups', icon: History },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/costs', label: 'Costs', icon: Wallet },
  { to: '/settings', label: 'Settings', icon: SlidersHorizontal },
]

function ClusterStatus() {
  const apps = useAsync(() => api.listApps())
  // Refresh the count on navigation so new deploys show up.
  const { pathname } = useLocation()
  const { reload } = apps
  useEffect(() => void reload(), [pathname, reload])
  const count = apps.data?.length
  const region = apps.data?.[0]?.region || import.meta.env.VITE_AWS_REGION || 'us-east-1'
  // Online = the platform API answered. Between work sessions the cluster is destroyed and this goes offline.
  const state = apps.error ? 'offline' : apps.data ? 'online' : 'checking'

  return (
    <div className="m-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="flex items-center gap-2 font-mono text-xs text-slate-600">
        <span
          className={cx(
            'size-2 rounded-full',
            state === 'online' ? 'bg-emerald-600' : state === 'offline' ? 'bg-red-500' : 'bg-slate-400',
          )}
        />
        {region}
      </p>
      <p className="mt-1.5 text-sm font-medium text-slate-900">
        {state === 'online' ? 'Cluster online' : state === 'offline' ? 'Cluster offline' : 'Checking cluster…'}
      </p>
      <p className="text-xs text-slate-500">
        {usingMock ? 'Mock data · ' : ''}
        {count === undefined ? (state === 'offline' ? 'No session running' : '…') : `${count} ${count === 1 ? 'app' : 'apps'}`}
      </p>
    </div>
  )
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center px-4">
        <Link
          to="/apps"
          aria-label="Rebound home"
          onClick={onNavigate}
          className="rounded-md transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          <Logo />
        </Link>
      </div>
      <nav className="mt-2 space-y-1 px-3">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition-colors',
                isActive ? 'bg-indigo-100 font-medium text-blue-700' : 'text-slate-700 hover:bg-slate-100',
              )
            }
          >
            <Icon className="size-[18px]" strokeWidth={1.75} />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto">
        <ClusterStatus />
      </div>
    </div>
  )
}

function UserMenu() {
  const { user, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
      >
        <span className="grid size-8 place-items-center rounded-full bg-indigo-100 text-blue-700">
          <UserRound className="size-4" />
        </span>
        <span className="hidden max-w-40 truncate sm:inline">{user?.name}</span>
        <ChevronDown className="size-4 text-slate-500" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium text-slate-900">{user?.name}</p>
            <p className="truncate text-xs text-slate-500">{user?.email}</p>
          </div>
          <div className="my-1 h-px bg-slate-100" />
          <button
            role="menuitem"
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()
  useEffect(() => setMobileOpen(false), [location.pathname])

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 hidden w-62 border-r border-slate-200 bg-white lg:block">
        <Sidebar />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <aside className="relative h-full w-72 bg-white shadow-xl">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="absolute top-4 right-3 grid size-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
            >
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-62">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-8">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              className="grid size-9 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden"
            >
              <Menu className="size-5" />
            </button>
            <span className="inline-flex items-center gap-2 rounded-md bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-600">
              <span className="size-2 rounded-full bg-emerald-600" />
              us-east-1
            </span>
          </div>
          <UserMenu />
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
