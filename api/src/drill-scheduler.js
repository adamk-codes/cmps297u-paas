// Nightly recovery drill. Every night after the 02:00 UTC scheduled backups, test each app's newest backup:
// restore it into a temporary database, count the rows against the backup, drop the copy. A passed drill
// marks the backup "verified" in the dashboard; a failed one emails the team (alerts.js).
//
// Runs inside the API. One drill at a time (restores share the database server), one per app per day:
// the idempotency key drill-<app>-<YYYYMMDD> makes a second API pod, or a restart, a no-op.
export function drillKey(appId, now) {
  return `drill-${appId}-${now.toISOString().slice(0, 10).replaceAll('-', '')}`
}

export function isDrillTime(drillTime, now) {
  const m = /^(\d{2}):(\d{2})$/.exec(drillTime ?? '')
  if (!m) return false
  return now.getUTCHours() * 60 + now.getUTCMinutes() >= Number(m[1]) * 60 + Number(m[2])
}

// One pass: start at most one drill (for the first app not yet drilled today). Returns what it did.
export async function drillTick({ operations, apps, config, now = new Date(), log = console }) {
  if (!isDrillTime(config.drillTime, now)) return 'not yet'
  const running = await operations.store.list({ status: 'running' })
  if (running.some((o) => o.kind === 'drill' || o.kind === 'restore')) return 'busy'
  const live = (await apps.list()).filter((a) => a.database && a.status === 'running' && !a.id.endsWith('-recovery'))
  for (const app of live) {
    const key = drillKey(app.id, now)
    if (await operations.store.findByIdempotencyKey(key)) continue // already drilled today
    try {
      const op = await operations.startDrill(app.id, { idempotencyKey: key })
      log.info?.(`nightly drill of ${app.id} started (${op.id})`)
      return `started ${app.id}`
    } catch (err) {
      if (err.status === 404) continue // no backups yet
      log.error(`nightly drill of ${app.id} could not start: ${err.message}`)
      return 'error'
    }
  }
  return 'done for today'
}

export function startDrillScheduler(deps, { everyMs = 60_000 } = {}) {
  if (!deps.config.drillTime || deps.config.drillTime === 'off') return () => {}
  let ticking = false
  const timer = setInterval(async () => {
    if (ticking) return
    ticking = true
    try {
      await drillTick(deps)
    } catch (err) {
      deps.log?.error?.(`drill scheduler: ${err.message}`)
    } finally {
      ticking = false
    }
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
