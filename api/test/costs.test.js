import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCostService, monthWindow, summarizeCostAndUsage, SESSION_RATE } from '../src/costs.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

const ceResults = [
  {
    TimePeriod: { Start: '2026-11-23' },
    Groups: [
      { Keys: ['Amazon Elastic Kubernetes Service'], Metrics: { UnblendedCost: { Amount: '0.80' } } },
      { Keys: ['Amazon Elastic Compute Cloud - Compute'], Metrics: { UnblendedCost: { Amount: '0.66' } } },
      { Keys: ['AWS Key Management Service'], Metrics: { UnblendedCost: { Amount: '0.001' } } },
    ],
  },
  {
    TimePeriod: { Start: '2026-11-24' },
    Groups: [{ Keys: ['Amazon Elastic Kubernetes Service'], Metrics: { UnblendedCost: { Amount: '1.20' } } }],
  },
]

test('summarizes Cost Explorer daily results by day and service', () => {
  const s = summarizeCostAndUsage(ceResults)
  assert.deepEqual(s.daily, [{ date: '2026-11-23', amount: 1.46 }, { date: '2026-11-24', amount: 1.2 }])
  assert.deepEqual(s.byService[0], { service: 'Amazon Elastic Kubernetes Service', amount: 2 })
  assert.equal(s.byService.length, 2, 'sub-cent services are dropped')
  assert.equal(s.monthToDate, 2.66)
})

test('month window covers the 1st through tomorrow (End is exclusive)', () => {
  const w = monthWindow(new Date('2026-11-30T23:00:00Z'))
  assert.deepEqual(w, { start: '2026-11-01', end: '2026-12-01', nextMonth: '2026-12-01', tomorrow: '2026-12-01' })
  assert.equal(monthWindow(new Date('2026-11-01T05:00:00Z')).end, '2026-11-02')
})

function fakeClients({ budgetMissing = false } = {}) {
  const sent = []
  let limit = '40.00'
  const ce = {
    async send(cmd) {
      sent.push(cmd.constructor.name)
      if (cmd.constructor.name === 'GetCostAndUsageCommand') {
        assert.deepEqual(cmd.input.Filter.Not.Dimensions.Values, ['Credit', 'Refund'], 'credits excluded')
        return { ResultsByTime: ceResults }
      }
      return { Total: { Amount: '9.34' } }
    },
  }
  const budgets = {
    async send(cmd) {
      sent.push(cmd.constructor.name)
      if (budgetMissing) throw Object.assign(new Error('missing'), { name: 'NotFoundException' })
      if (cmd.constructor.name === 'UpdateBudgetCommand') {
        limit = cmd.input.NewBudget.BudgetLimit.Amount
        return {}
      }
      return {
        Budget: {
          BudgetName: 'rebound-monthly',
          BudgetLimit: { Amount: limit, Unit: 'USD' },
          CalculatedSpend: { ActualSpend: { Amount: '2.66' }, ForecastedSpend: { Amount: '12' } },
        },
      }
    },
  }
  return { ce, budgets, sent }
}

test('report combines spend, forecast, budget and the session rate, and is cached', async () => {
  const { ce, budgets, sent } = fakeClients()
  const svc = createCostService(loadConfig({ AWS_ACCOUNT_ID: '123456789012' }), { ce, budgets })
  const r = await svc.report()
  assert.equal(r.source, 'cost-explorer')
  assert.equal(r.monthToDate, 2.66)
  assert.equal(r.forecastMonth, 12)
  assert.deepEqual(r.budget, { name: 'rebound-monthly', limit: 40, actual: 2.66, forecast: 12, alertThresholds: [50, 80, 100] })
  assert.equal(r.sessionRate.items.length, SESSION_RATE.length)
  assert.ok(r.sessionRate.perHour > 0.29 && r.sessionRate.perHour < 0.31)

  const calls = sent.length
  await svc.report()
  assert.equal(sent.length, calls, 'second call served from cache (Cost Explorer costs $0.01/request)')
})

test('budget updates are validated and applied', async () => {
  const { ce, budgets } = fakeClients()
  const svc = createCostService(loadConfig({ AWS_ACCOUNT_ID: '123456789012' }), { ce, budgets })
  await assert.rejects(svc.updateBudget(0), /between/)
  await assert.rejects(svc.updateBudget('lots'), /between/)
  const b = await svc.updateBudget(55)
  assert.equal(b.limit, 55)
})

test('without AWS (local) the report is an estimate only; budget changes are refused', async () => {
  const svc = createCostService(loadConfig({}))
  const r = await svc.report()
  assert.equal(r.source, 'estimate')
  assert.equal(r.monthToDate, undefined)
  await assert.rejects(svc.updateBudget(50), /cluster/)
})

test('a missing budget is reported clearly', async () => {
  const { ce, budgets } = fakeClients({ budgetMissing: true })
  const svc = createCostService(loadConfig({ AWS_ACCOUNT_ID: '123456789012' }), { ce, budgets })
  assert.equal((await svc.report()).budget, undefined)
  await assert.rejects(svc.updateBudget(50), /budget_alert_emails/)
})

test('cost routes: GET report, PUT budget, AWS errors become readable 502s', async () => {
  const costs = {
    report: async () => ({ currency: 'USD', source: 'estimate', byService: [], daily: [], sessionRate: { perHour: 0.3, items: [] } }),
    updateBudget: async () => {
      throw Object.assign(new Error('nope'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } })
    },
  }
  const server = await new Promise((r) => {
    const s = createApp({ operations: {}, apps: {}, costs, config: loadConfig({}) }).listen(0, () => r(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await (await fetch(`${base}/api/costs`)).json()).source, 'estimate')
    const res = await fetch(`${base}/api/costs/budget`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limitUsd: 50 }),
    })
    assert.equal(res.status, 502)
    assert.match((await res.json()).error, /Cost Explorer \/ Budgets denied/)
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
})
