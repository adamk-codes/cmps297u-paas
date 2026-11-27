// Failure alerts: a failed operation publishes one SNS message; successes don't; a broken SNS never
// changes the operation's outcome.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alertText, createAlerts } from '../src/alerts.js'
import { loadConfig } from '../src/config.js'
import { Operations } from '../src/operations.js'
import { MemoryStore } from '../src/store.js'

const log = { error() {}, info() {} }

function setup(executor, alerts) {
  const ops = new Operations({ store: new MemoryStore(), executor, catalog: { get: async () => null }, alerts, log })
  return ops
}

test('a failed backup sends one alert with the app, step, error and who started it', async () => {
  const sent = []
  const alerts = createAlerts(loadConfig({ ALERTS_TOPIC_ARN: 'arn:aws:sns:us-east-1:111122223333:rebound-alerts', PUBLIC_URL: 'https://d.example/' }),
    { send: async (cmd) => sent.push(cmd.input) })
  const ops = setup({ backup: async ({ onStep }) => { onStep('store'); return { ok: false, error: 'S3 upload denied' } } }, alerts)
  const op = await ops.startBackup('notes-app', { startedBy: 'jason@team.test' })
  await ops.idle()
  assert.equal((await ops.get(op.id)).status, 'failed')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].TopicArn, 'arn:aws:sns:us-east-1:111122223333:rebound-alerts')
  assert.equal(sent[0].Subject, '[Rebound] Backup of notes-app failed')
  assert.match(sent[0].Message, /at the "Store" step/)
  assert.match(sent[0].Message, /Error: S3 upload denied/)
  assert.match(sent[0].Message, /Started by: jason@team.test/)
  assert.match(sent[0].Message, /https:\/\/d\.example\/activity/)
})

test('successes send nothing, and a broken SNS does not change the result', async () => {
  let calls = 0
  const alerts = { operationFailed: async () => { calls++; throw new Error('SNS down') } }
  const ok = setup({ backup: async () => ({ ok: true, result: { s3Key: 'k', sizeBytes: 1, imageTag: 't', rowCount: 1 } }) }, alerts)
  const a = await ok.startBackup('notes-app')
  await ok.idle()
  assert.equal((await ok.get(a.id)).status, 'succeeded')
  assert.equal(calls, 0)

  const bad = setup({ backup: async () => ({ ok: false, error: 'boom' }) }, alerts)
  const b = await bad.startBackup('notes-app')
  await bad.idle()
  assert.equal((await bad.get(b.id)).status, 'failed')
  assert.equal(calls, 1)
})

test('alerts are off without a topic', () => {
  assert.equal(createAlerts(loadConfig({})), undefined)
  assert.match(alertText({ kind: 'delete', appId: 'x', id: 'op-1', startedAt: 't', steps: [] }).subject, /Delete of x failed/)
})
