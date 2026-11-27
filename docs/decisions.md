# Decisions and open questions

## Changed since the proposal (Oct 11 2026)

| Proposal said | Now | Why / note |
| --- | --- | --- |
| EKS **on Fargate** | EKS 1.35 with a **managed node group, 2 × c7i-flex.large** | Simpler for the ALB controller, metrics-server/HPA and Jobs. Fallback in the proposal was ECS on Fargate. Nodes were first planned as t3.medium; switched to c7i-flex.large (2 vCPU, 4 GiB, same memory) because our AWS account is on the **Free plan**, which only allows Free-plan-eligible instance types (PR #2). Kubernetes 1.35 on **standard support**, so no extended-support surcharge on the control plane. |
| One URL per app (host-based) | One shared ALB, **path-based** `/apps/<name>` | Hence every app must honour `BASE_PATH`. |
| Two sample apps | `notes-app` built; a second app (`shop-api` in the mock) is optional | Needed only for the cross-app isolation demo. |
| Dashboard hosting unspecified | S3 + CloudFront | One HTTPS URL for dashboard, API and apps. |
| Product unnamed | **Rebound** | Dashboard rebrand, commit `0d03180`. |

Unchanged: one region, one shared RDS with a database + login per app, backups as `pg_dump` files (not RDS
snapshots), restore into a new database at a recovery URL, Cognito sign-in, Terraform for everything, create and
destroy per work session, budget alerts.

## Data + recovery design decisions (Nov 2026)

| Decision | Why | Trade-off |
| --- | --- | --- |
| `pg_dump -Fc` files in S3, not RDS snapshots | Restores one app's database in seconds into a new DB on the same server; a snapshot restores a whole new instance (minutes, extra cost) | Point-in-time is the backup time; later changes are lost |
| Restore always into a **new** database, never over the live one | The live app keeps running; the restore is checked at a separate URL before anyone switches | Switching the live app to the restored DB is a separate, deliberate step |
| Row count stored as S3 metadata at backup time, compared after restore | Verifies completeness, not just "pg_restore exited 0" | Counts one table (`VERIFY_TABLE`); deeper checks would need checksums |
| Image tag stored with each backup; recovery app runs that exact image | Schema and code match the data | Old images must stay in ECR (no aggressive lifecycle policy) |
| Per-app role owns only its DB; `CONNECT` revoked from `PUBLIC` | Apps can't read each other's data (success criterion 1), shown by `isolation-check` | All apps share one RDS instance's CPU/connections |
| Restore Jobs `backoffLimit: 0`, backups `backoffLimit: 1`, one restore at a time | "Limited retries" and "one restore at a time" from the proposal; a retried restore would create a second DB | A transient failure needs a manual re-run |
| Job credentials via IRSA, DB passwords in Secrets Manager → Kubernetes Secret | No static AWS keys in the cluster; least-privilege policy in `iam-policy.json` | `rebound-data.sh` (or the API) copies the secret; no automatic rotation sync |
| TLS to RDS without CA verification by default (`sslmode=require`) | Works with RDS out of the box; traffic is encrypted | Not protected against an active MITM inside the VPC; set `DATABASE_CA_FILE` to the RDS bundle to verify |
| Local S3 = `adobe/s3mock` | MinIO stopped publishing public images | No KMS locally (`S3_SSE=""`) |

## Infrastructure decisions (Nov 2026)

| Decision | Why | Trade-off |
| --- | --- | --- |
| Two Terraform stacks: `foundation` (keep) and `cluster` (per session) | Only hourly resources are destroyed; backups, images, users and the public URL survive; a restore can use a backup from an earlier session | Two applies; the cluster stack looks up foundation resources by name |
| CloudFront in front of S3 (dashboard) **and** the ALB (`/api`, `/apps`) | HTTPS without a custom domain or certificate, one origin (no CORS), stable URL across sessions | CloudFront → ALB is HTTP inside AWS; `up.sh` must re-point the origin each session (a few minutes) |
| Shared Terraform state in S3 with native locking (`use_lockfile`) | Any team member can run `up.sh` / `down.sh` | Foundation state starts local and is migrated once |
| EKS access entries (not `aws-auth`), CI limited to the `apps` namespace | Native IAM-based access, least privilege for CI | Each member's IAM ARN must be listed |
| IRSA roles per workload; GitHub OIDC for CI; RDS-managed master secret | No long-lived AWS keys or DB passwords anywhere in code, CI or state | — |
| One customer-managed KMS key for S3, RDS, secrets, EKS Secrets, ECR, CloudTrail | Encryption story in one place; key rotation on | One key's policy governs all of it |
| ECR immutable tags, keep 30 images | A backup's image tag always means the same image and stays available for 30 days of backups | Re-tagging is impossible (by design) |
| Dashboard calls Cognito directly (no Amplify) | Small bundle, one file to review, works with the existing auth context | Only password + new-password flows (no MFA/SRP UI) |
| Redeploy only to tags in the app's history; new apps via CI (`POST /api/apps` → 501) | Builds/tests/scans belong in the pipeline; the API never builds code | Dashboard "Deploy new app" needs the pipeline to work |

## Open questions (ask the team; record the answer here)

1. **Terraform state**: remote backend (S3 + lock) so everyone can apply/destroy, or only Ahmad runs it?
2. **Cluster access**: are all four IAM users added as EKS access entries? Same AWS account for everyone (assumed yes).
3. **API stack and location**: *Done for data:* `api/` is Node 20 + Express (same as the sample apps). It
   launches Jobs by running `rebound-data.sh` (kubectl in the pod, namespaced RBAC). Jason: add deploy endpoints
   to the same package (routes in `src/app.js`, operation kinds in `src/steps.js`), or tell us if you prefer
   a separate service behind `/api/deploy`.
4. **Image tag format**: git short SHA, semver, or both? Needed for backup keys.
5. **DB credentials in the cluster**: *Proposed:* `rebound-data.sh provision <app>` writes Secrets Manager
   `rebound/apps/<app>/db` and the Kubernetes Secret `<app>-db`; the pipeline's Deployment reads `DATABASE_URL`
   from it. Confirm with Jason.
8. **Kubernetes names**: namespace `apps`, ALB group `rebound`, Deployment/Service named `<app>`, images
   `$ECR_REGISTRY/<app>:<tag>` (see AGENTS.md contract 5). Confirm with Jason and Ahmad.
9. **RDS details for the jobs**: Postgres major version (jobs image client must be ≥), master secret in
   Secrets Manager (`manage_master_user_password`), an IRSA role with `jobs/backup-restore/k8s/iam-policy.json`,
   and ECR repo `rebound/backup-restore`. Ask Ahmad.
6. **Second sample app**: is it needed for the "users can't read each other's data" demo
   (success criterion 1 requires two apps)?
7. **Branching**: work directly on `main` (current practice) or feature branches + PRs?
