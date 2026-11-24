import { createApp } from './app.js'
import { createAppsSource } from './apps.js'
import { S3Catalog } from './catalog.js'
import { loadConfig } from './config.js'
import { createExecutor } from './executor.js'
import { Operations } from './operations.js'
import { MemoryStore, PgStore } from './store.js'

const config = loadConfig()
const store = config.platformDatabaseUrl ? new PgStore(config.platformDatabaseUrl) : new MemoryStore()
await store.init()
if (!config.platformDatabaseUrl) console.warn('PLATFORM_DATABASE_URL not set: operation history is kept in memory')

const operations = new Operations({
  store,
  executor: createExecutor(config),
  catalog: new S3Catalog(config.s3),
})
if (!config.auth.userPoolId) console.warn('COGNITO_USER_POOL_ID not set: API is open (local dev only)')
const app = createApp({ operations, apps: createAppsSource(config), config })
const server = app.listen(config.port, () => {
  console.log(`rebound-api listening on :${config.port} (executor: ${config.executor}, bucket: ${config.s3.bucket})`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`)
    server.close(async () => {
      await store.close?.()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
