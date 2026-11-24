# Rebound API

Node 20 + Express. This package implements the **data + recovery** half of the platform API (backups,
restores, operations). The deploy half (apps, deploy, redeploy, logs, approved repos) can be added as more
routes in `src/app.js` and more operation kinds in `src/operations.js` + `src/steps.js`.

```bash
npm install
npm test          # 29 tests, no AWS/Docker/DB needed
npm run dev       # in-memory history, no auth, process executor
```

## Endpoints (shapes = `dashboard/src/api/types.ts`)

| Dashboard call | HTTP | Returns |
| --- | --- | --- |
| `listBackups(appId?)` | `GET /api/backups?appId=` | `Backup[]` newest first (S3 objects + running/failed backup operations) |
| `createBackup(appId)` | `POST /api/apps/:appId/backups` | `202 Operation` (steps `dump`, `store`) |
| `restore(backupId)` | `POST /api/backups/:backupId/restore` | `202 Operation` (steps `restore`, `run`, `check`); `409` if a restore is running |
| `listRestores()` | `GET /api/restores` | `Restore[]` |
| `getOperation(id)` | `GET /api/operations/:id` | `Operation`; `result` is the `RestoreResult` for restores |
| (activity) | `GET /api/operations?kind=&appId=&status=` | `Operation[]` |
| | `GET /api/backups/:backupId` | `Backup` |
| `listApps()` / `getApp(id)` | `GET /api/apps`, `GET /api/apps/:appId` | `App[]` / `App`, read from Kubernetes |
| `getLogs(id)` | `GET /api/apps/:appId/logs` | `LogLine[]` (last 200 lines) |
| `redeploy(id, tag)` | `POST /api/apps/:appId/redeploy {imageTag}` | `202 Operation` (`pull`, `release`); only tags in the app's history |
| `listApprovedRepos()` | `GET /api/repos` | `APPROVED_REPOS` |
| `deploy(req)` | `POST /api/apps` | `501`: new apps go through the CI pipeline |
| `getCosts()` | `GET /api/costs` | `CostReport`: Cost Explorer spend (before credits) by day and service, forecast, AWS Budget, session rate; cached 6 h |
| `updateBudget(limit)` | `PUT /api/costs/budget {limitUsd}` | `BudgetStatus`; updates the `rebound-monthly` AWS Budget |
| | `GET /healthz`, `GET /api/healthz` | no auth |

- **Auth:** with `COGNITO_USER_POOL_ID` set, every `/api` call needs `Authorization: Bearer <Cognito id or
  access token>`, verified with `aws-jwt-verify` (signature, expiry, issuer, client). Unset = open (local only).
- **Idempotency:** send `Idempotency-Key: <uuid>` on POSTs; a repeated request returns the same operation.
  A second backup request for an app that is already backing up joins the running operation.
- **Backup ids** are the S3 key without prefix/extension, `/` → `~`: `notes-app~20261124T183411Z-3f9c2ab`.
- **Errors:** `{ "error": "..." }` with 400 / 401 / 404 / 409 / 502 (S3 unavailable).

## How work runs

`src/executor.js` runs the scripts in [`jobs/backup-restore`](../jobs/backup-restore) and follows their progress
(`[step]` / `::step` log lines) and results (`*_RESULT` JSON lines):

| `EXECUTOR` | Backup | Restore |
| --- | --- | --- |
| `process` (local) | `backup.sh` with the app's URL from `LOCAL_APPS` | `restore.sh`; recovery URL from `RECOVERY_URL_TEMPLATE` |
| `kubernetes` (EKS) | `k8s/rebound-data.sh backup <app>` → Kubernetes Job | `rebound-data.sh restore <app> <key>` → Job, recovery app, check through the app |

Operation history is stored in the platform database (`PLATFORM_DATABASE_URL`, table `operations`, created on
start) or in memory. Operations left `running` by a crashed API are marked failed on start.

## Run locally with the dashboard

```bash
cd sample-apps/notes-app
docker compose --profile api up --build -d api        # API on :8080 + app + Postgres + local S3
# dashboard/.env.local: VITE_API_URL=http://localhost:8080
```

## Deploy on EKS

1. Build from the repo root and push: `docker build -f api/Dockerfile -t $ECR_REGISTRY/rebound-api:<tag> .`
2. IAM role for service account `apps/rebound-api` with [`k8s/iam-policy.json`](k8s/iam-policy.json)
   (list/read backup metadata only; Jobs use their own role).
3. Platform database: `jobs/backup-restore/k8s/rebound-data.sh provision rebound-platform` (creates the
   `rebound_platform` database, its own login, and the Secret `rebound-platform-db` the API reads).
4. `envsubst < api/k8s/api.yaml | kubectl apply -f -` (variables listed at the top of the file). It is served at
   `/api` on the shared ALB, with a namespaced Role limited to what `rebound-data.sh` needs.
