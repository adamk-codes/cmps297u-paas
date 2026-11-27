import type { PlatformApi } from './index'
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

// PlatformApi over HTTP, against the Rebound API (api/ in this repo). Paths are documented in api/README.md.
// baseUrl '' means same origin (the dashboard and /api are both served by CloudFront).

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export const UNAUTHORIZED_EVENT = 'rebound:unauthorized'

export function createHttpApi(baseUrl: string, getToken: () => Promise<string | null>): PlatformApi {
  const root = baseUrl.replace(/\/$/, '')

  async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const token = await getToken()
    if (token) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    // Every POST carries a fresh idempotency key: a retried request never starts the same job twice.
    if (method === 'POST' || method === 'DELETE') headers['Idempotency-Key'] = crypto.randomUUID()

    let res: Response
    try {
      res = await fetch(`${root}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch {
      throw new ApiError('Cannot reach the platform API. Is a cluster session running?', 0)
    }
    if (res.status === 401) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
      throw new ApiError('Your session has expired. Sign in again.', 401)
    }
    const data = res.status === 204 ? undefined : await res.json().catch(() => undefined)
    if (!res.ok) {
      const message =
        (data as { error?: string } | undefined)?.error ??
        (res.status === 502 || res.status === 504
          ? 'The platform API is not running (start a session with infra/scripts/up.sh).'
          : `Request failed (${res.status})`)
      throw new ApiError(message, res.status)
    }
    return data as T
  }

  const id = encodeURIComponent
  return {
    listApps: () => request<App[]>('GET', '/api/apps'),
    getApp: (appId) => request<App>('GET', `/api/apps/${id(appId)}`),
    listApprovedRepos: () => request<ApprovedRepo[]>('GET', '/api/repos'),
    deploy: (req: DeployRequest) => request<Operation>('POST', '/api/apps', req),
    redeploy: (appId, imageTag) => request<Operation>('POST', `/api/apps/${id(appId)}/redeploy`, { imageTag }),
    runDrill: (appId) => request<Operation>('POST', `/api/apps/${id(appId)}/drill`),
    deleteApp: (appId) => request<Operation>('DELETE', `/api/apps/${id(appId)}`),
    listOperations: (limit = 100) => request<Operation[]>('GET', `/api/operations?limit=${limit}`),
    getOperation: (opId) => request<Operation>('GET', `/api/operations/${id(opId)}`),
    listBackups: (appId) => request<Backup[]>('GET', `/api/backups${appId ? `?appId=${id(appId)}` : ''}`),
    createBackup: (appId) => request<Operation>('POST', `/api/apps/${id(appId)}/backups`),
    restore: (backupId) => request<Operation>('POST', `/api/backups/${id(backupId)}/restore`),
    listRestores: () => request<Restore[]>('GET', '/api/restores'),
    getLogs: (appId) => request<LogLine[]>('GET', `/api/apps/${id(appId)}/logs`),
    getCosts: () => request<CostReport>('GET', '/api/costs'),
    updateBudget: (limitUsd) => request<BudgetStatus>('PUT', '/api/costs/budget', { limitUsd }),
  }
}
