import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { Button, ErrorBanner, Logo, Spinner } from '../components/ui'

const inputCls =
  'h-11 w-full rounded-lg border border-slate-300 bg-white pl-11 text-[15px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20'

export function SignIn() {
  const { user, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/apps'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (user) return <Navigate to={from} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await signIn(email.trim(), password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-[545px] rounded-2xl border border-slate-100 bg-white px-6 py-10 shadow-xl shadow-slate-200/70 sm:px-10">
        <div className="flex justify-center">
          <Logo size="lg" />
        </div>
        <h1 className="mt-10 text-center text-[22px] font-semibold tracking-tight text-slate-900">Sign in to your account</h1>
        <p className="mt-1 text-center text-sm text-slate-600">Enter your operational credentials</p>

        <form onSubmit={onSubmit} className="mt-8 space-y-5" noValidate>
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-800">
              Email address
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-slate-500" strokeWidth={1.5} />
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-800">
              Password
            </label>
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-slate-500" strokeWidth={1.5} />
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className={`${inputCls} pr-11`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-slate-500 hover:text-slate-800"
              >
                {showPassword ? <EyeOff className="size-5" strokeWidth={1.5} /> : <Eye className="size-5" strokeWidth={1.5} />}
              </button>
            </div>
          </div>

          {error && <ErrorBanner message={error} />}

          <Button type="submit" size="lg" className="w-full" disabled={submitting}>
            {submitting ? <Spinner /> : null}
            Sign in
            {!submitting && <ArrowRight className="size-5" />}
          </Button>
        </form>

        <div className="mt-6 border-t border-slate-200 pt-6 text-center text-sm text-slate-600">
          Access is limited to team members.
        </div>
      </div>
      <p className="mt-8 flex items-center gap-2 font-mono text-xs text-slate-500">
        <span className="size-1.5 rounded-full bg-emerald-600" />
        Internal Cloud Workspace
      </p>
    </div>
  )
}
