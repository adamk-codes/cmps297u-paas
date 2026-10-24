import type { ReactNode } from 'react'
import { BadgeCheck, LogOut } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../lib/auth'
import { useAsync } from '../lib/hooks'
import { Button, Card, Chip, PageHeader, Spinner } from '../components/ui'

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

        <Section title="Platform" description="Fixed for this prototype.">
          <div className="divide-y divide-slate-100">
            <Item label="Region" value={<span className="font-mono text-[13px]">us-east-1</span>} />
            <Item label="Runtime" value="Node.js 20" />
            <Item label="Database engine" value="PostgreSQL 16.3 on a shared RDS instance" />
            <Item label="Backup schedule" value="Daily at 02:00 UTC" />
            <Item label="Backup storage" value="Amazon S3, encrypted with AWS KMS" />
          </div>
        </Section>
      </div>
    </>
  )
}
