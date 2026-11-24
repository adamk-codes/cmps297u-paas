import type { App, ApprovedRepo, Backup, DeployRequest, LogLine, Operation, Restore } from './types'
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
  getOperation(id: string): Promise<Operation>
  listBackups(appId?: string): Promise<Backup[]>
  createBackup(appId: string): Promise<Operation>
  restore(backupId: string): Promise<Operation>
  listRestores(): Promise<Restore[]>
  getLogs(appId: string): Promise<LogLine[]>
}

// VITE_USE_MOCK=true forces the mock, =false forces HTTP. Unset: HTTP when VITE_API_URL is set.
const env = import.meta.env
export const usingMock: boolean =
  env.VITE_USE_MOCK === 'true' || (env.VITE_USE_MOCK !== 'false' && !env.VITE_API_URL)

export const api: PlatformApi = usingMock ? mockApi : createHttpApi(env.VITE_API_URL ?? '', getIdToken)

export * from './types'
