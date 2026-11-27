import { advanceSteps, finishSteps, stepKeyFor } from './steps.js'

export function failedOperation(steps, error, when) {
  return { status: 'failed', steps: finishSteps(steps, false), error, finishedAt: when.toISOString() }
}

// Both the local API and the SQS worker use the same executor and dashboard result mapping.
async function execute(op, message, { executor, catalog }, onStep, backup) {
  const { kind, appId } = op
  if (kind === 'restore') {
    backup ??= await catalog.get(op.backupId)
    if (!backup) return { ok: false, error: `backup ${op.backupId} was not found` }
    const outcome = await executor.restore({ appId, backup, onStep })
    if (!outcome.ok) return outcome
    const { targetDatabase, recoveryUrl, recordsChecked, durationSeconds, restoreSeconds, image } = outcome.result
    return {
      ok: true,
      result: { backupId: op.backupId, targetDatabase, recoveryUrl, recordsChecked, durationSeconds },
      detail: { restoreSeconds, image, backupKey: backup.s3Key },
    }
  }
  if (kind === 'backup') {
    const outcome = await executor.backup({ appId, onStep })
    if (!outcome.ok) return outcome
    const { s3Key, sizeBytes, imageTag, rowCount } = outcome.result
    return { ok: true, detail: { s3Key, sizeBytes, imageTag, rowCount } }
  }
  if (kind === 'redeploy') {
    const outcome = await executor.redeploy({ appId, imageTag: message.imageTag, onStep })
    if (!outcome.ok) return outcome
    const { image, imageTag } = outcome.result
    return { ok: true, detail: { image, imageTag } }
  }
  if (kind === 'deploy') {
    const outcome = await executor.deploy({ appId, sourceApp: message.sourceApp, repo: message.repo, onStep })
    if (!outcome.ok) return outcome
    const { image, imageTag } = outcome.result
    return { ok: true, detail: { image, imageTag, sourceApp: message.sourceApp } }
  }
  throw new Error(`Unsupported operation kind: ${kind}`)
}

export async function runOperation(op, message, deps, { backup, retryUnexpected = false } = {}) {
  const { store, now = () => new Date(), log = console } = deps
  let steps = op.steps
  let progress = Promise.resolve()
  const onStep = (name) => {
    const key = stepKeyFor(op.kind, name)
    if (!key) return
    const next = advanceSteps(steps, key)
    if (next === steps) return
    steps = next
    progress = progress.then(() => store.update(op.id, { steps: next })).catch((err) => log.error(err))
  }

  let outcome
  try {
    outcome = await execute(op, message, deps, onStep, backup)
  } catch (err) {
    if (retryUnexpected) throw err
    outcome = { ok: false, error: err.message }
  } finally {
    await progress
  }
  let patch
  if (outcome.ok) {
    const { detail, result } = outcome
    patch = { status: 'succeeded', steps: finishSteps(steps, true), finishedAt: now().toISOString(), detail }
    if (result) patch.result = result
  } else {
    log.error(`operation ${op.id} (${op.kind} ${op.appId}) failed: ${outcome.error}`)
    patch = failedOperation(steps, outcome.error, now())
  }
  // A failed terminal write must reach the worker so it leaves the SQS receipt unacknowledged.
  const saved = await store.update(op.id, patch)
  if (!saved) throw new Error(`Could not save operation ${op.id}`)
  return saved
}
