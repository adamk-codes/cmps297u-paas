import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConnection } from '../src/db.js'
import { buildSeedRows } from '../src/seed.js'

const RDS = 'postgres://notes_app:pw@db.abc.us-east-1.rds.amazonaws.com:5432/notes_app'

test('sslmode=require uses TLS without failing on the RDS certificate', () => {
  const { connectionString, ssl } = resolveConnection({ databaseUrl: `${RDS}?sslmode=require` })
  assert.deepEqual(ssl, { rejectUnauthorized: false })
  assert.ok(!connectionString.includes('sslmode'), 'sslmode must be removed so pg does not override ssl')
})

test('a CA bundle turns on certificate verification', () => {
  const { ssl } = resolveConnection({ databaseUrl: `${RDS}?sslmode=require`, databaseCa: 'PEM' })
  assert.deepEqual(ssl, { rejectUnauthorized: true, ca: 'PEM' })
})

test('local URLs without sslmode stay plain unless DATABASE_SSL is set', () => {
  assert.equal(resolveConnection({ databaseUrl: 'postgres://u:p@postgres:5432/db' }).ssl, undefined)
  assert.deepEqual(resolveConnection({ databaseUrl: 'postgres://u:p@postgres:5432/db', databaseSsl: true }).ssl, {
    rejectUnauthorized: false,
  })
  assert.equal(resolveConnection({ databaseUrl: `${RDS}?sslmode=disable` }).ssl, undefined)
})

test('seed data has 100+ deterministic rows', () => {
  const a = buildSeedRows(120)
  assert.equal(a.length, 120)
  assert.deepEqual(a, buildSeedRows(120))
  assert.ok(a.every((r) => r.title.length > 0 && r.title.length <= 200))
})
