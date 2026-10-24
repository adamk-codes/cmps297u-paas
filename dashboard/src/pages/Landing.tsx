import { Link } from 'react-router-dom'
import { BadgeCheck, Database, GitFork, LogIn, Lock, Network, NotepadText, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth'
import { Logo } from '../components/ui'

const previewApps = [
  { name: 'shop-api', icon: Network, commit: 'a91d02f' },
  { name: 'notes-app', icon: NotepadText, commit: '6bd7741' },
]

function Feature({ icon, iconCls, title, children }: { icon: ReactNode; iconCls: string; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 rounded-xl bg-blue-50/60 p-5">
      <div className={`grid size-12 shrink-0 place-items-center rounded-md ${iconCls}`}>{icon}</div>
      <div>
        <h3 className="text-[17px] font-semibold text-slate-900">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">{children}</p>
      </div>
    </div>
  )
}

export function Landing() {
  const { user } = useAuth()
  const cta = user ? { to: '/apps', label: 'Open dashboard' } : { to: '/signin', label: 'Sign in' }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <Link to={cta.to} className="text-sm font-medium text-blue-700 hover:text-blue-800">
            {cta.label}
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-5xl px-4 pt-14 text-center sm:px-6 sm:pt-16">
          <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-6xl sm:leading-[1.1]">
            Deploy apps. Back them up. Restore with confidence.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-slate-600">
            One dashboard to deploy, manage, and recover your apps.
          </p>
          <Link
            to={cta.to}
            className="mt-8 inline-flex h-12 items-center gap-2 rounded-lg bg-blue-600 px-6 text-[15px] font-medium text-white shadow-sm hover:bg-blue-700"
          >
            <LogIn className="size-5" />
            {cta.label}
          </Link>
        </section>

        {/* Product preview */}
        <section className="mx-auto mt-12 max-w-5xl px-4 sm:px-6">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60">
            <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
              <div className="flex gap-1.5">
                <span className="size-2.5 rounded-full bg-slate-300" />
                <span className="size-2.5 rounded-full bg-slate-300" />
                <span className="size-2.5 rounded-full bg-slate-300" />
              </div>
              <div className="mx-auto flex min-w-0 items-center gap-2 rounded-md bg-white px-3 py-1.5 font-mono text-xs text-slate-700 shadow-xs">
                <Lock className="size-3.5 shrink-0 text-emerald-600" />
                <span className="truncate">console.internal.app-platform.net</span>
              </div>
              <SlidersHorizontal className="hidden size-4 text-slate-500 sm:block" />
            </div>

            <div className="p-5 sm:p-8">
              <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">Organization workspace</p>
                  <p className="mt-1 flex items-center gap-2 text-xl font-semibold text-slate-900">
                    Core services
                    <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-blue-700">2 active</span>
                  </p>
                </div>
                <div className="flex items-center gap-3 text-sm text-slate-500">
                  <Search className="size-4" />
                  <span className="rounded-md bg-slate-100 px-3 py-2">Filter by branch…</span>
                </div>
              </div>

              <ul className="space-y-3">
                {previewApps.map(({ name, icon: Icon, commit }) => (
                  <li key={name} className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-slate-50 p-4 sm:px-5">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-indigo-50 text-blue-700">
                        <Icon className="size-5" strokeWidth={1.75} />
                      </div>
                      <div className="min-w-0">
                        <p className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{name}</span>
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            <span className="size-1.5 rounded-full bg-emerald-500" />
                            Healthy
                          </span>
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-600">
                          <span className="font-mono text-xs">git:main@{commit}</span>·
                          <span className="inline-flex items-center gap-1">
                            <Database className="size-3.5" /> PostgreSQL 16.3
                          </span>
                          <span className="text-xs font-medium text-slate-700">Node.js 20</span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-slate-600">us-east-1</span>
                      <span className="inline-flex items-center gap-2 rounded-md bg-indigo-100 px-3 py-2 text-xs font-medium text-blue-700">
                        <BadgeCheck className="size-4" /> Backup verified 02:00 AM UTC
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="mx-auto mt-12 grid max-w-6xl gap-4 px-4 pb-16 sm:px-6 md:grid-cols-3">
          <Feature icon={<GitFork className="size-5" />} iconCls="bg-indigo-100 text-blue-700" title="Deploy from approved repos">
            Strict branch protection and predictable builds from team-approved sources.
          </Feature>
          <Feature icon={<Database className="size-5" />} iconCls="bg-indigo-100 text-blue-700" title="A database for every app">
            One PostgreSQL database per app, with daily scheduled backups.
          </Feature>
          <Feature icon={<ShieldCheck className="size-5" />} iconCls="bg-emerald-300 text-emerald-900" title="Verified backups and restores">
            Test a backup against its saved app image at a separate recovery URL.
          </Feature>
        </section>
      </main>

      <footer className="bg-blue-50/60 py-6 text-center text-sm text-slate-600">Access is limited to team members.</footer>
    </div>
  )
}
