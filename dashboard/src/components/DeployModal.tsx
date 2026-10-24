import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, BadgeCheck, ChevronDown, Info, Link2, Play, SquareTerminal } from 'lucide-react'
import { api, type ApprovedRepo, type Operation } from '../api'
import { useOperation } from '../lib/hooks'
import { validateAppName } from '../lib/format'
import { Modal } from './Modal'
import { DEPLOY_STEPS, Pipeline } from './Pipeline'
import { Button, Code, cx, ErrorBanner, Spinner } from './ui'

const REGION = 'us-east-1'

function defaultName(repo: string, taken: string[]) {
  const base = repo.split('/').pop() ?? 'app'
  return taken.includes(base) ? `${base}-staging` : base
}

export function DeployModal({
  existingNames,
  onClose,
  onChanged,
}: {
  existingNames: string[]
  onClose: () => void
  onChanged: () => void
}) {
  const navigate = useNavigate()
  // Snapshot on open: once our own deploy starts, its name joins the parent's list.
  const [takenNames] = useState(existingNames)
  const [repos, setRepos] = useState<ApprovedRepo[] | null>(null)
  const [repo, setRepo] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [createDatabase, setCreateDatabase] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)

  const op = useOperation(operationId, () => onChanged())
  const started = operationId !== null
  const finished = op !== null && op.status !== 'running'

  useEffect(() => {
    api.listApprovedRepos().then((list) => {
      setRepos(list)
      if (list[0]) {
        setRepo(list[0].fullName)
        setName(defaultName(list[0].fullName, takenNames))
      }
    }, (e: Error) => setError(e.message))
  }, [takenNames])

  const selected = repos?.find((r) => r.fullName === repo)
  const nameError =
    validateAppName(name) ?? (takenNames.includes(name) ? `An app named "${name}" already exists` : null)
  const url = `https://${name || 'your-app'}.${REGION}.appplatform.internal`

  function chooseRepo(next: string) {
    setRepo(next)
    if (!nameTouched) setName(defaultName(next, takenNames))
  }

  async function start() {
    setNameTouched(true)
    if (nameError || !repo) return
    setSubmitting(true)
    setError(null)
    try {
      const created: Operation = await api.deploy({ repo, name, createDatabase })
      setOperationId(created.id)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const failedStep = op?.steps.find((s) => s.state === 'failed')

  return (
    <Modal title="Deploy new app" onClose={onClose}>
      <p className="font-mono text-xs font-medium tracking-wider text-blue-700 uppercase">
        Deploy workbench · {REGION}
      </p>
      <p className="mt-1 text-[15px] text-slate-600">Deploy a Node.js 20 service from an approved repository.</p>

      <div className="mt-5 space-y-5">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <label htmlFor="repo" className="text-sm font-medium text-slate-800">
              Approved repository
            </label>
            <span className="font-mono text-xs text-slate-500">Git integration</span>
          </div>
          <div className="relative">
            <BadgeCheck className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-blue-600" />
            <select
              id="repo"
              value={repo}
              disabled={!repos || started}
              onChange={(e) => chooseRepo(e.target.value)}
              className="h-11 w-full appearance-none rounded-lg border border-transparent bg-blue-50 pr-10 pl-11 text-[15px] text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-70"
            >
              {!repos && <option>Loading approved repositories…</option>}
              {repos?.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName} (approved)
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-slate-500" />
          </div>
          <p className="mt-2 flex items-center gap-2 text-sm text-slate-600">
            <Info className="size-4 shrink-0 text-slate-500" />
            Only repositories pre-approved by your team are deployable.
          </p>
        </div>

        <div>
          <label htmlFor="app-name" className="mb-1.5 block text-sm font-medium text-slate-800">
            App name
          </label>
          <input
            id="app-name"
            value={name}
            disabled={started}
            onChange={(e) => {
              setName(e.target.value.toLowerCase())
              setNameTouched(true)
            }}
            aria-invalid={nameTouched && !!nameError}
            aria-describedby="app-name-help"
            spellCheck={false}
            autoComplete="off"
            className={cx(
              'h-11 w-full rounded-lg border bg-white px-3.5 text-[15px] text-slate-900 outline-none focus:ring-2 disabled:bg-slate-50',
              nameTouched && nameError
                ? 'border-red-400 focus:ring-red-500/20'
                : 'border-slate-300 focus:border-blue-500 focus:ring-blue-500/20',
            )}
          />
          <p id="app-name-help" className="mt-2 flex items-start gap-2 text-sm text-slate-600">
            {nameTouched && nameError ? (
              <span className="text-red-600">{nameError}</span>
            ) : (
              <>
                <Link2 className="mt-0.5 size-4 shrink-0 text-slate-500" />
                <span className="min-w-0 break-all">
                  App will be accessible at <span className="font-mono text-[13px] text-blue-700">{url}</span>
                </span>
              </>
            )}
          </p>
        </div>

        <label
          className={cx(
            'flex gap-3 rounded-xl bg-blue-50/70 p-4 sm:p-5',
            started ? 'cursor-default' : 'cursor-pointer',
          )}
        >
          <input
            type="checkbox"
            checked={createDatabase}
            disabled={started}
            onChange={(e) => setCreateDatabase(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-blue-600"
          />
          <span>
            <span className="block text-base font-semibold text-slate-900">Create a PostgreSQL database for this app</span>
            <span className="mt-1 block text-sm text-slate-600">
              Provisions a single PostgreSQL database with automatic daily scheduled backups.
            </span>
            <span className="mt-2 flex items-center gap-2 text-sm text-slate-500">
              <Code className="bg-blue-100 text-slate-700">PostgreSQL 16.3</Code>· Single database
            </span>
          </span>
        </label>

        {error && <ErrorBanner message={error} />}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-slate-600">
            <SquareTerminal className="size-4 text-slate-500" />
            Target runtime: {selected?.runtime ?? 'Node.js 20'}
          </p>
          <div className="flex gap-2">
            {finished ? (
              <>
                <Button variant="secondary" onClick={onClose}>
                  Close
                </Button>
                {op?.status === 'succeeded' && (
                  <Button onClick={() => navigate(`/apps/${op.appId}`)}>
                    View app <ArrowRight className="size-4" />
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={onClose}>
                  {started ? 'Hide' : 'Cancel'}
                </Button>
                <Button onClick={start} disabled={submitting || started || !repos}>
                  {submitting || started ? <Spinner /> : <Play className="size-4" />}
                  {started ? 'Deploying…' : 'Start deployment'}
                </Button>
              </>
            )}
          </div>
        </div>

        {op?.status === 'failed' && (
          <ErrorBanner
            message={`${failedStep?.label ?? 'A step'} failed, so the release was blocked. Nothing was changed on the cluster.`}
          />
        )}
        {op?.status === 'succeeded' && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <span className="font-medium">{name}</span> is live at{' '}
            <span className="font-mono text-[13px] break-all">{url}</span>
          </div>
        )}

        <Pipeline title="Deployment pipeline" steps={DEPLOY_STEPS} op={op} />
      </div>
    </Modal>
  )
}
