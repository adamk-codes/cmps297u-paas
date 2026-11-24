// Step lists the dashboard renders (keep in sync with dashboard/src/api/mock.ts STEP_TEMPLATES).
export const STEP_TEMPLATES = {
  backup: [
    { key: 'dump', label: 'Back up', description: 'Database dumped by a Kubernetes Job' },
    { key: 'store', label: 'Store', description: 'Encrypted in S3 with the image version' },
  ],
  restore: [
    { key: 'restore', label: 'Restore', description: 'Into a new database, never over the live one' },
    { key: 'run', label: 'Run', description: 'Matching image at a recovery URL' },
    { key: 'check', label: 'Check', description: 'Records verified, recovery time measured' },
  ],
}

// Script log step names -> dashboard step keys.
//   backup.sh logs [dump] [store]; restore.sh logs [download] [restore] [check];
//   rebound-data.sh logs "::step dump|restore|run|check".
const STEP_ALIASES = {
  backup: { dump: 'dump', store: 'store' },
  restore: { download: 'restore', restore: 'restore', run: 'run', check: 'check' },
}

export function stepKeyFor(kind, logStep) {
  return STEP_ALIASES[kind]?.[logStep]
}

export function initialSteps(kind) {
  return STEP_TEMPLATES[kind].map((s, i) => ({ ...s, state: i === 0 ? 'running' : 'pending' }))
}

// Marks `key` running and everything before it succeeded (steps only move forward).
export function advanceSteps(steps, key) {
  const idx = steps.findIndex((s) => s.key === key)
  if (idx === -1) return steps
  const current = steps.findIndex((s) => s.state === 'running')
  if (current > idx) return steps
  return steps.map((s, i) => ({ ...s, state: i < idx ? 'succeeded' : i === idx ? 'running' : s.state }))
}

export function finishSteps(steps, ok) {
  if (ok) return steps.map((s) => ({ ...s, state: 'succeeded' }))
  let failed = false
  return steps.map((s) => {
    if (s.state === 'running' && !failed) {
      failed = true
      return { ...s, state: 'failed' }
    }
    return s.state === 'succeeded' ? s : { ...s, state: failed ? 'pending' : s.state }
  })
}
