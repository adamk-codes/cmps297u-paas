import path from 'node:path'
import { runScript } from './runner.js'

// Runs the actual data work. Two modes share the same scripts and result lines:
//   process    -> jobs/backup-restore/{backup,restore}.sh on this machine/container (local dev)
//   kubernetes -> jobs/backup-restore/k8s/rebound-data.sh, which runs Kubernetes Jobs and the recovery app
// Every method resolves to { ok, result?, error?, logTail }.
export function createExecutor(config, run = runScript) {
  const timeoutMs = config.operationTimeoutMs
  const fail = (res, fallback) => ({
    ok: false,
    error: res.logTail.filter((l) => /ERROR|error|failed/.test(l)).at(-1) ?? fallback,
    logTail: res.logTail,
  })
  const s3Env = () => ({
    S3_BUCKET: config.s3.bucket,
    S3_PREFIX: config.s3.prefix,
    AWS_REGION: config.s3.region,
    ...(config.s3.endpoint && { S3_ENDPOINT: config.s3.endpoint, S3_SSE: '' }),
  })

  if (config.executor === 'kubernetes') {
    const runner = path.join(config.jobsDir, 'k8s', 'rebound-data.sh')
    return {
      mode: 'kubernetes',
      async redeploy({ appId, imageTag, onStep }) {
        if (!config.ecrRegistry) return { ok: false, error: 'ECR_REGISTRY is not set', logTail: [] }
        const image = `${config.ecrRegistry}/${appId}:${imageTag}`
        const res = await run({ command: 'bash', args: [config.deployScript, appId, image], env: {}, timeoutMs, onStep })
        const r = res.results.DEPLOY_RESULT
        return res.code === 0 && r ? { ok: true, result: r, logTail: res.logTail } : fail(res, 'rollout failed; previous image restored')
      },
      // New app from the newest CI-built, scanned image of sourceApp (deploy/deploy-new-app.sh).
      async deploy({ appId, sourceApp, repo, onStep }) {
        if (!config.ecrRegistry) return { ok: false, error: 'ECR_REGISTRY is not set', logTail: [] }
        const res = await run({
          command: 'bash',
          args: [config.deployNewScript, appId, sourceApp],
          env: {
            REBOUND_DATA: runner,
            APP_REPO: repo ?? '',
            APP_ICON: sourceApp === 'notes-app' ? 'notes' : 'box',
            APP_DESCRIPTION: `Deployed from the dashboard (${sourceApp})`,
          },
          timeoutMs,
          onStep,
        })
        const r = res.results.DEPLOY_RESULT
        return res.code === 0 && r ? { ok: true, result: r, logTail: res.logTail } : fail(res, 'deploy failed')
      },
      // Recovery drill: restore into a temporary database, count, drop (rebound-data.sh drill).
      async drill({ appId, backup, onStep }) {
        const res = await run({ command: 'bash', args: [runner, 'drill', appId, backup.s3Key], env: s3Env(), timeoutMs, onStep })
        const r = res.results.DRILL_RESULT
        return res.code === 0 && r ? { ok: true, result: r, logTail: res.logTail } : fail(res, 'drill failed')
      },
      // "Undo deploy": previous image live again on the data from the safety backup (rebound-data.sh undo).
      async undo({ appId, backup, imageTag, onStep }) {
        if (!config.ecrRegistry) return { ok: false, error: 'ECR_REGISTRY is not set', logTail: [] }
        const image = `${config.ecrRegistry}/${appId}:${imageTag}`
        const res = await run({
          command: 'bash',
          args: [runner, 'undo', appId, backup.s3Key, image],
          env: { ...s3Env(), DEPLOY_SCRIPT: config.deployScript },
          timeoutMs,
          onStep,
        })
        const r = res.results.UNDO_RESULT
        return res.code === 0 && r ? { ok: true, result: r, logTail: res.logTail } : fail(res, 'undo failed')
      },
      // "Delete app": cluster resources, then database + login (rebound-data.sh delete). Backups stay in S3.
      async delete({ appId, onStep }) {
        const res = await run({ command: 'bash', args: [runner, 'delete', appId], env: {}, timeoutMs, onStep })
        const r = res.results.DELETE_RESULT
        return res.code === 0 && r ? { ok: true, result: r, logTail: res.logTail } : fail(res, 'delete failed')
      },
      async backup({ appId, onStep }) {
        const res = await run({ command: 'bash', args: [runner, 'backup', appId], env: s3Env(), timeoutMs, onStep })
        const r = res.results.BACKUP_RESULT
        return res.code === 0 && r ? { ok: true, result: r, logTail: res.logTail } : fail(res, 'backup failed')
      },
      async restore({ appId, backup, onStep }) {
        const res = await run({
          command: 'bash',
          args: [runner, 'restore', appId, backup.s3Key],
          env: s3Env(),
          timeoutMs,
          onStep,
        })
        const r = res.results.RECOVERY_RESULT
        if (res.code !== 0 || !r) return fail(res, 'restore failed')
        return {
          ok: true,
          result: {
            targetDatabase: r.targetDatabase,
            recoveryUrl: r.recoveryUrl,
            recordsChecked: r.recordsChecked,
            durationSeconds: r.durationSeconds,
            restoreSeconds: r.restoreSeconds,
            image: r.image,
          },
          logTail: res.logTail,
        }
      },
    }
  }

  return {
    mode: 'process',
    async redeploy() {
      return { ok: false, error: 'redeploys run on the cluster (EXECUTOR=kubernetes)', logTail: [] }
    },
    async deploy() {
      return { ok: false, error: 'new deploys run on the cluster (EXECUTOR=kubernetes)', logTail: [] }
    },
    async undo() {
      return { ok: false, error: 'undoing a deploy runs on the cluster (EXECUTOR=kubernetes)', logTail: [] }
    },
    async delete() {
      return { ok: false, error: 'deleting apps runs on the cluster (EXECUTOR=kubernetes)', logTail: [] }
    },
    async backup({ appId, onStep }) {
      const app = config.localApps[appId]
      if (!app?.databaseUrl) return { ok: false, error: `no LOCAL_APPS entry with databaseUrl for ${appId}`, logTail: [] }
      const res = await run({
        command: 'bash',
        args: [path.join(config.jobsDir, 'backup.sh')],
        env: {
          ...s3Env(),
          DATABASE_URL: app.databaseUrl,
          APP_NAME: appId,
          ...(app.imageTag && { IMAGE_TAG: app.imageTag }),
          ...(app.healthUrl && { IMAGE_TAG_URL: app.healthUrl }),
        },
        timeoutMs,
        onStep,
      })
      const r = res.results.BACKUP_RESULT
      return res.code === 0 && r ? { ok: true, result: r, logTail: res.logTail } : fail(res, 'backup failed')
    },
    async drill({ appId, backup, onStep }) {
      if (!config.adminDatabaseUrl) return { ok: false, error: 'ADMIN_DATABASE_URL is not set', logTail: [] }
      const res = await run({
        command: 'bash',
        args: [path.join(config.jobsDir, 'restore.sh')],
        env: {
          ...s3Env(),
          ADMIN_DATABASE_URL: config.adminDatabaseUrl,
          BACKUP_KEY: backup.s3Key,
          TARGET_OWNER: appId.replaceAll('-', '_'),
          DROP_AFTER_CHECK: 'true',
        },
        timeoutMs,
        onStep,
      })
      const r = res.results.RESTORE_RESULT
      return res.code === 0 && r ? { ok: true, result: r, logTail: res.logTail } : fail(res, 'drill failed')
    },
    async restore({ appId, backup, onStep }) {
      if (!config.adminDatabaseUrl) return { ok: false, error: 'ADMIN_DATABASE_URL is not set', logTail: [] }
      const started = Date.now()
      const res = await run({
        command: 'bash',
        args: [path.join(config.jobsDir, 'restore.sh')],
        env: {
          ...s3Env(),
          ADMIN_DATABASE_URL: config.adminDatabaseUrl,
          BACKUP_KEY: backup.s3Key,
          TARGET_OWNER: appId.replaceAll('-', '_'),
        },
        timeoutMs,
        onStep,
      })
      const r = res.results.RESTORE_RESULT
      if (res.code !== 0 || !r) return fail(res, 'restore failed')
      return {
        ok: true,
        result: {
          targetDatabase: r.targetDatabase,
          // Locally the recovery app is started with docker compose (see demo-local.sh); on EKS the
          // kubernetes executor starts it and reports the real URL.
          recoveryUrl: config.recoveryUrlTemplate.replaceAll('{app}', appId),
          recordsChecked: r.recordsChecked,
          durationSeconds: Math.round((Date.now() - started) / 1000),
          restoreSeconds: r.durationSeconds,
        },
        logTail: res.logTail,
      }
    },
  }
}
