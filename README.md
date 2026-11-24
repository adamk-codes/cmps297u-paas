# cmps297u-paas

AWS-based PaaS for application deployment, PostgreSQL setup, and verified backup and recovery.
CMPS 297U Cloud Computing — Group 4: Ahmad Marjeh · Jason Keyrouz · Abdulrahman Kaddoura · Adam Al Khatib.

A team member signs in, picks an approved GitHub repo, requests a PostgreSQL database, starts a
deployment, gets an application URL, and can back up and restore its data — all from one dashboard.

## Repository layout

| Folder | What lives there | Owner |
| --- | --- | --- |
| `dashboard/` | React dashboard (Cognito sign-in, apps, deploys, backups) | Adam |
| `sample-apps/` | Sample Node.js apps (`notes-app/`: Express + Postgres, Dockerfile, docker-compose) | Abdulrahman (notes-app) / Adam |
| `jobs/` | Backup and restore job image (`jobs/backup-restore/`: pg_dump to S3, restore into a new DB + verify) | Abdulrahman |
| `api/` | Platform API (Node + Express): backups, restores, operations done; deploy endpoints next | Abdulrahman (data) / Jason (deploy) |
| `infra/` | Terraform: network, EKS (managed nodes), ECR, load balancer, RDS, S3, IAM, Cognito | Ahmad |
| `.github/workflows/` | CI/CD: test, build, scan, push to ECR, release | Jason |
| `docs/` | Deployment and recovery guide, test results, cost report | Adam |

Folders are added as each part of the project starts. Context for contributors and coding agents: [AGENTS.md](AGENTS.md).

## Dashboard

```bash
cd dashboard
npm install
npm run dev
```

See [`dashboard/README.md`](dashboard/README.md) for details.
