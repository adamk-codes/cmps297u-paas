// In-memory stand-in for the platform API, so the dashboard can be built and demoed before
// the backend exists. Long-running work advances on a timer, like the real jobs would.
import type {
  App,
  ApprovedRepo,
  Backup,
  DeployRequest,
  LogLine,
  Operation,
  OperationKind,
  PipelineStep,
  Restore,
} from './types'
import type { PlatformApi } from './index'

const REGION = 'us-east-1'
const STEP_MS = 1600
// Deploying this repo makes the test step fail, to demo "a failed test blocks the release".
const FAILING_REPO = 'github.com/company-org/failing-tests-demo'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const appUrl = (name: string) => `https://${name}.${REGION}.appplatform.internal`
const randomHex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, n)
const delay = (ms = 250) => new Promise((r) => setTimeout(r, ms))
const clone = <T>(v: T): T => structuredClone(v)

// Most recent 02:00 UTC — when scheduled backups run.
function lastScheduledRun(daysBack = 0): string {
  const d = new Date()
  d.setUTCHours(2, 0, 0, 0)
  if (d.getTime() > Date.now()) d.setUTCDate(d.getUTCDate() - 1)
  d.setUTCDate(d.getUTCDate() - daysBack)
  return d.toISOString()
}

const approvedRepos: ApprovedRepo[] = [
  { fullName: 'github.com/company-org/shop-api', defaultBranch: 'main', runtime: 'Node.js 20' },
  { fullName: 'github.com/company-org/notes-app', defaultBranch: 'main', runtime: 'Node.js 20' },
  { fullName: FAILING_REPO, defaultBranch: 'main', runtime: 'Node.js 20' },
]

let apps: App[] = [
  {
    id: 'shop-api',
    name: 'shop-api',
    description: 'Primary commerce routing API for orders and checkout',
    icon: 'terminal',
    runtime: 'Node.js 20',
    repo: 'github.com/company-org/shop-api',
    branch: 'main',
    region: REGION,
    url: appUrl('shop-api'),
    status: 'running',
    health: 'healthy',
    pods: { ready: 1, desired: 1 },
    image: { tag: 'v2.14.0', digest: 'sha256:7f9a3c1e88b2', commit: 'a91d02f', deployedAt: minutesAgo(95) },
    history: [
      { tag: 'v2.14.0', digest: 'sha256:7f9a3c1e88b2', commit: 'a91d02f', deployedAt: minutesAgo(95) },
      { tag: 'v2.13.1', digest: 'sha256:51be09d4a7c3', commit: '3c7e9b1', deployedAt: minutesAgo(60 * 26) },
      { tag: 'v2.13.0', digest: 'sha256:e02f6a9b1d44', commit: 'f4410aa', deployedAt: minutesAgo(60 * 74) },
    ],
    database: { engine: 'PostgreSQL', version: '16.3', name: 'shop_api' },
    lastBackupAt: lastScheduledRun(),
  },
  {
    id: 'notes-app',
    name: 'notes-app',
    description: 'Collaborative operational notes for the team',
    icon: 'notes',
    runtime: 'Node.js 20',
    repo: 'github.com/company-org/notes-app',
    branch: 'main',
    region: REGION,
    url: appUrl('notes-app'),
    status: 'running',
    health: 'healthy',
    pods: { ready: 1, desired: 1 },
    image: { tag: 'v1.8.2', digest: 'sha256:4c11d7e0a5f9', commit: '6bd7741', deployedAt: minutesAgo(114) },
    history: [
      { tag: 'v1.8.2', digest: 'sha256:4c11d7e0a5f9', commit: '6bd7741', deployedAt: minutesAgo(114) },
      { tag: 'v1.8.1', digest: 'sha256:9a2e40c17b6d', commit: 'e19c0d2', deployedAt: minutesAgo(60 * 50) },
    ],
    database: { engine: 'PostgreSQL', version: '16.3', name: 'notes_app' },
    lastBackupAt: lastScheduledRun(),
  },
]

let backups: Backup[] = [
  ...[0, 1, 2, 3].flatMap((day) =>
    apps.map<Backup>((a, i) => ({
      id: `bk-${a.id}-${day}`,
      appId: a.id,
      appName: a.name,
      createdAt: lastScheduledRun(day),
      trigger: 'scheduled',
      status: 'completed',
      sizeBytes: (i === 0 ? 18_400_000 : 6_200_000) - day * 210_000,
      image: { tag: a.history[Math.min(day, a.history.length - 1)].tag, digest: a.history[Math.min(day, a.history.length - 1)].digest },
      s3Key: `backups/${a.id}/${lastScheduledRun(day).slice(0, 10)}.dump`,
      verifiedAt: day === 0 ? minutesAgo(40 + i * 15) : undefined,
    })),
  ),
]

let restores: Restore[] = []

interface MockOperation extends Operation {
  startedMs: number
  applied: boolean
  onSuccess: (op: MockOperation) => void
  failAtStep?: number
}
const operations = new Map<string, MockOperation>()

const STEP_TEMPLATES: Record<OperationKind, Omit<PipelineStep, 'state'>[]> = {
  deploy: [
    { key: 'test', label: 'Test', description: 'A failed test blocks the release' },
    { key: 'build', label: 'Build and scan', description: 'Docker image built and scanned' },
    { key: 'store', label: 'Store image', description: 'Versioned in ECR for rollback' },
    { key: 'release', label: 'Release', description: 'Runs on EKS on Fargate' },
  ],
  redeploy: [
    { key: 'pull', label: 'Pull image', description: 'Previous image fetched from ECR' },
    { key: 'release', label: 'Release', description: 'Rolled out on EKS on Fargate' },
  ],
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

function startOperation(
  kind: OperationKind,
  appId: string,
  onSuccess: (op: MockOperation) => void,
  failAtStep?: number,
): Operation {
  const op: MockOperation = {
    id: `op-${randomHex(12)}`,
    kind,
    appId,
    status: 'running',
    steps: STEP_TEMPLATES[kind].map((s, i) => ({ ...s, state: i === 0 ? 'running' : 'pending' })),
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    applied: false,
    onSuccess,
    failAtStep,
  }
  operations.set(op.id, op)
  return publicOp(op)
}

function advance(op: MockOperation) {
  if (op.status !== 'running') return
  const current = Math.floor((Date.now() - op.startedMs) / STEP_MS)
  op.steps.forEach((s, i) => {
    if (op.failAtStep !== undefined && i === op.failAtStep && current >= i + 1) s.state = 'failed'
    else s.state = i < current ? 'succeeded' : i === current ? 'running' : 'pending'
  })
  if (op.failAtStep !== undefined && current > op.failAtStep) {
    op.steps.forEach((s, i) => i > op.failAtStep! && (s.state = 'pending'))
    op.status = 'failed'
    op.finishedAt = new Date().toISOString()
    const app = apps.find((a) => a.id === op.appId)
    if (app) Object.assign(app, { status: 'failed', health: 'unknown' })
  } else if (current >= op.steps.length) {
    op.status = 'succeeded'
    op.finishedAt = new Date().toISOString()
    if (!op.applied) {
      op.applied = true
      op.onSuccess(op)
    }
  }
}

function publicOp(op: MockOperation): Operation {
  const { startedMs, applied, onSuccess, failAtStep, ...rest } = op
  return clone(rest)
}

function findApp(id: string): App {
  const app = apps.find((a) => a.id === id)
  if (!app) throw new Error(`App "${id}" was not found`)
  return app
}

function newImage(commit = randomHex(7)) {
  return { tag: 'v1.0.0', digest: `sha256:${randomHex(12)}`, commit, deployedAt: new Date().toISOString() }
}

export const mockApi: PlatformApi = {
  async listApps() {
    await delay()
    return clone(apps)
  },

  async getApp(id) {
    await delay()
    return clone(findApp(id))
  },

  async listApprovedRepos() {
    await delay(150)
    return clone(approvedRepos)
  },

  async deploy(req: DeployRequest) {
    await delay()
    if (apps.some((a) => a.name === req.name)) throw new Error(`An app named "${req.name}" already exists`)
    const repo = approvedRepos.find((r) => r.fullName === req.repo)
    if (!repo) throw new Error('Only repositories pre-approved by your team are deployable')

    const image = newImage()
    const app: App = {
      id: req.name,
      name: req.name,
      description: `Deployed from ${repo.fullName.split('/').pop()}`,
      icon: 'box',
      runtime: repo.runtime,
      repo: repo.fullName,
      branch: repo.defaultBranch,
      region: REGION,
      url: appUrl(req.name),
      status: 'deploying',
      health: 'unknown',
      pods: { ready: 0, desired: 1 },
      image,
      history: [],
      database: req.createDatabase
        ? { engine: 'PostgreSQL', version: '16.3', name: req.name.replace(/-/g, '_') }
        : undefined,
    }
    apps = [...apps, app]

    return startOperation(
      'deploy',
      app.id,
      () => {
        const deployed = { ...image, deployedAt: new Date().toISOString() }
        Object.assign(app, { status: 'running', health: 'healthy', pods: { ready: 1, desired: 1 }, image: deployed })
        app.history = [deployed]
      },
      repo.fullName === FAILING_REPO ? 0 : undefined,
    )
  },

  async redeploy(appId, tag) {
    await delay()
    const app = findApp(appId)
    const target = app.history.find((h) => h.tag === tag)
    if (!target) throw new Error(`Image ${tag} is not in ECR for ${app.name}`)
    if (operations.size && [...operations.values()].some((o) => o.appId === appId && o.status === 'running'))
      throw new Error(`${app.name} already has an operation in progress`)
    app.status = 'deploying'
    return startOperation('redeploy', appId, () => {
      const deployed = { ...target, deployedAt: new Date().toISOString() }
      Object.assign(app, { status: 'running', health: 'healthy', image: deployed })
      app.history = [deployed, ...app.history.filter((h) => h.tag !== tag)]
    })
  },

  async getOperation(id) {
    await delay(100)
    const op = operations.get(id)
    if (!op) throw new Error(`Operation ${id} was not found`)
    advance(op)
    return publicOp(op)
  },

  async listBackups(appId) {
    await delay()
    const list = appId ? backups.filter((b) => b.appId === appId) : backups
    return clone([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  },

  async createBackup(appId) {
    await delay()
    const app = findApp(appId)
    if (!app.database) throw new Error(`${app.name} has no database to back up`)
    return startOperation('backup', appId, () => {
      const createdAt = new Date().toISOString()
      backups = [
        {
          id: `bk-${randomHex(8)}`,
          appId,
          appName: app.name,
          createdAt,
          trigger: 'manual',
          status: 'completed',
          sizeBytes: app.id === 'shop-api' ? 18_620_000 : 6_340_000,
          image: { tag: app.image.tag, digest: app.image.digest },
          s3Key: `backups/${app.id}/${createdAt.replace(/[:.]/g, '-')}.dump`,
        },
        ...backups,
      ]
      app.lastBackupAt = createdAt
    })
  },

  async restore(backupId) {
    await delay()
    const backup = backups.find((b) => b.id === backupId)
    if (!backup) throw new Error(`Backup ${backupId} was not found`)
    if ([...operations.values()].some((o) => o.kind === 'restore' && o.status === 'running'))
      throw new Error('A restore is already running. Restores run one at a time.')
    const app = findApp(backup.appId)
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const targetDatabase = `${app.database?.name ?? app.id}_restore_${stamp}`
    const recoveryUrl = appUrl(`${app.name}-recovery`)

    return startOperation('restore', app.id, (op) => {
      const durationSeconds = Math.round((Date.now() - op.startedMs) / 1000)
      const recordsChecked = app.id === 'shop-api' ? 3184 : 1240
      op.result = { backupId, targetDatabase, recoveryUrl, recordsChecked, durationSeconds }
      backup.verifiedAt = new Date().toISOString()
      restores = [{ id: op.id, appId: app.id, appName: app.name, startedAt: op.startedAt, ...op.result }, ...restores]
    })
  },

  async listRestores() {
    await delay()
    return clone(restores)
  },

  async getLogs(appId) {
    await delay()
    const app = findApp(appId)
    const lines: [number, LogLine['level'], string][] = [
      [180, 'info', `Pulled image ${app.image.tag} (${app.image.digest.slice(0, 19)})`],
      [178, 'info', 'Container started on Fargate'],
      [177, 'info', app.database ? `Connected to PostgreSQL ${app.database.version} database "${app.database.name}"` : 'No database configured'],
      [176, 'info', 'Listening on port 3000'],
      [120, 'info', 'GET /health 200 3ms'],
      [64, 'warn', 'Slow query: 412ms on GET /api/items'],
      [30, 'info', 'GET /health 200 2ms'],
      [2, 'info', 'GET /health 200 2ms'],
    ]
    return lines.map(([secAgo, level, message]) => ({
      ts: new Date(Date.now() - secAgo * 1000).toISOString(),
      level,
      message,
    }))
  },
}
