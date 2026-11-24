// Deterministic seed data: same input -> same rows, so restores can be compared reliably.

const TOPICS = [
  'Deploy checklist', 'Incident review', 'On-call handover', 'Database migration', 'Release notes',
  'Load test results', 'Backup drill', 'Cost review', 'Security patch', 'Sprint retro',
  'Runbook update', 'Customer feedback', 'Feature flag cleanup', 'Latency spike', 'Capacity plan',
]
const AUTHORS = ['ahmad', 'jason', 'abdulrahman', 'adam']
const BODIES = [
  'Checked health endpoints after the rollout; all pods ready.',
  'Restored the latest backup into a new database and verified the row count.',
  'Scaled the deployment under load; HPA added two pods within a minute.',
  'Rotated the database password in Secrets Manager.',
  'Image scan found no critical vulnerabilities.',
  'Rolled back to the previous image after a failing smoke test.',
  'Budget alert fired at 50%; destroyed idle resources.',
  'Reviewed CloudTrail for unexpected API calls.',
]

export function buildSeedRows(count, start = new Date('2026-10-12T08:00:00Z')) {
  const rows = []
  for (let i = 0; i < count; i++) {
    const created = new Date(start.getTime() + i * 3 * 60 * 60 * 1000) // every 3 hours
    rows.push({
      title: `${TOPICS[i % TOPICS.length]} #${i + 1}`,
      body: BODIES[(i * 7) % BODIES.length],
      author: AUTHORS[i % AUTHORS.length],
      createdAt: created.toISOString(),
    })
  }
  return rows
}

export async function seedNotes(client, count) {
  if (count <= 0) return
  const rows = buildSeedRows(count)
  // One multi-row insert per 100 rows keeps the parameter count well under Postgres' limit.
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100)
    const values = []
    const params = []
    batch.forEach((r, i) => {
      const p = i * 4
      values.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 4})`)
      params.push(r.title, r.body, r.author, r.createdAt)
    })
    await client.query(
      `INSERT INTO notes (title, body, author, created_at, updated_at) VALUES ${values.join(', ')}`,
      params,
    )
  }
}
