// All runtime settings come from environment variables (the platform's app contract).

// "/apps/notes-app/" -> "/apps/notes-app", "/" or "" -> "" (served at the root).
export function normalizeBasePath(value) {
  if (!value) return ''
  let path = String(value).trim()
  if (!path.startsWith('/')) path = `/${path}`
  path = path.replace(/\/+$/, '')
  return path
}

function intFromEnv(value, fallback) {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function loadConfig(env = process.env) {
  return {
    port: intFromEnv(env.PORT, 3000),
    basePath: normalizeBasePath(env.BASE_PATH),
    databaseUrl: env.DATABASE_URL,
    // TLS to the database (RDS). Also turned on by ?sslmode=require in DATABASE_URL. Off locally.
    databaseSsl: env.DATABASE_SSL === 'true',
    // Optional CA bundle (e.g. RDS global-bundle.pem) to verify the server certificate.
    databaseCaFile: env.DATABASE_CA_FILE || undefined,
    // Rows inserted the first time the notes table is created. Never re-seeds an existing table.
    seedCount: intFromEnv(env.SEED_COUNT, 120),
    appName: env.APP_NAME || 'notes-app',
    imageTag: env.IMAGE_TAG || 'dev',
    // Enables POST /api/demo/data-loss, which deletes notes to simulate an incident before a restore.
    allowDataLossDemo: env.ALLOW_DATA_LOSS_DEMO === 'true',
  }
}
