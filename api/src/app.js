import express from 'express'
import { createAuth } from './auth.js'
import { HttpError } from './operations.js'

// HTTP layer. Paths and shapes follow the dashboard contract (dashboard/src/api/index.ts + types.ts):
//   listBackups(appId?)   GET  /api/backups?appId=
//   createBackup(appId)   POST /api/apps/:appId/backups          -> 202 Operation
//   restore(backupId)     POST /api/backups/:backupId/restore    -> 202 Operation (409 if one is running)
//   listRestores()        GET  /api/restores
//   getOperation(id)      GET  /api/operations/:id
//   listApps / getApp     GET  /api/apps, /api/apps/:appId        (from Kubernetes)
//   getLogs(appId)        GET  /api/apps/:appId/logs
//   redeploy(appId, tag)  POST /api/apps/:appId/redeploy {imageTag} -> 202 Operation
//   listApprovedRepos()   GET  /api/repos
//   deploy(req)           POST /api/apps -> 501 (new apps go through the CI pipeline)
//   getCosts()            GET  /api/costs                         (Cost Explorer + Budgets, cached)
//   updateBudget(limit)   PUT  /api/costs/budget {limitUsd}
export function createApp({ operations, apps, costs, config, verifier }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)
  app.use(express.json({ limit: '16kb' }))

  app.use((req, res, next) => {
    const origin = req.get('origin')
    if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
      res.set('Access-Control-Allow-Origin', origin)
      res.set('Vary', 'Origin')
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key')
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  })

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next)
  const idem = (req) => req.get('Idempotency-Key') || undefined

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', executor: config.executor }))
  app.get('/api/healthz', (_req, res) => res.json({ status: 'ok', executor: config.executor }))

  // Everything else under /api requires a signed-in team member (when Cognito is configured).
  const auth = createAuth(config.auth, verifier)
  if (auth) app.use('/api', auth)

  // ---- apps (read from the cluster) ----
  const withLastBackup = async (list) => {
    const backups = await operations.catalog.list().catch(() => [])
    const last = new Map()
    for (const b of backups) if (!last.has(b.appId)) last.set(b.appId, b.createdAt) // newest first
    return list.map((a) => (last.has(a.id) ? { ...a, lastBackupAt: last.get(a.id) } : a))
  }
  const findApp = async (id) => {
    const app = (await apps.list()).find((a) => a.id === id)
    if (!app) throw new HttpError(404, `app ${id} was not found`)
    return app
  }

  app.get('/api/apps', wrap(async (_req, res) => {
    res.json(await withLastBackup(await apps.list()))
  }))

  app.get('/api/apps/:appId', wrap(async (req, res) => {
    res.json((await withLastBackup([await findApp(req.params.appId)]))[0])
  }))

  app.get('/api/apps/:appId/logs', wrap(async (req, res) => {
    await findApp(req.params.appId)
    res.json(await apps.logs(req.params.appId))
  }))

  // Redeploy an image this app has run before (rollback / roll forward).
  app.post('/api/apps/:appId/redeploy', wrap(async (req, res) => {
    const target = await findApp(req.params.appId)
    const tag = req.body?.imageTag
    if (!target.history.some((h) => h.tag === tag)) {
      throw new HttpError(400, `image ${tag} is not in ${target.id}'s history`)
    }
    const op = await operations.startRedeploy(target.id, tag, { idempotencyKey: idem(req) })
    res.status(202).location(`/api/operations/${op.id}`).json(op)
  }))

  app.get('/api/repos', (_req, res) => res.json(config.approvedRepos))

  // ---- costs and budget ----
  app.get('/api/costs', wrap(async (req, res) => {
    if (!costs) throw new HttpError(501, 'cost reporting is not configured')
    res.json(await costs.report({ refresh: req.query.refresh === '1' }))
  }))

  app.put('/api/costs/budget', wrap(async (req, res) => {
    if (!costs) throw new HttpError(501, 'cost reporting is not configured')
    res.json(await costs.updateBudget(req.body?.limitUsd))
  }))

  // New apps are built by the CI pipeline (test -> build -> scan -> push), not by the API.
  app.post('/api/apps', (_req, res) => {
    res.status(501).json({ error: 'New deployments run through the GitHub Actions pipeline; push to main to deploy.' })
  })

  // ---- backups and restores ----

  app.get('/api/backups', wrap(async (req, res) => {
    res.json(await operations.listBackups(req.query.appId || undefined))
  }))

  app.get('/api/backups/:backupId', wrap(async (req, res) => {
    const backup = await operations.catalog.get(req.params.backupId)
    if (!backup) throw new HttpError(404, `backup ${req.params.backupId} was not found`)
    res.json(backup)
  }))

  app.post('/api/apps/:appId/backups', wrap(async (req, res) => {
    const op = await operations.startBackup(req.params.appId, { idempotencyKey: idem(req) })
    res.status(202).location(`/api/operations/${op.id}`).json(op)
  }))

  app.post('/api/backups/:backupId/restore', wrap(async (req, res) => {
    const op = await operations.startRestore(req.params.backupId, { idempotencyKey: idem(req) })
    res.status(202).location(`/api/operations/${op.id}`).json(op)
  }))

  app.get('/api/restores', wrap(async (_req, res) => {
    res.json(await operations.listRestores())
  }))

  app.get('/api/operations', wrap(async (req, res) => {
    const { kind, appId, status } = req.query
    res.json(await operations.store.list({ kind, appId, status, limit: 100 }))
  }))

  app.get('/api/operations/:id', wrap(async (req, res) => {
    res.json(await operations.get(req.params.id))
  }))

  app.use((_req, res) => res.status(404).json({ error: 'not found' }))
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra })
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' })
    if (err.$metadata || ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(err.code)) {
      // An AWS dependency failed (S3 for backups; Cost Explorer / Budgets for costs).
      const service = req.path.startsWith('/api/costs') ? 'AWS Cost Explorer / Budgets' : 'backup storage (S3)'
      console.error(`${service} error:`, err.name, err.message)
      const denied = err.name === 'AccessDeniedException' || err.$metadata?.httpStatusCode === 403
      return res.status(502).json({ error: `${service} ${denied ? 'denied the request' : 'is unavailable'}` })
    }
    console.error(err)
    res.status(500).json({ error: 'internal error' })
  })
  return app
}
