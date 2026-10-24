const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "May 30, 09:14 AM UTC" — all platform times are shown in UTC.
export function formatUtc(iso: string): string {
  const d = new Date(iso)
  const h = d.getUTCHours()
  const hh = String(h % 12 || 12).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} ${h < 12 ? 'AM' : 'PM'} UTC`
}

export function formatTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19)
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m ? `${m}m ${s}s` : `${s}s`
}

export function shortDigest(digest: string): string {
  return digest.slice(0, 12)
}

// App names become Kubernetes names and URL hostnames, so keep them DNS-safe.
export function validateAppName(name: string): string | null {
  if (!name) return 'Enter an app name'
  if (name.length < 3 || name.length > 30) return 'Use 3 to 30 characters'
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name))
    return 'Use lowercase letters, numbers, and hyphens; start with a letter'
  return null
}
