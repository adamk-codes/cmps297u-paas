import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Archive, CalendarClock, DatabaseBackup, History, Rocket, ShieldCheck, Trash2, Undo2 } from 'lucide-react'
import { api, type Backup, type Operation, type OperationKind } from '../api'
import { useAsync } from '../lib/hooks'
import { formatUtc, timeAgo } from '../lib/format'
import { Card, cx, EmptyState, ErrorBanner, PageHeader, Spinner } from '../components/ui'

// Audit trail: every deploy, redeploy, backup, restore and delete, with the team member who started it
// (their Cognito sign-in), plus the scheduled backups the platform takes on its own.

interface Entry {
  id: string
  at: string
  who: string | null // null = the platform itself (daily schedule)
  email?: string
  action: string
  appId: string
  status: Operation['status'] | 'scheduled'
  seconds?: number
  icon: ReactNode
}

const ACTIONS: Record<OperationKind, { verb: string; icon: ReactNode }> = {
  deploy: { verb: 'deployed', icon: <Rocket className="size-4" /> },
  redeploy: { verb: 'rolled back', icon: <Undo2 className="size-4" /> },
  backup: { verb: 'backed up', icon: <Archive className="size-4" /> },
  restore: { verb: 'restored', icon: <DatabaseBackup className="size-4" /> },
  delete: { verb: 'deleted', icon: <Trash2 className="size-4" /> },
  drill: { verb: 'tested the latest backup of', icon: <ShieldCheck className="size-4" /> },
  undo: { verb: 'undid the last deploy (code and data) of', icon: <History className="size-4" /> },
}

const nameOf = (email: string) =>
  email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

function fromOperation(op: Operation): Entry {
  const a = ACTIONS[op.kind]
  return {
    id: op.id,
    at: op.startedAt,
    // No startedBy: the platform did it itself (the nightly drill), or auth was off.
    who: op.startedBy ? nameOf(op.startedBy) : op.kind === 'drill' ? 'Nightly drill' : 'Someone',
    email: op.startedBy,
    action: a.verb,
    appId: op.appId,
    status: op.status,
    seconds: op.finishedAt
      ? Math.max(1, Math.round((Date.parse(op.finishedAt) - Date.parse(op.startedAt)) / 1000))
      : undefined,
    icon: a.icon,
  }
}

function fromScheduledBackup(b: Backup): Entry {
  return {
    id: b.id,
    at: b.createdAt,
    who: null,
    action: 'backed up',
    appId: b.appId,
    status: 'scheduled',
    icon: <CalendarClock className="size-4" />,
  }
}

const STATUS: Record<Entry['status'], { label: string; cls: string }> = {
  running: { label: 'Running', cls: 'border-blue-200 bg-blue-50 text-blue-700' },
  succeeded: { label: 'Succeeded', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  failed: { label: 'Failed', cls: 'border-red-200 bg-red-50 text-red-700' },
  scheduled: { label: 'Scheduled', cls: 'border-slate-200 bg-slate-50 text-slate-600' },
}

export function Activity() {
  const feed = useAsync(async () => {
    const [ops, backups] = await Promise.all([api.listOperations(100), api.listBackups().catch(() => [])])
    return [...ops.map(fromOperation), ...backups.filter((b) => b.trigger === 'scheduled').map(fromScheduledBackup)]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 100)
  })

  // Keep running entries moving without a manual refresh.
  const running = feed.data?.some((e) => e.status === 'running')
  useEffect(() => {
    if (!running) return
    const t = setInterval(feed.reload, 3000)
    return () => clearInterval(t)
  }, [running, feed.reload])

  return (
    <>
      <PageHeader eyebrow="Platform / Audit trail" title="Activity">
        <p className="mt-2 text-slate-600">
          Who deployed, backed up, restored or deleted what, newest first, plus the nightly backups and recovery
          drills. Names come from each person's sign-in.
        </p>
      </PageHeader>
      {feed.error && !feed.data && <ErrorBanner message={feed.error} />}
      <Card>
        {!feed.data && !feed.error ? (
          <div className="flex justify-center py-16 text-slate-400">
            <Spinner className="size-6" />
          </div>
        ) : feed.data && feed.data.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {feed.data.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-5 py-4">
                <span
                  className={cx(
                    'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg',
                    e.status === 'failed' ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-600',
                  )}
                >
                  {e.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] text-slate-700">
                    <span className="font-medium text-slate-900" title={e.email}>
                      {e.who ?? 'Daily schedule'}
                    </span>{' '}
                    {e.action}{' '}
                    <Link to={`/apps/${e.appId}`} className="font-mono text-[14px] text-blue-700 hover:underline">
                      {e.appId}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-sm text-slate-500" title={formatUtc(e.at)}>
                    {timeAgo(e.at)} · {formatUtc(e.at)}
                    {e.seconds !== undefined && ` · took ${e.seconds}s`}
                  </p>
                </div>
                <span
                  className={cx(
                    'shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium',
                    STATUS[e.status].cls,
                  )}
                >
                  {STATUS[e.status].label}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No activity yet">Events show up here as the team deploys and recovers apps.</EmptyState>
        )}
      </Card>
    </>
  )
}
