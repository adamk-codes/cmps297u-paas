import { createAlerts } from './alerts.js'
import { S3Catalog } from './catalog.js'
import { createExecutor } from './executor.js'
import { OperationsQueue } from './queue.js'
import { MemoryStore, PgStore } from './store.js'

export async function openOperationRuntime(config, { worker = false } = {}) {
  if (worker && !config.queueUrl) throw new Error('The worker requires QUEUE_URL')
  if (config.queueUrl && !config.platformDatabaseUrl) throw new Error('QUEUE_URL requires a shared PLATFORM_DATABASE_URL')
  const store = config.platformDatabaseUrl ? new PgStore(config.platformDatabaseUrl) : new MemoryStore()
  await store.init({ recoverLocal: !worker })
  return {
    store, executor: createExecutor(config), catalog: new S3Catalog(config.s3),
    queue: config.queueUrl ? new OperationsQueue(config.queueUrl, config.s3.region) : undefined,
    alerts: createAlerts(config),
  }
}
