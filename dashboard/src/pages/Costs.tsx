import { Card, EmptyState, PageHeader } from '../components/ui'

export function Costs() {
  return (
    <>
      <PageHeader eyebrow="Platform / AWS spend" title="Costs">
        <p className="mt-2 text-slate-600">Estimated AWS spend per app for compute, databases, and backup storage.</p>
      </PageHeader>
      <Card>
        <EmptyState title="Cost data appears once apps are deployed" />
      </Card>
    </>
  )
}
