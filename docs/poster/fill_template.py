"""Fill the course poster template's named text shapes with Rebound content.

Usage: unzip Project_Poster_Template.pptx into <unpacked-dir>, then python fill_template.py <unpacked-dir>,
then zip the folder back into a .pptx ([Content_Types].xml first).
Replaces the text of each named shape (first run keeps its formatting; extra runs in that paragraph are dropped).
"""
import re
import sys
from xml.sax.saxutils import escape

SLOT = {
    # header
    "project-title": "Rebound: deploy, back up, and verifiably recover apps on AWS",
    "project-subtitle": "A small platform that deploys a team's Node.js apps with their own PostgreSQL database, and proves every backup can be restored.",
    "team-authors": "Ahmad Marjeh  ·  Jason Keyrouz  ·  Abdulrahman Kaddoura  ·  Adam Al Khatib   ·   Fall 2026–27",
    # purpose & function
    "problem-prompt": "Small teams with a working app still have to set up hosting, a database, releases and backups, and rarely test a restore.",
    "function-prompt": "Sign in, deploy an approved repo, get a URL and a private database, back up on demand or nightly, restore in one click.",
    "outcome-prompt": "Each backup is tied to its app version; each restore is checked at a separate URL before anyone relies on it.",
    "user-flow-prompt": "Deploy → back up → lose data → restore → verify",
    # design choices
    "design-row-1-left": "EKS on 2 × t3.medium",
    "design-row-1-right": "Runs the API, the apps (scaled by HPA) and backup/restore Jobs. Managed nodes instead of Fargate: simpler controller setup, fixed hourly cost.",
    "design-row-2-left": "RDS + pg_dump in S3",
    "design-row-2-right": "One database and login per app on one shared instance. A dump file restores one app in seconds; changes after the backup are lost.",
    "design-row-3-left": "CloudFront + one ALB",
    "design-row-3-right": "One HTTPS URL for dashboard, API and apps, routed by path. No custom domain, so CloudFront → ALB is HTTP inside AWS.",
    "design-row-4-left": "HPA + verified restore",
    "design-row-4-right": "Pods scale out on CPU. Single-AZ RDS keeps cost low, so a failure is fixed by restoring a backup into a new database.",
    "design-row-5-left": "Cognito, IRSA, KMS",
    "design-row-5-right": "Team sign-in, one IAM role per workload, no static keys, one KMS key for all data; CloudTrail and Budgets watch actions and spend.",
    "design-add-note": "All infrastructure is Terraform: a kept foundation stack and a per-session cluster stack.",
    # architecture
    "architecture-instructions": "One HTTPS entry point. Everything is created by Terraform; the cluster is destroyed after each session.",
    "aws-boundary-label": "AWS CLOUD  ·  us-east-1  ·  VPC over 2 AZs: public, private and database subnets",
    "diagram-client-prompt": "Team member in a browser",
    "diagram-entry-prompt": "CloudFront (HTTPS) → shared ALB",
    "diagram-compute-prompt": "EKS: API, apps, backup Jobs",
    "diagram-data-prompt": "RDS PostgreSQL · S3 backups (KMS)",
    "diagram-optional-identity-label": "Cognito · IAM roles · Secrets Manager",
    "diagram-optional-observability-label": "CloudWatch · CloudTrail · Budgets",
    "diagram-optional-other-label": "GitHub Actions → ECR (scanned images)",
    "diagram-remove-note": "Kept between sessions: S3 backups, ECR images, Cognito users, CloudFront URL. Destroyed: VPC, EKS, RDS, ALB.",
    "architecture-checklist-heading": "Key flows",
    "architecture-checklist-1": "Request: browser → CloudFront → dashboard on S3, or /api and /apps → ALB → EKS pods",
    "architecture-checklist-2": "Release: GitHub Actions (OIDC) → test → build → scan → ECR → rolling update on EKS",
    "architecture-checklist-3": "Backup: Job → pg_dump → S3 backups/<app>/<time>-<imageTag>.dump, encrypted with KMS",
    "architecture-checklist-4": "Restore: Job → NEW database → same image at /apps/<app>-recovery → rows and time checked",
    "architecture-checklist-note": "Only one restore runs at a time; a repeated request never starts the same job twice.",
    # cost
    "cost-estimate": "~ $26 / month",
    "cost-assumptions-prompt": "us-east-1 on-demand; cluster up 80 h/month, foundation always on",
    "cost-drivers-prompt": "EKS control plane and nodes (~60% of $0.30/h), then NAT and ALB. Left on 24/7: ~ $222/month.",
    # scalability
    "scale-load-prompt": "4 team members, 2 Node.js apps, 100+ rows each; a load test pushes notes-app past its CPU target.",
    "scale-design-prompt": "HPA adds pods (1 → 5) at 60% CPU; one ALB spreads traffic; backups and restores run as separate Jobs.",
    "scale-limit-prompt": "Shared db.t4g.micro (~80 connections) caps total pods; next step: PgBouncer or a larger instance.",
    # security
    "security-identity-prompt": "Cognito sign-in; one IAM role per workload (IRSA); CI via GitHub OIDC; DB passwords in Secrets Manager.",
    "security-network-prompt": "Only CloudFront and the ALB are public; EKS in private subnets; RDS in database subnets, open to EKS only.",
    "security-data-prompt": "One KMS key for S3, RDS, secrets and EKS Secrets; TLS-only, versioned backup bucket, 30-day retention.",
    "security-risk-prompt": "One app reading another's data: own DB and login per app, CONNECT revoked; an isolation Job proves the refusal.",
    "security-evidence": "Implemented: all of the above. Planned: verified RDS certificates and HTTPS to the ALB with a custom domain.",
    # footer
    "footer-print-note": "Source: github.com/adamk-codes/cmps297u-paas   ·   Live demo URL and QR code added after the final session",
}


def set_shape_text(xml: str, name: str, text: str) -> str:
    # The <p:sp> whose cNvPr name is exactly `name`.
    pattern = re.compile(r'<p:sp>(?:(?!</p:sp>).)*?<p:cNvPr id="\d+" name="' + re.escape(name) + r'".*?</p:sp>', re.S)
    m = pattern.search(xml)
    if not m:
        raise SystemExit(f"shape not found: {name}")
    sp = m.group(0)
    # Keep the first paragraph only, and in it the first run (with its formatting).
    body = re.search(r"<p:txBody>.*?</p:txBody>", sp, re.S).group(0)
    paras = re.findall(r"<a:p>.*?</a:p>|<a:p/>", body, re.S)
    first = next(p for p in paras if "<a:r>" in p)  # first paragraph that has text
    runs = re.findall(r"<a:r>.*?</a:r>", first, re.S)
    run = re.sub(r"<a:t>[^<]*</a:t>", "<a:t>" + escape(text) + "</a:t>", runs[0], count=1)
    if text != text.strip():
        run = run.replace("<a:t>", '<a:t xml:space="preserve">', 1)
    new_first = first.replace(runs[0], "\0RUN\0", 1)
    for r in runs[1:]:
        new_first = new_first.replace(r, "", 1)
    new_first = new_first.replace("\0RUN\0", run)
    new_body = body
    for p in paras:
        new_body = new_body.replace(p, "\0P\0" if p is first else "", 1)
    new_body = new_body.replace("\0P\0", new_first)
    return xml.replace(sp, sp.replace(body, new_body), 1)


def box(xml: str, name: str):
    sp = re.search(r'<p:cNvPr id="\d+" name="' + re.escape(name) + r'".*?<a:off x="(\d+)" y="(\d+)"/><a:ext cx="(\d+)" cy="(\d+)"', xml, re.S)
    return tuple(int(v) for v in sp.groups())


def add_arrows(xml: str) -> str:
    """Straight arrow connectors client -> entry -> compute -> data, at the vertical centre of the boxes."""
    if 'name="flow-arrow-' in xml:
        return xml
    next_id = max(int(i) for i in re.findall(r'<p:cNvPr id="(\d+)"', xml)) + 1
    chain = ["diagram-client", "diagram-entry", "diagram-compute", "diagram-data"]
    shapes = []
    for i, (a, b) in enumerate(zip(chain, chain[1:])):
        ax, ay, aw, ah = box(xml, a)
        bx, by, bw, bh = box(xml, b)
        x1, x2, y = ax + aw + 45720, bx - 45720, ay + ah // 2
        shapes.append(
            f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{next_id + i}" name="flow-arrow-{i + 1}" descr="Request flow arrow"/>'
            f'<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="{x1}" y="{y}"/><a:ext cx="{x2 - x1}" cy="0"/></a:xfrm>'
            '<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>'
            '<a:ln w="38100"><a:solidFill><a:srgbClr val="1F2A44"/></a:solidFill>'
            '<a:tailEnd type="triangle" w="med" len="med"/></a:ln></p:spPr></p:cxnSp>'
        )
    return xml.replace("</p:spTree>", "".join(shapes) + "</p:spTree>", 1)


def main(root: str) -> None:
    path = f"{root}/ppt/slides/slide1.xml"
    xml = open(path, encoding="utf8").read()
    for name, text in SLOT.items():
        xml = set_shape_text(xml, name, text)
    xml = add_arrows(xml)
    open(path, "w", encoding="utf8", newline="").write(xml)
    print(f"filled {len(SLOT)} shapes")


if __name__ == "__main__":
    main(sys.argv[1])
