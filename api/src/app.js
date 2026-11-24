import express from 'express'
import { createAuth } from './auth.js'
import { HttpError } from './operations.js'

// HTTP layer. Paths and shapes follow the dashboard contract (dashboard/src/api/index.ts + types.ts):
//   listBackups(appId?)   GET  /api/backups?appId=
//   createBackup(appId)   POST /api/apps/:appId/backups          -> 202 Operation
//   restore(backupId)     POST /api/backups/:backupId/restore    -> 202 Operation (409 if one is running)
//   listRestores()        GET  /api/restores
//   getOperation(id)      GET  /api/operations/:id
// Deploy/app endpoints (listApps, deploy, redeploy, getLogs, ...) belong to the deploy side of the API.
export function createApp({ operations, config, verifier }) {
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
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
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
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra })
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' })
    if (err.$metadata || ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(err.code)) {
      console.error('backup storage error:', err.name, err.message)
      return res.status(502).json({ error: 'backup storage (S3) is unavailable' })
    }
    console.error(err)
    res.status(500).json({ error: 'internal error' })
  })
  return app
}
