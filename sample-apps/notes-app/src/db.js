import { readFileSync } from 'node:fs'
import pg from 'pg'
import { seedNotes } from './seed.js'

// Arbitrary constant so concurrent replicas don't create/seed the table at the same time.
const SCHEMA_LOCK_ID = 297_004

// node-postgres lets `sslmode` in the URL override the `ssl` option, and treats `require` as
// full certificate verification, which fails against RDS without its CA bundle. So we take sslmode
// out of the URL and build the TLS options ourselves:
//   disable                      -> no TLS
//   require / prefer / no-verify -> TLS, certificate not verified (encrypted in transit)
//   verify-ca / verify-full      -> TLS, verified (pass the RDS bundle via DATABASE_CA_FILE)
// DATABASE_SSL=true turns TLS on when the URL doesn't say; DATABASE_CA_FILE always enables verification.
export function resolveConnection({ databaseUrl, databaseSsl = false, databaseCa }) {
  let url
  try {
    url = new URL(databaseUrl)
  } catch {
    return { connectionString: databaseUrl, ssl: databaseSsl ? { rejectUnauthorized: false } : undefined }
  }
  const mode = url.searchParams.get('sslmode')
  for (const p of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) url.searchParams.delete(p)
  const connectionString = url.toString()

  if (databaseCa) return { connectionString, ssl: { rejectUnauthorized: true, ca: databaseCa } }
  if (mode === 'disable') return { connectionString, ssl: undefined }
  if (mode === 'verify-ca' || mode === 'verify-full') return { connectionString, ssl: { rejectUnauthorized: true } }
  if (mode || databaseSsl) return { connectionString, ssl: { rejectUnauthorized: false } }
  return { connectionString, ssl: undefined }
}

export function createPool({ databaseUrl, databaseSsl, databaseCaFile }) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set')
  const databaseCa = databaseCaFile ? readFileSync(databaseCaFile, 'utf8') : undefined
  const { connectionString, ssl } = resolveConnection({ databaseUrl, databaseSsl, databaseCa })
  return new pg.Pool({
    connectionString,
    ssl,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  })
}

// Creates the notes table and seeds it, but only when the table does not exist yet.
// A restored database (or one where notes were deleted) is never re-seeded, so row counts
// after a restore reflect the backup, not the seed.
export async function migrate(pool, { seedCount }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID])
    const { rows } = await client.query("SELECT to_regclass('public.notes') AS t")
    const existed = rows[0].t !== null
    if (!existed) {
      await client.query(`
        CREATE TABLE notes (
          id         SERIAL PRIMARY KEY,
          title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
          body       TEXT NOT NULL DEFAULT '',
          author     TEXT NOT NULL DEFAULT 'anonymous',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`)
      await client.query('CREATE INDEX notes_created_at_idx ON notes (created_at DESC)')
      await seedNotes(client, seedCount)
    }
    await client.query('COMMIT')
    return { created: !existed, seeded: existed ? 0 : seedCount }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Data access used by the HTTP layer. Tests swap this for an in-memory version.
export function createNotesRepo(pool) {
  return {
    async ping() {
      await pool.query('SELECT 1')
    },
    async databaseName() {
      const { rows } = await pool.query('SELECT current_database() AS name')
      return rows[0].name
    },
    async count() {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM notes')
      return rows[0].n
    },
    async list({ limit, offset }) {
      const { rows } = await pool.query(
        'SELECT id, title, body, author, created_at, updated_at FROM notes ORDER BY id DESC LIMIT $1 OFFSET $2',
        [limit, offset],
      )
      return rows
    },
    async get(id) {
      const { rows } = await pool.query(
        'SELECT id, title, body, author, created_at, updated_at FROM notes WHERE id = $1',
        [id],
      )
      return rows[0] ?? null
    },
    async create({ title, body, author }) {
      const { rows } = await pool.query(
        `INSERT INTO notes (title, body, author) VALUES ($1, $2, $3)
         RETURNING id, title, body, author, created_at, updated_at`,
        [title, body, author],
      )
      return rows[0]
    },
    async remove(id) {
      const { rowCount } = await pool.query('DELETE FROM notes WHERE id = $1', [id])
      return rowCount > 0
    },
    // Deletes `percent`% of notes (the newest ones are kept so the page still shows something).
    async deleteFraction(percent) {
      const { rowCount } = await pool.query(
        `DELETE FROM notes WHERE id IN (
           SELECT id FROM notes ORDER BY id ASC
           LIMIT (SELECT ceil(count(*) * $1::numeric / 100) FROM notes))`,
        [percent],
      )
      return rowCount
    },
  }
}
