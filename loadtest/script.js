// k6 load test for a Rebound app (default: notes-app). Run through loadtest/run.sh, which also records the HPA.
//
// Two phases, so the report can compare latency before and under load:
//   baseline: 2 virtual users for BASELINE (30s): what one pod serves when idle
//   load:     ramp to VUS over RAMP, hold for HOLD, ramp down: pushes CPU past the HPA target (60%)
// Each virtual user sends requests back to back (no think time). Mix: 60% home page (HTML with 50 notes and a
// count: the heaviest route), 30% /api/notes?limit=200, 10% /api/stats. All of them hit PostgreSQL.
//
// Env: TARGET_URL (app base URL incl. /apps/<app>), VUS (40), RAMP (30s), HOLD (3m), BASELINE (30s).
// Prints a human summary and one line `K6_RESULT {json}` for run.sh.
import http from 'k6/http'
import { check } from 'k6'

const BASE = (__ENV.TARGET_URL || 'http://localhost:3000/apps/notes-app').replace(/\/+$/, '')
const VUS = Number(__ENV.VUS || 40)
const RAMP = __ENV.RAMP || '30s'
const HOLD = __ENV.HOLD || '3m'
const BASELINE = __ENV.BASELINE || '30s'

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    baseline: { executor: 'constant-vus', vus: 2, duration: BASELINE, tags: { phase: 'baseline' } },
    load: {
      executor: 'ramping-vus',
      startTime: BASELINE,
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: HOLD, target: VUS },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '10s',
      tags: { phase: 'load' },
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // more than 1% errors fails the run (and the Job)
    // Declared so k6 computes per-phase numbers for the summary.
    'http_req_duration{phase:baseline}': ['max>=0'],
    'http_req_duration{phase:load}': ['max>=0'],
    'http_reqs{phase:load}': ['count>=0'],
  },
}

export default function () {
  const r = Math.random()
  let res
  if (r < 0.6) res = http.get(`${BASE}/`, { tags: { name: 'home' } })
  else if (r < 0.9) res = http.get(`${BASE}/api/notes?limit=200`, { tags: { name: 'notes' } })
  else res = http.get(`${BASE}/api/stats`, { tags: { name: 'stats' } })
  check(res, { 'status is 200': (x) => x.status === 200 })
}

const round = (v) => (v === undefined || v === null ? null : Math.round(v * 10) / 10)
const stat = (m, name, s) => (m[name] && m[name].values ? round(m[name].values[s]) : null)

export function handleSummary(data) {
  const m = data.metrics
  const result = {
    target: BASE,
    vus: VUS,
    hold: HOLD,
    durationSeconds: round(data.state.testRunDurationMs / 1000),
    requests: m.http_reqs.values.count,
    requestsPerSecond: round(m.http_reqs.values.rate),
    loadRequests: stat(m, 'http_reqs{phase:load}', 'count'),
    failedRatePercent: round(m.http_req_failed.values.rate * 100),
    baselineP95Ms: stat(m, 'http_req_duration{phase:baseline}', 'p(95)'),
    baselineMedianMs: stat(m, 'http_req_duration{phase:baseline}', 'med'),
    loadP95Ms: stat(m, 'http_req_duration{phase:load}', 'p(95)'),
    loadMedianMs: stat(m, 'http_req_duration{phase:load}', 'med'),
    loadMaxMs: stat(m, 'http_req_duration{phase:load}', 'max'),
  }
  const lines = [
    '',
    `Target            ${result.target}`,
    `Requests          ${result.requests} (${result.requestsPerSecond}/s over ${result.durationSeconds}s), failed ${result.failedRatePercent}%`,
    `Baseline (2 VUs)  median ${result.baselineMedianMs} ms, p95 ${result.baselineP95Ms} ms`,
    `Load (${VUS} VUs)    median ${result.loadMedianMs} ms, p95 ${result.loadP95Ms} ms, max ${result.loadMaxMs} ms`,
    `K6_RESULT ${JSON.stringify(result)}`,
    '',
  ]
  return { stdout: lines.join('\n') }
}
