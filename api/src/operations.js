import { randomUUID } from 'node:crypto'
import { advanceSteps, finishSteps, initialSteps, stepKeyFor } from './steps.js'

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const APP_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

// Starts backups and restores as background operations and records their progress.
// Guarantees from the proposal:
//   - unique operation ids, and an Idempotency-Key header makes a repeated request return the same operation
//   - one restore at a time (across all apps); one backup at a time per app
//   - steps move forward only, and a failed operation keeps the step where it failed
export class Operations {
  constructor({ store, executor, catalog, now = () => new Date(), log = console }) {
    this.store = store
    this.executor = executor
    this.catalog = catalog
    this.now = now
    this.log = log
    this.inFlight = new Set() // promises, so tests/shutdown can wait for background work
  }

  async startBackup(appId, { idempotencyKey } = {}) {
    if (!APP_ID.test(appId ?? '')) throw new HttpError(400, 'invalid app id')
    const existing = await this.replay(idempotencyKey)
    if (existing) return existing
    const running = await this.store.list({ kind: 'backup', appId, status: 'running', limit: 1 })
    if (running.length) return running[0] // a second click joins the backup already in progress

    const op = await this.create('backup', appId, { idempotencyKey })
    this.track(op, (onStep) => this.executor.backup({ appId, onStep }), (r) => ({
      detail: { s3Key: r.s3Key, sizeBytes: r.sizeBytes, imageTag: r.imageTag, rowCount: r.rowCount },
    }))
    return op
  }

  async startRestore(backupId, { idempotencyKey } = {}) {
    const existing = await this.replay(idempotencyKey)
    if (existing) return existing
    const backup = await this.catalog.get(backupId)
    if (!backup) throw new HttpError(404, `backup ${backupId} was not found`)
    const running = await this.store.list({ kind: 'restore', status: 'running', limit: 1 })
    if (running.length) {
      throw new HttpError(409, 'A restore is already running. Restores run one at a time.', {
        operationId: running[0].id,
      })
    }

    const op = await this.create('restore', backup.appId, { idempotencyKey, backupId })
    this.track(op, (onStep) => this.executor.restore({ appId: backup.appId, backup, onStep }), (r) => ({
      result: {
        backupId,
        targetDatabase: r.targetDatabase,
        recoveryUrl: r.recoveryUrl,
        recordsChecked: r.recordsChecked,
        durationSeconds: r.durationSeconds,
      },
      detail: { restoreSeconds: r.restoreSeconds, image: r.image, backupKey: backup.s3Key },
    }))
    return op
  }

  async get(id) {
    const op = await this.store.get(id)
    if (!op) throw new HttpError(404, `operation ${id} was not found`)
    return op
  }

  async replay(idempotencyKey) {
    if (!idempotencyKey) return null
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new HttpError(400, 'invalid Idempotency-Key')
    return this.store.findByIdempotencyKey(idempotencyKey)
  }

  async create(kind, appId, { idempotencyKey, backupId } = {}) {
    const op = {
      id: `op-${randomUUID()}`,
      kind,
      appId,
      status: 'running',
      steps: initialSteps(kind),
      startedAt: this.now().toISOString(),
      ...(backupId && { backupId }),
      ...(idempotencyKey && { idempotencyKey }),
    }
    try {
      await this.store.create(op)
    } catch (err) {
      // Two identical requests raced; return the one that won.
      if (err.code === 'DUPLICATE') return this.store.findByIdempotencyKey(idempotencyKey)
      throw err
    }
    return op
  }

  track(op, work, onSuccess) {
    let steps = op.steps
    let pending = Promise.resolve()
    const save = (patch) => {
      pending = pending.then(() => this.store.update(op.id, patch)).catch((e) => this.log.error(e))
      return pending
    }
    const onStep = (logStep) => {
      const key = stepKeyFor(op.kind, logStep)
      if (!key) return
      const next = advanceSteps(steps, key)
      if (next !== steps) {
        steps = next
        save({ steps })
      }
    }
    const done = (async () => {
      let outcome
      try {
        outcome = await work(onStep)
      } catch (err) {
        outcome = { ok: false, error: err.message }
      }
      const finishedAt = this.now().toISOString()
      if (outcome.ok) {
        await save({ status: 'succeeded', steps: finishSteps(steps, true), finishedAt, ...onSuccess(outcome.result) })
      } else {
        this.log.error(`operation ${op.id} (${op.kind} ${op.appId}) failed: ${outcome.error}`)
        await save({ status: 'failed', steps: finishSteps(steps, false), finishedAt, error: outcome.error })
      }
    })()
    this.inFlight.add(done)
    done.finally(() => this.inFlight.delete(done))
  }

  async idle() {
    while (this.inFlight.size) await Promise.all([...this.inFlight])
  }

  // ---- read models for the dashboard ----

  async listBackups(appId) {
    if (appId && !APP_ID.test(appId)) throw new HttpError(400, 'invalid app id')
    const [stored, ops, restores] = await Promise.all([
      this.catalog.list(appId),
      this.store.list({ kind: 'backup', appId }),
      this.store.list({ kind: 'restore', status: 'succeeded' }),
    ])
    const verified = new Map()
    for (const r of restores) {
      if (r.backupId && !verified.has(r.backupId)) verified.set(r.backupId, r.finishedAt)
    }
    const backups = stored.map((b) => ({ ...b, ...(verified.has(b.id) && { verifiedAt: verified.get(b.id) }) }))
    // Backups still running or failed exist only as operations, not as S3 objects.
    const inProgress = ops
      .filter((o) => o.status !== 'succeeded')
      .map((o) => ({
        id: o.id,
        appId: o.appId,
        appName: o.appId,
        createdAt: o.startedAt,
        trigger: 'manual',
        status: o.status === 'running' ? 'running' : 'failed',
        sizeBytes: 0,
        image: { tag: '', digest: '' },
        s3Key: '',
        operationId: o.id,
      }))
    return [...inProgress, ...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async listRestores() {
    const ops = await this.store.list({ kind: 'restore', status: 'succeeded' })
    return ops.map((o) => ({
      id: o.id,
      appId: o.appId,
      appName: o.appId,
      startedAt: o.startedAt,
      ...o.result,
    }))
  }
}
