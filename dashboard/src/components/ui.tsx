import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Box, Check, Copy, LoaderCircle, NotepadText, Server, SquareTerminal } from 'lucide-react'
import type { AppIcon, AppStatus, Health } from '../api'

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'size-12 rounded-lg' : 'size-9 rounded-lg'
  return (
    <div className="flex items-center gap-3">
      <div className={cx('grid place-items-center bg-blue-600 text-white shadow-sm', box)}>
        <Server className={size === 'lg' ? 'size-6' : 'size-5'} strokeWidth={1.75} />
      </div>
      <span className={cx('font-semibold tracking-tight text-slate-900', size === 'lg' ? 'text-xl' : 'text-[17px]')}>
        App Platform
      </span>
    </div>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-xl border border-slate-200 bg-white', className)}>{children}</div>
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-blue-600 text-white shadow-sm hover:bg-blue-700 disabled:bg-blue-300',
  secondary: 'border border-slate-300 bg-white text-slate-800 shadow-xs hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-red-600 text-white hover:bg-red-700',
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-5 text-[15px]',
        buttonStyles[variant],
        className,
      )}
    />
  )
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx('size-4 animate-spin', className)} />
}

const statusStyles: Record<AppStatus, { label: string; cls: string; dot: string }> = {
  running: { label: 'Running', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  deploying: { label: 'Deploying', cls: 'border-blue-200 bg-blue-50 text-blue-700', dot: 'bg-blue-500 animate-pulse' },
  failed: { label: 'Failed', cls: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
  stopped: { label: 'Stopped', cls: 'border-slate-200 bg-slate-50 text-slate-600', dot: 'bg-slate-400' },
}

export function StatusPill({ status }: { status: AppStatus }) {
  const s = statusStyles[status]
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', s.cls)}>
      <span className={cx('size-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  )
}

const healthLabels: Record<Health, { label: string; cls: string }> = {
  healthy: { label: 'Healthy', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  degraded: { label: 'Degraded', cls: 'border-amber-200 bg-amber-50 text-amber-700' },
  unhealthy: { label: 'Unhealthy', cls: 'border-red-200 bg-red-50 text-red-700' },
  unknown: { label: 'Pending', cls: 'border-slate-200 bg-slate-50 text-slate-600' },
}

export function HealthPill({ health }: { health: Health }) {
  const h = healthLabels[health]
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', h.cls)}>
      <span className="size-1.5 rounded-full bg-current" />
      {h.label}
    </span>
  )
}

export function healthText(health: Health) {
  return healthLabels[health].label
}

export function Chip({ children, mono, className }: { children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-xs text-slate-600',
        mono && 'font-mono',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function CountBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-blue-700">
      {children}
    </span>
  )
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cx('rounded-md bg-slate-100 px-2 py-1 font-mono text-[13px] text-slate-800', className)}>{children}</code>
  )
}

const appIcons = { terminal: SquareTerminal, notes: NotepadText, box: Box }

export function AppIconTile({ icon, className }: { icon: AppIcon; className?: string }) {
  const Icon = appIcons[icon]
  return (
    <div className={cx('grid size-10 shrink-0 place-items-center rounded-lg bg-indigo-50 text-blue-700', className)}>
      <Icon className="size-5" strokeWidth={1.75} />
    </div>
  )
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be blocked; the value is still visible to select by hand.
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
      className="grid size-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
    >
      {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
    </button>
  )
}

export function PageHeader({
  eyebrow,
  title,
  actions,
  children,
}: {
  eyebrow: ReactNode
  title: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="mb-1 text-xs font-medium tracking-wider text-slate-500 uppercase">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{title}</h1>
        {children}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {message}
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="font-medium text-slate-900">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  )
}
