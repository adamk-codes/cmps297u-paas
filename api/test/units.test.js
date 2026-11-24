import { test } from 'node:test'
import assert from 'node:assert/strict'
import { S3Catalog, backupIdFromKey, keyFromBackupId, parseBackupFileName } from '../src/catalog.js'
import { createExecutor } from '../src/executor.js'
import { loadConfig } from '../src/config.js'
import { runScript } from '../src/runner.js'
import { advanceSteps, finishSteps, initialSteps } from '../src/steps.js'

test('backup ids round-trip with S3 keys and reject junk', () => {
  const key = 'backups/notes-app/20261124T183411Z-3f9c2ab.dump'
  const id = backupIdFromKey(key)
  assert.equal(id, 'notes-app~20261124T183411Z-3f9c2ab')
  assert.equal(keyFromBackupId(id), key)
  assert.equal(keyFromBackupId('../../etc/passwd'), null)
  assert.equal(keyFromBackupId('notes-app~a/b'), null)
  assert.deepEqual(parseBackupFileName('20261124T183411Z-3f9c2ab'), { createdAt: '2026-11-24T18:34:11Z', tag: '3f9c2ab' })
})

test('S3 catalog maps objects + metadata to dashboard Backup shapes', async () => {
  const sent = []
  const client = {
    async send(cmd) {
      sent.push(cmd.constructor.name)
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return {
          Contents: [
            { Key: 'backups/notes-app/20261124T020000Z-3f9c2ab.dump', Size: 5000, LastModified: new Date() },
            { Key: 'backups/notes-app/20261124T183411Z-4a1b2c3.dump', Size: 5216, LastModified: new Date() },
            { Key: 'backups/notes-app/readme.txt', Size: 1, LastModified: new Date() },
          ],
        }
      }
      const scheduled = cmd.input.Key.includes('T020000Z')
      return { Metadata: { app: 'notes-app', 'image-tag': scheduled ? '3f9c2ab' : '4a1b2c3', trigger: scheduled ? 'scheduled' : 'manual', 'row-count': '120' } }
    },
  }
  const catalog = new S3Catalog({ bucket: 'b', prefix: 'backups' }, client)
  const list = await catalog.list('notes-app')
  assert.equal(list.length, 2)
  assert.equal(list[0].createdAt, '2026-11-24T18:34:11Z') // newest first
  assert.equal(list[0].image.tag, '4a1b2c3')
  assert.equal(list[1].trigger, 'scheduled')
  assert.equal(list[0].rowCount, 120)
  // Metadata is cached: a second listing does no extra HeadObject calls.
  const heads = sent.filter((n) => n === 'HeadObjectCommand').length
  await catalog.list('notes-app')
  assert.equal(sent.filter((n) => n === 'HeadObjectCommand').length, heads)
})

test('steps only move forward and failures stop at the running step', () => {
  let steps = initialSteps('restore')
  steps = advanceSteps(steps, 'check')
  assert.deepEqual(steps.map((s) => s.state), ['succeeded', 'succeeded', 'running'])
  assert.equal(advanceSteps(steps, 'restore'), steps)
  assert.deepEqual(finishSteps(initialSteps('backup'), false).map((s) => s.state), ['failed', 'pending'])
})

test('runner parses step markers and result lines from a real child process', async () => {
  const script = `
    console.error('2026-11-24T18:34:11Z [dump] dumping database');
    console.error('18:34:12 ::step store');
    console.log('BACKUP_RESULT {"status":"succeeded","s3Key":"backups/x/y.dump"}');`
  const steps = []
  const res = await runScript({ command: process.execPath, args: ['-e', script], onStep: (s) => steps.push(s) })
  assert.equal(res.code, 0)
  assert.deepEqual(steps, ['dump', 'store'])
  assert.equal(res.results.BACKUP_RESULT.s3Key, 'backups/x/y.dump')
})

test('runner reports non-zero exits without throwing', async () => {
  const res = await runScript({ command: process.execPath, args: ['-e', "console.error('ERROR: boom'); process.exit(3)"] })
  assert.equal(res.code, 3)
  assert.match(res.logTail.at(-1), /boom/)
})

test('kubernetes executor runs rebound-data.sh and maps RECOVERY_RESULT', async () => {
  const config = loadConfig({ EXECUTOR: 'kubernetes', JOBS_DIR: '/jobs', S3_BUCKET: 'rebound-backups' })
  let invoked
  const fakeRun = async (opts) => {
    invoked = opts
    return {
      code: 0,
      logTail: [],
      results: {
        RECOVERY_RESULT: {
          targetDatabase: 'notes_app_restore_1', recoveryUrl: 'http://alb/apps/notes-app-recovery/',
          recordsChecked: 120, durationSeconds: 40, restoreSeconds: 8, image: 'repo/notes-app:3f9c2ab',
        },
      },
    }
  }
  const ex = createExecutor(config, fakeRun)
  const out = await ex.restore({ appId: 'notes-app', backup: { s3Key: 'backups/notes-app/x.dump' } })
  assert.deepEqual(invoked.args.slice(1), ['restore', 'notes-app', 'backups/notes-app/x.dump'])
  assert.match(invoked.args[0].replaceAll('\\', '/'), /\/jobs\/k8s\/rebound-data\.sh$/)
  assert.equal(out.ok, true)
  assert.equal(out.result.recordsChecked, 120)
  assert.equal(out.result.recoveryUrl, 'http://alb/apps/notes-app-recovery/')
})

test('process executor needs per-app settings and surfaces the error line', async () => {
  const config = loadConfig({ EXECUTOR: 'process', JOBS_DIR: '/jobs' })
  const ex = createExecutor(config, async () => ({ code: 1, results: {}, logTail: ['x', 'ERROR: pg_dump failed'] }))
  assert.match((await ex.backup({ appId: 'notes-app' })).error, /LOCAL_APPS/)
  const withApp = createExecutor(
    loadConfig({ EXECUTOR: 'process', JOBS_DIR: '/jobs', LOCAL_APPS: '{"notes-app":{"databaseUrl":"postgres://u:p@h/db"}}' }),
    async () => ({ code: 1, results: {}, logTail: ['x', 'ERROR: pg_dump failed'] }),
  )
  assert.equal((await withApp.backup({ appId: 'notes-app' })).error, 'ERROR: pg_dump failed')
})
