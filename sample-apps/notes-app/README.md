# notes-app

Sample app for Rebound: Node.js 20 + Express + PostgreSQL. It is what the pipeline builds and deploys, and
what the backup/restore drill protects. On first start it creates a `notes` table and seeds 120 rows.

## Run locally

```bash
docker compose up --build -d        # app + Postgres 16 + local S3 stand-in
# http://localhost:3000/apps/notes-app/
npm install && npm test             # unit tests, no database needed
```

Full recovery drill (backup → simulated data loss → restore into a new DB → verify → recovery app on :3001):

```bash
../../jobs/backup-restore/demo-local.sh
docker compose --profile recovery down -v   # clean up
```

## Environment (the platform's app contract)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | `postgres://user:pass@host:5432/db` |
| `BASE_PATH` | `""` | Path prefix on the shared ALB, e.g. `/apps/notes-app` |
| `PORT` | `3000` | Listen port |
| `DATABASE_SSL` | `false` | `true` to use TLS to RDS |
| `IMAGE_TAG` | `dev` | Shown on the page and in `/healthz`; baked in at build (`--build-arg IMAGE_TAG=...`) |
| `SEED_COUNT` | `120` | Rows seeded **only when the table is first created**; existing or restored tables are never re-seeded |
| `ALLOW_DATA_LOSS_DEMO` | `false` | Enables `POST /api/demo/data-loss` (deletes a % of notes, for the demo) |
| `APP_NAME` | `notes-app` | Display name |

## Endpoints (all under `BASE_PATH`)

| Method | Path | |
| --- | --- | --- |
| GET | `/healthz` | 200 if the DB answers, else 503. Also served at the root `/healthz` for probes |
| GET | `/` | HTML page: note count, database name, image tag, latest notes, add form |
| GET | `/api/stats` | `{ app, imageTag, database, notes }`, used by restore checks |
| GET | `/api/notes?limit=&offset=` | Paged list, newest first |
| GET | `/api/notes/:id` | One note |
| POST | `/api/notes` | `{ title, body?, author? }` → 201 |
| DELETE | `/api/notes/:id` | 204 |
| POST | `/api/demo/data-loss` | `{ percent: 80 }` → deletes the oldest 80% (only if enabled) |

Kubernetes probes: readiness and liveness on `GET /healthz`. ALB health check path: `<BASE_PATH>/healthz`.

Version 2 of the notes app.