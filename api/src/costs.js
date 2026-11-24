import { BudgetsClient, DescribeBudgetCommand, UpdateBudgetCommand } from '@aws-sdk/client-budgets'
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer'
import { HttpError } from './operations.js'

// What a work session costs per hour (cluster stack, us-east-1 on-demand). Same numbers as docs/cost.md;
// keep them in sync. Used for the "this session" estimate next to the real Cost Explorer data.
export const SESSION_RATE = [
  { item: 'EKS control plane', perHour: 0.1 },
  { item: 'EC2 nodes (2 × t3.medium)', perHour: 0.0832 },
  { item: 'NAT gateway', perHour: 0.045 },
  { item: 'Application Load Balancer', perHour: 0.0305 },
  { item: 'RDS db.t4g.micro', perHour: 0.016 },
  { item: 'Public IPv4 (3)', perHour: 0.015 },
  { item: 'EBS storage', perHour: 0.007 },
]

const round2 = (n) => Math.round(n * 100) / 100
const day = (d) => d.toISOString().slice(0, 10)

export function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return { start: day(start), end: day(tomorrow), nextMonth: day(nextMonth), tomorrow: day(tomorrow) }
}

// Cost Explorer GetCostAndUsage (DAILY, grouped by SERVICE) -> totals per day and per service.
export function summarizeCostAndUsage(results = []) {
  const byService = new Map()
  const daily = []
  for (const r of results) {
    let total = 0
    for (const g of r.Groups ?? []) {
      const amount = Number(g.Metrics?.UnblendedCost?.Amount ?? 0)
      total += amount
      const service = g.Keys?.[0] ?? 'Other'
      byService.set(service, (byService.get(service) ?? 0) + amount)
    }
    daily.push({ date: r.TimePeriod?.Start, amount: round2(total) })
  }
  const services = [...byService.entries()]
    .map(([service, amount]) => ({ service, amount: round2(amount) }))
    .filter((s) => s.amount >= 0.01)
    .sort((a, b) => b.amount - a.amount)
  const monthToDate = round2(services.reduce((sum, s) => sum + s.amount, 0))
  return { byService: services, daily, monthToDate }
}

const sessionRate = () => ({
  perHour: Math.round(SESSION_RATE.reduce((s, i) => s + i.perHour, 0) * 1000) / 1000,
  items: SESSION_RATE,
})

// Spend and budget for the Costs page. Cost Explorer charges per request and updates a few times a day,
// so results are cached (COST_CACHE_MINUTES, default 360).
export function createCostService(config, clients = {}) {
  const enabled = config.executor === 'kubernetes' && Boolean(config.accountId)
  const ce = clients.ce ?? (enabled ? new CostExplorerClient({ region: 'us-east-1' }) : null)
  const budgets = clients.budgets ?? (enabled ? new BudgetsClient({ region: 'us-east-1' }) : null)
  const budgetName = config.budgetName
  let cache = null

  async function describeBudget() {
    if (!budgets) return undefined
    try {
      const { Budget: b } = await budgets.send(
        new DescribeBudgetCommand({ AccountId: config.accountId, BudgetName: budgetName }),
      )
      return {
        name: b.BudgetName,
        limit: Number(b.BudgetLimit?.Amount ?? 0),
        actual: round2(Number(b.CalculatedSpend?.ActualSpend?.Amount ?? 0)),
        ...(b.CalculatedSpend?.ForecastedSpend && {
          forecast: round2(Number(b.CalculatedSpend.ForecastedSpend.Amount)),
        }),
        alertThresholds: [50, 80, 100],
      }
    } catch (err) {
      if (err.name === 'NotFoundException') return undefined
      throw err
    }
  }

  return {
    async report({ refresh = false } = {}) {
      const ttl = (config.costCacheMinutes ?? 360) * 60_000
      if (!refresh && cache && Date.now() - cache.at < ttl) return cache.value

      if (!ce) {
        return {
          currency: 'USD',
          generatedAt: new Date().toISOString(),
          source: 'estimate',
          byService: [],
          daily: [],
          sessionRate: sessionRate(),
          note: 'Actual spend comes from AWS Cost Explorer when the API runs on the cluster.',
        }
      }

      const w = monthWindow()
      // Usage only: our AWS credits would otherwise net the bill to $0.
      const usageOnly = { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] } } }
      const [usage, forecast, budget] = await Promise.all([
        ce.send(
          new GetCostAndUsageCommand({
            TimePeriod: { Start: w.start, End: w.end },
            Granularity: 'DAILY',
            Metrics: ['UnblendedCost'],
            GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
            Filter: usageOnly,
          }),
        ),
        ce
          .send(
            new GetCostForecastCommand({
              TimePeriod: { Start: w.tomorrow, End: w.nextMonth },
              Metric: 'UNBLENDED_COST',
              Granularity: 'MONTHLY',
              Filter: usageOnly,
            }),
          )
          .catch(() => null), // not enough history yet, or last day of the month
        describeBudget(),
      ])
      const summary = summarizeCostAndUsage(usage.ResultsByTime)
      const rest = forecast ? Number(forecast.Total?.Amount ?? 0) : null
      const value = {
        currency: 'USD',
        generatedAt: new Date().toISOString(),
        source: 'cost-explorer',
        ...summary,
        ...(rest !== null && { forecastMonth: round2(summary.monthToDate + rest) }),
        ...(budget && { budget }),
        sessionRate: sessionRate(),
        note: 'Usage cost before credits. Cost Explorer data lags by up to 24 hours.',
      }
      cache = { at: Date.now(), value }
      return value
    },

    // Change the monthly AWS Budget limit (alerts at 50/80/100% stay as configured in Terraform).
    async updateBudget(limitUsd) {
      const limit = Number(limitUsd)
      if (!Number.isFinite(limit) || limit < 1 || limit > 10_000) {
        throw new HttpError(400, 'budget must be between $1 and $10,000')
      }
      if (!budgets) throw new HttpError(501, 'Budgets are managed on AWS; run the API on the cluster')
      const { Budget: current } = await budgets
        .send(new DescribeBudgetCommand({ AccountId: config.accountId, BudgetName: budgetName }))
        .catch((err) => {
          if (err.name === 'NotFoundException') {
            throw new HttpError(404, 'No budget exists yet: set budget_alert_emails in infra/foundation')
          }
          throw err
        })
      await budgets.send(
        new UpdateBudgetCommand({
          AccountId: config.accountId,
          NewBudget: { ...current, BudgetLimit: { Amount: limit.toFixed(2), Unit: 'USD' }, CalculatedSpend: undefined },
        }),
      )
      cache = null
      return describeBudget()
    },
  }
}
