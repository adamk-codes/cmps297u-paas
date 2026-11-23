import { Card, EmptyState, PageHeader } from '../components/ui'

export function Activity() {
  return (
    <>
      <PageHeader eyebrow="Platform / Audit trail" title="Activity">
        <p className="mt-2 text-slate-600">Deployments, backups, and restores across the team, newest first.</p>
      </PageHeader>
      <Card>
        <EmptyState title="No activity yet">Events show up here as the team deploys and recovers apps.</EmptyState>
      </Card>
    </>
  )
}
