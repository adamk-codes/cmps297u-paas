import { useState, type ReactNode } from 'react'
import { BadgeCheck, Database, ExternalLink, GitCommitHorizontal, Info, RotateCcw } from 'lucide-react'
import { api, type Backup } from '../api'
import { useOperation } from '../lib/hooks'
import { formatDuration, formatUtc, shortDigest } from '../lib/format'
import { Modal } from './Modal'
import { Pipeline, RESTORE_STEPS } from './Pipeline'
import { Button, CopyButton, ErrorBanner, Spinner } from './ui'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3.5">
      <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">{label}</p>
      <div className="mt-1.5 text-sm text-slate-900">{children}</div>
    </div>
  )
}

export function RestoreModal({
  backup,
  onClose,
  onChanged,
}: {
  backup: Backup
  onClose: () => void
  onChanged: () => void
}) {
  const [operationId, setOperationId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const op = useOperation(operationId, () => onChanged())
  const result = op?.result
  const started = operationId !== null
  const running = started && (!op || op.status === 'running')

  async function start() {
    setSubmitting(true)
    setError(null)
    try {
      const created = await api.restore(backup.id)
      setOperationId(created.id)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title={`Restore ${backup.appName}`} onClose={onClose}>
      <p className="font-mono text-xs font-medium tracking-wider text-blue-700 uppercase">Recovery workbench · us-east-1</p>
      <p className="mt-1 text-[15px] text-slate-600">
        The backup is restored into a new database and checked with the app image it was taken with.
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Fact label="Backup">
          <p>{formatUtc(backup.createdAt)}</p>
          <p className="mt-0.5 text-xs text-slate-500 capitalize">{backup.trigger}</p>
        </Fact>
        <Fact label="App image">
          <p className="flex items-center gap-1.5 font-mono text-[13px]">
            <GitCommitHorizontal className="size-4 text-slate-500" />
            <span className="font-semibold">{backup.image.tag}</span>
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-slate-500">@{shortDigest(backup.image.digest)}</p>
        </Fact>
        <Fact label="Target">
          <p className="flex items-center gap-1.5">
            <Database className="size-4 text-slate-500" /> New database
          </p>
          <p className="mt-0.5 text-xs text-slate-500">The live database is not touched</p>
        </Fact>
      </div>

      <p className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
        <Info className="mt-0.5 size-4 shrink-0" />
        A restore returns the data to the backup time; changes made after it are not included.
      </p>

      {error && (
        <div className="mt-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {result && op?.status === 'succeeded' && (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="flex items-center gap-2 font-semibold text-emerald-800">
            <BadgeCheck className="size-5" /> Restore verified
          </p>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-emerald-700">Records checked</dt>
              <dd className="font-medium text-slate-900">{result.recordsChecked.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-emerald-700">Recovery time</dt>
              <dd className="font-medium text-slate-900">{formatDuration(result.durationSeconds)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-emerald-700">Restored database</dt>
              <dd className="truncate font-mono text-[13px] text-slate-900">{result.targetDatabase}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-emerald-700">Recovery URL</dt>
              <dd className="flex items-center gap-1">
                <a
                  href={result.recoveryUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-mono text-[13px] text-blue-700 hover:underline"
                >
                  {result.recoveryUrl}
                </a>
                <CopyButton value={result.recoveryUrl} label="Copy recovery URL" />
              </dd>
            </div>
          </dl>
        </div>
      )}
      {op?.status === 'failed' && (
        <div className="mt-4">
          <ErrorBanner message="The restore did not pass its checks. The restored database was kept for inspection." />
        </div>
      )}

      <div className="my-5 flex justify-end gap-2">
        {op && op.status !== 'running' ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {started ? 'Hide' : 'Cancel'}
            </Button>
            <Button onClick={start} disabled={submitting || started}>
              {submitting || running ? <Spinner /> : <RotateCcw className="size-4" />}
              {running ? 'Restoring…' : 'Start restore'}
            </Button>
          </>
        )}
        {result && (
          <a
            href={result.recoveryUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
          >
            Open recovery app <ExternalLink className="size-4" />
          </a>
        )}
      </div>

      <Pipeline title="Recovery pipeline" steps={RESTORE_STEPS} op={op} />
    </Modal>
  )
}
