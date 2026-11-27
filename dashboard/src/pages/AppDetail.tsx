import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, BadgeCheck, ExternalLink, GitCommitHorizontal, History, RotateCcw, ShieldCheck, Trash2, Undo2 } from 'lucide-react'
import { api, type App, type Backup, type ImageVersion, type Operation } from '../api'
import { useAsync, useOperation } from '../lib/hooks'
import { formatBytes, formatTime, formatUtc, shortDigest, timeAgo, triggerLabel } from '../lib/format'
import { BackupButton } from '../components/BackupButton'
import { Modal } from '../components/Modal'
import { DELETE_STEPS, DRILL_STEPS, Pipeline, REDEPLOY_STEPS, UNDO_STEPS } from '../components/Pipeline'
import { RestoreModal } from '../components/RestoreModal'
import {
  AppIconTile,
  Button,
  Card,
  Chip,
  CopyButton,
  cx,
  EmptyState,
  ErrorBanner,
  HealthPill,
  PageHeader,
  Spinner,
  StatusPill,
} from '../components/ui'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3 py-2.5 text-sm sm:grid-cols-[150px_1fr]">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-900">{children}</dd>
    </div>
  )
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
      <h2 className="text-[17px] font-medium text-slate-900">{children}</h2>
      {aside}
    </div>
  )
}

function RedeployModal({
  appId,
  appName,
  image,
  onClose,
  onChanged,
}: {
  appId: string
  appName: string
  image: ImageVersion
  onClose: () => void
  onChanged: () => void
}) {
  const [operationId, setOperationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const op = useOperation(operationId, () => onChanged())
  const started = operationId !== null

  async function start() {
    setError(null)
    try {
      const created = await api.redeploy(appId, image.tag)
      setOperationId(created.id)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={`Redeploy ${image.tag}`} onClose={onClose} size="md">
      <p className="text-[15px] text-slate-600">
        Roll <span className="font-medium text-slate-900">{appName}</span> back to an image already stored in ECR. Tests and
        the build are skipped because this image already passed them.
      </p>
      <div className="mt-4 rounded-lg border border-slate-200 p-3.5 font-mono text-[13px]">
        <p>
          <span className="font-semibold">{image.tag}</span> <span className="text-slate-500">@{shortDigest(image.digest)}</span>
        </p>
        <p className="mt-1 text-slate-500">
          commit {image.commit} · first deployed {formatUtc(image.deployedAt)}
        </p>
      </div>
      {error && (
        <div className="mt-4">
          <ErrorBanner message={error} />
        </div>
      )}
      <div className="my-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {op && op.status !== 'running' ? 'Close' : started ? 'Hide' : 'Cancel'}
        </Button>
        {!(op && op.status !== 'running') && (
          <Button onClick={start} disabled={started}>
            {started ? <Spinner /> : <Undo2 className="size-4" />}
            {started ? 'Redeploying…' : 'Redeploy image'}
          </Button>
        )}
      </div>
      <Pipeline title="Rollback" steps={REDEPLOY_STEPS} op={op} />
    </Modal>
  )
}

function DrillModal({ appId, appName, onClose, onChanged }: { appId: string; appName: string; onClose: () => void; onChanged: () => void }) {
  const [operationId, setOperationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const op = useOperation(operationId, () => onChanged())
  const started = operationId !== null
  const finished = op !== null && op.status !== 'running'
  const d = op?.detail

  async function start() {
    setError(null)
    try {
      setOperationId((await api.runDrill(appId)).id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title="Test the latest backup" onClose={onClose} size="md">
      <p className="text-[15px] text-slate-600">
        A recovery drill restores <span className="font-medium text-slate-900">{appName}</span>'s newest backup into a
        temporary database, checks that every table came back with exactly the rows and values the backup had,
        then deletes the copy. It works for any app, whatever its tables. The live app is never touched.
        Rebound runs this by itself every night at 5:00 AM Beirut time.
      </p>
      {error && (
        <div className="mt-4">
          <ErrorBanner message={error} />
        </div>
      )}
      {op?.status === 'succeeded' && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <BadgeCheck className="mt-0.5 size-4 shrink-0" />
          <span>
            Backup verified: {d?.recordsChecked ?? '?'}
            {d?.expectedRecords != null && ` of ${d.expectedRecords}`} rows restored and checked
            {d?.durationSeconds != null && ` in ${d.durationSeconds}s`}
            {d?.contentChecked ? ', and every value in every row matched the backup' : ''}. The temporary copy was deleted.
            {!d?.contentChecked && d?.contentNote && <span className="mt-1 block text-xs">Content: {d.contentNote}.</span>}
          </span>
        </div>
      )}
      {op?.status === 'failed' && (
        <div className="mt-4">
          <ErrorBanner message="The drill failed: this backup may not restore correctly. The team was emailed; take a new backup now." />
        </div>
      )}
      <div className="my-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {finished ? 'Close' : started ? 'Hide' : 'Cancel'}
        </Button>
        {!finished && (
          <Button variant="recover" onClick={start} disabled={started}>
            {started ? <Spinner /> : <ShieldCheck className="size-4" />}
            {started ? 'Testing…' : 'Run drill'}
          </Button>
        )}
      </div>
      {started && <Pipeline title="Recovery drill" steps={DRILL_STEPS} op={op} />}
    </Modal>
  )
}

// "Undo deploy": the previous version back, with the data as it was just before the deploy (or code only).
function UndoDeployModal({ app, onClose, onChanged }: { app: App; onClose: () => void; onChanged: () => void }) {
  // Kept from when the dialog opened: after the undo the app has no lastDeploy any more.
  const [last] = useState(() => app.lastDeploy!)
  const [mode, setMode] = useState<'data' | 'code'>('data')
  const [operationId, setOperationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const op = useOperation(operationId, () => onChanged())
  const started = operationId !== null
  const finished = op !== null && op.status !== 'running'
  const since = formatUtc(last.deployedAt)

  async function start() {
    setError(null)
    try {
      const created =
        mode === 'data' ? await api.undoDeploy(app.id, last.imageTag) : await api.redeploy(app.id, last.previousImageTag)
      setOperationId(created.id)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const options = [
    {
      value: 'data' as const,
      title: 'Undo code and data',
      body: (
        <>
          {last.previousImageTag} comes back with the data exactly as it was just before the deploy. Anything users changed
          since {since} is saved in a "Before undo" backup and the current database is kept, so nothing is deleted. The
          app pauses for about a minute. Use this when the new version damaged data.
        </>
      ),
    },
    {
      value: 'code' as const,
      title: 'Undo code only',
      body: (
        <>
          {last.previousImageTag} comes back and keeps all current data, including what users changed since the deploy. Use
          this when the new version was buggy but the data is fine.
        </>
      ),
    },
  ]

  return (
    <Modal title="Undo last deploy" onClose={onClose} size="md">
      <p className="text-[15px] text-slate-600">
        <span className="font-mono font-semibold text-slate-900">{last.imageTag}</span> went live {since} (
        {timeAgo(last.deployedAt)}). Rebound backed up <span className="font-medium text-slate-900">{app.name}</span>'s data
        just before, so it can put back <span className="font-mono font-semibold text-slate-900">{last.previousImageTag}</span>.
      </p>
      {!started && (
        <fieldset className="mt-4 space-y-2">
          <legend className="sr-only">What to undo</legend>
          {options.map((o) => (
            <label
              key={o.value}
              className={cx(
                'flex cursor-pointer gap-3 rounded-lg border p-3.5',
                mode === o.value ? 'border-blue-500 bg-blue-50/60' : 'border-slate-200 hover:border-slate-300',
              )}
            >
              <input
                type="radio"
                name="undo-mode"
                className="mt-1 size-4 accent-blue-600"
                checked={mode === o.value}
                onChange={() => setMode(o.value)}
              />
              <span>
                <span className="block text-sm font-medium text-slate-900">{o.title}</span>
                <span className="mt-0.5 block text-sm text-slate-600">{o.body}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <div className="mt-4">
          <ErrorBanner message={error} />
        </div>
      )}
      {op?.status === 'succeeded' && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <BadgeCheck className="mt-0.5 size-4 shrink-0" />
          {op.kind === 'undo' ? (
            <span>
              {last.previousImageTag} is live again on the data from {since}
              {op.detail?.downtimeSeconds != null && ` (paused ${op.detail.downtimeSeconds}s)`}. What users changed since is
              in the "Before undo" backup on the{' '}
              <Link to="/backups" className="font-medium underline">
                Backups
              </Link>{' '}
              page{op.detail?.keptDatabase && <>, and the previous database is kept as <span className="font-mono">{op.detail.keptDatabase}</span></>}.
            </span>
          ) : (
            <span>{last.previousImageTag} is live again. The data was not changed.</span>
          )}
        </div>
      )}
      {op?.status === 'failed' && (
        <div className="mt-4">
          <ErrorBanner
            message={`${op.steps.find((s) => s.state === 'failed')?.label ?? 'A step'} failed. Nothing was deleted: the app keeps its current data, and the team was emailed.`}
          />
        </div>
      )}
      <div className="my-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {finished ? 'Close' : started ? 'Hide' : 'Cancel'}
        </Button>
        {!finished && (
          <Button onClick={start} disabled={started}>
            {started ? <Spinner /> : <History className="size-4" />}
            {started ? 'Undoing…' : mode === 'data' ? 'Undo code and data' : 'Undo code only'}
          </Button>
        )}
      </div>
      {started && (
        <Pipeline
          title={mode === 'data' ? 'Undo deploy' : 'Rollback'}
          steps={mode === 'data' ? UNDO_STEPS : REDEPLOY_STEPS}
          op={op}
        />
      )}
    </Modal>
  )
}

// How old the data is: "6 hours", "25 min".
function ageText(iso: string): string {
  return timeAgo(iso).replace(/ ago$/, '').replace('just now', 'under a minute')
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}

// Recovery scorecard: measured numbers for this app, not promises. How much data a failure right now could
// lose (age of the newest backup), how long getting it back takes (real restores and drills), and the last test.
function RecoveryScorecard({ appId, backups }: { appId: string; backups: Backup[] | null }) {
  const ops = useAsync(() => api.listOperations(200), [appId, backups])
  const newest = backups?.find((b) => b.status === 'completed')
  const mine = (ops.data ?? []).filter((o) => o.appId === appId)
  const timed = mine
    .filter((o) => o.status === 'succeeded' && (o.kind === 'restore' || o.kind === 'drill'))
    .map((o: Operation) => (o.kind === 'restore' ? o.result?.durationSeconds : o.detail?.durationSeconds))
    .filter((s): s is number => typeof s === 'number')
    .slice(0, 5)
  const lastDrill = mine.find((o) => o.kind === 'drill' && o.status !== 'running')
  const stale = newest ? Date.now() - Date.parse(newest.createdAt) > 26 * 3600_000 : true

  const tiles: { label: string; value: string; note: string; tone: 'good' | 'warn' | 'none' }[] = [
    {
      label: 'Data you could lose',
      value: newest ? `at most ${ageText(newest.createdAt)}` : 'everything',
      note: newest ? `Newest backup: ${formatUtc(newest.createdAt)}` : 'No backup yet: take one now',
      tone: newest && !stale ? 'good' : 'warn',
    },
    {
      label: 'Time to get it back',
      value: timed.length ? `about ${median(timed)}s` : 'not measured',
      note: timed.length
        ? `Median of the last ${timed.length} restore${timed.length === 1 ? '' : 's'} and drills (${Math.min(...timed)}–${Math.max(...timed)}s)`
        : 'Run "Test latest" to measure it',
      tone: timed.length ? 'good' : 'none',
    },
    {
      label: 'Last recovery test',
      value: !lastDrill ? 'never' : lastDrill.status === 'succeeded' ? 'passed' : 'failed',
      note: lastDrill
        ? `${lastDrill.startedBy ? 'Run by hand' : 'Nightly drill'}, ${timeAgo(lastDrill.startedAt)}`
        : 'Runs every night at 5:00 AM Beirut time',
      tone: !lastDrill ? 'none' : lastDrill.status === 'succeeded' ? 'good' : 'warn',
    },
  ]
  return (
    <Card className="mt-6 overflow-hidden">
      <SectionTitle aside={<span className="text-sm text-slate-500">Measured on this app, not estimated</span>}>
        Recovery scorecard
      </SectionTitle>
      <div className="grid gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.label} className="bg-white px-5 py-4">
            <p className="text-sm text-slate-500">{t.label}</p>
            <p
              className={cx(
                'mt-1 text-2xl font-semibold',
                t.tone === 'good' ? 'text-slate-900' : t.tone === 'warn' ? 'text-red-600' : 'text-slate-400',
              )}
            >
              {ops.data || t.label === 'Data you could lose' ? t.value : '…'}
            </p>
            <p className="mt-1 text-xs text-slate-500">{t.note}</p>
          </div>
        ))}
      </div>
    </Card>
  )
}

function DeleteAppModal({ appId, appName, onClose }: { appId: string; appName: string; onClose: () => void }) {
  const navigate = useNavigate()
  const [typed, setTyped] = useState('')
  const [operationId, setOperationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const op = useOperation(operationId)
  const started = operationId !== null
  const finished = op !== null && op.status !== 'running'

  async function start() {
    setError(null)
    try {
      const created = await api.deleteApp(appId)
      setOperationId(created.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={`Delete ${appName}`} onClose={onClose} size="md">
      <p className="text-[15px] text-slate-600">
        This stops <span className="font-medium text-slate-900">{appName}</span>, removes its recovery copy and daily backup,
        and drops its database and login. <span className="font-medium text-slate-900">Its backups stay in S3</span>, so the
        data can still be restored later.
      </p>
      {!started && (
        <label className="mt-4 block text-sm text-slate-700">
          Type <span className="font-mono font-semibold">{appName}</span> to confirm
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 font-mono text-sm focus:border-red-500 focus:outline-none"
          />
        </label>
      )}
      {error && (
        <div className="mt-4">
          <ErrorBanner message={error} />
        </div>
      )}
      {op?.status === 'failed' && (
        <div className="mt-4">
          <ErrorBanner
            message={`${op.steps.find((s) => s.state === 'failed')?.label ?? 'A step'} failed. Its backups are untouched; try again or check the API logs.`}
          />
        </div>
      )}
      <div className="my-5 flex justify-end gap-2">
        {op?.status === 'succeeded' ? (
          <Button onClick={() => navigate('/apps')}>Back to apps</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {finished ? 'Close' : started ? 'Hide' : 'Cancel'}
            </Button>
            {!finished && (
              <Button variant="danger" onClick={start} disabled={started || typed !== appName}>
                {started ? <Spinner /> : <Trash2 className="size-4" />}
                {started ? 'Deleting…' : 'Delete app'}
              </Button>
            )}
          </>
        )}
      </div>
      {started && <Pipeline title="Delete" steps={DELETE_STEPS} op={op} />}
    </Modal>
  )
}

export function AppDetail() {
  const { appId = '' } = useParams()
  const app = useAsync(() => api.getApp(appId), [appId])
  const backups = useAsync(() => api.listBackups(appId), [appId])
  const logs = useAsync(() => api.getLogs(appId), [appId])
  const [redeployImage, setRedeployImage] = useState<ImageVersion | null>(null)
  const [restoreBackup, setRestoreBackup] = useState<Backup | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [drilling, setDrilling] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const a = app.data
  const deploying = a?.status === 'deploying'
  useEffect(() => {
    if (!deploying) return
    const t = setInterval(app.reload, 2000)
    return () => clearInterval(t)
  }, [deploying, app.reload])

  function refresh() {
    app.reload()
    backups.reload()
  }

  if (app.error && !a)
    return (
      <div className="space-y-4">
        <ErrorBanner message={app.error} />
        <Link to="/apps" className="inline-flex items-center gap-2 text-sm font-medium text-blue-700">
          <ArrowLeft className="size-4" /> Back to apps
        </Link>
      </div>
    )
  if (!a)
    return (
      <div className="flex justify-center py-24 text-slate-400">
        <Spinner className="size-6" />
      </div>
    )

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/apps" className="hover:text-slate-800">
            Apps / {a.name}
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            <AppIconTile icon={a.icon} className="size-11" />
            {a.name}
            <StatusPill status={a.status} />
          </span>
        }
        actions={
          <>
            {a.database && (
              <BackupButton
                appId={a.id}
                disabled={a.status !== 'running'}
                onDone={() => {
                  setNotice({ kind: 'ok', text: 'Backup stored in S3 with the current image version.' })
                  refresh()
                }}
                onError={(text) => setNotice({ kind: 'error', text })}
              />
            )}
            <a
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-12 items-center gap-2 rounded-lg bg-blue-600 px-5 text-[15px] font-medium text-white shadow-sm hover:bg-blue-700"
            >
              Open app <ExternalLink className="size-4" />
            </a>
            <Button variant="secondary" size="lg" onClick={() => setDeleting(true)} aria-label={`Delete ${a.name}`}>
              <Trash2 className="size-4 text-red-600" /> Delete
            </Button>
          </>
        }
      >
        <p className="mt-2 text-slate-600">{a.description}</p>
      </PageHeader>

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

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>Overview</SectionTitle>
          <dl className="divide-y divide-slate-100 border-t border-slate-100 px-5 pb-2">
            <Row label="URL">
              <span className="flex items-center gap-1">
                <code className="truncate rounded-md bg-slate-100 px-2 py-1 font-mono text-[13px]">{a.url}</code>
                <CopyButton value={a.url} label="Copy URL" />
              </span>
            </Row>
            <Row label="Repository">
              <span className="font-mono text-[13px] break-all">{a.repo}</span>
            </Row>
            <Row label="Source">
              <span className="font-mono text-[13px]">
                git:{a.branch}@{a.image.commit}
              </span>
            </Row>
            <Row label="Runtime">
              <Chip>{a.runtime}</Chip>
            </Row>
            <Row label="Region">
              <span className="font-mono text-[13px]">{a.region}</span>
            </Row>
            <Row label="Database">
              {a.database ? (
                <span>
                  {a.database.engine} {a.database.version} ·{' '}
                  <span className="font-mono text-[13px]">{a.database.name}</span>
                </span>
              ) : (
                <span className="text-slate-500">None</span>
              )}
            </Row>
          </dl>
        </Card>

        <Card>
          <SectionTitle>Health</SectionTitle>
          <div className="space-y-4 border-t border-slate-100 px-5 py-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">Health check</span>
              <HealthPill health={a.health} />
            </div>
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-slate-500">Pods ready</span>
                <span className="text-2xl font-semibold">
                  {a.pods.ready}/{a.pods.desired}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${a.pods.desired ? (a.pods.ready / a.pods.desired) * 100 : 0}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-slate-500">Scales out automatically when CPU load rises.</p>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Last backup</span>
              <span>{a.lastBackupAt ? timeAgo(a.lastBackupAt) : '—'}</span>
            </div>
          </div>
        </Card>
      </div>

      {a.database && <RecoveryScorecard appId={a.id} backups={backups.data} />}

      <Card className="mt-6 overflow-hidden">
        <SectionTitle
          aside={
            a.lastDeploy && a.status === 'running' ? (
              <span className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-slate-500">Data was backed up before {a.lastDeploy.imageTag} went live</span>
                <Button variant="secondary" size="sm" onClick={() => setUndoing(true)}>
                  <History className="size-3.5" /> Undo last deploy
                </Button>
              </span>
            ) : (
              <span className="text-sm text-slate-500">Images stored in Amazon ECR</span>
            )
          }
        >
          Image history
        </SectionTitle>
        {a.history.length ? (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {a.history.map((img, i) => (
              <li key={img.tag} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <div className="flex min-w-0 items-center gap-3">
                  <GitCommitHorizontal className="size-4 shrink-0 text-slate-500" />
                  <span className="font-mono text-[13px] font-semibold">{img.tag}</span>
                  <span className="truncate font-mono text-[13px] text-slate-500">@{shortDigest(img.digest)}</span>
                  <span className="hidden font-mono text-xs text-slate-500 sm:inline">commit {img.commit}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-slate-600">{formatUtc(img.deployedAt)}</span>
                  {i === 0 && a.status === 'running' ? (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">Current</span>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => setRedeployImage(img)} disabled={deploying}>
                      <Undo2 className="size-3.5" /> Redeploy
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No images yet">The first image appears after a successful deployment.</EmptyState>
        )}
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <SectionTitle
            aside={
              <span className="flex items-center gap-3">
                {a.database && !!backups.data?.some((b) => b.status === 'completed') && (
                  <Button variant="secondary" size="sm" onClick={() => setDrilling(true)}>
                    <ShieldCheck className="size-3.5 text-recover-dark" /> Test latest
                  </Button>
                )}
                <Link to="/backups" className="text-sm font-medium text-blue-700 hover:text-blue-800">
                  All backups
                </Link>
              </span>
            }
          >
            Backups
          </SectionTitle>
          {!a.database ? (
            <EmptyState title="No database">This app was deployed without a PostgreSQL database.</EmptyState>
          ) : backups.data?.length ? (
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {backups.data.slice(0, 5).map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{formatUtc(b.createdAt)}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                      <span>{triggerLabel(b.trigger)}</span>· {formatBytes(b.sizeBytes)} ·
                      <span className="font-mono">{b.image.tag}</span>
                      {b.verifiedAt && (
                        <span className="flex items-center gap-1 text-recover-dark">
                          <BadgeCheck className="size-3.5" /> Verified
                        </span>
                      )}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setRestoreBackup(b)}>
                    <RotateCcw className="size-3.5" /> Restore
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No backups yet">The first scheduled backup runs at 4:00 AM Beirut time.</EmptyState>
          )}
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle aside={<span className="text-sm text-slate-500">Last 200 lines, from Kubernetes</span>}>Recent logs</SectionTitle>
          <div className="max-h-80 overflow-auto bg-slate-900 px-5 py-4 font-mono text-xs leading-6">
            {logs.data?.map((l, i) => (
              <p key={i} className="whitespace-pre-wrap">
                <span className="text-slate-500">{formatTime(l.ts)}</span>{' '}
                <span className={l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-300' : 'text-emerald-400'}>
                  {l.level.toUpperCase().padEnd(5)}
                </span>{' '}
                <span className="text-slate-200">{l.message}</span>
              </p>
            )) ?? <p className="text-slate-500">Loading logs…</p>}
          </div>
        </Card>
      </div>

      {redeployImage && (
        <RedeployModal
          appId={a.id}
          appName={a.name}
          image={redeployImage}
          onClose={() => setRedeployImage(null)}
          onChanged={refresh}
        />
      )}
      {drilling && (
        <DrillModal appId={a.id} appName={a.name} onClose={() => setDrilling(false)} onChanged={() => backups.reload()} />
      )}
      {undoing && <UndoDeployModal app={a} onClose={() => setUndoing(false)} onChanged={refresh} />}
      {deleting && <DeleteAppModal appId={a.id} appName={a.name} onClose={() => setDeleting(false)} />}
      {restoreBackup && (
        <RestoreModal backup={restoreBackup} onClose={() => setRestoreBackup(null)} onChanged={() => backups.reload()} />
      )}
    </>
  )
}
