import { HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

// Backup ids are the S3 key without the prefix and extension, with "/" -> "~", so they are URL-safe
// and reversible:  backups/notes-app/20261124T183411Z-3f9c2ab.dump  <->  notes-app~20261124T183411Z-3f9c2ab
export function backupIdFromKey(key, prefix = 'backups') {
  const rest = key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key
  return rest.replace(/\.dump$/, '').replaceAll('/', '~')
}

export function keyFromBackupId(id, prefix = 'backups') {
  if (!/^[a-z0-9][a-z0-9-]*~[A-Za-z0-9._-]+$/.test(id)) return null
  return `${prefix}/${id.replace('~', '/')}.dump`
}

// "20261124T183411Z-3f9c2ab" -> { createdAt: "2026-11-24T18:34:11Z", tag: "3f9c2ab" }
export function parseBackupFileName(name) {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(.+)$/)
  if (!m) return null
  return { createdAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, tag: m[7] }
}

// Reads the backup catalog straight from S3 (the source of truth); metadata written by backup.sh.
export class S3Catalog {
  constructor({ bucket, prefix, endpoint, region }, client) {
    this.bucket = bucket
    this.prefix = prefix
    this.client =
      client ?? new S3Client({ region, ...(endpoint && { endpoint, forcePathStyle: true }) })
    this.metaCache = new Map() // backups are immutable, so metadata can be cached by key
  }

  async list(appId) {
    const prefix = appId ? `${this.prefix}/${appId}/` : `${this.prefix}/`
    const objects = []
    let ContinuationToken
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken }),
      )
      objects.push(...(page.Contents ?? []).filter((o) => o.Key.endsWith('.dump')))
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (ContinuationToken)

    const backups = await Promise.all(objects.map((o) => this.describe(o)))
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async get(backupId) {
    const key = keyFromBackupId(backupId, this.prefix)
    if (!key) return null
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return this.describe({ Key: key, Size: head.ContentLength, LastModified: head.LastModified }, head.Metadata)
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null
      throw err
    }
  }

  async describe(object, knownMeta) {
    let meta = knownMeta ?? this.metaCache.get(object.Key)
    if (!meta) {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: object.Key }))
      meta = head.Metadata ?? {}
    }
    this.metaCache.set(object.Key, meta)
    const id = backupIdFromKey(object.Key, this.prefix)
    const [appId, fileName] = id.split('~')
    const parsed = parseBackupFileName(fileName) ?? {}
    return {
      id,
      appId,
      appName: meta.app || appId,
      createdAt: parsed.createdAt ?? new Date(object.LastModified).toISOString(),
      trigger: meta.trigger === 'scheduled' ? 'scheduled' : 'manual',
      status: 'completed',
      sizeBytes: Number(object.Size ?? 0),
      image: { tag: meta['image-tag'] || parsed.tag || 'unknown', digest: meta['image-digest'] || '' },
      s3Key: object.Key,
      ...(meta['row-count'] && { rowCount: Number(meta['row-count']) }),
    }
  }
}
