import pg from 'pg'

// Operation history. One row per operation (backup, restore; deploys can use the same table later).
// Shape matches the dashboard's Operation, plus bookkeeping fields:
//   { id, kind, appId, status, steps, startedAt, finishedAt?, result?, error?, backupId?, idempotencyKey?, detail? }

export class MemoryStore {
  constructor() {
    this.ops = new Map()
    this.unsent = new Map()
  }
  async init() {}
  async create(op, message) {
    const all = [...this.ops.values()]
    const replay = op.idempotencyKey && all.find((o) => o.idempotencyKey === op.idempotencyKey)
    const running = all.find((o) => o.status === 'running' && o.kind === op.kind &&
      (op.kind === 'restore' || o.appId === op.appId))
    if (replay || running) return structuredClone(replay || running)
    if (message) {
      this.unsent.set(op.id, structuredClone(message))
    }
    this.ops.set(op.id, structuredClone(op))
    return op
  }
  async pendingMessages(before) {
    return [...this.unsent.values()].filter(({ operationId }) => {
      const op = this.ops.get(operationId)
      return op.status === 'running' && new Date(op.startedAt) < before
    }).slice(0, 10)
  }
  async markDispatched(id) {
    this.unsent.delete(id)
  }
  async update(id, patch) {
    const op = this.ops.get(id)
    if (!op) return null
    Object.assign(op, structuredClone(patch))
    return structuredClone(op)
  }
  async get(id) {
    const op = this.ops.get(id)
    return op ? structuredClone(op) : null
  }
  async findByIdempotencyKey(key) {
    for (const op of this.ops.values()) if (op.idempotencyKey === key) return structuredClone(op)
    return null
  }
  async list({ kind, appId, status, limit = 200 } = {}) {
    return [...this.ops.values()]
      .filter((o) => (!kind || o.kind === kind) && (!appId || o.appId === appId) && (!status || o.status === status))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((o) => structuredClone(o))
  }
}

// Postgres store for the platform database (one database on the shared RDS instance).
export class PgStore {
  constructor(databaseUrl) {
    const url = new URL(databaseUrl)
    const tls = url.searchParams.get('sslmode')
    url.searchParams.delete('sslmode')
    this.pool = new pg.Pool({
      connectionString: url.toString(),
      ssl: tls && tls !== 'disable' ? { rejectUnauthorized: false } : undefined,
      max: 5,
    })
  }

  async init({ recoverLocal = true } = {}) {
    await this.pool.query(`
      SELECT pg_advisory_xact_lock(hashtext('rebound:operation-schema'));
      CREATE TABLE IF NOT EXISTS operations (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        app_id          TEXT NOT NULL,
        status          TEXT NOT NULL,
        steps           JSONB NOT NULL,
        started_at      TIMESTAMPTZ NOT NULL,
        finished_at     TIMESTAMPTZ,
        result          JSONB,
        error           TEXT,
        backup_id       TEXT,
        detail          JSONB,
        idempotency_key TEXT UNIQUE
      );
      ALTER TABLE operations ADD COLUMN IF NOT EXISTS queue_message JSONB;
      ALTER TABLE operations ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS operations_kind_started ON operations (kind, started_at DESC);
      CREATE INDEX IF NOT EXISTS operations_app_started ON operations (app_id, started_at DESC);`)
    // Only work owned by the old API process was interrupted. Queued work survives either pod.
    if (recoverLocal) {
      await this.pool.query(
        `UPDATE operations SET status = 'failed', finished_at = now(), error = 'interrupted: API restarted'
         WHERE status = 'running' AND queue_message IS NULL`,
      )
    }
  }

  static toOp(r) {
    return {
      id: r.id,
      kind: r.kind,
      appId: r.app_id,
      status: r.status,
      steps: r.steps,
      startedAt: r.started_at.toISOString(),
      ...(r.finished_at && { finishedAt: r.finished_at.toISOString() }),
      ...(r.result && { result: r.result }),
      ...(r.error && { error: r.error }),
      ...(r.backup_id && { backupId: r.backup_id }),
      ...(r.detail && { detail: r.detail }),
      ...(r.idempotency_key && { idempotencyKey: r.idempotency_key }),
    }
  }

  async create(op, message) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Serialize only the short check-and-insert, including across API processes.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('rebound:operation-admission'))")
      const { rows } = await client.query(
        `SELECT * FROM operations WHERE idempotency_key = $1 OR
         (status = 'running' AND kind = $2 AND (kind = 'restore' OR app_id = $3))
         ORDER BY (idempotency_key = $1) DESC NULLS LAST, started_at DESC LIMIT 1`,
        [op.idempotencyKey ?? null, op.kind, op.appId],
      )
      if (!rows.length) {
        await client.query(
          `INSERT INTO operations (id, kind, app_id, status, steps, started_at, backup_id, detail, idempotency_key, queue_message)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [op.id, op.kind, op.appId, op.status, JSON.stringify(op.steps), op.startedAt, op.backupId ?? null,
            op.detail ?? null, op.idempotencyKey ?? null, message ?? null],
        )
      }
      await client.query('COMMIT')
      return rows.length ? PgStore.toOp(rows[0]) : op
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // Recover the gap between committing a new operation and sending its message to SQS.
  async pendingMessages(before) {
    const { rows } = await this.pool.query(
      `SELECT queue_message FROM operations WHERE status = 'running' AND queue_message IS NOT NULL
       AND dispatched_at IS NULL AND started_at < $1 ORDER BY started_at LIMIT 10`, [before],
    )
    return rows.map((row) => row.queue_message)
  }

  async markDispatched(id) {
    await this.pool.query('UPDATE operations SET dispatched_at = now() WHERE id = $1 AND dispatched_at IS NULL', [id])
  }

  async update(id, patch) {
    const cols = { status: 'status', steps: 'steps', finishedAt: 'finished_at', result: 'result', error: 'error', detail: 'detail' }
    const sets = []
    const values = []
    for (const [k, col] of Object.entries(cols)) {
      if (!(k in patch)) continue
      const v = patch[k]
      values.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v)
      sets.push(`${col} = $${values.length}`)
    }
    if (!sets.length) return this.get(id)
    values.push(id)
    const { rows } = await this.pool.query(
      `UPDATE operations SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    )
    return rows[0] ? PgStore.toOp(rows[0]) : null
  }

  async get(id) {
    const { rows } = await this.pool.query('SELECT * FROM operations WHERE id = $1', [id])
    return rows[0] ? PgStore.toOp(rows[0]) : null
  }

  async findByIdempotencyKey(key) {
    const { rows } = await this.pool.query('SELECT * FROM operations WHERE idempotency_key = $1', [key])
    return rows[0] ? PgStore.toOp(rows[0]) : null
  }

  async list({ kind, appId, status, limit = 200 } = {}) {
    const where = []
    const values = []
    for (const [v, col] of [[kind, 'kind'], [appId, 'app_id'], [status, 'status']]) {
      if (!v) continue
      values.push(v)
      where.push(`${col} = $${values.length}`)
    }
    values.push(limit)
    const { rows } = await this.pool.query(
      `SELECT * FROM operations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY started_at DESC LIMIT $${values.length}`,
      values,
    )
    return rows.map(PgStore.toOp)
  }

  async close() {
    await this.pool.end()
  }
}
