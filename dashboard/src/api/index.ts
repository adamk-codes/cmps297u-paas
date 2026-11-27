import type {
  App,
  ApprovedRepo,
  Backup,
  BudgetStatus,
  CostReport,
  DeployRequest,
  LogLine,
  Operation,
  Restore,
} from './types'
import { mockApi } from './mock'
import { createHttpApi } from './http'
import { getIdToken } from '../lib/cognito'

// Everything the dashboard needs from the platform API. Two implementations:
//   mockApi        in-memory, for UI work without a backend
//   createHttpApi  the real API (api/ in this repo), at VITE_API_URL ('' = same origin)
export interface PlatformApi {
  listApps(): Promise<App[]>
  getApp(id: string): Promise<App>
  listApprovedRepos(): Promise<ApprovedRepo[]>
  deploy(req: DeployRequest): Promise<Operation>
  redeploy(appId: string, imageTag: string): Promise<Operation>
  // Recovery drill: restore the newest backup into a temporary database, count, drop. Also runs nightly.
  runDrill(appId: string): Promise<Operation>
  // Undo the last deploy, code and data: the previous version goes live again on the data from just before
  // the deploy (the current data is backed up first). "Code only" is redeploy(appId, previousImageTag).
  undoDeploy(appId: string, imageTag: string): Promise<Operation>
  // Removes the app, its recovery copy and its database. Its backups stay in S3.
  deleteApp(appId: string): Promise<Operation>
  getOperation(id: string): Promise<Operation>
  // Activity log: recent operations across all apps, newest first.
  listOperations(limit?: number): Promise<Operation[]>
  listBackups(appId?: string): Promise<Backup[]>
  createBackup(appId: string): Promise<Operation>
  restore(backupId: string): Promise<Operation>
  listRestores(): Promise<Restore[]>
  getLogs(appId: string): Promise<LogLine[]>
  getCosts(): Promise<CostReport>
  updateBudget(limitUsd: number): Promise<BudgetStatus>
}

// VITE_USE_MOCK=true forces the mock, =false forces HTTP. Unset: HTTP when VITE_API_URL is set.
const env = import.meta.env
export const usingMock: boolean =
  env.VITE_USE_MOCK === 'true' || (env.VITE_USE_MOCK !== 'false' && !env.VITE_API_URL)

export const api: PlatformApi = usingMock ? mockApi : createHttpApi(env.VITE_API_URL ?? '', getIdToken)

export * from './types'
