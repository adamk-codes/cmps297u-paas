# Cost estimate (draft for the report, section 4.2)

Region **us-east-1**, on-demand prices. **Rates below are from memory as of late 2026 and must be checked in
the AWS Pricing Calculator before the report is submitted**; record the date you checked. Compare with actual
spend in Cost Explorer after the sessions (rubric: "real cost reported against our estimate").

## Hourly: the cluster stack (only while a session is up)

| Service | Usage | Rate (USD) | Per hour |
| --- | --- | --- | --- |
| EKS control plane | 1 cluster | 0.10 / h | 0.100 |
| EC2 nodes | 2 × t3.medium | 0.0416 / h each | 0.083 |
| NAT gateway | 1 (single, not per AZ) | 0.045 / h + 0.045 / GB | 0.045 |
| Application Load Balancer | 1 shared, low traffic | 0.0225 / h + ~1 LCU × 0.008 | 0.031 |
| RDS PostgreSQL | db.t4g.micro, single-AZ | 0.016 / h | 0.016 |
| Public IPv4 addresses | NAT EIP + 2 ALB IPs | 0.005 / h each | 0.015 |
| EBS (node disks), RDS gp3 20 GB | ~60 GB gp3 | 0.08 / GB-month | ~0.007 |
| **Session total** | | | **≈ $0.30 / hour** |

## Monthly: the foundation stack (always on)

| Service | Usage | Per month |
| --- | --- | --- |
| KMS | 1 customer-managed key | 1.00 |
| Secrets Manager | RDS master + 2 app secrets (+ platform) | ~1.60 (0.40 each, prorated) |
| S3 | backups < 1 GB, dashboard, state, CloudTrail logs | < 0.10 |
| ECR | ~4 repos, < 3 GB images | ~0.30 |
| CloudFront | < 1 GB transfer (free tier 1 TB) | 0.00 |
| Cognito | 4 users (free tier) | 0.00 |
| CloudTrail | first trail, management events | 0.00 (S3 storage only) |
| Budgets | 1 budget | 0.00 |
| **Foundation total** | | **≈ $3 / month** |

## Estimates for the report

| Scenario | Calculation | Total |
| --- | --- | --- |
| **Our project** (80 session hours over ~1.5 months) | 80 h × $0.30 + 1.5 × $3 | **≈ $28.50** |
| Always on, one month (730 h) | 730 h × $0.30 + $3 | **≈ $222 / month** |
| Proposal estimate | (EKS on Fargate) | $41 |

Main cost drivers: the EKS control plane (33% of the hourly cost) and the two nodes (28%), then the NAT gateway.
Design choices that cut cost: one NAT gateway instead of one per AZ (saves ~$33/month always-on); one shared ALB
for all apps via an IngressGroup (instead of one per app: ~$16/month each); one shared RDS instance with a
database per app; single-AZ RDS with no automated backups (our pg_dump backups are the recovery path);
destroying the cluster stack after every session.

Beyond the limits: more apps add only pods (until the 2 nodes are full, ~$30/month per extra t3.medium) and
databases on the same RDS instance (until its connections/CPU are the bottleneck; db.t4g.micro allows ~80
connections, so 5 pool connections × pods × apps is the limit to watch).
