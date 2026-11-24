#!/usr/bin/env bash
# End a work session: delete everything billed by the hour.
#   infra/scripts/down.sh [--yes]
# Kept: backups in S3, images in ECR, Cognito users, the dashboard and its CloudFront URL (foundation stack).
# Ingresses are deleted first so the Load Balancer Controller removes the ALB and its security groups;
# otherwise `terraform destroy` would hang on the VPC (Terraform doesn't know about the ALB).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INFRA="$ROOT/infra"
APPROVE=""
[ "${1:-}" = "--yes" ] && APPROVE="-auto-approve"
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ -f "$INFRA/backend.hcl" ] || { echo "infra/backend.hcl missing: was the session started with up.sh?" >&2; exit 1; }
terraform -chdir="$INFRA/cluster" init -input=false -backend-config=../backend.hcl >/dev/null
REGION="$(terraform -chdir="$INFRA/cluster" output -raw kubeconfig_command 2>/dev/null | sed -n 's/.*--region \([^ ]*\).*/\1/p')"
CLUSTER="$(terraform -chdir="$INFRA/cluster" output -raw cluster_name 2>/dev/null || true)"
VPC="$(terraform -chdir="$INFRA/cluster" output -raw vpc_id 2>/dev/null || true)"

if [ -n "$CLUSTER" ] && aws eks describe-cluster --name "$CLUSTER" --region "$REGION" >/dev/null 2>&1; then
  aws eks update-kubeconfig --region "$REGION" --name "$CLUSTER" >/dev/null
  step "Deleting Ingresses (removes the ALB) and suspending CronJobs"
  kubectl delete ingress --all --all-namespaces --wait=true --timeout=300s || true
  kubectl patch cronjob --all -n apps -p '{"spec":{"suspend":true}}' >/dev/null 2>&1 || true

  step "Waiting for the ALB to disappear"
  for _ in $(seq 1 40); do
    left="$(aws elbv2 describe-load-balancers --region "$REGION" \
      --query "LoadBalancers[?VpcId=='$VPC'].LoadBalancerName" --output text 2>/dev/null || true)"
    [ -z "$left" ] && break
    echo "  still there: $left"; sleep 10
  done
fi

step "Destroying the cluster stack (EKS, nodes, RDS, NAT, VPC): ~10-15 minutes"
terraform -chdir="$INFRA/cluster" destroy -input=false $APPROVE

step "Done. Nothing billed by the hour is left from this stack."
echo "CloudFront still points at the old ALB name (dashboard loads; /api returns 502 until the next up.sh)."
