# AGENTS.md — context for anyone (human or agent) picking up this repo

**Rebound** is a small Platform-as-a-Service on AWS, built as the CMPS 297U (Cloud Computing) group project, Group 4.
A team member signs in to one dashboard, picks an approved GitHub repo, gets a PostgreSQL database, deploys,
gets an app URL, and can **back up and restore** the app's data. The selling point is **verified recovery**:
every backup is stored with the app image version it came from, and every restore goes into a *new* database,
runs at a *separate recovery URL*, and is checked (record count, recovery time) before anyone relies on it.

Deeper docs:

- [docs/architecture.md](docs/architecture.md): components, request/deploy/backup/restore flows, naming conventions.
- [docs/decisions.md](docs/decisions.md): what changed since the proposal, and open questions.
- [docs/submission.md](docs/submission.md): final deliverables, rubric, report outline, evidence checklist.
- Course PDFs (proposal, slides, instructions, rubric, report and poster templates) are outside the repo, one folder up
  in the original author's checkout): the approved proposal. The repo docs summarise them; where they disagree,
  the latest task assignment (below) wins.

## Team and ownership

| Person | Area | Current task (assigned Nov 2026) |
| --- | --- | --- |
| Ahmad Marjeh | Infra | Terraform in `infra/`: VPC, EKS (2 × t3.medium managed nodes, community `terraform-aws-modules/vpc` + `eks`), ECR, RDS Postgres, S3 backup bucket, AWS Load Balancer Controller, metrics-server. Goal: `kubectl get nodes` works for everyone. |
| Jason Keyrouz | CI/CD + deploy | GitHub Actions in `.github/workflows/`: test → Docker build → scan → push to ECR → deploy to EKS, each app at `/apps/<name>` on one shared ALB. Then the deploy part of the API, HPA autoscaling, load test. |
| Abdulrahman Kaddoura | Data + recovery | `sample-apps/notes-app/` (Node + Express + Postgres, 100+ rows, `DATABASE_URL` + `BASE_PATH`, `/healthz`), Dockerfile + docker-compose. Then backup script/Job (pg_dump → S3) and restore script/Job (new DB + recovery URL), plus their API endpoints. |
| Adam Al Khatib | Dashboard + docs | HTTP client implementing `PlatformApi` against the real API (switchable with the mock), dashboard on S3 + CloudFront. Later: budget field, cost page, poster draft. Owns `docs/` guides. |

The README's folder table says who owns which folder. Stay inside your area. If you need a change in someone
else's folder or in a shared contract (see below), say so; don't silently edit it.

## Timeline and what gets graded

- Oct 11 2026: proposal + presentation (done).
- Nov 27 2026: implementation and testing done (team target).
- **Nov 30 2026, 9:00 a.m.: final submission**: 3–4 page report, A1 poster, 3–5 min video demo, one ZIP of
  all source/Terraform/config.
- Dec 1–4 2026: 5-minute pitch + demo; every member answers questions about the whole system.

Grading: demo working end to end (25), architecture and justified trade-offs (20), AWS service exploration (15),
security / scalability / cost analyses with evidence (7 / 7 / 6), individual Q&A (20). Details, report outline
and the evidence to capture each session: [docs/submission.md](docs/submission.md). Prefer work that shows up in
the demo or as measured evidence in the report.

## Current state of the repo (as of 2026-11-24)

- `dashboard/`: React 19 + Vite + TypeScript + Tailwind, rebranded to **Rebound**. Runs fully against an
  in-memory mock (`dashboard/src/api/mock.ts`). Sign-in is mocked in `dashboard/src/lib/auth.tsx`.
- `sample-apps/notes-app/` (PR #1, branch `feature/notes-app-backup-restore`): Express + Postgres, 120 seeded
  notes, `BASE_PATH`, `/healthz`, `/api/stats`, data-loss demo endpoint, RDS-safe TLS handling (`sslmode` in the
  URL), `npm test` (12 tests, no DB needed), Dockerfile, docker-compose (Postgres 16 with an admin login +
  provisioned app login, local S3 stand-in `adobe/s3mock`).
- `jobs/backup-restore/` (same PR): one image with `provision`, `backup`, `restore`, `isolation-check`; each
  prints a `*_RESULT` JSON line for the API. `k8s/` has the Job/CronJob/recovery-app manifests, the IRSA IAM
  policy, and `rebound-data.sh`, which runs every operation on EKS end to end. `demo-local.sh` runs the full
  drill locally (the earlier version passed: 120 rows backed up, 80% deleted, 120 restored and served).
- `README.md`, `.gitignore` (ignores `.env*` except `.env.example`, Terraform state, `*.tfvars`),
  `.gitattributes` (LF for `*.sh` and Dockerfiles).

Not yet pushed: `infra/`, `.github/workflows/`, `api/`, `docs/` guides.

Not yet verified: the EKS path (`rebound-data.sh`) has only been checked offline (templates rendered and parsed,
helpers unit-checked); it needs a cluster session. Next for data + recovery: run it on EKS, then the
backup/restore API endpoints (they can call the same Jobs and parse the same result lines).

## How it gets deployed (the short version)

- **One AWS account, one region (us-east-1).** Everyone works against the same account; there is no
  multi-account setup and nothing has to talk across accounts. Ahmad's Terraform creates everything; the
  others get cluster access (`kubectl`) to it.
- **Everything is created at the start of a work session and destroyed at the end** (`terraform apply` …
  `terraform destroy`) because EKS, NAT gateway, ALB and nodes bill by the hour. Budget is about $41 of AWS
  credits for ~80 hours. Never leave hourly resources running.
- So **build and test locally first** (docker-compose), then run the same thing on the cluster during a session.
- One EKS cluster runs: the sample apps, their recovery copies, the platform API, and backup/restore Jobs.
- One shared RDS PostgreSQL instance holds one database + restricted login per app, plus one platform database.
- One shared ALB routes by path: `/apps/<name>` → that app. Apps therefore must honour `BASE_PATH`.
- Images live in ECR, tagged per build; backups live in S3 (KMS-encrypted).
- Dashboard is static on S3 + CloudFront, signs in through Cognito, calls the platform API.

Details and diagrams: [docs/architecture.md](docs/architecture.md).

## Shared contracts — do not break without telling the owner

1. **Dashboard ↔ API**: `dashboard/src/api/index.ts` (`PlatformApi`) and `dashboard/src/api/types.ts`. The API
   must return these shapes. Long-running work (deploy, redeploy, backup, restore) is a POST that returns an
   `Operation`; the dashboard polls `getOperation(id)`. Step keys the dashboard shows:
   - deploy: `test`, `build`, `store`, `release`; redeploy: `pull`, `release`
   - backup: `dump`, `store`; restore: `restore`, `run`, `check`
   - Restore result: `{ backupId, targetDatabase, recoveryUrl, recordsChecked, durationSeconds }`.
   - Only one restore may run at a time (the API must reject a second one).
2. **App runtime contract** (every deployable app): reads `DATABASE_URL`, `BASE_PATH`, `PORT` (default 3000);
   serves everything under `BASE_PATH`; exposes `GET <BASE_PATH>/healthz` (and ideally `/healthz`) returning 200
   when the DB is reachable; has `npm test` (a failing test must block the release in CI).
3. **Backup object key**: `backups/<app>/<timestamp>-<imageTag>.dump` in the backup bucket, `pg_dump -Fc`
   (custom format, so `pg_restore` works). See naming in [docs/architecture.md](docs/architecture.md#naming-conventions).
4. **Paths**: app at `/apps/<name>`, its recovery copy at `/apps/<name>-recovery`.
5. **Kubernetes names** (proposed by data + recovery, confirm with the pipeline): namespace `apps`; app
   Deployment and Service named `<app>`; app DB credentials in Secret `<app>-db` (key `DATABASE_URL`, created by
   `rebound-data.sh provision`); every Ingress joins the ALB group `alb.ingress.kubernetes.io/group.name: rebound`;
   app images at `$ECR_REGISTRY/<app>:<tag>`; Secrets Manager names `rebound/apps/<app>/db`.

## Working rules

- Never commit secrets: no `.env`, `*.tfvars`, kubeconfigs, AWS keys, DB passwords. Commit `.env.example` files.
- Never add AI/Claude attribution (no `Co-Authored-By: Claude`, no "Generated with" lines) to commits or PRs.
- Don't run `terraform apply`/`destroy` or anything that creates AWS resources unless the user explicitly asks;
  it costs real credits and the infra is shared by the team.
- Small focused commits; push work others depend on early (e.g. the sample app before the pipeline needs it).
- Keep Node at 20 (matches `runtime: 'Node.js 20'` in the dashboard data). Match Postgres client major version
  to the RDS server (16 in the mock; confirm against `infra/`).
- Dev OS for some members is Windows: keep scripts POSIX `sh`/`bash` that run inside containers, so they behave
  the same locally and as Kubernetes Jobs.

## Quick start per area

- Dashboard: `cd dashboard && npm install && npm run dev` (mock mode, any email + 8-char password).
- Sample app: `cd sample-apps/notes-app && docker compose up --build -d`, then
  `http://localhost:3000/apps/notes-app/`. Tests: `npm install && npm test`.
- Recovery drill: `bash jobs/backup-restore/demo-local.sh --fresh` (needs Docker; Git Bash works on Windows).
- On EKS: `jobs/backup-restore/k8s/rebound-data.sh` (see `jobs/backup-restore/README.md`).
- Infra (once pushed): see `infra/README.md`; always `terraform destroy` after a session.
