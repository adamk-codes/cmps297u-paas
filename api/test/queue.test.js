import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { Operations } from '../src/operations.js'
import { openOperationRuntime } from '../src/operation-runtime.js'
import { OperationsQueue } from '../src/queue.js'
import { MemoryStore } from '../src/store.js'
import { processDelivery, runWorker } from '../src/worker.js'

const log = { error() {}, info() {} }
const backup = { id: 'notes~tag', appId: 'notes', s3Key: 'backups/notes/tag.dump' }
const restored = { targetDatabase: 'notes_copy', recoveryUrl: '/apps/notes-recovery', recordsChecked: 120, durationSeconds: 14 }

function fixture(executor = {}) {
  const sent = [], deleted = []
  const queue = {
    async send(message) { sent.push(structuredClone(message)) },
    async delete(receipt) { deleted.push(receipt) },
  }
  const deps = { store: new MemoryStore(), catalog: { get: async () => backup }, executor, queue, log }
  return { deps, sent, deleted, ops: new Operations(deps) }
}

async function serve(t, operations) {
  const app = createApp({ operations, config: loadConfig({}) })
  const server = await new Promise((resolve) => {
    const http = app.listen(0, '127.0.0.1', () => resolve(http))
  })
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  return 'http://127.0.0.1:' + server.address().port
}

test('POST enqueues once, a separate worker persists progress, and a redelivery just deletes the receipt', async (t) => {
  let executions = 0
  const detail = { s3Key: backup.s3Key, sizeBytes: 256, imageTag: 'abc', rowCount: 120 }
  const { ops, deps, sent, deleted } = fixture({
    async backup({ onStep }) {
      executions++
      onStep('store')
      return { ok: true, result: detail }
    },
  })
  const base = await serve(t, ops)
  const post = () => fetch(base + '/api/apps/notes/backups', { method: 'POST', headers: { 'Idempotency-Key': 'same-click' } })
  const [a, b] = await Promise.all([post(), post()])
  assert.equal(a.status, 202)
  const op = await a.json()
  assert.equal((await b.json()).id, op.id)
  assert.equal(op.status, 'running')
  assert.deepEqual(op.steps.map((s) => s.key), ['dump', 'store'])
  assert.deepEqual(sent, [{ operationId: op.id, kind: 'backup', appId: 'notes' }])
  assert.equal(executions, 0)
  await processDelivery({ message: sent[0], receipt: 'first' }, deps)
  const done = await (await fetch(base + '/api/operations/' + op.id)).json()
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(done.steps.map((s) => s.state), ['succeeded', 'succeeded'])
  assert.deepEqual(done.detail, detail)
  await processDelivery({ message: sent[0], receipt: 'duplicate' }, deps)
  await processDelivery({ message: { operationId: 'unknown' }, receipt: 'missing' }, deps)
  assert.equal(executions, 1)
  assert.deepEqual(deleted, ['first', 'duplicate', 'missing'])
})

test('only one queued restore is admitted and the worker returns the dashboard RestoreResult', async (t) => {
  const { ops, deps, sent } = fixture({ restore: async ({ backup: item }) => {
    assert.equal(item.s3Key, backup.s3Key)
    return { ok: true, result: { ...restored, image: 'notes:abc', restoreSeconds: 2 } }
  } })
  const base = await serve(t, ops)
  const path = base + '/api/backups/' + backup.id + '/restore'
  const responses = await Promise.all([fetch(path, { method: 'POST' }), fetch(path, { method: 'POST' })])
  assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409])
  const started = await responses.find((r) => r.status === 202).json()
  const conflict = await responses.find((r) => r.status === 409).json()
  assert.equal(conflict.operationId, started.id)
  assert.deepEqual(sent, [{ operationId: started.id, kind: 'restore', appId: 'notes', backupId: backup.id }])
  await processDelivery({ message: sent[0], receipt: 'restore' }, deps)
  const done = await ops.get(started.id)
  assert.deepEqual(done.result, { backupId: backup.id, ...restored })
  assert.deepEqual(done.steps.map((s) => s.key), ['restore', 'run', 'check'])
})

test('redeploy passes the requested tag and a handled failure is saved before deletion', async () => {
  const { ops, deps, sent, deleted } = fixture({ redeploy: async ({ imageTag, onStep }) => {
    assert.equal(imageTag, 'old-tag')
    onStep('release')
    return { ok: false, error: 'rollout failed' }
  } })
  const op = await ops.startRedeploy('notes', 'old-tag')
  assert.equal(sent[0].imageTag, 'old-tag')
  await processDelivery({ message: sent[0], receipt: 'handled' }, deps)
  await processDelivery({ message: sent[0], receipt: 'again' }, deps)
  const saved = await ops.get(op.id)
  assert.equal(saved.status, 'failed')
  assert.equal(saved.error, 'rollout failed')
  assert.deepEqual(saved.steps.map((s) => s.state), ['succeeded', 'failed'])
  assert.deepEqual(deleted, ['handled', 'again'])
})

test('an enqueue failure is visible to the dashboard and releases the per-app lock', async () => {
  const { ops, deps } = fixture()
  deps.queue.send = async () => { throw new Error('queue unavailable') }
  const op = await ops.startBackup('notes')
  assert.equal(op.status, 'failed')
  assert.match((await ops.get(op.id)).error, /Could not enqueue backup: queue unavailable/)
  assert.equal(op.steps[0].state, 'failed')
  assert.notEqual((await ops.startBackup('notes')).id, op.id)
})

test('a crash, malformed input, or a failed terminal write leaves the message for retry', async () => {
  const { ops, deps, sent, deleted } = fixture({ backup: async () => { throw new Error('worker crashed') } })
  const op = await ops.startBackup('notes')
  const delivery = { message: sent[0], receipt: 'receipt' }
  await assert.rejects(processDelivery(delivery, deps), /worker crashed/)
  await assert.rejects(processDelivery({ message: {}, receipt: 'bad' }, deps), /Invalid/)
  deps.executor.backup = async () => ({ ok: true, result: {} })
  deps.store.update = async () => { throw new Error('database unavailable') }
  await assert.rejects(processDelivery(delivery, deps), /database unavailable/)
  assert.equal((await ops.get(op.id)).status, 'running')
  assert.deepEqual(deleted, [])
})

test('the worker recovers an unsent operation and finishes the active message on shutdown', async () => {
  const stop = new AbortController()
  const { ops, deps, sent, deleted } = fixture({ backup: async () => {
    stop.abort()
    return { ok: true, result: {} }
  } })
  const op = { id: 'op-before-restart', kind: 'backup', appId: 'notes', status: 'running',
    startedAt: new Date(0).toISOString(), steps: [{ key: 'dump', state: 'running' }] }
  const message = { operationId: op.id, kind: op.kind, appId: op.appId }
  await deps.store.create(op, message) // the API stopped before it could send to SQS
  deps.queue.receive = async () => ({ message: sent[0], receipt: 'recovered' })
  await runWorker(deps, stop.signal)
  assert.deepEqual(sent, [message])
  assert.deepEqual(deleted, ['recovered'])
  assert.equal((await ops.get(op.id)).status, 'succeeded')
})

test('SQS requests poll for one message, support an idle poll, and use the returned receipt', async () => {
  const calls = []
  const message = { operationId: 'op-test' }
  const replies = [{}, {}, { Messages: [{ Body: JSON.stringify(message), ReceiptHandle: 'receipt' }] }, {}]
  const queue = new OperationsQueue('queue-url', 'us-east-1', { async send(command) {
    calls.push(command.input)
    return replies.shift()
  } })
  await queue.send(message)
  assert.equal(await queue.receive(), null)
  const delivery = await queue.receive()
  assert.deepEqual(delivery, { message, receipt: 'receipt' })
  await queue.delete(delivery.receipt)
  assert.deepEqual(calls[0], { QueueUrl: 'queue-url', MessageBody: JSON.stringify(message) })
  assert.deepEqual(calls[1], { QueueUrl: 'queue-url', MaxNumberOfMessages: 1, WaitTimeSeconds: 20 })
  assert.deepEqual(calls[3], { QueueUrl: 'queue-url', ReceiptHandle: 'receipt' })
})

test('a deploy redelivered after a lost acknowledgement keeps its original result', async () => {
  let rollouts = 0
  const detail = { image: 'registry/notes:good', imageTag: 'good' }
  const { ops, deps, sent } = fixture({ redeploy: async () => {
    rollouts++
    return { ok: true, result: detail }
  } })
  const op = await ops.startRedeploy('notes', 'good')
  deps.queue.delete = async () => { throw new Error('acknowledgement lost') }
  await assert.rejects(processDelivery({ message: sent[0], receipt: 'first' }, deps), /acknowledgement lost/)
  const done = await ops.get(op.id)
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(done.detail, detail)
  assert.deepEqual(done.steps.map((s) => s.key), ['pull', 'release'])
  deps.queue.delete = async () => {}
  await processDelivery({ message: sent[0], receipt: 'retry' }, deps)
  assert.equal(rollouts, 1)
})

test('queue mode requires shared storage and the worker requires a queue', async () => {
  await assert.rejects(openOperationRuntime(loadConfig({ QUEUE_URL: 'url' })), /PLATFORM_DATABASE_URL/)
  await assert.rejects(openOperationRuntime(loadConfig({}), { worker: true }), /QUEUE_URL/)
})
