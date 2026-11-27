# Final submission: deliverables and grading

Source: course "Project Instructions", "Project Rubric", report and poster templates (PDF/PPTX outside the repo).

## Deadline: Monday, November 30, 2026, 9:00 a.m.

| Deliverable | Format | Notes |
| --- | --- | --- |
| Project report | Report template, **3–4 pages** (excl. references and AWS screenshots) | Non-functional analysis (scalability, cost, security) takes 1–2 of those pages |
| Poster | Poster template (`Project_Poster_Template.pptx`), **A1 landscape** | Architecture must show the system **as built**. QR code to the app is optional |
| Video demo | **3–5 minutes** | Main workflow and core functionality |
| Project files | **One ZIP** | Source, Terraform, configuration, everything needed to reproduce |

Presentation (date TBA, after the deadline): **5-minute pitch** (goal, AWS architecture, key design choices), live
demo recommended. **Every member presents and must be able to answer questions about teammates' work too.**

## Rubric (100 points)

| Criterion | Points | What "strong" needs | Where our evidence comes from |
| --- | --- | --- | --- |
| Project challenge and AWS service exploration | 15 | Well-scoped, AWS services used meaningfully | EKS, RDS, S3 + KMS, ECR, ALB, Secrets Manager, Cognito, CloudFront, CloudWatch, CloudTrail, Budgets, each with a real role |
| Architecture and design choices | 20 | Coherent; choices and trade-offs justified | `docs/architecture.md`, `docs/decisions.md` (Fargate → nodes, path routing, pg_dump vs. snapshots, single-AZ RDS) |
| Completeness and functionality (demo) | 25 | Core functionality works **end to end** in the demo | Deploy via pipeline → app URL → backup → simulated data loss → restore → recovery URL verified. A failing test blocks a release. Redeploy an old image |
| Security analysis | 7 | Risks clearly connected to implemented measures | Per-app DB login (show one app can't read the other's DB), IAM role per workload (IRSA), SSE-KMS backups, Secrets Manager, HTTPS, image scan, CloudTrail |
| Scalability analysis | 7 | Capacity, bottlenecks, limits **with evidence** | Load test + HPA scale-out numbers; restore duration vs. dump size; RDS connections as the bottleneck |
| Cost analysis | 6 | Monthly estimate: assumptions, per-service costs, total | Pricing calculator, us-east-1, stated hours; compare to real spend from Cost Explorer |
| Individual Q&A | 20 | Explains system, design, analysis, **own contribution** | Everyone reads `AGENTS.md` + `docs/` before presenting |

Group score (80) is shared; Q&A (20) is individual.

## Who does what (equal split)

| Member | Report | Poster / video / pitch |
| --- | --- | --- |
| Ahmad | 3. AWS services used; 4.2 cost analysis | Infrastructure part of the diagram; demo of `up.sh` / cluster |
| Jason | 4.1 scalability analysis | CI/CD part; demo of deploy, failing test blocks release, HPA under load |
| Abdulrahman | 2. AWS architecture; recovery numbers | Data + recovery part; demo of backup, data loss, restore, recovery URL |
| Adam | 4.3 security analysis | Poster layout; demo of dashboard sign-in, operations, costs page |
| All | 1. Abstract, 5. AI use statement, references | Each presents their own area |

## Drafts

- Report: [report-draft.md](report-draft.md), following the template; every **[TODO]** is a number to measure in a session.
- Poster: [poster/Rebound_Poster_Draft.pptx](poster/Rebound_Poster_Draft.pptx) (preview: [PNG](poster/Rebound_Poster_Draft.png)),
  filled from the course template by `poster/fill_template.py` (edit the text there and re-run, or edit in PowerPoint).
  Still to add: the live CloudFront URL + QR code, AWS icons in the diagram if wanted, measured numbers.
- Cost: [cost.md](cost.md).

## Report sections (template)

1. Abstract and project goal (one-sentence goal, 100–150-word abstract)
2. AWS architecture (same figure as the poster, updated to what was built)
3. AWS services used (service / role / rationale table)
4. Non-functional analysis: 4.1 scalability and capacity (workload, evidence, limit), 4.2 monthly cost table with
   pricing basis and date, 4.3 security (assets, risks, measures, remaining limitations)
5. AI use statement (two sentences: tools used, and how output was reviewed)
6. References; AWS screenshots showing the services working in our account

## Evidence to capture during cluster sessions

Screenshots and numbers are needed for the report and are only available while the infrastructure is up, so
capture them every session:

- `kubectl get nodes,pods -A`, ALB in the console, ECR repo with tags, RDS instance, S3 backup objects (with
  KMS encryption shown), Secrets Manager entries, Cognito pool, CloudTrail events, Budgets alert.
- Backup/restore: `BACKUP_RESULT` / `RESTORE_RESULT` lines (size, row counts, `durationSeconds`), recovery URL page.
- HPA during the load test: `loadtest/run.sh --scale-down` records pods and CPU every 5 s (`hpa.csv`) and prints
  `LOADTEST_RESULT` (p95 before vs. under load, time to scale out and back). Also screenshot `kubectl get hpa -w`.
- Cost Explorer for actual spend.
