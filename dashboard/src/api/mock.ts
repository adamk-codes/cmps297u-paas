// In-memory stand-in for the platform API, so the dashboard can be built and demoed before
// the backend exists. Long-running work advances on a timer, like the real jobs would.
import type {
  App,
  ApprovedRepo,
  Backup,
  BudgetStatus,
  CostReport,
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
const appUrl = (name: string) => `/apps/${name}/`
const randomHex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, n)
const delay = (ms = 250) => new Promise((r) => setTimeout(r, ms))
const clone = <T>(v: T): T => structuredClone(v)

// Most recent 02:00 UTC (4:00 AM Beirut time in winter) — when scheduled backups run.
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
    // v2.14.0 replaced v2.13.1 95 min ago; the data was backed up just before (see the pre-deploy backup below).
    lastDeploy: { imageTag: 'v2.14.0', deployedAt: minutesAgo(95), previousImageTag: 'v2.13.1', safetyBackupId: 'bk-shop-api-predeploy' },
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

backups.unshift({
  id: 'bk-shop-api-predeploy', appId: 'shop-api', appName: 'shop-api', createdAt: minutesAgo(96), trigger: 'pre-deploy',
  status: 'completed', sizeBytes: 18_510_000, image: { tag: 'v2.13.1', digest: 'sha256:51be09d4a7c3' },
  s3Key: 'backups/shop-api/pre-deploy.dump',
})

let restores: Restore[] = []

// A little history so the Activity page isn't empty in mock mode.
const pastOp = (kind: OperationKind, appId: string, startedBy: string, min: number, status: Operation['status'] = 'succeeded') => ({
  id: `op-${randomHex(12)}`, kind, appId, status, startedBy, steps: [],
  startedAt: minutesAgo(min), finishedAt: minutesAgo(min - 1),
})
const restoreResult = (appId: string, seconds: number) => ({
  backupId: `bk-${appId}-0`, targetDatabase: `${appId.replace(/-/g, '_')}_restore_20261127`,
  recoveryUrl: appUrl(`${appId}-recovery`), recordsChecked: 120, durationSeconds: seconds, contentChecked: true,
})
const pastActivity: Operation[] = [
  { ...pastOp('drill', 'notes-app', '', 690), startedBy: undefined, detail: { recordsChecked: 120, expectedRecords: 120, durationSeconds: 9 } },
  { ...pastOp('drill', 'shop-api', '', 692), startedBy: undefined, detail: { recordsChecked: 4210, expectedRecords: 4210, durationSeconds: 14 } },
  { ...pastOp('drill', 'shop-api', '', 692 + 1440), startedBy: undefined, detail: { recordsChecked: 4180, expectedRecords: 4180, durationSeconds: 13 } },
  { ...pastOp('restore', 'notes-app', 'adam.alkhatib@example.com', 55), result: restoreResult('notes-app', 38) },
  { ...pastOp('restore', 'shop-api', 'jason.keyrouz@example.com', 60 * 30), result: restoreResult('shop-api', 47) },
  pastOp('backup', 'notes-app', 'jason.keyrouz@example.com', 70),
  pastOp('redeploy', 'shop-api', 'ahmad.marjeh@example.com', 180),
  pastOp('deploy', 'shop-api', 'abdulrahman.kaddoura@example.com', 600, 'failed'),
]

interface MockOperation extends Operation {
  startedMs: number
  applied: boolean
  onSuccess: (op: MockOperation) => void
  failAtStep?: number
}
const operations = new Map<string, MockOperation>()

const STEP_TEMPLATES: Record<OperationKind, Omit<PipelineStep, 'state'>[]> = {
  deploy: [
    { key: 'test', label: 'Test', description: 'Newest image that passed CI tests' },
    { key: 'build', label: 'Build and scan', description: 'ECR scan: no critical vulnerabilities' },
    { key: 'store', label: 'Database', description: 'Own PostgreSQL database and login' },
    { key: 'release', label: 'Release', description: 'Rolled out on EKS, rolls back if unhealthy' },
  ],
  redeploy: [
    { key: 'snapshot', label: 'Safety backup', description: 'Data saved first, so the deploy can be undone' },
    { key: 'pull', label: 'Pull image', description: 'Previous image fetched from ECR' },
    { key: 'release', label: 'Release', description: 'Rolled out on EKS, rolls back if unhealthy' },
  ],
  undo: [
    { key: 'restore', label: 'Restore', description: 'Data from just before the deploy, into a new database' },
    { key: 'save', label: 'Save', description: 'App paused; current data backed up, nothing deleted' },
    { key: 'switch', label: 'Switch', description: 'Previous version goes live on the restored data' },
    { key: 'check', label: 'Check', description: 'Pods healthy and the app answers' },
  ],
  drill: [
    { key: 'restore', label: 'Restore', description: 'Latest backup into a temporary database' },
    { key: 'check', label: 'Check', description: 'Every table and row checked against the backup' },
    { key: 'cleanup', label: 'Clean up', description: 'Temporary database dropped; live app untouched' },
  ],
  delete: [
    { key: 'stop', label: 'Stop', description: 'App, recovery copy and daily backup removed' },
    { key: 'database', label: 'Database', description: 'Database and login dropped; backups kept in S3' },
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
    startedBy: currentEmail(),
    startedMs: Date.now(),
    applied: false,
    onSuccess,
    failAtStep,
  }
  operations.set(op.id, op)
  return publicOp(op)
}

// The signed-in mock user (lib/auth.tsx keeps it in sessionStorage), for the activity log.
function currentEmail(): string | undefined {
  try {
    return (JSON.parse(sessionStorage.getItem('app-platform.user') ?? 'null') as { email?: string } | null)?.email
  } catch {
    return undefined
  }
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

function addBackup(app: App, trigger: Backup['trigger']): Backup {
  const createdAt = new Date().toISOString()
  const b: Backup = {
    id: `bk-${randomHex(8)}`, appId: app.id, appName: app.name, createdAt, trigger, status: 'completed',
    sizeBytes: app.id === 'shop-api' ? 18_620_000 : 6_340_000, image: { tag: app.image.tag, digest: app.image.digest },
    s3Key: `backups/${app.id}/${createdAt.replace(/[:.]/g, '-')}-${app.image.tag}.dump`,
  }
  backups = [b, ...backups]
  app.lastBackupAt = createdAt
  return b
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
      // Safety backup of the version that was live, so this deploy can be undone with its data.
      const safety = app.database && app.image.tag !== tag ? addBackup(app, 'pre-deploy') : undefined
      app.lastDeploy = safety
        ? { imageTag: tag, deployedAt: deployed.deployedAt, previousImageTag: app.image.tag, safetyBackupId: safety.id }
        : undefined
      Object.assign(app, { status: 'running', health: 'healthy', image: deployed })
      app.history = [deployed, ...app.history.filter((h) => h.tag !== tag)]
    })
  },

  async undoDeploy(appId, imageTag) {
    await delay()
    const app = findApp(appId)
    const last = app.lastDeploy
    if (!last) throw new Error(`${app.name}'s last deploy has no safety backup, so it can't be undone with its data`)
    if (last.imageTag !== imageTag) throw new Error(`${app.name} was deployed again since; reload and try again`)
    if ([...operations.values()].some((o) => o.appId === appId && o.status === 'running'))
      throw new Error(`${app.name} has an operation in progress; wait for it to finish`)
    app.status = 'deploying'
    return startOperation('undo', appId, (op) => {
      const saved = addBackup(app, 'pre-undo')
      const previous = app.history.find((h) => h.tag === last.previousImageTag) ?? { ...app.image, tag: last.previousImageTag }
      const deployed = { ...previous, deployedAt: new Date().toISOString() }
      Object.assign(app, { status: 'running', health: 'healthy', image: deployed, lastDeploy: undefined })
      app.history = [deployed, ...app.history.filter((h) => h.tag !== deployed.tag)]
      op.detail = {
        imageTag: deployed.tag, recordsRestored: 4210, beforeUndoBackupKey: saved.s3Key, downtimeSeconds: 41, durationSeconds: 74,
        keptDatabase: `${app.database?.name ?? app.id}_undo_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
      }
    })
  },

  async runDrill(appId) {
    await delay()
    const app = findApp(appId)
    const newest = backups.find((b) => b.appId === appId && b.status === 'completed')
    if (!newest) throw new Error(`${app.name} has no backups to test yet`)
    if ([...operations.values()].some((o) => o.appId === appId && o.kind === 'drill' && o.status === 'running'))
      throw new Error(`a recovery drill of ${app.name} is already running`)
    return startOperation('drill', appId, (op) => {
      newest.verifiedAt = new Date().toISOString()
      op.detail = { recordsChecked: 120, expectedRecords: 120, durationSeconds: 9, contentChecked: true }
    })
  },

  async deleteApp(appId) {
    await delay()
    const app = findApp(appId)
    if (app.id === 'notes-app') throw new Error("notes-app is the platform's demo app and can't be deleted")
    if ([...operations.values()].some((o) => o.appId === appId && o.status === 'running'))
      throw new Error(`${app.name} has an operation in progress; wait for it to finish`)
    app.status = 'deploying'
    return startOperation('delete', appId, () => {
      apps = apps.filter((a) => a.id !== appId)
    })
  },

  async listOperations(limit = 100) {
    await delay(150)
    const live = [...operations.values()]
    live.forEach(advance)
    return [...live.map(publicOp), ...pastActivity]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
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
      op.result = { backupId, targetDatabase, recoveryUrl, recordsChecked, durationSeconds, contentChecked: true }
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
      [178, 'info', 'Pod started on EKS (c7i-flex.large node)'],
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

  async getCosts() {
    await delay()
    return mockCosts()
  },

  async updateBudget(limitUsd) {
    await delay(400)
    if (!Number.isFinite(limitUsd) || limitUsd < 1 || limitUsd > 10_000) throw new Error('budget must be between $1 and $10,000')
    budget.limit = Math.round(limitUsd * 100) / 100
    return clone(budget)
  },
}

// ---- costs: a month of work sessions (~$0.30/h while the cluster is up) on top of ~$0.10/day ----

const SESSION_RATE = [
  { item: 'EKS control plane', perHour: 0.1 },
  { item: 'EC2 nodes (2 × c7i-flex.large)', perHour: 0.1696 },
  { item: 'NAT gateway', perHour: 0.045 },
  { item: 'Application Load Balancer', perHour: 0.0305 },
  { item: 'RDS db.t4g.micro', perHour: 0.016 },
  { item: 'Public IPv4 (3)', perHour: 0.015 },
  { item: 'EBS storage', perHour: 0.007 },
]
const SERVICE_SHARE: [string, number][] = [
  ['Amazon Elastic Kubernetes Service', 0.34],
  ['Amazon Elastic Compute Cloud - Compute', 0.28],
  ['Amazon Virtual Private Cloud', 0.2],
  ['Elastic Load Balancing', 0.1],
  ['Amazon Relational Database Service', 0.06],
  ['AWS Key Management Service', 0.01],
  ['Amazon Simple Storage Service', 0.01],
]
const budget: BudgetStatus = { name: 'rebound-monthly', limit: 40, actual: 0, alertThresholds: [50, 80, 100] }

function mockCosts(): CostReport {
  const now = new Date()
  const days = now.getUTCDate()
  const perHour = SESSION_RATE.reduce((s, i) => s + i.perHour, 0)
  const round = (n: number) => Math.round(n * 100) / 100
  // Deterministic "session hours" per day: about one day in two has a 3-7 hour session.
  const daily = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), i + 1))
    const hours = i % 2 === 1 || i % 7 === 3 ? 2 + ((i * 7) % 5) : 0
    return { date: d.toISOString().slice(0, 10), amount: round(0.1 + hours * perHour) }
  })
  const monthToDate = round(daily.reduce((s, d) => s + d.amount, 0))
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const forecastMonth = round((monthToDate / days) * daysInMonth)
  budget.actual = monthToDate
  budget.forecast = forecastMonth
  return {
    currency: 'USD',
    generatedAt: now.toISOString(),
    source: 'mock',
    monthToDate,
    forecastMonth,
    byService: SERVICE_SHARE.map(([service, share]) => ({ service, amount: round(monthToDate * share) })),
    daily,
    budget: clone(budget),
    sessionRate: { perHour: Math.round(perHour * 1000) / 1000, items: SESSION_RATE },
    note: 'Mock data. On AWS this page shows Cost Explorer usage before credits.',
  }
}
