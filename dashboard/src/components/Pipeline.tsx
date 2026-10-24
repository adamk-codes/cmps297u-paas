import { Circle, CircleCheck, CircleX } from 'lucide-react'
import type { Operation, PipelineStep, StepState } from '../api'
import { cx, Spinner } from './ui'

const stateText: Record<StepState, string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
}

function StepIcon({ state }: { state: StepState }) {
  const wrap = 'grid size-8 shrink-0 place-items-center rounded-full'
  if (state === 'running')
    return (
      <span className={cx(wrap, 'bg-blue-100 text-blue-600')}>
        <Spinner />
      </span>
    )
  if (state === 'succeeded')
    return (
      <span className={cx(wrap, 'bg-emerald-100 text-emerald-600')}>
        <CircleCheck className="size-5" />
      </span>
    )
  if (state === 'failed')
    return (
      <span className={cx(wrap, 'bg-red-100 text-red-600')}>
        <CircleX className="size-5" />
      </span>
    )
  return (
    <span className={cx(wrap, 'bg-slate-100 text-slate-500')}>
      <Circle className="size-5" strokeWidth={1.5} />
    </span>
  )
}

function overallLabel(op: Operation | null) {
  if (!op) return { text: 'Ready', cls: 'bg-white text-slate-600' }
  if (op.status === 'running') return { text: 'In progress', cls: 'bg-blue-600 text-white' }
  if (op.status === 'succeeded') return { text: 'Succeeded', cls: 'bg-emerald-600 text-white' }
  return { text: 'Failed', cls: 'bg-red-600 text-white' }
}

// Shows each step of a deploy, backup, or restore. Before it starts, pass the template steps
// with op = null so the user can see what will happen.
export function Pipeline({ title, steps, op }: { title: string; steps: PipelineStep[]; op: Operation | null }) {
  const label = overallLabel(op)
  const shown = op?.steps ?? steps
  return (
    <section className="rounded-xl bg-blue-50 p-4 sm:p-5" aria-live="polite">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-[17px] font-semibold text-slate-900">{title}</h3>
        <span className={cx('rounded-full px-3 py-1 text-xs font-medium shadow-xs', label.cls)}>{label.text}</span>
      </div>
      <ol className={cx('grid gap-3', shown.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        {shown.map((s) => (
          <li key={s.key} className="flex gap-3 rounded-lg bg-white p-3.5 shadow-xs">
            <StepIcon state={s.state} />
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium text-slate-900">{s.label}</span>
                <span
                  className={cx(
                    'text-xs',
                    s.state === 'failed' ? 'text-red-600' : s.state === 'succeeded' ? 'text-emerald-700' : 'text-slate-500',
                  )}
                >
                  {stateText[s.state]}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-slate-500">{s.description}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

export const DEPLOY_STEPS: PipelineStep[] = [
  { key: 'test', label: 'Test', description: 'A failed test blocks the release', state: 'pending' },
  { key: 'build', label: 'Build and scan', description: 'Docker image built and scanned', state: 'pending' },
  { key: 'store', label: 'Store image', description: 'Versioned in ECR for rollback', state: 'pending' },
  { key: 'release', label: 'Release', description: 'Runs on EKS on Fargate', state: 'pending' },
]

export const RESTORE_STEPS: PipelineStep[] = [
  { key: 'restore', label: 'Restore', description: 'Into a new database, never over the live one', state: 'pending' },
  { key: 'run', label: 'Run', description: 'Matching image at a recovery URL', state: 'pending' },
  { key: 'check', label: 'Check', description: 'Records verified, recovery time measured', state: 'pending' },
]

export const REDEPLOY_STEPS: PipelineStep[] = [
  { key: 'pull', label: 'Pull image', description: 'Previous image fetched from ECR', state: 'pending' },
  { key: 'release', label: 'Release', description: 'Rolled out on EKS on Fargate', state: 'pending' },
]
