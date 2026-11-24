# Decisions and open questions

## Changed since the proposal (Oct 11 2026)

| Proposal said | Now | Why / note |
| --- | --- | --- |
| EKS **on Fargate** | EKS with a **managed node group, 2 × t3.medium** | Current infra task. Simpler for the ALB controller, metrics-server/HPA and Jobs. Fallback in the proposal was ECS on Fargate. |
| One URL per app (host-based) | One shared ALB, **path-based** `/apps/<name>` | Hence every app must honour `BASE_PATH`. |
| Two sample apps, owned by Adam | `notes-app` owned by Abdulrahman | Who builds the second app (the mock shows `shop-api`) is not assigned yet. |
| Dashboard hosting unspecified | S3 + CloudFront | Adam's task. |
| Product unnamed | **Rebound** | Dashboard rebrand, commit `0d03180`. |

Unchanged: one region, one shared RDS with a database + login per app, backups as `pg_dump` files (not RDS
snapshots), restore into a new database at a recovery URL, Cognito sign-in, Terraform for everything, create and
destroy per work session, budget alerts.

## Data + recovery design decisions (Abdulrahman, Nov 2026)

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

## Open questions (ask the team; record the answer here)

1. **Terraform state**: remote backend (S3 + lock) so everyone can apply/destroy, or only Ahmad runs it?
2. **Cluster access**: are all four IAM users added as EKS access entries? Same AWS account for everyone (assumed yes).
3. **API stack and location**: language/framework for `api/`, and how it launches Jobs (Kubernetes API from a
   pod with RBAC is the likely route). Jason owns deploy endpoints, Abdulrahman backup/restore endpoints.
4. **Image tag format**: git short SHA, semver, or both? Needed for backup keys.
5. **DB credentials in the cluster**: *Proposed:* `rebound-data.sh provision <app>` writes Secrets Manager
   `rebound/apps/<app>/db` and the Kubernetes Secret `<app>-db`; the pipeline's Deployment reads `DATABASE_URL`
   from it. Confirm with Jason.
8. **Kubernetes names**: namespace `apps`, ALB group `rebound`, Deployment/Service named `<app>`, images
   `$ECR_REGISTRY/<app>:<tag>` (see AGENTS.md contract 5). Confirm with Jason and Ahmad.
9. **RDS details for the jobs**: Postgres major version (jobs image client must be ≥), master secret in
   Secrets Manager (`manage_master_user_password`), an IRSA role with `jobs/backup-restore/k8s/iam-policy.json`,
   and ECR repo `rebound/backup-restore`. Ask Ahmad.
6. **Second sample app**: who builds it, and is it needed for the "users can't read each other's data" demo
   (success criterion 1 requires two apps)?
7. **Branching**: work directly on `main` (current practice) or feature branches + PRs?
