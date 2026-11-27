// "Deploy new app" (POST /api/apps): validation, the queued message, and the worker running deploy-new-app.sh.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { Operations } from '../src/operations.js'
import { MemoryStore } from '../src/store.js'
import { processDelivery } from '../src/worker.js'

const REPO = 'github.com/adamk-codes/cmps297u-paas'
const log = { error() {}, info() {} }

async function serve(t, { executor = {}, existing = ['notes-app'], queue, env = {} } = {}) {
  const deps = { store: new MemoryStore(), catalog: { get: async () => null, list: async () => [] }, executor, queue, log }
  const operations = new Operations(deps)
  const apps = { list: async () => existing.map((id) => ({ id, name: id, history: [] })) }
  const config = loadConfig({
    APPROVED_REPOS: JSON.stringify([
      { fullName: REPO, defaultBranch: 'main', runtime: 'Node.js 20', sourceApp: 'notes-app' },
      { fullName: 'github.com/x/no-image', defaultBranch: 'main', runtime: 'Node.js 20' },
    ]),
    ...env,
  })
  const app = createApp({ operations, apps, config })
  const server = await new Promise((resolve) => {
    const http = app.listen(0, '127.0.0.1', () => resolve(http))
  })
  t.after(async () => {
    await operations.idle?.().catch(() => {})
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const base = 'http://127.0.0.1:' + server.address().port
  const deploy = (body) => fetch(base + '/api/apps', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { deps, operations, deploy, get: async (path) => (await fetch(base + path)).json() }
}

test('rejects unapproved repos, bad or taken names, no database, and too many apps', async (t) => {
  const { deploy } = await serve(t, { existing: ['notes-app', 'notes-app-recovery', 'a1', 'a2'], env: { MAX_APPS: '3' } })
  const cases = [
    [{ repo: 'github.com/evil/repo', name: 'x-app', createDatabase: true }, 400, /pre-approved/],
    [{ repo: 'github.com/x/no-image', name: 'x-app', createDatabase: true }, 400, /sourceApp/],
    [{ repo: REPO, name: 'Bad_Name', createDatabase: true }, 400, /lowercase/],
    [{ repo: REPO, name: 'ab', createDatabase: true }, 400, /lowercase/],
    [{ repo: REPO, name: 'rebound-api', createDatabase: true }, 400, /reserved/],
    [{ repo: REPO, name: 'team-recovery', createDatabase: true }, 400, /reserved/],
    [{ repo: REPO, name: 'team-notes', createDatabase: false }, 400, /database/],
    [{ repo: REPO, name: 'notes-app', createDatabase: true }, 409, /already exists/],
    [{ repo: REPO, name: 'team-notes', createDatabase: true }, 409, /at most 3 apps/],
  ]
  for (const [body, status, error] of cases) {
    const res = await deploy(body)
    assert.equal(res.status, status, JSON.stringify(body))
    assert.match((await res.json()).error, error)
  }
})

test('runs the deploy with the dashboard step keys and returns the released image', async (t) => {
  const calls = []
  const executor = {
    async deploy({ appId, sourceApp, repo, onStep }) {
      calls.push({ appId, sourceApp, repo })
      for (const step of ['build', 'store', 'release']) onStep(step)
      return { ok: true, result: { status: 'deployed', app: appId, image: 'reg/notes-app:abc123', imageTag: 'abc123' } }
    },
  }
  const { deploy, get } = await serve(t, { executor })
  const res = await deploy({ repo: REPO, name: 'team-notes', createDatabase: true })
  assert.equal(res.status, 202)
  const op = await res.json()
  assert.equal(op.kind, 'deploy')
  assert.equal(op.appId, 'team-notes')
  assert.deepEqual(op.steps.map((s) => s.key), ['test', 'build', 'store', 'release'])
  assert.equal(res.headers.get('location'), `/api/operations/${op.id}`)
  await new Promise((r) => setTimeout(r, 20))
  const done = await get(`/api/operations/${op.id}`)
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(done.steps.map((s) => s.state), ['succeeded', 'succeeded', 'succeeded', 'succeeded'])
  assert.deepEqual(done.detail, { image: 'reg/notes-app:abc123', imageTag: 'abc123', sourceApp: 'notes-app' })
  assert.deepEqual(calls, [{ appId: 'team-notes', sourceApp: 'notes-app', repo: REPO }])
})

test('a failed deploy shows the failing step and the error', async (t) => {
  const executor = {
    async deploy({ onStep }) {
      onStep('build')
      return { ok: false, error: 'image abc has 2 critical vulnerabilities; not deploying' }
    },
  }
  const { deploy, get } = await serve(t, { executor })
  const op = await (await deploy({ repo: REPO, name: 'team-notes', createDatabase: true })).json()
  await new Promise((r) => setTimeout(r, 20))
  const done = await get(`/api/operations/${op.id}`)
  assert.equal(done.status, 'failed')
  assert.match(done.error, /critical/)
  assert.deepEqual(done.steps.map((s) => s.state), ['succeeded', 'failed', 'pending', 'pending'])
})

test('through SQS, the message carries the source app and the worker runs the deploy', async (t) => {
  const sent = [], deleted = []
  const queue = {
    async send(message) { sent.push(structuredClone(message)) },
    async delete(receipt) { deleted.push(receipt) },
  }
  let ran = 0
  const executor = {
    async deploy({ appId, sourceApp }) {
      ran++
      assert.equal(appId, 'team-notes')
      assert.equal(sourceApp, 'notes-app')
      return { ok: true, result: { image: 'reg/notes-app:abc', imageTag: 'abc' } }
    },
  }
  const { deploy, deps, operations } = await serve(t, { executor, queue })
  const op = await (await deploy({ repo: REPO, name: 'team-notes', createDatabase: true })).json()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'deploy')
  assert.equal(sent[0].sourceApp, 'notes-app')
  assert.equal(sent[0].repo, REPO)
  assert.equal(ran, 0, 'the API only enqueues')

  await assert.rejects(processDelivery({ message: { ...sent[0], sourceApp: '../etc' }, receipt: 'bad' }, deps), /does not match/)
  await processDelivery({ message: sent[0], receipt: 'r1' }, deps)
  assert.equal(ran, 1)
  assert.equal((await operations.get(op.id)).status, 'succeeded')
  assert.deepEqual(deleted, ['r1'])
})
