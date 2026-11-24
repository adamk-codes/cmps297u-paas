import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createNotesRepo, createPool, migrate } from './db.js'

const config = loadConfig()
const pool = createPool(config)

// Retry the first connection for a while: the database may still be starting (compose, fresh RDS).
async function migrateWithRetry(attempts = 20, delayMs = 3000) {
  for (let i = 1; ; i++) {
    try {
      return await migrate(pool, config)
    } catch (err) {
      if (i >= attempts) throw err
      console.warn(`database not ready (${err.message}); retry ${i}/${attempts - 1} in ${delayMs}ms`)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

const result = await migrateWithRetry()
console.log(
  result.created ? `created notes table and seeded ${result.seeded} rows` : 'notes table already exists; not seeding',
)

const app = createApp({ repo: createNotesRepo(pool), config })
const server = app.listen(config.port, () => {
  console.log(`${config.appName} (${config.imageTag}) listening on :${config.port}${config.basePath || '/'}`)
})

// Kubernetes sends SIGTERM on rollout; finish in-flight requests, then close the pool.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`)
    server.close(() => pool.end().finally(() => process.exit(0)))
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
