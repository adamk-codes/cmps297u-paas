import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appsFromKube, createAppsSource, parseLogLines } from '../src/apps.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { Operations } from '../src/operations.js'
import { MemoryStore } from '../src/store.js'

const REG = '123.dkr.ecr.us-east-1.amazonaws.com'
const labels = { 'rebound.io/kind': 'app', 'rebound.io/app': 'notes-app' }

const kubeList = {
  items: [
    {
      kind: 'Deployment',
      metadata: {
        name: 'notes-app', labels, generation: 3, creationTimestamp: '2026-11-20T10:00:00Z',
        annotations: { 'rebound.io/icon': 'notes', 'rebound.io/repo': 'github.com/x/y', 'rebound.io/description': 'Notes' },
      },
      spec: { replicas: 2, template: { spec: { containers: [{ image: `${REG}/notes-app:4a1b2c3` }] } } },
      status: { observedGeneration: 3, updatedReplicas: 2, readyReplicas: 2 },
    },
    {
      kind: 'ReplicaSet',
      metadata: { labels, creationTimestamp: '2026-11-21T10:00:00Z', annotations: { 'deployment.kubernetes.io/revision': '1' } },
      spec: { template: { spec: { containers: [{ image: `${REG}/notes-app:3f9c2ab` }] } } },
    },
    {
      kind: 'ReplicaSet',
      metadata: { labels, creationTimestamp: '2026-11-24T10:00:00Z', annotations: { 'deployment.kubernetes.io/revision': '2' } },
      spec: { template: { spec: { containers: [{ image: `${REG}/notes-app:4a1b2c3` }] } } },
    },
    {
      kind: 'Pod',
      metadata: { labels },
      status: { containerStatuses: [{ imageID: `${REG}/notes-app@sha256:abcdef0123456789` }] },
    },
    { kind: 'Deployment', metadata: { name: 'unrelated', labels: {} }, spec: {}, status: {} },
  ],
}

test('maps Kubernetes objects to dashboard App objects', () => {
  const [app, ...rest] = appsFromKube(kubeList, { publicUrl: 'https://d.cloudfront.net/', region: 'us-east-1' })
  assert.equal(rest.length, 0, 'only labelled Deployments are apps')
  assert.equal(app.id, 'notes-app')
  assert.equal(app.url, 'https://d.cloudfront.net/apps/notes-app/')
  assert.equal(app.status, 'running')
  assert.equal(app.health, 'healthy')
  assert.deepEqual(app.pods, { ready: 2, desired: 2 })
  assert.equal(app.icon, 'notes')
  assert.equal(app.image.tag, '4a1b2c3')
  assert.equal(app.image.digest, 'sha256:abcdef0123456789')
  assert.equal(app.image.commit, '4a1b2c3')
  assert.deepEqual(app.history.map((h) => h.tag), ['4a1b2c3', '3f9c2ab'], 'newest rollout first')
  assert.equal(app.database.name, 'notes_app')
})

test('derives deploying / degraded / failed states', () => {
  const clone = structuredClone(kubeList)
  const d = clone.items[0]
  d.status = { observedGeneration: 3, updatedReplicas: 1, readyReplicas: 1 }
  let [app] = appsFromKube(clone)
  assert.equal(app.status, 'deploying')
  assert.equal(app.health, 'degraded')
  d.status.conditions = [{ type: 'Progressing', reason: 'ProgressDeadlineExceeded' }]
  d.status.readyReplicas = 0
  ;[app] = appsFromKube(clone)
  assert.equal(app.status, 'failed')
  assert.equal(app.health, 'unhealthy')
})

test('parses kubectl --timestamps logs with levels', () => {
  const lines = parseLogLines(
    '2026-11-24T18:00:02.000Z ERROR: connection refused\n2026-11-24T18:00:01.000Z notes-app listening on :3000\n' +
      '2026-11-24T18:00:03.000Z database not ready; retry 1/19\n',
  )
  assert.deepEqual(lines.map((l) => l.level), ['info', 'error', 'warn'])
  assert.equal(lines[0].message, 'notes-app listening on :3000')
})

test('kubernetes apps source queries the apps namespace by label', async () => {
  const calls = []
  const capture = async (cmd, args) => {
    calls.push([cmd, ...args])
    return { code: 0, stdout: JSON.stringify(kubeList), stderr: '' }
  }
  const source = createAppsSource(loadConfig({ EXECUTOR: 'kubernetes', NAMESPACE: 'apps' }), capture)
  const list = await source.list()
  assert.equal(list.length, 1)
  assert.deepEqual(calls[0], ['kubectl', '-n', 'apps', 'get', 'deploy,rs,pods', '-l', 'rebound.io/kind=app', '-o', 'json'])
})

test('app routes: list with last backup, redeploy only known images, deploy rejects unapproved repos', async () => {
  const [app] = appsFromKube(kubeList, { publicUrl: 'https://d' })
  const redeploys = []
  const executor = {
    redeploy: async (args) => {
      redeploys.push(args)
      return { ok: true, result: { image: `${REG}/notes-app:${args.imageTag}`, imageTag: args.imageTag } }
    },
  }
  const catalog = {
    list: async () => [{ appId: 'notes-app', createdAt: '2026-11-24T02:00:00Z' }],
    get: async () => null,
  }
  const operations = new Operations({ store: new MemoryStore(), executor, catalog, log: { error() {} } })
  const apps = { list: async () => [app], logs: async () => [{ ts: 't', level: 'info', message: 'hi' }] }
  const config = loadConfig({ APPROVED_REPOS: '[{"fullName":"github.com/x/y","defaultBranch":"main","runtime":"Node.js 20"}]' })
  const server = await new Promise((r) => {
    const s = createApp({ operations, apps, config }).listen(0, () => r(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const list = await (await fetch(`${base}/api/apps`)).json()
    assert.equal(list[0].lastBackupAt, '2026-11-24T02:00:00Z')
    assert.equal((await fetch(`${base}/api/apps/missing`)).status, 404)
    assert.equal((await (await fetch(`${base}/api/apps/notes-app/logs`)).json())[0].message, 'hi')
    assert.equal((await (await fetch(`${base}/api/repos`)).json())[0].fullName, 'github.com/x/y')

    assert.equal((await post('/api/apps/notes-app/redeploy', { imageTag: 'never-deployed' })).status, 400)
    const res = await post('/api/apps/notes-app/redeploy', { imageTag: '3f9c2ab' })
    assert.equal(res.status, 202)
    const op = await res.json()
    assert.deepEqual(op.steps.map((s) => s.key), ['pull', 'release'])
    await operations.idle()
    assert.equal((await (await fetch(`${base}/api/operations/${op.id}`)).json()).status, 'succeeded')
    assert.equal(redeploys[0].imageTag, '3f9c2ab')

    assert.equal((await post('/api/apps', { repo: 'x', name: 'y', createDatabase: true })).status, 400)
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
})
