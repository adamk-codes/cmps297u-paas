# loadtest

Scalability evidence for the report (section 4.1): load an app with [k6](https://k6.io) and record how its
HorizontalPodAutoscaler reacts.

| File | What |
| --- | --- |
| `script.js` | k6 test: 30 s **baseline** at 2 users, then ramp to `VUS` users, hold, ramp down. Requests back to back: 60% home page (50 notes + count), 30% `/api/notes?limit=200`, 10% `/api/stats`, all hitting PostgreSQL. Fails if more than 1% of requests fail. |
| `k8s/k6-job.yaml` | Runs the script as a Job in the `apps` namespace (`grafana/k6:1.8.2`, 0.5–1 CPU), preferring a node without app pods so the load generator doesn't take the CPU being measured. |
| `run.sh` | Starts the Job, samples the HPA every 5 s while it runs, and writes the results. |

## Run it (during a cluster session)

```bash
infra/scripts/up.sh                       # notes-app deployed with its HPA: 1-5 pods, 60% CPU target
loadtest/run.sh --scale-down              # ~4.5 min test + up to 8 min watching the scale-down
kubectl get hpa -n apps -w                # in a second terminal, for the screenshot
```

Options: `--vus 40`, `--ramp 30s`, `--hold 3m`, `--baseline 30s`, `--app notes-app`, `--public` (go through
CloudFront and the ALB instead of the in-cluster Service), `--local URL` (no cluster: k6 in Docker against a
local app, e.g. `http://host.docker.internal:3000/apps/notes-app`).

Results land in `loadtest/results/<UTC time>/` (commit the run used in the report):

- `hpa.csv`: seconds, HPA current/desired replicas, ready pods, average CPU (% of the 100m request)
- `k6.log`: k6 output
- `result.json` / the last line `LOADTEST_RESULT {...}`: requests, req/s, failure %, **p95 and median latency
  for the baseline vs. under load**, start/max pods, peak CPU, **seconds to first scale-up and to max pods**
  (counted from the start of the load phase), seconds to scale back down after the test

## What to expect, and what limits it

- Each pod requests 100m CPU (limit 500m), so 60% means ~60m average per pod. 40 back-to-back users should push
  one pod far past that within seconds. The HPA adds up to 2 pods per 15 s, up to 5.
- 5 pods × 500m fit easily on 2 × c7i-flex.large (4 vCPU in total) next to the API and the load generator.
- The database is the real limit: each pod opens up to 5 connections, so 5 pods use 25 of the ~80 that a
  db.t4g.micro allows. More apps or a higher `maxReplicas` hit that limit before the nodes run out.
- Default mode targets the in-cluster Service, so the numbers measure the app and the database, not the internet
  path from a laptop. `--public` adds CloudFront + ALB (data leaves via the NAT gateway: cents, not dollars).

Checked offline only so far: the script's syntax and summary, and `run.sh` end to end against a simulated
`kubectl` (rendered Job, HPA timeline, result numbers). The first real run is in the first AWS session.
