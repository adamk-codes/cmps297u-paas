# Report draft: Rebound

> Draft for the final report (template: `Project_Report_Template.pdf`; **3–4 pages**, NFR analysis 1–2 pages,
> excluding references and screenshots). Move into the template when numbers are in. Everything in **[TODO]**
> must be measured during a cluster session (checklist in `docs/submission.md`). Keep it short: cut, don't add.

**Project:** Rebound: an AWS-based PaaS for application deployment, database setup, and verified recovery
**Team:** Ahmad Marjeh · Jason Keyrouz · Abdulrahman Kaddoura · Adam Al Khatib

## 1. Abstract and project goal

**Project goal:** Let a team deploy a Node.js app with its own PostgreSQL database from one dashboard, and prove
that its data can be recovered.

Developers with a working app still have to set up hosting, a database, releases and backups. Rebound is a small
platform-as-a-service for a trusted team: a member signs in (Amazon Cognito), deploys an approved app through a
GitHub Actions pipeline that tests, builds and scans it, gets a URL, and gets a database of its own on a shared
Amazon RDS instance. Its focus is **verified recovery**: every backup is stored in Amazon S3 with the image
version it was taken from, and every restore goes into a new database, runs that same image at a separate
recovery URL, and is checked (row count, recovery time) before anyone relies on it. The platform runs on Amazon
EKS behind one Application Load Balancer and Amazon CloudFront, is defined entirely in Terraform, and is created
and destroyed for each work session to keep cost low.

## 2. AWS architecture

*Figure 1: same figure as the poster.* Request path: user → CloudFront (HTTPS) → `/` dashboard from S3, or
`/api/*` and `/apps/*` → ALB → EKS pods. Data path: Kubernetes Jobs → RDS (private subnets) and S3 (SSE-KMS).
Release path: GitHub Actions (OIDC) → ECR → EKS. Two Terraform stacks: *foundation* (kept) and *cluster*
(per session).

## 3. AWS services used

| AWS service | Role in the system | Selection or configuration rationale |
| --- | --- | --- |
| Amazon EKS (2 × t3.medium) | Runs the API, the apps (with HPA), recovery apps, and backup/restore **Jobs** | Jobs, CronJobs and autoscaling are native; managed nodes instead of Fargate (proposal) for the load balancer controller and short Jobs |
| Elastic Load Balancing (ALB) | One shared ALB, path routing `/apps/<name>`, `/api` | One IngressGroup for all apps instead of one ALB per app |
| Amazon CloudFront | One stable HTTPS URL for the dashboard, API and apps | HTTPS without buying a domain; same origin (no CORS); survives session teardown |
| Amazon RDS for PostgreSQL | One database + restricted login per app, plus a platform database | Single-AZ db.t4g.micro; recovery is from our own backups |
| Amazon S3 | Backups (`backups/<app>/<time>-<imageTag>.dump`), dashboard, Terraform state | Versioned, SSE-KMS, TLS-only policy, 30-day expiry; backups outlive the cluster |
| AWS KMS | One customer-managed key for S3, RDS, secrets, EKS Secrets, ECR, CloudTrail | Rotation on; one place to reason about encryption |
| AWS Secrets Manager | RDS master password (managed by RDS) and each app's DB URL | No passwords in code, CI, or Terraform state |
| Amazon ECR | Versioned images, scanned on push | Immutable tags: a backup's image tag always means the same image |
| Amazon Cognito | Team sign-in for the dashboard and API | Admin-created users only; API verifies JWTs |
| IAM (IRSA, OIDC) | Per-workload roles; GitHub Actions without stored keys | Least privilege per service account; CI limited to `main` |
| CloudWatch / CloudTrail / Budgets / Cost Explorer | Logs, audit trail, spend alerts, the dashboard's Costs page | Budget alerts at 50/80/100%; costs shown before credits |

## 4. Non-functional requirements analysis

### 4.1 Scalability and capacity

**Workload (assumption):** a team of 4 running 2 sample apps; demo load of **[TODO: N] concurrent users** on
notes-app; backups up to tens of MB.

**Design choices:** stateless app pods behind the ALB, scaled by an HPA on CPU (target 60% of a 100m request,
1→5 pods, scale-up of 2 pods per 15 s); zero-downtime rolling updates (`maxUnavailable: 0`); backups and restores
run as separate Jobs, so they never compete with request handling inside the app; restores are serialized (one
at a time) to protect the shared database.

**Evidence:** load test with **[TODO: tool, e.g. `hey`/k6, rate, duration]**: pods went from 1 to **[TODO]** in
**[TODO] s**; p95 latency **[TODO] ms** before vs **[TODO] ms** at peak (screenshot of `kubectl get hpa -w`).
Recovery: restoring **120 rows ([TODO] KB dump)** took **[TODO] s** for the restore Job and **[TODO] s** end to
end until the recovery URL was verified (`RECOVERY_RESULT`). Locally (docker-compose) the restore Job took 2 s
and 14 s end to end including starting the recovery app (5.2 KB dump, 120/120 rows).

**Limit:** the shared db.t4g.micro is the bottleneck: ~80 connections (each app pod opens up to 5) and burstable
CPU. At ~**[TODO]** pods across apps, connections run out; next steps would be PgBouncer or a larger instance.
The two nodes hold roughly **[TODO]** app pods at 100m CPU requests before the cluster needs a third node.

### 4.2 Monthly cost estimate

Region us-east-1, on-demand, **[TODO: date] prices from the AWS Pricing Calculator**. Workload: cluster up only
during work sessions (80 h total); foundation always on. Details in `docs/cost.md`.

| AWS service | Monthly usage and calculation | Estimated cost |
| --- | --- | --- |
| EKS control plane | 80 h × $0.10 | $8.00 |
| EC2 (2 × t3.medium) | 80 h × 2 × $0.0416 | $6.66 |
| NAT gateway | 80 h × $0.045 (+ data) | $3.60 |
| ALB | 80 h × ~$0.031 | $2.44 |
| RDS db.t4g.micro + 20 GB | 80 h × $0.016 + storage (prorated) | $1.40 |
| Public IPv4 (3) | 80 h × 3 × $0.005 | $1.20 |
| KMS, Secrets Manager, S3, ECR, CloudFront, Cognito | 1 key, ~4 secrets, < 5 GB; free tiers | ~$3.00 |
| **Total** | | **≈ $26 for the project** (vs. $41 proposed); ≈ $222/month if left on 24/7 |

**Actual spend:** **[TODO: Cost Explorer total]** (dashboard Costs page, usage before credits). Main drivers: EKS
control plane and nodes (~60% of the hourly cost). Savings: one NAT instead of two, one shared ALB, one RDS
instance, destroy-after-session.

### 4.3 Security

| Asset / risk | Implemented measures | Remaining limitation |
| --- | --- | --- |
| One app reading another app's data | Own database + login per app; `CONNECT` revoked from `PUBLIC`; **isolation check Job proves notes-app's login is refused by shop-api's database** [TODO: screenshot] | All apps share one RDS instance (noisy neighbour) |
| Leaked credentials | No static AWS keys: IRSA per workload, GitHub OIDC limited to `main`; RDS-managed master password; DB URLs in Secrets Manager and KMS-encrypted Kubernetes Secrets | Recovery app's DB URL is copied into a Kubernetes Secret |
| Backups read or lost | SSE-KMS, TLS-only bucket policy, versioning, public access blocked; data-jobs role limited to `backups/*` | Same account and region (no cross-region copy) |
| Unauthorized platform actions | Cognito sign-in; API verifies JWT signature/expiry/client; namespaced RBAC for the API; CI can deploy only into `apps` | No per-user roles (every member is an admin) |
| Bad or vulnerable releases | Tests block the release; images scanned on push; immutable tags; automatic rollout rollback | Scan findings don't yet block a deploy **[TODO: confirm with pipeline]** |
| Traffic interception | HTTPS at CloudFront; TLS to RDS (`sslmode=require`) | CloudFront → ALB is HTTP inside AWS (no custom domain/certificate); RDS cert not verified by default |
| Unnoticed changes | CloudTrail (log file validation, KMS), CloudWatch logs, operation history with unique IDs | No alerting on CloudTrail events |

## 5. AI use statement

**[TODO: team to confirm wording]** We used Claude (Anthropic) through Claude Code to draft parts of the code,
Terraform, scripts and documentation. Every change was reviewed by a team member, covered by automated tests
(notes-app, API) and checked by running it locally and on AWS before it was merged.

## References

- AWS pricing pages and AWS Pricing Calculator (EKS, EC2, VPC/NAT, ELB, RDS, public IPv4), accessed **[TODO]**
- Amazon EKS user guide: access entries, IAM roles for service accounts; AWS Load Balancer Controller (IngressGroup)
- PostgreSQL documentation: `pg_dump`, `pg_restore`, `GRANT/REVOKE`
- terraform-aws-modules (vpc, eks, iam)

## AWS snapshots (to capture, see `docs/submission.md`)

EKS nodes and pods · ALB and target groups · ECR repo with scan results · RDS instance · S3 backups with KMS ·
Secrets Manager · Cognito users · CloudFront distribution · CloudTrail events · Budgets · Cost Explorer ·
HPA scaling · restore result and recovery URL page.
