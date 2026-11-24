import express from 'express'
import { renderHome } from './views.js'

// Builds the Express app. `repo` is the data layer (see db.js); tests pass an in-memory one.
export function createApp({ repo, config }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true) // behind the ALB

  const router = express.Router()
  router.use(express.json({ limit: '32kb' }))
  router.use(express.urlencoded({ extended: false, limit: '32kb' }))

  // Health: 200 when the database answers, 503 otherwise. Used by Kubernetes probes and the ALB.
  const healthz = async (_req, res) => {
    try {
      await repo.ping()
      res.json({ status: 'ok', database: 'up', app: config.appName, imageTag: config.imageTag })
    } catch (err) {
      res.status(503).json({ status: 'error', database: 'down', error: err.message })
    }
  }
  router.get('/healthz', healthz)

  router.get('/', async (_req, res, next) => {
    try {
      const [notes, count, database] = await Promise.all([
        repo.list({ limit: 50, offset: 0 }),
        repo.count(),
        repo.databaseName(),
      ])
      res.type('html').send(renderHome({ notes, count, database, config }))
    } catch (err) {
      next(err)
    }
  })

  // Summary used by the restore check and the dashboard: how many notes, which database, which image.
  router.get('/api/stats', async (_req, res, next) => {
    try {
      const [count, database] = await Promise.all([repo.count(), repo.databaseName()])
      res.json({ app: config.appName, imageTag: config.imageTag, database, notes: count })
    } catch (err) {
      next(err)
    }
  })

  router.get('/api/notes', async (req, res, next) => {
    try {
      const limit = clampInt(req.query.limit, 50, 1, 500)
      const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      const [notes, total] = await Promise.all([repo.list({ limit, offset }), repo.count()])
      res.json({ total, limit, offset, notes })
    } catch (err) {
      next(err)
    }
  })

  router.get('/api/notes/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id)
      if (!id) return res.status(400).json({ error: 'id must be a positive integer' })
      const note = await repo.get(id)
      if (!note) return res.status(404).json({ error: 'note not found' })
      res.json(note)
    } catch (err) {
      next(err)
    }
  })

  const createNote = async (req, res, next) => {
    try {
      const input = validateNote(req.body)
      if (input.error) return res.status(400).json({ error: input.error })
      const note = await repo.create(input)
      // HTML form posts get redirected back to the page; API clients get JSON.
      if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, `${config.basePath}/`)
      res.status(201).json(note)
    } catch (err) {
      next(err)
    }
  }
  router.post('/api/notes', createNote)
  router.post('/notes', createNote)

  router.delete('/api/notes/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id)
      if (!id) return res.status(400).json({ error: 'id must be a positive integer' })
      const removed = await repo.remove(id)
      if (!removed) return res.status(404).json({ error: 'note not found' })
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })

  // Simulated incident for the recovery demo. Disabled unless ALLOW_DATA_LOSS_DEMO=true.
  router.post('/api/demo/data-loss', async (req, res, next) => {
    if (!config.allowDataLossDemo) return res.status(403).json({ error: 'data-loss demo is disabled' })
    try {
      const percent = clampInt(req.body?.percent ?? req.query.percent, 80, 1, 100)
      const deleted = await repo.deleteFraction(percent)
      res.json({ deleted, remaining: await repo.count() })
    } catch (err) {
      next(err)
    }
  })

  app.use(config.basePath || '/', router)
  // Probes may hit /healthz at the root even when the app lives under a base path.
  if (config.basePath) app.get('/healthz', healthz)

  app.use((_req, res) => res.status(404).json({ error: 'not found' }))
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err)
    res.status(500).json({ error: 'internal error' })
  })
  return app
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function parseId(value) {
  return /^[1-9]\d{0,9}$/.test(value) ? Number(value) : null
}

export function validateNote(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const text = typeof body?.body === 'string' ? body.body : ''
  const author = typeof body?.author === 'string' && body.author.trim() ? body.author.trim() : 'anonymous'
  if (!title) return { error: 'title is required' }
  if (title.length > 200) return { error: 'title must be at most 200 characters' }
  if (text.length > 10_000) return { error: 'body must be at most 10000 characters' }
  if (author.length > 80) return { error: 'author must be at most 80 characters' }
  return { title, body: text, author }
}
