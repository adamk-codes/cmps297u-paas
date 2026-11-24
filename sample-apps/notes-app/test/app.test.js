// Fast tests with an in-memory data layer: no database needed, so CI can run `npm test` anywhere.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { loadConfig, normalizeBasePath } from '../src/config.js'
import { buildSeedRows } from '../src/seed.js'

function memoryRepo({ healthy = true } = {}) {
  let nextId = 1
  const notes = buildSeedRows(120).map((r) => ({ id: nextId++, ...r, created_at: r.createdAt }))
  return {
    async ping() {
      if (!healthy) throw new Error('connection refused')
    },
    async databaseName() {
      return 'notes_app'
    },
    async count() {
      return notes.length
    },
    async list({ limit, offset }) {
      return [...notes].reverse().slice(offset, offset + limit)
    },
    async get(id) {
      return notes.find((n) => n.id === id) ?? null
    },
    async create(input) {
      const note = { id: nextId++, ...input, created_at: new Date().toISOString() }
      notes.push(note)
      return note
    },
    async remove(id) {
      const i = notes.findIndex((n) => n.id === id)
      if (i === -1) return false
      notes.splice(i, 1)
      return true
    },
    async deleteFraction(percent) {
      return notes.splice(0, Math.ceil((notes.length * percent) / 100)).length
    },
  }
}

async function startApp(env, repo = memoryRepo()) {
  const app = createApp({ repo, config: loadConfig(env) })
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base }
}

describe('notes-app under BASE_PATH', () => {
  let server
  let base
  before(async () => ({ server, base } = await startApp({ BASE_PATH: '/apps/notes-app/', ALLOW_DATA_LOSS_DEMO: 'true' })))
  after(() => server.close())

  test('serves health under the base path and at the root', async () => {
    for (const path of ['/apps/notes-app/healthz', '/healthz']) {
      const res = await fetch(base + path)
      assert.equal(res.status, 200, path)
      assert.equal((await res.json()).status, 'ok')
    }
  })

  test('only serves the app under the base path', async () => {
    assert.equal((await fetch(`${base}/api/notes`)).status, 404)
    const page = await fetch(`${base}/apps/notes-app/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /action="\/apps\/notes-app\/notes"/)
  })

  test('lists the seeded notes (at least 100)', async () => {
    const res = await fetch(`${base}/apps/notes-app/api/notes?limit=10`)
    const data = await res.json()
    assert.ok(data.total >= 100)
    assert.equal(data.notes.length, 10)
  })

  test('creates a note and rejects an empty title', async () => {
    const ok = await fetch(`${base}/apps/notes-app/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Backup drill passed', body: '120 rows restored' }),
    })
    assert.equal(ok.status, 201)
    assert.equal((await ok.json()).title, 'Backup drill passed')

    const bad = await fetch(`${base}/apps/notes-app/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    assert.equal(bad.status, 400)
  })

  test('simulated data loss deletes notes when enabled', async () => {
    const res = await fetch(`${base}/apps/notes-app/api/demo/data-loss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ percent: 50 }),
    })
    const data = await res.json()
    assert.ok(data.deleted > 0)
    assert.ok(data.remaining < 100)
  })
})

describe('notes-app edge cases', () => {
  test('health returns 503 when the database is down', async () => {
    const { server, base } = await startApp({}, memoryRepo({ healthy: false }))
    try {
      const res = await fetch(`${base}/healthz`)
      assert.equal(res.status, 503)
    } finally {
      server.close()
    }
  })

  test('data-loss demo is disabled by default', async () => {
    const { server, base } = await startApp({})
    try {
      assert.equal((await fetch(`${base}/api/demo/data-loss`, { method: 'POST' })).status, 403)
    } finally {
      server.close()
    }
  })

  test('normalizes BASE_PATH values', () => {
    assert.equal(normalizeBasePath(undefined), '')
    assert.equal(normalizeBasePath('/'), '')
    assert.equal(normalizeBasePath('apps/notes-app'), '/apps/notes-app')
    assert.equal(normalizeBasePath('/apps/notes-app///'), '/apps/notes-app')
  })
})
