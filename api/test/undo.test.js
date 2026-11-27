// "Undo deploy": the safety backup recorded by deploy-app.sh, the endpoint, and the operation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appsFromKube } from '../src/apps.js'
import { createApp } from '../src/app.js'
import { S3Catalog } from '../src/catalog.js'
import { loadConfig } from '../src/config.js'
import { Operations } from '../src/operations.js'
import { MemoryStore } from '../src/store.js'

const log = { error() {}, info() {} }
const REG = '123.dkr.ecr.us-east-1.amazonaws.com'
const SAFETY_KEY = 'backups/notes-app/20261127T130000Z-v1.dump'
const SAFETY_ID = 'notes-app~20261127T130000Z-v1'

const deployment = (annotations, tag = 'v2') => ({
  items: [{
    kind: 'Deployment',
    metadata: { name: 'notes-app', labels: { 'rebound.io/kind': 'app', 'rebound.io/app': 'notes-app' }, annotations },
    spec: { replicas: 1, template: { spec: { containers: [{ image: `${REG}/notes-app:${tag}` }] } } },
    status: { readyReplicas: 1, updatedReplicas: 1 },
  }],
})

test('an app shows an undoable last deploy only when a safety backup was recorded', () => {
  const [app] = appsFromKube(deployment({ 'rebound.io/safety-backup': SAFETY_KEY, 'rebound.io/previous-image-tag': 'v1' }))
  assert.deepEqual({ ...app.lastDeploy, deployedAt: undefined },
    { imageTag: 'v2', previousImageTag: 'v1', safetyBackupId: SAFETY_ID, deployedAt: undefined })
  assert.equal(appsFromKube(deployment({}))[0].lastDeploy, undefined, 'first deploy: nothing to undo')
  assert.equal(appsFromKube(deployment({ 'rebound.io/safety-backup': '', 'rebound.io/previous-image-tag': '' }))[0].lastDeploy, undefined)
  const rolledBack = { 'rebound.io/safety-backup': SAFETY_KEY, 'rebound.io/previous-image-tag': 'v2' }
  assert.equal(appsFromKube(deployment(rolledBack))[0].lastDeploy, undefined, 'already on the previous version')
})

test('the catalog keeps the safety backup triggers', async () => {
  const client = {
    async send(cmd) {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return { Contents: ['pre-deploy', 'pre-undo', 'weird'].map((t, i) => ({ Key: `backups/a/2026112${i}T000000Z-${t}.dump`, Size: 1 })) }
      }
      return { Metadata: { trigger: cmd.input.Key.match(/-(\w[\w-]*)\.dump$/)[1] } }
    },
  }
  const list = await new S3Catalog({ bucket: 'b', prefix: 'backups' }, client).list('a')
  assert.deepEqual(list.map((b) => b.trigger).sort(), ['manual', 'pre-deploy', 'pre-undo'])
})

function fixture({ annotations = { 'rebound.io/safety-backup': SAFETY_KEY, 'rebound.io/previous-image-tag': 'v1' }, undo } = {}) {
  const seen = []
  const executor = {
    async undo({ appId, backup, imageTag, onStep }) {
      seen.push([appId, backup.s3Key, imageTag])
      if (undo) return undo({ onStep })
      onStep('save'); onStep('switch'); onStep('check')
      return {
        ok: true,
        result: { image: `${REG}/notes-app:v1`, imageTag: 'v1', recordsRestored: 120, beforeUndoBackupKey: 'backups/notes-app/x-v2.dump',
          keptDatabase: 'notes_app_undo_20261127150000', downtimeSeconds: 41, durationSeconds: 70 },
      }
    },
  }
  const catalog = {
    async list() { return [] },
    async get(id) { return id === SAFETY_ID ? { id, appId: 'notes-app', s3Key: SAFETY_KEY, status: 'completed' } : null },
  }
  const store = new MemoryStore()
  const ops = new Operations({ store, executor, catalog, log })
  const apps = { list: async () => appsFromKube(deployment(annotations)) }
  return { ops, store, seen, app: createApp({ operations: ops, apps, config: loadConfig({}) }) }
}

async function serve(t, app, ops) {
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  t.after(async () => { await ops.idle(); server.closeAllConnections(); await new Promise((r) => server.close(r)) })
  return `http://127.0.0.1:${server.address().port}`
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })

test('POST undo-deploy restores the safety backup and puts the previous version back', async (t) => {
  const { ops, seen, app } = fixture()
  const base = await serve(t, app, ops)
  const res = await post(`${base}/api/apps/notes-app/undo-deploy`, { imageTag: 'v2' })
  assert.equal(res.status, 202)
  const op = await res.json()
  assert.equal(op.kind, 'undo')
  assert.equal(op.backupId, SAFETY_ID)
  assert.deepEqual(op.steps.map((s) => s.key), ['restore', 'save', 'switch', 'check'])
  await ops.idle()
  const done = await ops.get(op.id)
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(seen, [['notes-app', SAFETY_KEY, 'v1']])
  assert.equal(done.detail.keptDatabase, 'notes_app_undo_20261127150000')
  assert.equal(done.detail.beforeUndoBackupKey, 'backups/notes-app/x-v2.dump')
  assert.equal(done.detail.restoredFrom, SAFETY_KEY)
})

test('undo-deploy refuses when there is nothing to undo, the app moved on, or it is busy', async (t) => {
  const none = fixture({ annotations: {} })
  const base1 = await serve(t, none.app, none.ops)
  const r1 = await post(`${base1}/api/apps/notes-app/undo-deploy`)
  assert.equal(r1.status, 409)
  assert.match((await r1.json()).error, /no safety backup/)

  const f = fixture()
  const base = await serve(t, f.app, f.ops)
  const stale = await post(`${base}/api/apps/notes-app/undo-deploy`, { imageTag: 'v3' })
  assert.equal(stale.status, 409, 'deployed again since the dashboard loaded')
  await f.store.create({ id: 'op-busy', kind: 'backup', appId: 'notes-app', status: 'running', steps: [], startedAt: new Date().toISOString() })
  const busy = await post(`${base}/api/apps/notes-app/undo-deploy`)
  assert.equal(busy.status, 409)
  assert.match((await busy.json()).error, /in progress/)
  assert.equal(f.seen.length, 0)
})

test('a failed undo is saved with the step it stopped at', async () => {
  const { ops } = fixture({ undo: async ({ onStep }) => { onStep('save'); return { ok: false, error: 'ERROR: could not save the current data first (nothing was changed)' } } })
  const op = await ops.startUndo('notes-app', { backupId: SAFETY_ID, imageTag: 'v1' })
  await ops.idle()
  const done = await ops.get(op.id)
  assert.equal(done.status, 'failed')
  assert.deepEqual(done.steps.map((s) => s.state), ['succeeded', 'failed', 'pending', 'pending'])
  assert.match(done.error, /nothing was changed/)
})
