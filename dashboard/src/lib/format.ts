// All platform times are shown in Beirut time (Intl handles daylight saving).
const TIME_ZONE = 'Asia/Beirut'

const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

// "Nov 27, 4:00 AM Beirut". The name is kept so existing callers don't change.
export function formatUtc(iso: string): string {
  return `${dateTimeFmt.format(new Date(iso))} Beirut`
}

// "04:00:12", in Beirut time (used for log lines).
export function formatTime(iso: string): string {
  return clockFmt.format(new Date(iso))
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
