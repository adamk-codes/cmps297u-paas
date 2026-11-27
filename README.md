# cmps297u-paas

AWS-based PaaS for application deployment, PostgreSQL setup, and verified backup and recovery.
CMPS 297U Cloud Computing — Group 4: Ahmad Marjeh · Jason Keyrouz · Abdulrahman Kaddoura · Adam Al Khatib.

A team member signs in, picks an approved GitHub repo, requests a PostgreSQL database, starts a
deployment, gets an application URL, and can back up and restore its data — all from one dashboard.

## Team and task split

Work is split equally: each member owns one area end to end (code, evidence, part of the poster and demo) and one
section of the report.

| Member | Area | Owns | Report section | Demo |
| --- | --- | --- | --- | --- |
| Ahmad Marjeh | Infrastructure | `infra/` (Terraform: VPC, EKS, ECR, RDS, S3 + KMS, ALB controller, IRSA), `up.sh` / `down.sh`, SQS operations queue + worker | 3. AWS services used; 4.2 cost analysis | Bringing the cluster up |
| Jason Keyrouz | CI/CD + deploy | `.github/workflows/`, `deploy/`, deploy / redeploy / delete endpoints, HPA autoscaling, `loadtest/` | 4.1 scalability analysis | Deploy, failing test blocks a release, autoscaling under load |
| Abdulrahman Kaddoura | Data + recovery | `sample-apps/notes-app/`, `jobs/backup-restore/`, backup / restore / recovery-drill endpoints | 2. AWS architecture; recovery numbers | Backup, data loss, restore, recovery URL |
| Adam Al Khatib | Dashboard + platform API core | `dashboard/` (Cognito sign-in, costs page), S3 + CloudFront hosting, API core (auth, operations, activity log, alerts), poster | 4.3 security analysis | Dashboard sign-in, operations, costs |

Shared by all four: the abstract, AI use statement, references, video, and pitch (each presents their own area).

## Repository layout

| Folder | What lives there | Owner |
| --- | --- | --- |
| `infra/` | Terraform: `foundation/` (KMS, S3, ECR, Cognito, CloudFront, CI role, budgets, CloudTrail) and `cluster/` (VPC, EKS, ALB controller, RDS, IRSA); `scripts/up.sh`, `down.sh` | Ahmad |
| `.github/workflows/` | CI/CD: test, build, scan, push to ECR, release | Jason |
| `deploy/` | Generic app template (Deployment, Service, Ingress, HPA) and `deploy-app.sh` | Jason |
| `loadtest/` | k6 load test as a Kubernetes Job + `run.sh`, which records the HPA scale-out (scalability evidence) | Jason |
| `sample-apps/` | Sample Node.js apps (`notes-app/`: Express + Postgres, Dockerfile, docker-compose) | Abdulrahman |
| `jobs/` | Backup and restore job image (`jobs/backup-restore/`: pg_dump to S3, restore into a new DB + verify) | Abdulrahman |
| `dashboard/` | React dashboard (Cognito sign-in, apps, deploys, backups, costs), hosted on S3 + CloudFront | Adam |
| `api/` | Platform API (Node + Express) | Shared: core, auth, operations, activity log, alerts (Adam); deploy endpoints (Jason); backup/restore endpoints (Abdulrahman); SQS queue + worker (Ahmad) |
| `docs/` | Architecture, decisions, submission checklist, cost estimate, report and poster drafts | All (each writes their own section) |

Folders are added as each part of the project starts. Context for contributors and coding agents: [AGENTS.md](AGENTS.md).

## Dashboard

```bash
cd dashboard
npm install
npm run dev
```

See [`dashboard/README.md`](dashboard/README.md) for details.
