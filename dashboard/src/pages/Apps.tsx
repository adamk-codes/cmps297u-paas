import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BadgeCheck,
  CircleCheck,
  GitCommitHorizontal,
  Grip,
  History,
  Plus,
  Rocket,
  Server,
  ShieldCheck,
  TriangleAlert,
  Activity,
} from 'lucide-react'
import { api, type App, type Backup } from '../api'
import { useAsync } from '../lib/hooks'
import { formatUtc, shortDigest, timeAgo } from '../lib/format'
import { DeployModal } from '../components/DeployModal'
import {
  AppIconTile,
  Button,
  Card,
  Chip,
  CopyButton,
  CountBadge,
  cx,
  EmptyState,
  ErrorBanner,
  healthText,
  PageHeader,
  Spinner,
  StatusPill,
} from '../components/ui'

function StatCard({
  title,
  icon,
  iconCls,
  children,
}: {
  title: string
  icon: ReactNode
  iconCls: string
  children: ReactNode
}) {
  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-[17px] font-medium text-slate-900">{title}</h2>
        <div className={cx('grid size-10 place-items-center rounded-md', iconCls)}>{icon}</div>
      </div>
      <div className="mt-3">{children}</div>
    </Card>
  )
}

function Stats({ apps, backups }: { apps: App[]; backups: Backup[] }) {
  const ready = apps.reduce((n, a) => n + a.pods.ready, 0)
  const desired = apps.reduce((n, a) => n + a.pods.desired, 0)
  const pct = desired ? Math.round((ready / desired) * 100) : 0
  const unhealthy = apps.filter((a) => a.status === 'running' && a.health !== 'healthy').length
  const failing = apps.filter((a) => a.status === 'failed').length
  const latest = backups[0]

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <StatCard title="Total apps" icon={<Grip className="size-5" />} iconCls="bg-indigo-100 text-blue-700">
        <p className="flex items-baseline gap-2">
          <span className="text-4xl font-semibold text-slate-900">{apps.length}</span>
          <span className="text-sm text-slate-600">provisioned</span>
        </p>
        <p className="mt-3 flex items-center gap-2 text-sm text-slate-600">
          <span className="size-1.5 rounded-full bg-slate-500" /> Active regional namespace in us-east-1
        </p>
      </StatCard>

      <StatCard title="Healthy pods" icon={<Activity className="size-5" />} iconCls="bg-emerald-300 text-emerald-900">
        <p className="flex items-baseline gap-2">
          <span className="text-4xl font-semibold text-slate-900">
            {ready}/{desired}
          </span>
          <span
            className={cx(
              'rounded-full border px-2 py-0.5 text-xs font-medium',
              pct === 100 ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700',
            )}
          >
            {pct}%
          </span>
        </p>
        {unhealthy + failing === 0 && pct === 100 ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700">
            <CircleCheck className="size-4" /> All operational health checks passing
          </p>
        ) : (
          <p className="mt-3 flex items-center gap-2 text-sm text-amber-700">
            <TriangleAlert className="size-4" />
            {failing ? `${failing} deployment${failing === 1 ? '' : 's'} failed` : 'Pods are starting or unhealthy'}
          </p>
        )}
      </StatCard>

      <StatCard title="Last backup" icon={<History className="size-5" />} iconCls="bg-slate-100 text-slate-600">
        {latest ? (
          <>
            <p className="text-2xl font-semibold text-slate-900">{timeAgo(latest.createdAt)}</p>
            <p className="mt-3 flex flex-wrap items-center gap-x-2 text-sm text-slate-600">
              {latest.verifiedAt ? (
                <span className="flex items-center gap-1.5 text-emerald-700">
                  <BadgeCheck className="size-4" /> Backup verified
                </span>
              ) : (
                <span>{latest.appName}</span>
              )}
              · {latest.trigger === 'scheduled' ? 'Scheduled backup' : 'Manual backup'}
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-600">No backups yet</p>
        )}
      </StatCard>
    </div>
  )
}

function DeploymentsTable({ apps }: { apps: App[] }) {
  const th = 'px-3 py-3 text-left text-xs font-medium tracking-wider text-slate-600 uppercase first:pl-5 last:pr-5'
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1080px] text-sm">
        <thead className="border-y border-slate-200 bg-slate-50/60">
          <tr>
            <th className={th}>Application</th>
            <th className={th}>Status &amp; health</th>
            <th className={th}>Internal endpoint</th>
            <th className={th}>Image version</th>
            <th className={th}>Deployment &amp; backup</th>
            <th className={cx(th, 'text-right')}>Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {apps.map((app) => (
            <tr key={app.id} className="align-middle hover:bg-slate-50/50">
              <td className="py-4 pr-3 pl-5">
                <div className="flex gap-3">
                  <AppIconTile icon={app.icon} />
                  <div className="min-w-0">
                    <Link to={`/apps/${app.id}`} className="font-semibold text-slate-900 hover:text-blue-700">
                      {app.name}
                    </Link>
                    <div className="mt-1">
                      <Chip>{app.runtime}</Chip>
                    </div>
                    <p className="mt-1.5 max-w-52 truncate text-slate-600" title={app.description}>
                      {app.description}
                    </p>
                  </div>
                </div>
              </td>
              <td className="px-3 py-4">
                <StatusPill status={app.status} />
                <p className="mt-1.5 text-xs text-slate-500">{healthText(app.health)}</p>
              </td>
              <td className="px-3 py-4">
                <div className="flex items-center gap-1">
                  <code className="max-w-36 truncate rounded-md bg-slate-100 px-2 py-1.5 font-mono text-[13px] text-slate-800" title={app.url}>
                    {app.url}
                  </code>
                  <CopyButton value={app.url} label="Copy URL" />
                </div>
              </td>
              <td className="px-3 py-4">
                <span className="inline-flex max-w-52 items-center gap-2 rounded-md bg-slate-100 px-2.5 py-1.5 font-mono text-[13px]">
                  <GitCommitHorizontal className="size-4 shrink-0 text-slate-500" />
                  <span className="font-semibold text-slate-900">{app.image.tag}</span>
                  <span className="truncate text-slate-500">@{shortDigest(app.image.digest)}</span>
                </span>
              </td>
              <td className="px-3 py-4 text-slate-700">
                <p className="flex items-center gap-2">
                  <Rocket className="size-4 shrink-0 text-slate-500" />
                  {app.status === 'deploying' ? 'Deploying now' : formatUtc(app.image.deployedAt)}
                </p>
                <p className="mt-1.5 flex items-center gap-2">
                  <History className="size-4 shrink-0 text-slate-500" />
                  {app.lastBackupAt ? formatUtc(app.lastBackupAt) : app.database ? 'No backups yet' : 'No database'}
                </p>
              </td>
              <td className="py-4 pr-5 pl-3 text-right">
                <Link
                  to={`/apps/${app.id}`}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-800 shadow-xs hover:bg-slate-50"
                >
                  Manage <ArrowRight className="size-4" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Apps() {
  const apps = useAsync(() => api.listApps())
  const backups = useAsync(() => api.listBackups())
  const [deployOpen, setDeployOpen] = useState(false)

  // Keep the table live while something is deploying.
  const deploying = apps.data?.some((a) => a.status === 'deploying')
  useEffect(() => {
    if (!deploying) return
    const t = setInterval(apps.reload, 2000)
    return () => clearInterval(t)
  }, [deploying, apps.reload])

  const list = apps.data ?? []

  return (
    <>
      <PageHeader
        eyebrow="Overview / Production workloads"
        title="Apps"
        actions={
          <Button size="lg" onClick={() => setDeployOpen(true)}>
            <Plus className="size-5" /> Deploy new app
          </Button>
        }
      />

      {apps.error && <ErrorBanner message={`Could not load apps: ${apps.error}`} />}

      {apps.data && backups.data ? (
        <Stats apps={list} backups={backups.data} />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="h-[168px] animate-pulse bg-slate-100/60">
              <span className="sr-only">Loading</span>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-8 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5">
          <h2 className="flex items-center gap-2 text-[17px] font-medium text-slate-900">
            Active deployments <CountBadge>{list.length} total</CountBadge>
            {apps.loading && apps.data && <Spinner className="text-slate-400" />}
          </h2>
          <span className="flex items-center gap-2 text-sm text-slate-600">
            <Server className="size-4" /> Region: us-east-1
          </span>
        </div>
        {!apps.data ? (
          <div className="flex justify-center py-12 text-slate-400">
            <Spinner className="size-6" />
          </div>
        ) : list.length ? (
          <DeploymentsTable apps={list} />
        ) : (
          <EmptyState title="No apps yet">Deploy an approved repository to get started.</EmptyState>
        )}
      </Card>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-indigo-50 px-5 py-4">
        <div className="flex items-center gap-4">
          <div className="grid size-11 place-items-center rounded-md bg-emerald-300 text-emerald-900">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <p className="font-medium text-slate-900">Region us-east-1 operational</p>
            <p className="text-sm text-slate-600">Daily scheduled backups are enabled for apps with PostgreSQL.</p>
          </div>
        </div>
        <span className="rounded-md bg-white px-3 py-1.5 font-mono text-xs text-slate-600">App Platform</span>
      </div>

      {deployOpen && (
        <DeployModal
          existingNames={list.map((a) => a.name)}
          onClose={() => setDeployOpen(false)}
          onChanged={() => {
            apps.reload()
            backups.reload()
          }}
        />
      )}
    </>
  )
}
