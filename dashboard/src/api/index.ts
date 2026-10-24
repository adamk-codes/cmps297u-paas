import type { App, ApprovedRepo, Backup, DeployRequest, LogLine, Operation, Restore } from './types'
import { mockApi } from './mock'

// Everything the dashboard needs from the platform API. The mock implements it today; an HTTP
// client calling VITE_API_URL will implement the same interface once the API is deployed.
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

export const api: PlatformApi = mockApi

export * from './types'
