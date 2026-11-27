import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { openOperationRuntime } from './operation-runtime.js'
import { runOperation } from './run-operation.js'

export async function processDelivery({ message, receipt }, deps) {
  const { store, queue, log = console } = deps
  if (!receipt || typeof message?.operationId !== 'string' || !message.operationId) {
    throw new Error('Invalid operations queue message')
  }
  const op = await store.get(message.operationId)
  if (op?.status === 'running') {
    if (message.kind !== op.kind || message.appId !== op.appId ||
        message.backupId !== op.backupId ||
        ((op.kind === 'redeploy' || op.kind === 'undo') && !/^[A-Za-z0-9._-]{1,128}$/.test(message.imageTag ?? '')) ||
        (op.kind === 'deploy' && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(message.sourceApp ?? ''))) {
      throw new Error(`Queue message does not match operation ${op.id}`)
    }
    log.info(`Picked up ${op.id} (${op.kind} ${op.appId})`)
    const saved = await runOperation(op, message, deps, { retryUnexpected: true })
    log.info(`Finished ${op.id}: ${saved.status}`)
  }
  await queue.delete(receipt)
}

export async function runWorker(deps, signal) {
  const { store, queue, log = console } = deps
  while (!signal.aborted) {
    try {
      // If an API died between INSERT and SendMessage, republish its saved request.
      // Allow the API a minute for its normal send before attempting recovery.
      for (const message of await store.pendingMessages(new Date(Date.now() - 60_000))) {
        await queue.send(message)
        await store.markDispatched(message.operationId)
      }
    } catch (err) {
      log.error('Could not resend pending operations:', err.message)
    }
    if (signal.aborted) break
    try {
      const delivery = await queue.receive(signal)
      if (delivery) await processDelivery(delivery, deps)
    } catch (err) {
      if (signal.aborted) break
      log.error('Worker will poll again:', err.message)
      await delay(1000)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort())
  const deps = await openOperationRuntime(loadConfig(), { worker: true })
  try {
    await runWorker(deps, stop.signal)
  } finally {
    await deps.store.close()
    deps.queue.client.destroy()
  }
}
