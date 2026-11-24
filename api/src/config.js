// All settings come from environment variables. See api/.env.example.
import { fileURLToPath } from 'node:url'

function parseJson(value, name) {
  if (!value) return {}
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${name} is not valid JSON`)
  }
}

export function loadConfig(env = process.env) {
  const executor = env.EXECUTOR || 'process'
  if (!['process', 'kubernetes'].includes(executor)) throw new Error('EXECUTOR must be "process" or "kubernetes"')
  return {
    port: Number.parseInt(env.PORT || '8080', 10),
    // Browser origins allowed to call the API (the dashboard). Comma-separated; "*" for any.
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),

    // Cognito user pool from infra/. Unset = no auth (local dev only).
    auth: { userPoolId: env.COGNITO_USER_POOL_ID || undefined, clientId: env.COGNITO_CLIENT_ID || undefined },

    // Where operation history lives. Unset = in memory (lost on restart; fine for local dev and tests).
    platformDatabaseUrl: env.PLATFORM_DATABASE_URL || undefined,

    s3: {
      bucket: env.S3_BUCKET || 'rebound-backups',
      prefix: env.S3_PREFIX || 'backups',
      endpoint: env.S3_ENDPOINT || undefined, // local S3 stand-in
      region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
    },

    // How backups/restores run:
    //   process    -> run jobs/backup-restore/{backup,restore}.sh directly (local dev, docker-compose)
    //   kubernetes -> run jobs/backup-restore/k8s/rebound-data.sh, which starts Kubernetes Jobs (EKS)
    executor,
    jobsDir: env.JOBS_DIR || fileURLToPath(new URL('../../jobs/backup-restore', import.meta.url)),
    // process mode only: per-app settings, e.g. {"notes-app": {"databaseUrl": "postgres://...", "imageTag": "local"}}
    localApps: parseJson(env.LOCAL_APPS, 'LOCAL_APPS'),
    adminDatabaseUrl: env.ADMIN_DATABASE_URL || undefined,
    // Public URL of a recovery app; {app} is replaced. On EKS the runner reports the real ALB URL.
    recoveryUrlTemplate: env.RECOVERY_URL_TEMPLATE || 'http://localhost:3001/apps/{app}-recovery/',

    // Apps (read from Kubernetes in kubernetes mode)
    namespace: env.NAMESPACE || 'apps',
    publicUrl: (env.PUBLIC_URL || env.ALB_URL || 'http://localhost:3000').replace(/\/$/, ''),
    postgresVersion: env.POSTGRES_VERSION || '16',
    ecrRegistry: env.ECR_REGISTRY || '',
    deployScript: env.DEPLOY_SCRIPT || fileURLToPath(new URL('../../deploy/deploy-app.sh', import.meta.url)),
    // [{ "fullName": "github.com/org/notes-app", "defaultBranch": "main", "runtime": "Node.js 20" }]
    approvedRepos: Array.isArray(parseJson(env.APPROVED_REPOS, 'APPROVED_REPOS'))
      ? parseJson(env.APPROVED_REPOS, 'APPROVED_REPOS')
      : [],
    operationTimeoutMs: Number.parseInt(env.OPERATION_TIMEOUT_SECONDS || '1500', 10) * 1000,
  }
}
