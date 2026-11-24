# backup-restore

One image, two commands, used as Kubernetes Jobs on EKS and as `docker compose run` tools locally.
Base: `postgres:16-alpine` + AWS CLI + jq. Build with `--build-arg PG_MAJOR=<n>` so the client major version is
**≥ the RDS server's**.

```bash
docker build -t rebound/backup-restore jobs/backup-restore
```

## `backup`

`pg_dump -Fc` of the app database, uploaded to `s3://$S3_BUCKET/backups/<APP_NAME>/<YYYYMMDDTHHMMSSZ>-<IMAGE_TAG>.dump`.
The object metadata records `app`, `image-tag`, `database`, `verify-table` and `row-count`, so a restore knows
which image to run and how many rows to expect.

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | The app's database (its own restricted login is enough) |
| `APP_NAME` | yes | e.g. `notes-app` |
| `IMAGE_TAG` | yes* | Image the app is running (default `unknown`) |
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
| `TARGET_DB` | no | Default `<source db>_restore_<YYYYMMDDHHMM>` |
| `TARGET_OWNER` | no | App login that should own the restored DB/tables (master must be a member: `GRANT notes_app TO <master>`) |
| `MIN_ROWS` | no | Default `100` |
| `S3_ENDPOINT`, `VERIFY_TABLE` | no | As above (`VERIFY_TABLE` defaults to the backup's metadata) |

## Result line (for the platform API)

Each command's **last stdout line** is a marker plus JSON; logs go to stderr. Exit code is non-zero on failure,
so the Kubernetes Job is marked failed.

```
BACKUP_RESULT {"status":"succeeded","app":"notes-app","bucket":"rebound-backups","s3Key":"backups/notes-app/20261124T183411Z-local.dump","imageTag":"local","database":"notes_app","sizeBytes":5216,"rowCount":120,"createdAt":"2026-11-24T18:34:11Z","durationSeconds":1}
RESTORE_RESULT {"status":"succeeded","backupKey":"backups/notes-app/20261124T183411Z-local.dump","targetDatabase":"notes_app_restore_202611241834","imageTag":"local","verifyTable":"notes","recordsChecked":120,"expectedRecords":120,"durationSeconds":2}
```

After a successful restore, the API deploys the image `imageTag` at `/apps/<app>-recovery` with `DATABASE_URL`
pointing at `targetDatabase`, then checks `<recovery URL>/api/stats`.

## On EKS (next step)

- Run as `batch/v1` Jobs (`backoffLimit: 1`, `ttlSecondsAfterFinished`), scheduled backups as a CronJob.
- S3/KMS access through an IAM role on the Job's service account (IRSA or EKS Pod Identity), no static keys.
- `DATABASE_URL` / `ADMIN_DATABASE_URL` from Kubernetes Secrets populated from Secrets Manager.

## Local drill

`./demo-local.sh` runs the whole thing against `sample-apps/notes-app/docker-compose.yml`.
