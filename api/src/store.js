import pg from 'pg'

// Operation history. One row per operation (backup, restore; deploys can use the same table later).
// Shape matches the dashboard's Operation, plus bookkeeping fields:
//   { id, kind, appId, status, steps, startedAt, finishedAt?, result?, error?, backupId?, idempotencyKey?, detail? }

export class MemoryStore {
  constructor() {
    this.ops = new Map()
  }
  async init() {}
  async create(op) {
    if (op.idempotencyKey && (await this.findByIdempotencyKey(op.idempotencyKey))) {
      throw Object.assign(new Error('duplicate idempotency key'), { code: 'DUPLICATE' })
    }
    this.ops.set(op.id, structuredClone(op))
    return op
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

  async init() {
    await this.pool.query(`
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
      CREATE INDEX IF NOT EXISTS operations_kind_started ON operations (kind, started_at DESC);
      CREATE INDEX IF NOT EXISTS operations_app_started ON operations (app_id, started_at DESC);`)
    // Anything still "running" belongs to a previous API process that is gone.
    await this.pool.query(
      `UPDATE operations SET status = 'failed', finished_at = now(), error = 'interrupted: API restarted'
       WHERE status = 'running'`,
    )
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

  async create(op) {
    try {
      await this.pool.query(
        `INSERT INTO operations (id, kind, app_id, status, steps, started_at, backup_id, detail, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [op.id, op.kind, op.appId, op.status, JSON.stringify(op.steps), op.startedAt, op.backupId ?? null,
          op.detail ? JSON.stringify(op.detail) : null, op.idempotencyKey ?? null],
      )
    } catch (err) {
      if (err.code === '23505') throw Object.assign(new Error('duplicate idempotency key'), { code: 'DUPLICATE' })
      throw err
    }
    return op
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
