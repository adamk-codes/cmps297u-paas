// End-to-end tests of the HTTP API with a fake executor and an in-memory S3 catalog: no AWS, Docker or DB.
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { backupIdFromKey } from '../src/catalog.js'
import { loadConfig } from '../src/config.js'
import { Operations } from '../src/operations.js'
import { MemoryStore } from '../src/store.js'

const KEY = 'backups/notes-app/20261124T183411Z-3f9c2ab.dump'
const BACKUP_ID = backupIdFromKey(KEY)

function fakeCatalog() {
  const backups = [
    {
      id: BACKUP_ID, appId: 'notes-app', appName: 'notes-app', createdAt: '2026-11-24T18:34:11Z',
      trigger: 'manual', status: 'completed', sizeBytes: 5216, image: { tag: '3f9c2ab', digest: '' }, s3Key: KEY,
    },
  ]
  return {
    backups,
    async list(appId) {
      return backups.filter((b) => !appId || b.appId === appId)
    },
    async get(id) {
      return backups.find((b) => b.id === id) ?? null
    },
  }
}

// Each call waits until the test releases it, so we can observe the "running" state.
function controllableExecutor() {
  const calls = []
  const make = (kind) => ({ appId, backup, onStep }) =>
    new Promise((resolve) => calls.push({ kind, appId, backup, onStep, resolve }))
  return { calls, backup: make('backup'), restore: make('restore') }
}

let server, base, executor, operations, catalog

async function start() {
  executor = controllableExecutor()
  catalog = fakeCatalog()
  operations = new Operations({ store: new MemoryStore(), executor, catalog, log: { error() {} } })
  const config = loadConfig({ CORS_ORIGINS: 'http://localhost:5173' })
  const app = createApp({ operations, config })
  server = await new Promise((r) => {
    const s = app.listen(0, () => r(s))
  })
  base = `http://127.0.0.1:${server.address().port}`
}

async function stop() {
  await operations.idle().catch(() => {})
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
}

const post = (path, headers = {}) => fetch(base + path, { method: 'POST', headers })
const get = async (path) => (await fetch(base + path)).json()

describe('backups', () => {
  beforeEach(start)
  afterEach(stop)

  test('a backup runs as an operation with the dashboard step keys', async () => {
    const res = await post('/api/apps/notes-app/backups')
    assert.equal(res.status, 202)
    const op = await res.json()
    assert.equal(op.kind, 'backup')
    assert.equal(op.status, 'running')
    assert.deepEqual(op.steps.map((s) => [s.key, s.state]), [['dump', 'running'], ['store', 'pending']])
    assert.equal(res.headers.get('location'), `/api/operations/${op.id}`)

    // Script reports it moved to the store step.
    executor.calls[0].onStep('store')
    await new Promise((r) => setTimeout(r, 10))
    const mid = await get(`/api/operations/${op.id}`)
    assert.deepEqual(mid.steps.map((s) => s.state), ['succeeded', 'running'])

    // While running it shows up in the backup list.
    const listed = await get('/api/backups?appId=notes-app')
    assert.equal(listed.find((b) => b.id === op.id)?.status, 'running')

    executor.calls[0].resolve({ ok: true, result: { s3Key: KEY, sizeBytes: 5216, imageTag: '3f9c2ab', rowCount: 120 } })
    await operations.idle()
    const done = await get(`/api/operations/${op.id}`)
    assert.equal(done.status, 'succeeded')
    assert.ok(done.finishedAt)
    assert.ok(done.steps.every((s) => s.state === 'succeeded'))
  })

  test('repeated requests never run the same job twice', async () => {
    const a = await (await post('/api/apps/notes-app/backups', { 'Idempotency-Key': 'click-12345678' })).json()
    const b = await (await post('/api/apps/notes-app/backups', { 'Idempotency-Key': 'click-12345678' })).json()
    const c = await (await post('/api/apps/notes-app/backups')).json() // joins the running backup
    assert.equal(a.id, b.id)
    assert.equal(a.id, c.id)
    assert.equal(executor.calls.length, 1)
    executor.calls[0].resolve({ ok: true, result: {} })
    await operations.idle()
  })

  test('a failed backup is reported with the failing step and error', async () => {
    const op = await (await post('/api/apps/notes-app/backups')).json()
    executor.calls[0].resolve({ ok: false, error: 'pg_dump: connection refused' })
    await operations.idle()
    const done = await get(`/api/operations/${op.id}`)
    assert.equal(done.status, 'failed')
    assert.equal(done.error, 'pg_dump: connection refused')
    assert.deepEqual(done.steps.map((s) => s.state), ['failed', 'pending'])
  })

  test('rejects invalid app ids', async () => {
    assert.equal((await post('/api/apps/Bad_App;drop/backups')).status, 400)
  })
})

describe('restores', () => {
  beforeEach(start)
  afterEach(stop)

  test('restore returns the dashboard RestoreResult and marks the backup verified', async () => {
    const res = await post(`/api/backups/${BACKUP_ID}/restore`)
    assert.equal(res.status, 202)
    const op = await res.json()
    assert.deepEqual(op.steps.map((s) => s.key), ['restore', 'run', 'check'])
    assert.equal(executor.calls[0].backup.s3Key, KEY)

    executor.calls[0].onStep('run')
    executor.calls[0].onStep('restore') // late/out-of-order markers never move a step backwards
    executor.calls[0].resolve({
      ok: true,
      result: {
        targetDatabase: 'notes_app_restore_20261124190000',
        recoveryUrl: 'http://alb.example/apps/notes-app-recovery/',
        recordsChecked: 120,
        durationSeconds: 48,
        restoreSeconds: 9,
      },
    })
    await operations.idle()

    const done = await get(`/api/operations/${op.id}`)
    assert.equal(done.status, 'succeeded')
    assert.deepEqual(done.result, {
      backupId: BACKUP_ID,
      targetDatabase: 'notes_app_restore_20261124190000',
      recoveryUrl: 'http://alb.example/apps/notes-app-recovery/',
      recordsChecked: 120,
      durationSeconds: 48,
    })

    const restores = await get('/api/restores')
    assert.equal(restores.length, 1)
    assert.equal(restores[0].appName, 'notes-app')
    assert.equal(restores[0].recordsChecked, 120)

    const [backup] = await get('/api/backups')
    assert.ok(backup.verifiedAt, 'backup should be marked verified after a successful restore')
  })

  test('only one restore runs at a time', async () => {
    const first = await post(`/api/backups/${BACKUP_ID}/restore`)
    assert.equal(first.status, 202)
    const second = await post(`/api/backups/${BACKUP_ID}/restore`)
    assert.equal(second.status, 409)
    assert.match((await second.json()).error, /one at a time/)
    executor.calls[0].resolve({ ok: false, error: 'stopped' })
    await operations.idle()
    assert.equal((await post(`/api/backups/${BACKUP_ID}/restore`)).status, 202)
    executor.calls[1].resolve({ ok: false, error: 'stopped' })
    await operations.idle()
  })

  test('unknown backups and operations are 404', async () => {
    assert.equal((await post('/api/backups/notes-app~19990101T000000Z-x/restore')).status, 404)
    assert.equal((await post('/api/backups/not-a-valid-id/restore')).status, 404)
    assert.equal((await fetch(`${base}/api/operations/op-missing`)).status, 404)
  })
})

describe('http basics', () => {
  beforeEach(start)
  afterEach(stop)

  test('CORS allows the dashboard origin only', async () => {
    const ok = await fetch(`${base}/api/backups`, { headers: { Origin: 'http://localhost:5173' } })
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    const other = await fetch(`${base}/api/backups`, { headers: { Origin: 'http://evil.example' } })
    assert.equal(other.headers.get('access-control-allow-origin'), null)
    const preflight = await fetch(`${base}/api/apps/notes-app/backups`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(preflight.status, 204)
  })
})

describe('cognito auth', () => {
  async function withApp(verifier, fn) {
    const ops = new Operations({ store: new MemoryStore(), executor: controllableExecutor(), catalog: fakeCatalog() })
    const config = loadConfig({ COGNITO_USER_POOL_ID: 'us-east-1_AbCdEfGhI', COGNITO_CLIENT_ID: 'dashboardclient' })
    const s = await new Promise((r) => {
      const x = createApp({ operations: ops, config, verifier }).listen(0, () => r(x))
    })
    try {
      await fn(`http://127.0.0.1:${s.address().port}`)
    } finally {
      s.closeAllConnections()
      await new Promise((r) => s.close(r))
    }
  }

  test('requires a valid token for /api but not for health checks', async () => {
    // Real verifier: malformed tokens are rejected locally, before any call to Cognito.
    await withApp(undefined, async (url) => {
      assert.equal((await fetch(`${url}/healthz`)).status, 200)
      assert.equal((await fetch(`${url}/api/backups`)).status, 401)
      const bad = await fetch(`${url}/api/backups`, { headers: { Authorization: 'Bearer not.a.jwt' } })
      assert.equal(bad.status, 401)
    })
  })

  test('accepts a token the verifier approves', async () => {
    const verifier = { verify: async (t) => (t === 'good' ? { sub: 'u1', email: 'a@b.c' } : Promise.reject(new Error('no'))) }
    await withApp(verifier, async (url) => {
      assert.equal((await fetch(`${url}/api/backups`, { headers: { Authorization: 'Bearer good' } })).status, 200)
      assert.equal((await fetch(`${url}/api/backups`, { headers: { Authorization: 'Bearer nope' } })).status, 401)
    })
  })

  test('the activity log records who started each operation, newest first', async () => {
    const people = { jason: 'jason@team.test', adam: 'adam@team.test' }
    const verifier = { verify: async (t) => ({ sub: t, email: people[t] }) }
    await withApp(verifier, async (url) => {
      const as = (who) => ({ method: 'POST', headers: { Authorization: `Bearer ${who}` } })
      const first = await (await fetch(`${url}/api/apps/notes-app/backups`, as('jason'))).json()
      assert.equal(first.startedBy, 'jason@team.test')
      await new Promise((r) => setTimeout(r, 5))
      await fetch(`${url}/api/backups/${BACKUP_ID}/restore`, as('adam'))
      const list = await (await fetch(`${url}/api/operations?limit=10`, { headers: { Authorization: 'Bearer adam' } })).json()
      assert.deepEqual(list.map((o) => [o.kind, o.startedBy]), [['restore', 'adam@team.test'], ['backup', 'jason@team.test']])
      const one = await (await fetch(`${url}/api/operations?limit=1`, { headers: { Authorization: 'Bearer adam' } })).json()
      assert.equal(one.length, 1)
    })
  })
})
