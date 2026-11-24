import { runCapture } from './runner.js'

// Read model for deployed apps, in the dashboard's App shape (dashboard/src/api/types.ts).
//   kubernetes: Deployments/ReplicaSets/Pods labelled rebound.io/kind=app in the apps namespace
//   process:    LOCAL_APPS entries, health read from each app's /healthz

const ICONS = new Set(['terminal', 'notes', 'box'])

function imageTag(image = '') {
  const at = image.indexOf('@')
  const ref = at === -1 ? image : image.slice(0, at)
  const colon = ref.lastIndexOf(':')
  return colon > ref.lastIndexOf('/') ? ref.slice(colon + 1) : 'latest'
}

function digestOf(imageID = '') {
  const m = imageID.match(/sha256:[a-f0-9]+/)
  return m ? m[0] : ''
}

const looksLikeCommit = (tag) => /^[a-f0-9]{7,40}$/.test(tag)

function deploymentStatus(d) {
  const desired = d.spec?.replicas ?? 1
  const s = d.status ?? {}
  const progressing = (s.conditions ?? []).find((c) => c.type === 'Progressing')
  if (progressing?.reason === 'ProgressDeadlineExceeded') return 'failed'
  if (desired === 0) return 'stopped'
  if ((s.observedGeneration ?? 0) < (d.metadata?.generation ?? 0) || (s.updatedReplicas ?? 0) < desired) {
    return 'deploying'
  }
  return 'running'
}

function health(ready, desired) {
  if (desired === 0) return 'unknown'
  if (ready >= desired) return 'healthy'
  return ready > 0 ? 'degraded' : 'unhealthy'
}

// Pure mapping from a `kubectl get deploy,rs,pods -o json` list to App objects (unit-tested).
export function appsFromKube(list, { publicUrl = '', region = '', pgVersion = '16' } = {}) {
  const items = list.items ?? []
  const byApp = (kind) => {
    const out = new Map()
    for (const it of items.filter((i) => i.kind === kind)) {
      const app = it.metadata?.labels?.['rebound.io/app']
      if (!app) continue
      if (!out.has(app)) out.set(app, [])
      out.get(app).push(it)
    }
    return out
  }
  const replicaSets = byApp('ReplicaSet')
  const pods = byApp('Pod')

  return items
    .filter((i) => i.kind === 'Deployment' && i.metadata?.labels?.['rebound.io/app'])
    .map((d) => {
      const id = d.metadata.labels['rebound.io/app']
      const ann = d.metadata.annotations ?? {}
      const container = d.spec?.template?.spec?.containers?.[0] ?? {}
      const currentTag = imageTag(container.image)

      const runningPod = (pods.get(id) ?? []).find((p) => p.status?.containerStatuses?.[0]?.imageID)
      const currentDigest = runningPod ? digestOf(runningPod.status.containerStatuses[0].imageID) : ''

      // Image history from the Deployment's ReplicaSets (one per rollout), newest first, one entry per tag.
      const seen = new Set()
      const history = (replicaSets.get(id) ?? [])
        .map((rs) => ({
          tag: imageTag(rs.spec?.template?.spec?.containers?.[0]?.image),
          revision: Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0),
          deployedAt: rs.metadata?.creationTimestamp,
        }))
        .sort((a, b) => b.revision - a.revision)
        .filter((h) => (seen.has(h.tag) ? false : seen.add(h.tag)))
        .map((h) => ({
          tag: h.tag,
          digest: h.tag === currentTag ? currentDigest : '',
          commit: looksLikeCommit(h.tag) ? h.tag.slice(0, 7) : '',
          deployedAt: h.deployedAt,
        }))
      const image = history.find((h) => h.tag === currentTag) ?? {
        tag: currentTag,
        digest: currentDigest,
        commit: looksLikeCommit(currentTag) ? currentTag.slice(0, 7) : '',
        deployedAt: d.metadata.creationTimestamp,
      }

      const desired = d.spec?.replicas ?? 1
      const ready = d.status?.readyReplicas ?? 0
      return {
        id,
        name: id,
        description: ann['rebound.io/description'] ?? '',
        icon: ICONS.has(ann['rebound.io/icon']) ? ann['rebound.io/icon'] : 'box',
        runtime: ann['rebound.io/runtime'] || 'Node.js 20',
        repo: ann['rebound.io/repo'] ?? '',
        branch: ann['rebound.io/branch'] || 'main',
        region,
        url: `${publicUrl.replace(/\/$/, '')}/apps/${id}/`,
        status: deploymentStatus(d),
        health: health(ready, desired),
        pods: { ready, desired },
        image,
        history: history.length ? history : [image],
        database: { engine: 'PostgreSQL', version: pgVersion, name: id.replaceAll('-', '_') },
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function parseLogLines(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)$/)
      const ts = m ? m[1] : new Date().toISOString()
      const message = m ? m[2] : line
      const level = /\b(error|err|fatal|exception)\b/i.test(message)
        ? 'error'
        : /\b(warn|warning|retry)\b/i.test(message)
          ? 'warn'
          : 'info'
      return { ts, level, message }
    })
    .sort((a, b) => a.ts.localeCompare(b.ts))
}

export function createAppsSource(config, capture = runCapture) {
  const opts = { publicUrl: config.publicUrl, region: config.s3.region, pgVersion: config.postgresVersion }

  if (config.executor === 'kubernetes') {
    const kubectl = async (args) => {
      const res = await capture('kubectl', ['-n', config.namespace, ...args])
      if (res.code !== 0) throw new Error(`kubectl ${args[0]} failed: ${res.stderr.trim().split('\n').at(-1)}`)
      return res.stdout
    }
    return {
      async list() {
        const json = await kubectl(['get', 'deploy,rs,pods', '-l', 'rebound.io/kind=app', '-o', 'json'])
        return appsFromKube(JSON.parse(json), opts)
      },
      async logs(id) {
        const text = await kubectl([
          'logs', '-l', `app.kubernetes.io/name=${id}`, '--tail=200', '--timestamps', '--max-log-requests=5',
        ])
        return parseLogLines(text)
      },
    }
  }

  // process mode: one entry per LOCAL_APPS app
  return {
    async list() {
      return Promise.all(
        Object.entries(config.localApps).map(async ([id, app]) => {
          let healthy = false
          let tag = app.imageTag || 'local'
          if (app.healthUrl) {
            try {
              const res = await fetch(app.healthUrl, { signal: AbortSignal.timeout(2000) })
              healthy = res.ok
              tag = (await res.json()).imageTag ?? tag
            } catch {
              healthy = false
            }
          }
          const image = { tag, digest: '', commit: '', deployedAt: new Date(0).toISOString() }
          return {
            id, name: id, description: app.description ?? '', icon: ICONS.has(app.icon) ? app.icon : 'box',
            runtime: 'Node.js 20', repo: app.repo ?? '', branch: 'main', region: config.s3.region,
            url: app.url ?? `${config.publicUrl}/apps/${id}/`,
            status: healthy ? 'running' : 'failed', health: healthy ? 'healthy' : 'unhealthy',
            pods: { ready: healthy ? 1 : 0, desired: 1 }, image, history: [image],
            database: { engine: 'PostgreSQL', version: config.postgresVersion, name: id.replaceAll('-', '_') },
          }
        }),
      )
    },
    async logs() {
      return [{ ts: new Date().toISOString(), level: 'info', message: 'Logs are available on the cluster (EXECUTOR=kubernetes).' }]
    },
  }
}
