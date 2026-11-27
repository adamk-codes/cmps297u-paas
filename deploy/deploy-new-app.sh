#!/usr/bin/env bash
# Deploy a NEW app from the dashboard ("Deploy new app"), using an image the CI pipeline already built.
#   deploy/deploy-new-app.sh <new-app> <source-app>
#     e.g. deploy/deploy-new-app.sh team-notes notes-app
#
# The platform never builds code itself: GitHub Actions tests, builds and pushes images to ECR
# ($ECR_REGISTRY/<source-app>:<sha>). This script picks the newest of those images and only releases it if
# the ECR vulnerability scan found no CRITICAL findings. Steps (shown in the dashboard):
#   ::step test     newest image of <source-app> in ECR (CI pushes only after `npm test` passed)
#   ::step build    ECR scan gate: wait for the scan, block on CRITICAL findings
#   ::step store    own PostgreSQL database + login for the new app (rebound-data.sh provision)
#   ::step release  deploy/deploy-app.sh: Deployment, Service, Ingress (/apps/<new-app>), HPA; rolls back if unhealthy;
#                   then a daily backup CronJob (rebound-data.sh schedule)
# Needs: aws CLI, jq, kubectl; env ECR_REGISTRY, AWS_REGION, NAMESPACE, JOBS_IMAGE (for provision).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="${1:?usage: deploy-new-app.sh <new-app> <source-app>}"
SOURCE_APP="${2:?usage: deploy-new-app.sh <new-app> <source-app>}"
[[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "ERROR: invalid app name" >&2; exit 1; }
[[ "$SOURCE_APP" =~ ^[a-z][a-z0-9-]{1,40}$ ]] || { echo "ERROR: invalid source app" >&2; exit 1; }
: "${ECR_REGISTRY:?ECR_REGISTRY is not set}" "${AWS_REGION:=us-east-1}" "${NAMESPACE:=apps}"
export AWS_REGION NAMESPACE
REBOUND_DATA="${REBOUND_DATA:-$HERE/../jobs/backup-restore/k8s/rebound-data.sh}"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

echo "::step test" >&2
# Newest tagged image that ECR has scanned. describe-images doesn't always report imageScanStatus, so ask
# describe-image-scan-findings (what CI uses) for each tag, newest first, and take the first with a scan.
TAG=""
for t in $(aws ecr describe-images --region "$AWS_REGION" --repository-name "$SOURCE_APP" --filter tagStatus=TAGGED \
    --query 'reverse(sort_by(imageDetails,&imagePushedAt))[:20].imageTags[0]' --output text); do
  status="$(aws ecr describe-image-scan-findings --region "$AWS_REGION" --repository-name "$SOURCE_APP" \
    --image-id imageTag="$t" --query 'imageScanStatus.status' --output text 2>/dev/null || true)"
  case "$status" in COMPLETE|IN_PROGRESS|PENDING|ACTIVE) TAG="$t"; break ;; esac
done
[ -n "$TAG" ] && [ "$TAG" != "None" ] || { echo "ERROR: no scanned image of $SOURCE_APP in ECR" >&2; exit 1; }
IMAGE="$ECR_REGISTRY/$SOURCE_APP:$TAG"
log "newest CI image: $IMAGE"

echo "::step build" >&2
for _ in $(seq 1 30); do
  aws ecr describe-image-scan-findings --region "$AWS_REGION" --repository-name "$SOURCE_APP" \
    --image-id imageTag="$TAG" >/dev/null 2>&1 && break
  sleep 5
done
aws ecr wait image-scan-complete --region "$AWS_REGION" --repository-name "$SOURCE_APP" --image-id imageTag="$TAG" \
  || { echo "ERROR: image $TAG has no completed ECR scan; not deploying" >&2; exit 1; }
CRITICAL="$(aws ecr describe-image-scan-findings --region "$AWS_REGION" --repository-name "$SOURCE_APP" \
  --image-id imageTag="$TAG" --query 'imageScanFindings.findingSeverityCounts.CRITICAL' --output text)"
if [ "$CRITICAL" != "None" ] && [ "$CRITICAL" -gt 0 ]; then
  echo "ERROR: image $TAG has $CRITICAL critical vulnerabilities; not deploying" >&2; exit 1
fi
log "scan passed (CRITICAL=${CRITICAL/None/0})"

echo "::step store" >&2
if kubectl -n "$NAMESPACE" get secret "$APP_NAME-db" >/dev/null 2>&1; then
  log "database for $APP_NAME already exists"
else
  bash "$REBOUND_DATA" provision "$APP_NAME" >/dev/null
fi

echo "::step release" >&2
bash "$HERE/deploy-app.sh" "$APP_NAME" "$IMAGE"
# Daily scheduled backup, like notes-app (the dashboard promises it). Not fatal: the app is already live.
bash "$REBOUND_DATA" schedule "$APP_NAME" >/dev/null || log "WARNING: could not schedule daily backups for $APP_NAME"
