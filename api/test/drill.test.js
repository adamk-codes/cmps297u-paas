// Nightly recovery drill: the operation, its endpoint, "verified" marking, and the scheduler's rules.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { drillKey, drillTick, isDrillTime } from '../src/drill-scheduler.js'
import { Operations } from '../src/operations.js'
import { MemoryStore } from '../src/store.js'

const log = { error() {}, info() {} }
const backup = (appId, day) => ({
  id: `${appId}~${day}`, appId, appName: appId, createdAt: `2026-11-${day}T02:00:00Z`, trigger: 'scheduled',
  status: 'completed', sizeBytes: 5000, image: { tag: 't', digest: '' }, s3Key: `backups/${appId}/202611${day}T020000Z-t.dump`,
})
const catalog = {
  items: [backup('notes-app', '26'), backup('notes-app', '27'), backup('team-notes', '27')],
  async list(appId) { return this.items.filter((b) => !appId || b.appId === appId) },
  async get(id) { return this.items.find((b) => b.id === id) ?? null },
}
const passing = (seen) => ({
  async drill({ appId, backup: b, onStep }) {
    seen?.push([appId, b.s3Key])
    onStep('check'); onStep('cleanup')
    return { ok: true, result: { recordsChecked: 120, expectedRecords: 120, durationSeconds: 9, targetDatabase: 'x_restore_1', dropped: true } }
  },
})
const liveApps = (...ids) => ({ list: async () => ids.map((id) => ({ id, status: 'running', database: {}, history: [] })) })

test('a drill tests the newest backup, cleans up, and marks that backup verified', async () => {
  const seen = []
  const ops = new Operations({ store: new MemoryStore(), executor: passing(seen), catalog, log })
  const op = await ops.startDrill('notes-app', { startedBy: 'jason@team.test' })
  assert.deepEqual(op.steps.map((s) => s.key), ['restore', 'check', 'cleanup'])
  assert.equal(op.backupId, 'notes-app~27')
  await ops.idle()
  const done = await ops.get(op.id)
  assert.equal(done.status, 'succeeded')
  assert.equal(done.detail.recordsChecked, 120)
  assert.equal(done.detail.dropped, true)
  assert.deepEqual(seen, [['notes-app', 'backups/notes-app/20261127T020000Z-t.dump']])
  const listed = await ops.listBackups('notes-app')
  assert.ok(listed.find((b) => b.id === 'notes-app~27').verifiedAt, 'newest backup verified')
  assert.equal(listed.find((b) => b.id === 'notes-app~26').verifiedAt, undefined)
})

test('POST /api/apps/:appId/drill starts one; no backups is a 404', async (t) => {
  const ops = new Operations({ store: new MemoryStore(), executor: passing(), catalog, log })
  const app = createApp({ operations: ops, apps: liveApps('notes-app', 'empty-app'), config: loadConfig({}) })
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  t.after(async () => { await ops.idle(); server.closeAllConnections(); await new Promise((r) => server.close(r)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const res = await fetch(`${base}/api/apps/notes-app/drill`, { method: 'POST' })
  assert.equal(res.status, 202)
  assert.equal((await res.json()).kind, 'drill')
  const none = await fetch(`${base}/api/apps/empty-app/drill`, { method: 'POST' })
  assert.equal(none.status, 404)
  assert.match((await none.json()).error, /no backups/)
})

test('the scheduler waits for 03:00 UTC, runs one drill at a time, and once per app per day', async () => {
  const seen = []
  const ops = new Operations({ store: new MemoryStore(), executor: passing(seen), catalog, log })
  const deps = { operations: ops, apps: liveApps('notes-app', 'team-notes', 'empty-app'), config: { drillTime: '03:00' }, log }
  assert.equal(isDrillTime('03:00', new Date('2026-11-28T02:59:00Z')), false)
  assert.equal(isDrillTime('off', new Date('2026-11-28T12:00:00Z')), false)

  assert.equal(await drillTick({ ...deps, now: new Date('2026-11-28T02:30:00Z') }), 'not yet')
  const night = new Date('2026-11-28T03:01:00Z')
  assert.equal(await drillTick({ ...deps, now: night }), 'started notes-app')
  assert.equal(await drillTick({ ...deps, now: night }), 'busy', 'one drill at a time')
  await ops.idle()
  assert.equal(await drillTick({ ...deps, now: night }), 'started team-notes')
  await ops.idle()
  assert.equal(await drillTick({ ...deps, now: night }), 'done for today', 'empty-app has no backups; skipped')
  assert.equal(await drillTick({ ...deps, now: new Date('2026-11-28T09:00:00Z') }), 'done for today')
  assert.deepEqual(seen.map(([a]) => a), ['notes-app', 'team-notes'])
  assert.equal(drillKey('notes-app', night), 'drill-notes-app-20261128')
  assert.equal(await drillTick({ ...deps, now: new Date('2026-11-29T03:05:00Z') }), 'started notes-app', 'next night again')
  await ops.idle()
})
