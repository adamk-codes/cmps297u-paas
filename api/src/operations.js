import { randomUUID } from 'node:crypto'
import { failedOperation, runOperation } from './run-operation.js'
import { initialSteps } from './steps.js'

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const APP_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

function validateKey(key) {
  if (key && !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new HttpError(400, 'invalid Idempotency-Key')
}

export class Operations {
  constructor({ store, executor, catalog, queue, now = () => new Date(), log = console }) {
    this.store = store
    this.executor = executor
    this.catalog = catalog
    this.queue = queue
    this.now = now
    this.log = log
    this.inFlight = new Set()
  }

  async startBackup(appId, { idempotencyKey } = {}) {
    if (!APP_ID.test(appId ?? '')) throw new HttpError(400, 'invalid app id')
    return this.start('backup', appId, { idempotencyKey })
  }

  async startRestore(backupId, { idempotencyKey } = {}) {
    // An idempotent replay still works if the original backup has since expired.
    validateKey(idempotencyKey)
    if (idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(idempotencyKey)
      if (existing) return existing
    }
    const backup = await this.catalog.get(backupId)
    if (!backup) throw new HttpError(404, `backup ${backupId} was not found`)
    return this.start('restore', backup.appId, { idempotencyKey, backupId }, backup)
  }

  async startRedeploy(appId, imageTag, { idempotencyKey } = {}) {
    if (!APP_ID.test(appId ?? '')) throw new HttpError(400, 'invalid app id')
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(imageTag ?? '')) throw new HttpError(400, 'invalid image tag')
    return this.start('redeploy', appId, { idempotencyKey, imageTag })
  }

  // New app (dashboard "Deploy new app"). The caller checks the repo is approved and the name is free.
  async startDeploy(appId, { sourceApp, repo, idempotencyKey } = {}) {
    if (!APP_ID.test(appId ?? '')) throw new HttpError(400, 'invalid app name')
    if (!APP_ID.test(sourceApp ?? '')) throw new HttpError(400, 'invalid source app')
    return this.start('deploy', appId, { idempotencyKey, sourceApp, repo })
  }

  async get(id) {
    const op = await this.store.get(id)
    if (!op) throw new HttpError(404, `operation ${id} was not found`)
    return op
  }

  async start(kind, appId, { idempotencyKey, backupId, imageTag, sourceApp, repo }, backup) {
    validateKey(idempotencyKey)
    const op = {
      id: `op-${randomUUID()}`, kind, appId, status: 'running',
      steps: initialSteps(kind), startedAt: this.now().toISOString(),
      ...(backupId && { backupId }), ...(idempotencyKey && { idempotencyKey }),
    }
    const message = {
      operationId: op.id, kind, appId, ...(backupId && { backupId }), ...(imageTag && { imageTag }),
      ...(sourceApp && { sourceApp }), ...(repo && { repo }),
    }
    const saved = await this.store.create(op, this.queue ? message : undefined)
    if (saved.id !== op.id) {
      if ((idempotencyKey && saved.idempotencyKey === idempotencyKey) || kind === 'backup') return saved
      const reason = kind === 'restore' ? 'A restore is already running. Restores run one at a time.'
        : kind === 'deploy' ? `${appId} is already being deployed`
        : `a rollout of ${appId} is already running`
      throw new HttpError(409, reason, { operationId: saved.id })
    }

    if (this.queue) {
      try {
        await this.queue.send(message)
      } catch (err) {
        return this.store.update(op.id, failedOperation(op.steps, `Could not enqueue ${kind}: ${err.message}`, this.now()))
      }
      // SQS accepted the work. If bookkeeping fails, an extra delivery can be safely acknowledged later.
      await this.store.markDispatched(op.id).catch((err) => this.log.error(err))
    } else {
      const done = runOperation(op, message, this, { backup }).catch((err) => this.log.error(err))
      this.inFlight.add(done)
      done.finally(() => this.inFlight.delete(done))
    }
    return op
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
