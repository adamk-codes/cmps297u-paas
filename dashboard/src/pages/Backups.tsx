import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BadgeCheck, CalendarClock, ChevronDown, Database, GitCommitHorizontal, RotateCcw, ShieldCheck, Timer } from 'lucide-react'
import { api, type Backup } from '../api'
import { useAsync } from '../lib/hooks'
import { formatBytes, formatDuration, formatUtc, shortDigest, timeAgo } from '../lib/format'
import { BackupButton } from '../components/BackupButton'
import { RestoreModal } from '../components/RestoreModal'
import { Button, Card, Chip, CopyButton, CountBadge, cx, EmptyState, ErrorBanner, PageHeader, Spinner } from '../components/ui'

const recoverySteps = [
  { label: 'Back up', title: 'Saved with its version', text: 'Each S3 backup records the matching app image.' },
  { label: 'Restore', title: 'Restored side by side', text: 'Data goes into a new database, never over the live one.' },
  { label: 'Verify', title: 'Checked before use', text: 'The matching app runs at a separate recovery URL.' },
]

export function Backups() {
  const apps = useAsync(() => api.listApps())
  const backups = useAsync(() => api.listBackups())
  const restores = useAsync(() => api.listRestores())
  const [filter, setFilter] = useState<string>('all')
  const [backupApp, setBackupApp] = useState<string>('')
  const [restoreBackup, setRestoreBackup] = useState<Backup | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const withDb = useMemo(() => (apps.data ?? []).filter((a) => a.database), [apps.data])
  const selectedApp = backupApp || withDb[0]?.id || ''
  const all = backups.data ?? []
  const shown = filter === 'all' ? all : all.filter((b) => b.appId === filter)
  const totalSize = all.reduce((n, b) => n + b.sizeBytes, 0)
  const lastRestore = restores.data?.[0]

  function refresh() {
    apps.reload()
    backups.reload()
    restores.reload()
  }

  const th = 'px-3 py-3 text-left text-xs font-medium tracking-wider text-slate-600 uppercase first:pl-5 last:pr-5'

  return (
    <>
      <PageHeader
        eyebrow="Recovery / Backups and restores"
        title="Backups"
        actions={
          withDb.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <div className="relative">
                <label htmlFor="backup-app" className="sr-only">
                  App to back up
                </label>
                <select
                  id="backup-app"
                  value={selectedApp}
                  onChange={(e) => setBackupApp(e.target.value)}
                  className="h-12 appearance-none rounded-lg border border-slate-300 bg-white pr-10 pl-4 text-[15px] text-slate-800 shadow-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                >
                  {withDb.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-slate-500" />
              </div>
              <BackupButton
                key={selectedApp}
                appId={selectedApp}
                onDone={() => {
                  setNotice({ kind: 'ok', text: 'Backup stored in S3 with the current image version.' })
                  refresh()
                }}
                onError={(text) => setNotice({ kind: 'error', text })}
              />
            </div>
          )
        }
      />

      {notice && (
        <div
          role="status"
          className={cx(
            'mb-6 rounded-lg border px-4 py-3 text-sm',
            notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700',
          )}
        >
          {notice.text}
        </div>
      )}
      {backups.error && <ErrorBanner message={`Could not load backups: ${backups.error}`} />}

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <h2 className="text-[17px] font-medium">Backups stored</h2>
            <div className="grid size-10 place-items-center rounded-md bg-indigo-100 text-blue-700">
              <Database className="size-5" />
            </div>
          </div>
          <p className="mt-3 flex items-baseline gap-2">
            <span className="text-4xl font-semibold">{all.length}</span>
            <span className="text-sm text-slate-600">{formatBytes(totalSize)} in S3</span>
          </p>
          <p className="mt-3 text-sm text-slate-600">Encrypted with AWS KMS</p>
        </Card>
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <h2 className="text-[17px] font-medium">Last verified restore</h2>
            <div className="grid size-10 place-items-center rounded-md bg-emerald-300 text-emerald-900">
              <Timer className="size-5" />
            </div>
          </div>
          {lastRestore ? (
            <>
              <p className="mt-3 text-2xl font-semibold">{formatDuration(lastRestore.durationSeconds)}</p>
              <p className="mt-3 text-sm text-slate-600">
                {lastRestore.appName} · {lastRestore.recordsChecked.toLocaleString()} records checked ·{' '}
                {timeAgo(lastRestore.startedAt)}
              </p>
            </>
          ) : (
            <>
              <p className="mt-3 text-2xl font-semibold text-slate-400">—</p>
              <p className="mt-3 text-sm text-slate-600">Run a restore to measure recovery time.</p>
            </>
          )}
        </Card>
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <h2 className="text-[17px] font-medium">Schedule</h2>
            <div className="grid size-10 place-items-center rounded-md bg-slate-100 text-slate-600">
              <CalendarClock className="size-5" />
            </div>
          </div>
          <p className="mt-3 text-2xl font-semibold">Daily, 02:00 UTC</p>
          <p className="mt-3 text-sm text-slate-600">For every app with a PostgreSQL database</p>
        </Card>
      </div>

      <Card className="mt-8 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5">
          <h2 className="flex items-center gap-2 text-[17px] font-medium">
            Backup history <CountBadge>{shown.length} total</CountBadge>
            {backups.loading && backups.data && <Spinner className="text-slate-400" />}
          </h2>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1" role="tablist" aria-label="Filter by app">
            {[{ id: 'all', name: 'All apps' }, ...withDb].map((a) => (
              <button
                key={a.id}
                role="tab"
                aria-selected={filter === a.id}
                onClick={() => setFilter(a.id)}
                className={cx(
                  'rounded-md px-3 py-1.5 text-sm',
                  filter === a.id ? 'bg-white font-medium text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900',
                )}
              >
                {a.name}
              </button>
            ))}
          </div>
        </div>
        {!backups.data ? (
          <div className="flex justify-center py-12 text-slate-400">
            <Spinner className="size-6" />
          </div>
        ) : shown.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead className="border-y border-slate-200 bg-slate-50/60">
                <tr>
                  <th className={th}>Created</th>
                  <th className={th}>App</th>
                  <th className={th}>Trigger</th>
                  <th className={th}>App image</th>
                  <th className={th}>Size</th>
                  <th className={th}>Verification</th>
                  <th className={cx(th, 'text-right')}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50/50">
                    <td className="py-3.5 pr-3 pl-5">
                      <p className="font-medium text-slate-900">{formatUtc(b.createdAt)}</p>
                      <p className="mt-0.5 font-mono text-xs text-slate-500">{timeAgo(b.createdAt)}</p>
                    </td>
                    <td className="px-3 py-3.5">
                      <Link to={`/apps/${b.appId}`} className="font-medium text-slate-900 hover:text-blue-700">
                        {b.appName}
                      </Link>
                    </td>
                    <td className="px-3 py-3.5">
                      <Chip className="capitalize">{b.trigger}</Chip>
                    </td>
                    <td className="px-3 py-3.5">
                      <span className="inline-flex items-center gap-2 font-mono text-[13px]">
                        <GitCommitHorizontal className="size-4 text-slate-500" />
                        <span className="font-semibold">{b.image.tag}</span>
                        <span className="text-slate-500">@{shortDigest(b.image.digest)}</span>
                      </span>
                    </td>
                    <td className="px-3 py-3.5 text-slate-700">{formatBytes(b.sizeBytes)}</td>
                    <td className="px-3 py-3.5">
                      {b.verifiedAt ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-indigo-100 px-2.5 py-1 text-xs font-medium text-blue-700">
                          <BadgeCheck className="size-4" /> Verified {timeAgo(b.verifiedAt)}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-500">Not verified yet</span>
                      )}
                    </td>
                    <td className="py-3.5 pr-5 pl-3 text-right">
                      <Button variant="secondary" size="sm" onClick={() => setRestoreBackup(b)}>
                        <RotateCcw className="size-3.5" /> Restore
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No backups yet">Scheduled backups run daily at 02:00 UTC.</EmptyState>
        )}
      </Card>

      <div className="mt-8 grid gap-6 lg:grid-cols-5">
        <Card className="overflow-hidden lg:col-span-3">
          <div className="px-5 py-4">
            <h2 className="text-[17px] font-medium">Recent restores</h2>
          </div>
          {restores.data?.length ? (
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {restores.data.map((r) => (
                <li key={r.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 font-medium text-slate-900">
                      <BadgeCheck className="size-4 text-emerald-600" /> {r.appName}
                    </p>
                    <span className="text-xs text-slate-500">{formatUtc(r.startedAt)}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    {r.recordsChecked.toLocaleString()} records checked in {formatDuration(r.durationSeconds)} ·{' '}
                    <span className="font-mono text-xs">{r.targetDatabase}</span>
                  </p>
                  <p className="mt-1 flex items-center gap-1">
                    <a href={r.recoveryUrl} target="_blank" rel="noreferrer" className="truncate font-mono text-xs text-blue-700 hover:underline">
                      {r.recoveryUrl}
                    </a>
                    <CopyButton value={r.recoveryUrl} label="Copy recovery URL" />
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No restores yet">Pick a backup above and choose Restore to test it.</EmptyState>
          )}
        </Card>

        <Card className="bg-slate-900 p-6 text-white lg:col-span-2">
          <p className="flex items-center gap-2 text-xs font-semibold tracking-widest text-orange-300 uppercase">
            <ShieldCheck className="size-4" /> How recovery works
          </p>
          <ol className="mt-5 space-y-5">
            {recoverySteps.map((s, i) => (
              <li key={s.label} className="flex gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-semibold text-orange-300">
                  {i + 1}
                </span>
                <div>
                  <p className="font-semibold">{s.title}</p>
                  <p className="mt-0.5 text-sm text-slate-300">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-6 border-t border-white/10 pt-4 text-xs text-slate-400">Restores run one at a time.</p>
        </Card>
      </div>

      {restoreBackup && (
        <RestoreModal backup={restoreBackup} onClose={() => setRestoreBackup(null)} onChanged={refresh} />
      )}
    </>
  )
}
