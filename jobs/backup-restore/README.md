# backup-restore

The data + recovery side of Rebound. One image with four commands (`provision`, `backup`, `restore`,
`isolation-check`), used as Kubernetes Jobs on EKS (driven by [`k8s/rebound-data.sh`](k8s/rebound-data.sh)) and as
`docker compose run` tools locally.
Base: `postgres:16-alpine` + AWS CLI + jq. Build with `--build-arg PG_MAJOR=<n>` so the client major version is
**≥ the RDS server's**.

```bash
docker build -t rebound/backup-restore jobs/backup-restore
```

## `provision`

Creates the app's own database and login on the shared server (`notes-app` → database and role `notes_app`),
revokes `CONNECT` from `PUBLIC` so no other app's login can open it, and stores the connection URL in Secrets
Manager (`SECRET_ID`, e.g. `rebound/apps/notes-app/db`) and/or a file (`SECRET_FILE`). The password is never
logged. Idempotent; re-running sets the password again.

| Variable | Required | Meaning |
| --- | --- | --- |
| `ADMIN_DATABASE_URL` | yes | Admin (RDS master) login; keep `?sslmode=require` on RDS, it is copied to the app URL |
| `APP_NAME` | yes | e.g. `notes-app` |
| `DB_PASSWORD` | no | Fixed password (local only); random 32 characters otherwise |
| `SECRET_ID`, `SECRETS_KMS_KEY_ID` | no | Secrets Manager secret name / KMS key |
| `SECRET_FILE` | no | Write the URL to this file instead (local testing) |
| `APP_DB_HOST` | no | Host:port the apps should use, if different from the admin URL's |

## `isolation-check`

Security evidence: with `DATABASE_URL` (one app's login) it opens its own database, then tries `OTHER_DATABASE`
and must be refused (`permission denied for database`). Prints `ISOLATION_RESULT`, exit 0 only if isolation holds.

## `backup`

`pg_dump -Fc` of the app database, uploaded to `s3://$S3_BUCKET/backups/<APP_NAME>/<YYYYMMDDTHHMMSSZ>-<IMAGE_TAG>.dump`.
The object metadata records `app`, `image-tag`, `database`, `verify-table` and `row-count`, so a restore knows
which image to run and how many rows to expect.

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | The app's database (its own restricted login is enough) |
| `APP_NAME` | yes | e.g. `notes-app` |
| `IMAGE_TAG` | yes* | Image the app is running (default `unknown`) |
| `IMAGE_TAG_URL` | no | If `IMAGE_TAG` is unset, read `imageTag` from this app `/healthz` URL (scheduled backups) |
| `S3_BUCKET` | yes | Backup bucket |
| `S3_PREFIX` | no | Default `backups` |
| `S3_SSE` | no | Default `aws:kms`; `""` disables (local S3 stand-in) |
| `S3_KMS_KEY_ID` | no | KMS key for SSE-KMS (bucket default otherwise) |
| `S3_ENDPOINT` | no | Custom S3 endpoint (local only) |
| `VERIFY_TABLE` | no | Table whose rows are counted, default `notes` |

## `restore`

Downloads `BACKUP_KEY`, creates a **new** database (refuses if it exists), `pg_restore`s into it, then counts rows
in the verify table. Fails if the count differs from the backup's `row-count` or is below `MIN_ROWS`.
If `pg_restore` fails, the half-restored database is dropped (unless `KEEP_FAILED=true`).

| Variable | Required | Meaning |
| --- | --- | --- |
| `ADMIN_DATABASE_URL` | yes | Login allowed to `CREATE DATABASE` (RDS master user) |
| `BACKUP_KEY` | yes | S3 key from a backup result |
| `S3_BUCKET` | yes | Backup bucket |
| `TARGET_DB` | no | Default `<source db>_restore_<YYYYMMDDHHMMSS>` |
| `TARGET_OWNER` | no | App login that should own the restored DB/tables (master must be a member: `GRANT notes_app TO <master>`) |
| `MIN_ROWS` | no | Default `100` |
| `S3_ENDPOINT`, `VERIFY_TABLE` | no | As above (`VERIFY_TABLE` defaults to the backup's metadata) |

## Result line (for the platform API)

Each command's **last stdout line** is a marker plus JSON; logs go to stderr. Exit code is non-zero on failure,
so the Kubernetes Job is marked failed.

```
BACKUP_RESULT {"status":"succeeded","app":"notes-app","bucket":"rebound-backups","s3Key":"backups/notes-app/20261124T183411Z-local.dump","imageTag":"local","database":"notes_app","sizeBytes":5216,"rowCount":120,"createdAt":"2026-11-24T18:34:11Z","durationSeconds":1}
RESTORE_RESULT {"status":"succeeded","backupKey":"backups/notes-app/20261124T183411Z-local.dump","targetDatabase":"notes_app_restore_20261124183418","imageTag":"local","verifyTable":"notes","recordsChecked":120,"expectedRecords":120,"durationSeconds":2}
```

After a successful restore, the API deploys the image `imageTag` at `/apps/<app>-recovery` with `DATABASE_URL`
pointing at `targetDatabase`, then checks `<recovery URL>/api/stats`.

## On EKS

[`k8s/`](k8s) has the manifests (templated with `envsubst`) and the runner:

| File | What |
| --- | --- |
| `serviceaccount.yaml` | `rebound-data-jobs` with an IRSA role annotation, no static AWS keys |
| `iam-policy.json` | Least-privilege policy for that role: `backups/*` in the bucket, the KMS key, `rebound/apps/*` secrets |
| `provision-job.yaml`, `backup-job.yaml`, `restore-job.yaml`, `isolation-job.yaml` | One Job per operation, labelled with `rebound.io/operation-id`; non-root, read-only capabilities, resource limits |
| `backup-cronjob.yaml` | Daily 02:00 UTC, `concurrencyPolicy: Forbid`; reads the live image tag from the app's `/healthz` |
| `recovery-app.yaml` | Deployment + Service + Ingress at `/apps/<app>-recovery` on the shared ALB (IngressGroup `rebound`) |
| `rebound-data.sh` | Runs everything and prints `*_RESULT` JSON lines |

```bash
cp k8s/.env.example k8s/.env      # fill from terraform outputs
k8s/rebound-data.sh push-image     # build + push the jobs image to ECR (needs Docker)
k8s/rebound-data.sh bootstrap      # namespace, service account, admin DB secret from Secrets Manager
k8s/rebound-data.sh provision notes-app
k8s/rebound-data.sh schedule notes-app
k8s/rebound-data.sh backup notes-app
k8s/rebound-data.sh restore notes-app latest     # -> RECOVERY_RESULT with recoveryUrl + timings
k8s/rebound-data.sh isolation notes-app shop_api
```

`restore` refuses to start while another restore Job is active (one at a time), creates the new database, starts
the recovery app with the image recorded in the backup, checks the row count **through the running recovery
app**, and reports `restoreSeconds` (Job) and `durationSeconds` (end to end, until the recovery URL is verified).
Its `RECOVERY_RESULT` has the same fields as the dashboard's `RestoreResult`.

What the cluster needs from the rest of the team:
- **Infra:** an IAM role for `apps/rebound-data-jobs` with `iam-policy.json`, the RDS master secret, and an ECR
  repo `rebound/backup-restore`.
- **Pipeline:** the app's Deployment reads `DATABASE_URL` from the `<app>-db` Secret and sets `IMAGE_TAG`; app
  Ingresses use `alb.ingress.kubernetes.io/group.name: rebound`; images are `$ECR_REGISTRY/<app>:<tag>`.

## Local drill

`./demo-local.sh [--fresh]` runs the whole thing against `sample-apps/notes-app/docker-compose.yml`: provision,
isolation check against a second app's database, backup, simulated data loss, restore, verify, recovery app on
:3001, and the measured recovery time.
