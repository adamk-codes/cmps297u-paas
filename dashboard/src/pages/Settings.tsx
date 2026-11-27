import { useState, type FormEvent, type ReactNode } from 'react'
import { BadgeCheck, LogOut } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../lib/auth'
import { useAsync } from '../lib/hooks'
import { Button, Card, Chip, cx, ErrorBanner, PageHeader, Spinner } from '../components/ui'

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card className="grid gap-4 p-6 md:grid-cols-3">
      <div>
        <h2 className="font-medium text-slate-900">{title}</h2>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      </div>
      <div className="md:col-span-2">{children}</div>
    </Card>
  )
}

function Item({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-900">{value}</span>
    </div>
  )
}

// Monthly AWS Budget: emails at 50% / 80% (actual) and 100% (forecast) of the limit.
function BudgetSection() {
  const costs = useAsync(() => api.getCosts())
  const budget = costs.data?.budget
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    const limit = Number(value)
    if (!Number.isFinite(limit) || limit < 1 || limit > 10_000) {
      setMessage({ ok: false, text: 'Enter an amount between $1 and $10,000' })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const next = await api.updateBudget(limit)
      setMessage({ ok: true, text: `Budget set to $${next.limit.toFixed(2)} per month` })
      setValue('')
      await costs.reload()
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Could not update the budget' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section
      title="Monthly budget"
      description="An AWS Budget emails the team at 50% and 80% of actual spend and when the forecast passes 100%."
    >
      {costs.error && <ErrorBanner message={`Could not load the budget: ${costs.error}`} />}
      {!costs.data && !costs.error && <Spinner className="text-slate-400" />}
      {costs.data && (
        <>
          <div className="divide-y divide-slate-100">
            <Item
              label="Current limit"
              value={budget ? <span className="tabular-nums">${budget.limit.toFixed(2)} / month</span> : 'Not set up yet'}
            />
            {budget && <Item label="Spent this month" value={<span className="tabular-nums">${budget.actual.toFixed(2)}</span>} />}
            {budget && (
              <Item label="Alerts" value={budget.alertThresholds.map((t) => <Chip key={t} className="ml-1">{t}%</Chip>)} />
            )}
          </div>
          <form onSubmit={save} className="mt-4 flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium text-slate-800">New monthly limit (USD)</span>
              <span className="relative block">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-500">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={10000}
                  step="1"
                  required
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={budget ? String(budget.limit) : '40'}
                  className="h-10 w-40 rounded-lg border border-slate-300 bg-white pr-3 pl-7 tabular-nums outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                />
              </span>
            </label>
            <Button type="submit" disabled={saving || !value}>
              {saving && <Spinner />} Save budget
            </Button>
          </form>
          {message && (
            <p className={cx('mt-2 text-sm', message.ok ? 'text-emerald-700' : 'text-red-700')} role="status">
              {message.text}
            </p>
          )}
        </>
      )}
    </Section>
  )
}

export function Settings() {
  const { user, signOut } = useAuth()
  const repos = useAsync(() => api.listApprovedRepos())

  return (
    <>
      <PageHeader eyebrow="Workspace" title="Settings" />
      <div className="space-y-4">
        <Section title="Account" description="You are signed in through Amazon Cognito.">
          <div className="divide-y divide-slate-100">
            <Item label="Name" value={user?.name} />
            <Item label="Email" value={user?.email} />
            <Item label="Access" value={<Chip>Team member</Chip>} />
          </div>
          <Button variant="secondary" className="mt-3" onClick={signOut}>
            <LogOut className="size-4" /> Sign out
          </Button>
        </Section>

        <Section
          title="Approved repositories"
          description="Only these repositories can be deployed. The team manages the list in the platform config."
        >
          {repos.data ? (
            <ul className="divide-y divide-slate-100">
              {repos.data.map((r) => (
                <li key={r.fullName} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="flex min-w-0 items-center gap-2 font-mono text-[13px] break-all">
                    <BadgeCheck className="size-4 shrink-0 text-blue-600" />
                    {r.fullName}
                  </span>
                  <span className="flex gap-2">
                    <Chip mono>{r.defaultBranch}</Chip>
                    <Chip>{r.runtime}</Chip>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Spinner className="text-slate-400" />
          )}
        </Section>

        <BudgetSection />

        <Section title="Platform" description="Fixed for this prototype.">
          <div className="divide-y divide-slate-100">
            <Item label="Region" value={<span className="font-mono text-[13px]">us-east-1</span>} />
            <Item label="Runtime" value="Node.js 20 on Amazon EKS" />
            <Item label="Database engine" value="PostgreSQL 16 on a shared RDS instance" />
            <Item label="Backup schedule" value="Daily at 4:00 AM Beirut time" />
            <Item label="Backup storage" value="Amazon S3, encrypted with AWS KMS" />
          </div>
        </Section>
      </div>
    </>
  )
}
