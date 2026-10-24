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
}

export type BackupTrigger = 'manual' | 'scheduled'
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

export type OperationKind = 'deploy' | 'redeploy' | 'backup' | 'restore'
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
}

export interface RestoreResult {
  backupId: string
  targetDatabase: string
  recoveryUrl: string
  recordsChecked: number
  durationSeconds: number
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
