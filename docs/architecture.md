# Architecture

Target design as of 2026-11-24. The proposal's version differs in a few places; see [decisions.md](decisions.md).

## Components

```
                 Team member (browser)
                        │  signs in with Cognito
                        ▼
      CloudFront + S3 ── Dashboard (React, static)
                        │  HTTPS, Cognito JWT
                        ▼
 ┌──────────────── one AWS account, us-east-1 ────────────────────────────────┐
 │  VPC (public + private subnets, 1 NAT gateway)                             │
 │                                                                            │
 │  ALB (AWS Load Balancer Controller, one shared IngressGroup)               │
 │    /api/...                 → platform API                                 │
 │    /apps/<name>             → app Deployment                               │
 │    /apps/<name>-recovery    → recovery Deployment (restored DB)            │
 │                                                                            │
 │  EKS cluster, managed node group 2 × c7i-flex.large                        │
 │    - platform API (deploy / backup / restore endpoints, operation history) │
 │    - app Deployments + HPA (metrics-server)                                │
 │    - backup / restore Kubernetes Jobs                                      │
 │                                                                            │
 │  RDS PostgreSQL (single-AZ, shared)                                        │
 │    - one database + one restricted login per app                           │
 │    - <app>_restore_<stamp> databases created by restores                   │
 │    - one platform database (operations, backups, restores)                 │
 │                                                                            │
 │  ECR (one repo per app, images tagged per build)                           │
 │  S3 backup bucket (SSE-KMS)   Secrets Manager (DB passwords)               │
 │  CloudWatch, CloudTrail, AWS Budgets                                       │
 └────────────────────────────────────────────────────────────────────────────┘
        ▲
GitHub Actions: test → build → scan → push to ECR → deploy to EKS
```

## Flows

### Deploy

1. Push / dashboard "Deploy" on an approved repo triggers the reusable GitHub Actions workflow.
2. `npm test` — a failure stops here (step `test` fails, nothing is released).
3. Docker build + image scan (`build`), push to ECR with an immutable tag (`store`).
4. Apply Deployment + Service + Ingress (path `/apps/<name>`, shared IngressGroup) + HPA, with env
   `BASE_PATH=/apps/<name>`, `DATABASE_URL` from a Secret, `IMAGE_TAG=<tag>` (`release`).
5. Redeploy = re-apply a previous tag from ECR (`pull`, `release`).

### Backup

1. API (manual) or a CronJob (scheduled, 02:00 UTC in the mock) starts a backup Job for `<app>`.
2. The Job reads the app's `DATABASE_URL` and the **currently running image tag** of the app.
3. `pg_dump -Fc` → upload to `s3://<bucket>/backups/<app>/<timestamp>-<imageTag>.dump` (SSE-KMS)
   (steps `dump`, `store`).
4. Record the backup (size, key, image tag/digest, status) in the platform DB so `listBackups` can return it.

### Restore + verify

1. API rejects the request if another restore is running (one at a time).
2. Restore Job downloads the dump, `CREATE DATABASE <appdb>_restore_<stamp>`, `pg_restore --no-owner` into it
   (step `restore`). Never touches the live database.
3. Deploy the **image tag stored with the backup** at `/apps/<name>-recovery`, pointed at the new database
   (step `run`).
4. Verify: count rows (e.g. `SELECT count(*) FROM notes`), compare with the count taken at backup time if
   available, hit the recovery URL's `/healthz`; record `recordsChecked` and `durationSeconds` (step `check`).
5. Demo scenario: delete notes in the live app ("simulated deletion"), restore, show ≥ 100 records at the
   recovery URL, report recovery time.

### Undo deploy (code and data)

Render-style platforms roll back code only. Rebound can also roll back the data that a bad release damaged:

1. Every deploy of a new version over a running app with a database first takes a **safety backup**
   (`deploy/deploy-app.sh`, trigger `pre-deploy`, labelled with the version that was live). The Deployment
   records it (`rebound.io/safety-backup`, `rebound.io/previous-image-tag`); the dashboard shows "Undo last
   deploy". If the safety backup fails, the new version is not released. Applies to CI, dashboard and up.sh deploys.
2. "Undo code only" is a plain redeploy of the previous version; the data stays as it is.
3. "Undo code and data" (`POST /api/apps/:id/undo-deploy`, `rebound-data.sh undo`):
   restore the safety backup into a new database and verify it, like any restore, while the app keeps running
   (step `restore`); pause the app and back up the current data, trigger `pre-undo` (step `save`); rename the
   live database to `<appdb>_undo_<stamp>` and the restored copy to `<appdb>` in one transaction, release the
   previous version and start the app (step `switch`, `swap.sh`); check the rollout and `/healthz` (step `check`).
4. Nothing is deleted: what users changed after the deploy is in the "Before undo" backup (restorable to the
   recovery URL like any backup) and in the kept database. "Delete app" drops the kept databases too.
   Trade-off: the app pauses for about a minute (backup + rename + start), so the saved data is complete.

## Naming conventions

| Thing | Format | Example |
| --- | --- | --- |
| App path | `/apps/<name>` | `/apps/notes-app` |
| Recovery path | `/apps/<name>-recovery` | `/apps/notes-app-recovery` |
| App database | `<name>` with `-` → `_` | `notes_app` |
| Restored database | `<appdb>_restore_<YYYYMMDDHHMMSS>` | `notes_app_restore_20261124183005` |
| Database set aside by Undo deploy | `<appdb>_undo_<YYYYMMDDHHMMSS>` | `notes_app_undo_20261127150100` |
| Backup key | `backups/<app>/<timestamp>-<imageTag>.dump` | `backups/notes-app/20261124T183000Z-3f9c2ab.dump` |
| Timestamp in keys | UTC, `YYYYMMDDTHHMMSSZ` (no `:` so it's S3/shell safe) | `20261124T183000Z` |

The timestamp format and image-tag value (git short SHA vs. semver) are proposals; they must match what the CI
pipeline produces. The dashboard mock currently uses a different key format and `*.appplatform.internal`
host-style URLs; those are placeholders and will follow this table once the real API exists.

## Local development (no AWS)

- `sample-apps/notes-app/docker-compose.yml`: app + Postgres 16 + `adobe/s3mock` as a local S3 (MinIO no longer
  publishes public images). The backup/restore image runs as `docker compose run --rm backup|restore`.
- Scripts take `S3_ENDPOINT` as an optional override, so the same image works against the local S3 and real S3.
- `jobs/backup-restore/demo-local.sh` runs the full drill: backup → simulated data loss → restore into a new
  database → verify the row count → recovery app on port 3001.
- On the cluster, the same scripts run as Kubernetes Jobs using an image with `postgresql16-client` + AWS CLI,
  with S3 access through an IAM role for the service account (IRSA / EKS Pod Identity), not static keys.
