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

## Open questions (ask the team; record the answer here)

1. **Terraform state**: remote backend (S3 + lock) so everyone can apply/destroy, or only Ahmad runs it?
2. **Cluster access**: are all four IAM users added as EKS access entries? Same AWS account for everyone (assumed yes).
3. **API stack and location**: language/framework for `api/`, and how it launches Jobs (Kubernetes API from a
   pod with RBAC is the likely route). Jason owns deploy endpoints, Abdulrahman backup/restore endpoints.
4. **Image tag format**: git short SHA, semver, or both? Needed for backup keys.
5. **DB credentials in the cluster**: Secrets Manager → Kubernetes Secret how (External Secrets, CSI driver,
   or the API/pipeline writes the Secret)?
6. **Second sample app**: who builds it, and is it needed for the "users can't read each other's data" demo
   (success criterion 1 requires two apps)?
7. **Branching**: work directly on `main` (current practice) or feature branches + PRs?
