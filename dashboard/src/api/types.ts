// Shapes the dashboard expects from the platform API.
// Keep these in sync with the API team (api/) — they are the contract between us.

export type AppStatus = 'running' | 'deploying' | 'failed' | 'stopped'
export type Health = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
export type AppIcon = 'terminal' | 'notes' | 'box'

export interface ImageVersion {
  tag: string // e.g. "v2.14.0"
  digest: string // e.g. "sha256:7f9a..."
  commit: string // short git SHA the image was built from
  deployedAt: string // ISO timestamp
}

export interface AppDatabase {
  engine: 'PostgreSQL'
  version: string
  name: string // database name on the shared RDS instance
}

export interface App {
  id: string
  name: string
  description: string
  icon: AppIcon
  runtime: string // "Node.js 20"
  repo: string // "github.com/company-org/shop-api"
  branch: string
  region: string
  url: string
  status: AppStatus
  health: Health
  pods: { ready: number; desired: number }
  image: ImageVersion // currently running image
  history: ImageVersion[] // newest first, includes the current image
  database?: AppDatabase
  lastBackupAt?: string
  lastDeploy?: LastDeploy // set when the current version can be undone together with its data
}

// "Undo deploy": the data was backed up just before the current version went live.
export interface LastDeploy {
  imageTag: string // the version that is live now
  deployedAt: string
  previousImageTag: string // the version it replaced
  safetyBackupId: string // backup taken just before the deploy (trigger "pre-deploy")
}

// pre-deploy: safety backup before a new version; pre-undo: the data "Undo deploy" saved before switching
export type BackupTrigger = 'manual' | 'scheduled' | 'pre-deploy' | 'pre-undo'
export type BackupStatus = 'running' | 'completed' | 'failed'

export interface Backup {
  id: string
  appId: string
  appName: string
  createdAt: string
  trigger: BackupTrigger
  status: BackupStatus
  sizeBytes: number
  image: Pick<ImageVersion, 'tag' | 'digest'> // app image the backup was taken with
  s3Key: string
  verifiedAt?: string // set once a restore of this backup was checked
}

export type StepState = 'pending' | 'running' | 'succeeded' | 'failed'

export interface PipelineStep {
  key: string
  label: string
  description: string
  state: StepState
}

export type OperationKind = 'deploy' | 'redeploy' | 'backup' | 'restore' | 'delete' | 'drill' | 'undo'
export type OperationStatus = 'running' | 'succeeded' | 'failed'

// Long-running work (deploys, backups, restores) is started with a POST that returns an
// operation, which the dashboard polls until it finishes.
export interface Operation {
  id: string
  kind: OperationKind
  appId: string
  status: OperationStatus
  steps: PipelineStep[]
  startedAt: string
  finishedAt?: string
  result?: RestoreResult
  startedBy?: string // email of the team member who started it (activity log)
  detail?: OperationDetail
}

// Extra results by kind: drill (records, duration), undo (what was kept), redeploy (its safety backup).
export interface OperationDetail {
  recordsChecked?: number
  expectedRecords?: number | null
  durationSeconds?: number
  contentChecked?: boolean
  contentNote?: string
  imageTag?: string
  recordsRestored?: number
  beforeUndoBackupKey?: string
  keptDatabase?: string
  downtimeSeconds?: number
  safetyBackupKey?: string
}

export interface RestoreResult {
  backupId: string
  targetDatabase: string
  recoveryUrl: string
  recordsChecked: number
  durationSeconds: number
  contentChecked?: boolean // every value in every row matched the backup, not only the counts
  contentNote?: string // why content wasn't checked (database over 1 GB, or an older backup)
}

export interface Restore extends RestoreResult {
  id: string
  appId: string
  appName: string
  startedAt: string
}

export interface ApprovedRepo {
  fullName: string // "github.com/company-org/shop-api"
  defaultBranch: string
  runtime: string
}

export interface LogLine {
  ts: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface DeployRequest {
  repo: string
  name: string
  createDatabase: boolean
}

// ---- costs (GET /api/costs) ----

export interface CostLine {
  service: string // AWS service name as Cost Explorer reports it
  amount: number // USD, month to date
}

export interface DailyCost {
  date: string // YYYY-MM-DD (UTC)
  amount: number
}

export interface BudgetStatus {
  name: string
  limit: number // USD per month
  actual: number
  forecast?: number
  alertThresholds: number[] // percent of the limit that triggers an email
}

export interface CostReport {
  currency: 'USD'
  generatedAt: string
  // cost-explorer: real spend; estimate: no AWS access (local API); mock: dashboard mock
  source: 'cost-explorer' | 'estimate' | 'mock'
  monthToDate?: number // usage before credits
  forecastMonth?: number
  byService: CostLine[]
  daily: DailyCost[]
  budget?: BudgetStatus
  sessionRate: { perHour: number; items: { item: string; perHour: number }[] }
  note?: string
}
