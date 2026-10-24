# cmps297u-paas

AWS-based PaaS for application deployment, PostgreSQL setup, and verified backup and recovery.
CMPS 297U Cloud Computing — Group 4: Ahmad Marjeh · Jason Keyrouz · Abdulrahman Kaddoura · Adam Al Khatib.

A team member signs in, picks an approved GitHub repo, requests a PostgreSQL database, starts a
deployment, gets an application URL, and can back up and restore its data — all from one dashboard.

## Repository layout

| Folder | What lives there | Owner |
| --- | --- | --- |
| `dashboard/` | React dashboard (Cognito sign-in, apps, deploys, backups) | Adam |
| `sample-apps/` | The two sample Node.js apps and the Docker template | Adam |
| `api/` | Platform API: deployments, databases, backups, restores | Jason / Abdulrahman |
| `infra/` | Terraform: network, EKS on Fargate, load balancer, RDS, IAM, Cognito | Ahmad |
| `.github/workflows/` | CI/CD: test, build, scan, push to ECR, release | Jason |
| `docs/` | Deployment and recovery guide, test results, cost report | Adam |

Folders are added as each part of the project starts.

## Dashboard

```bash
cd dashboard
npm install
npm run dev
```

See [`dashboard/README.md`](dashboard/README.md) for details.
