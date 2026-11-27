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
  redeploy: [
    { key: 'snapshot', label: 'Safety backup', description: 'Data saved first, so the deploy can be undone' },
    { key: 'pull', label: 'Pull image', description: 'Previous image fetched from ECR' },
    { key: 'release', label: 'Release', description: 'Rolled out on EKS' },
  ],
  deploy: [
    { key: 'test', label: 'Test', description: 'Newest image that passed CI tests' },
    { key: 'build', label: 'Build and scan', description: 'ECR scan: no critical vulnerabilities' },
    { key: 'store', label: 'Database', description: 'Own PostgreSQL database and login' },
    { key: 'release', label: 'Release', description: 'Rolled out on EKS, rolls back if unhealthy' },
  ],
  drill: [
    { key: 'restore', label: 'Restore', description: 'Latest backup into a temporary database' },
    { key: 'check', label: 'Check', description: 'Every table and row checked against the backup' },
    { key: 'cleanup', label: 'Clean up', description: 'Temporary database dropped; live app untouched' },
  ],
  undo: [
    { key: 'restore', label: 'Restore', description: 'Data from just before the deploy, into a new database' },
    { key: 'save', label: 'Save', description: 'App paused; current data backed up, nothing deleted' },
    { key: 'switch', label: 'Switch', description: 'Previous version goes live on the restored data' },
    { key: 'check', label: 'Check', description: 'Pods healthy and the app answers' },
  ],
  delete: [
    { key: 'stop', label: 'Stop', description: 'App, recovery copy and daily backup removed' },
    { key: 'database', label: 'Database', description: 'Database and login dropped; backups kept in S3' },
  ],
}

// Script log step names -> dashboard step keys.
//   backup.sh logs [dump] [store]; restore.sh logs [download] [restore] [check];
//   rebound-data.sh logs "::step dump|restore|run|check".
const STEP_ALIASES = {
  backup: { dump: 'dump', store: 'store' },
  restore: { download: 'restore', restore: 'restore', run: 'run', check: 'check' },
  redeploy: { snapshot: 'snapshot', pull: 'pull', release: 'release' }, // deploy-app.sh
  deploy: { test: 'test', build: 'build', store: 'store', release: 'release' }, // deploy-new-app.sh
  delete: { stop: 'stop', database: 'database' }, // rebound-data.sh delete
  undo: { restore: 'restore', save: 'save', switch: 'switch', check: 'check' }, // rebound-data.sh undo
  drill: { download: 'restore', restore: 'restore', check: 'check', cleanup: 'cleanup' }, // rebound-data.sh drill, restore.sh
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
