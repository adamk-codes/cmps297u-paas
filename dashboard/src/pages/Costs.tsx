import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, CircleDollarSign, Clock, Gauge, TrendingUp } from 'lucide-react'
import { api, type CostReport } from '../api'
import { useAsync } from '../lib/hooks'
import { formatUtc } from '../lib/format'
import { Card, Chip, cx, EmptyState, ErrorBanner, PageHeader, Spinner } from '../components/ui'

const usd = (n: number, digits = 2) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits })

const SOURCE_LABEL: Record<CostReport['source'], string> = {
  'cost-explorer': 'Live from AWS Cost Explorer',
  estimate: 'Estimate only',
  mock: 'Mock data',
}

// Typical session length used for the "per session" column.
const SESSION_HOURS = 4

function Tile({
  icon: Icon,
  label,
  value,
  children,
}: {
  icon: typeof Gauge
  label: string
  value: string
  children?: ReactNode
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-slate-600">{label}</p>
        <Icon className="size-5 text-slate-400" strokeWidth={1.75} />
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </Card>
  )
}

function BudgetTile({ report }: { report: CostReport }) {
  const b = report.budget
  if (!b) {
    return (
      <Tile icon={Gauge} label="Monthly budget" value="—">
        No AWS Budget yet. <Link to="/settings" className="text-blue-700 hover:underline">Set one</Link>
      </Tile>
    )
  }
  const pct = b.limit > 0 ? (b.actual / b.limit) * 100 : 0
  const level = pct >= 80 ? 'critical' : pct >= 50 ? 'warning' : 'good'
  const meter = { good: 'bg-blue-600', warning: 'bg-amber-500', critical: 'bg-red-600' }[level]
  const StatusIcon = level === 'good' ? CheckCircle2 : AlertTriangle
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-slate-600">Monthly budget</p>
        <Gauge className="size-5 text-slate-400" strokeWidth={1.75} />
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 tabular-nums">
        {Math.round(pct)}%<span className="ml-1.5 text-base font-normal text-slate-500">of {usd(b.limit, 0)}</span>
      </p>
      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={b.limit}
        aria-valuenow={b.actual}
        aria-label="Budget used"
      >
        <div className={cx('h-full rounded-full', meter)} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-sm text-slate-600">
        <StatusIcon className={cx('size-4', level === 'good' ? 'text-emerald-600' : level === 'warning' ? 'text-amber-600' : 'text-red-600')} />
        {level === 'good' ? 'Under the first alert (50%)' : level === 'warning' ? 'Past the 50% alert' : 'Past the 80% alert'}
        <Link to="/settings" className="ml-auto text-blue-700 hover:underline">
          Change
        </Link>
      </p>
    </Card>
  )
}

// Daily spend: one series, so one hue, no legend; hover shows the exact value.
function DailyChart({ daily }: { daily: CostReport['daily'] }) {
  const [hover, setHover] = useState<number | null>(null)
  // Nice axis: the smallest step giving at most 4 gridlines above zero, with headroom over the tallest bar.
  const max = Math.max(0.1, ...daily.map((d) => d.amount)) * 1.1
  const step = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100].find((s) => max / s <= 4) ?? 100
  const top = Math.ceil(max / step) * step
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  const tickLabel = (t: number) => (step < 1 ? `$${t.toFixed(2)}` : `$${t}`)

  return (
    <div>
      <div className="relative flex h-56 gap-3">
        <div className="flex flex-col-reverse justify-between pb-6 text-right font-mono text-[11px] text-slate-500">
          {ticks.map((t) => (
            <span key={t} className="leading-none">
              {tickLabel(t)}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 bottom-6 flex flex-col-reverse justify-between">
            {ticks.map((t) => (
              <div key={t} className={cx('border-t', t === 0 ? 'border-slate-300' : 'border-slate-100')} />
            ))}
          </div>
          <div className="absolute inset-x-0 top-0 bottom-6 flex items-end gap-[2px]">
            {daily.map((d, i) => (
              <div
                key={d.date}
                className="group relative flex h-full flex-1 items-end"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <div
                  className={cx('w-full rounded-t-[4px] transition-colors', hover === i ? 'bg-blue-700' : 'bg-blue-500')}
                  style={{ height: `${(d.amount / top) * 100}%`, minHeight: d.amount > 0 ? 2 : 0 }}
                />
                {hover === i && (
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 rounded-md bg-slate-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg">
                    <span className="text-slate-300">{d.date}</span>
                    <span className="ml-2 font-medium tabular-nums">{usd(d.amount)}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="absolute inset-x-0 bottom-0 flex gap-[2px] font-mono text-[11px] text-slate-500">
            {daily.map((d, i) => (
              <span key={d.date} className="flex-1 text-center">
                {i === 0 || (i + 1) % 5 === 0 ? Number(d.date.slice(8)) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-slate-600 hover:text-slate-900">Show as table</summary>
        <table className="mt-2 w-full max-w-sm text-left">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 font-medium">Date (UTC)</th>
              <th className="py-1 text-right font-medium">Spend</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[13px]">
            {daily.map((d) => (
              <tr key={d.date} className="border-t border-slate-100">
                <td className="py-1">{d.date}</td>
                <td className="py-1 text-right tabular-nums">{usd(d.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

function ServiceBars({ lines }: { lines: CostReport['byService'] }) {
  const max = Math.max(...lines.map((l) => l.amount), 0.01)
  return (
    <ul className="space-y-3">
      {lines.map((l) => (
        <li key={l.service}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate text-slate-700">{l.service}</span>
            <span className="font-medium text-slate-900 tabular-nums">{usd(l.amount)}</span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-blue-500" style={{ width: `${(l.amount / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function Costs() {
  const report = useAsync(() => api.getCosts())
  const r = report.data

  return (
    <>
      <PageHeader eyebrow="Platform / AWS spend" title="Costs">
        <p className="mt-2 text-slate-600">
          What the platform costs: actual spend this month, the budget, and what a work session costs per hour.
        </p>
      </PageHeader>

      {report.error && <ErrorBanner message={`Could not load costs: ${report.error}`} />}
      {!r && !report.error && (
        <Card className="grid place-items-center p-12">
          <Spinner className="size-6 text-slate-400" />
        </Card>
      )}

      {r && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <Chip>{SOURCE_LABEL[r.source]}</Chip>
            <span>Updated {formatUtc(r.generatedAt)}</span>
            {r.note && <span>· {r.note}</span>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Tile icon={CircleDollarSign} label="Spend this month" value={r.monthToDate === undefined ? '—' : usd(r.monthToDate)}>
              Usage before AWS credits
            </Tile>
            <Tile icon={TrendingUp} label="Forecast for the month" value={r.forecastMonth === undefined ? '—' : usd(r.forecastMonth)}>
              {r.forecastMonth === undefined ? 'Needs a few days of history' : 'If sessions continue at this pace'}
            </Tile>
            <BudgetTile report={r} />
            <Tile icon={Clock} label="While a session is up" value={`${usd(r.sessionRate.perHour)}/h`}>
              {usd(r.sessionRate.perHour * SESSION_HOURS)} per {SESSION_HOURS}-hour session · $0 after down.sh
            </Tile>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="p-5 xl:col-span-2">
              <h2 className="font-medium text-slate-900">Daily spend</h2>
              <p className="mb-4 text-sm text-slate-500">Tall bars are days with a work session; short ones are the always-on foundation.</p>
              {r.daily.length ? <DailyChart daily={r.daily} /> : <EmptyState title="Daily spend appears when the API runs on AWS" />}
            </Card>
            <Card className="p-5">
              <h2 className="font-medium text-slate-900">Spend by service</h2>
              <p className="mb-4 text-sm text-slate-500">Month to date</p>
              {r.byService.length ? <ServiceBars lines={r.byService} /> : <EmptyState title="No spend data yet" />}
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="p-5 pb-3">
              <h2 className="font-medium text-slate-900">What a session costs</h2>
              <p className="text-sm text-slate-500">
                Hourly resources in the cluster stack (us-east-1 on-demand). Everything here is deleted by{' '}
                <code className="font-mono text-[13px]">infra/scripts/down.sh</code>.
              </p>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Resource</th>
                  <th className="px-5 py-2 text-right font-medium">Per hour</th>
                  <th className="px-5 py-2 text-right font-medium">Per {SESSION_HOURS} h session</th>
                  <th className="hidden px-5 py-2 text-right font-medium sm:table-cell">If left on for a month</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {r.sessionRate.items.map((i) => (
                  <tr key={i.item} className="border-t border-slate-100">
                    <td className="px-5 py-2 text-slate-700">{i.item}</td>
                    <td className="px-5 py-2 text-right">{usd(i.perHour, 3)}</td>
                    <td className="px-5 py-2 text-right">{usd(i.perHour * SESSION_HOURS)}</td>
                    <td className="hidden px-5 py-2 text-right sm:table-cell">{usd(i.perHour * 730)}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-200 bg-slate-50 font-medium text-slate-900">
                  <td className="px-5 py-2">Total</td>
                  <td className="px-5 py-2 text-right">{usd(r.sessionRate.perHour, 3)}</td>
                  <td className="px-5 py-2 text-right">{usd(r.sessionRate.perHour * SESSION_HOURS)}</td>
                  <td className="hidden px-5 py-2 text-right sm:table-cell">{usd(r.sessionRate.perHour * 730)}</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </>
  )
}
