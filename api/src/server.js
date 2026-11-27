import { createApp } from './app.js'
import { createAppsSource } from './apps.js'
import { createCostService } from './costs.js'
import { startDrillScheduler } from './drill-scheduler.js'
import { loadConfig } from './config.js'
import { openOperationRuntime } from './operation-runtime.js'
import { Operations } from './operations.js'

const config = loadConfig()
const runtime = await openOperationRuntime(config)
const { store } = runtime
if (!config.platformDatabaseUrl) console.warn('PLATFORM_DATABASE_URL not set: operation history is kept in memory')

const operations = new Operations(runtime)
if (!config.auth.userPoolId) console.warn('COGNITO_USER_POOL_ID not set: API is open (local dev only)')
const apps = createAppsSource(config)
const app = createApp({ operations, apps, costs: createCostService(config), config })
const stopDrills = startDrillScheduler({ operations, apps, config })
const server = app.listen(config.port, () => {
  console.log(`rebound-api listening on :${config.port} (executor: ${config.executor}, bucket: ${config.s3.bucket})`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`)
    stopDrills()
    server.close(async () => {
      await store.close?.()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
