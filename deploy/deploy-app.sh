#!/usr/bin/env bash
# Deploy (or redeploy) an app image to the cluster and wait until it is healthy.
#   deploy/deploy-app.sh <app> <image>          e.g. notes-app 123.dkr.ecr.us-east-1.amazonaws.com/notes-app:3f9c2ab
# Rolls back automatically if the new pods don't become ready. Used by up.sh and the CI pipeline.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="${1:?usage: deploy-app.sh <app> <image>}"
APP_IMAGE="${2:?usage: deploy-app.sh <app> <image>}"
[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || { echo "invalid app name" >&2; exit 1; }

export APP_NAME APP_IMAGE
export IMAGE_TAG="${APP_IMAGE##*:}"
export NAMESPACE="${NAMESPACE:-apps}" ALB_GROUP="${ALB_GROUP:-rebound}"
export MIN_REPLICAS="${MIN_REPLICAS:-1}" MAX_REPLICAS="${MAX_REPLICAS:-5}" CPU_TARGET="${CPU_TARGET:-60}"

# Display metadata for the dashboard; kept from the current Deployment when not given (redeploys).
current() {
  kubectl get deploy "$APP_NAME" -n "$NAMESPACE" -o "jsonpath={.metadata.annotations.rebound\.io/$1}" 2>/dev/null || true
}
APP_REPO="${APP_REPO:-$(current repo)}"
APP_DESCRIPTION="${APP_DESCRIPTION:-$(current description)}"
APP_ICON="${APP_ICON:-$(current icon)}"
export APP_REPO APP_DESCRIPTION APP_ICON="${APP_ICON:-box}"

echo "::step pull"
kubectl get secret "$APP_NAME-db" -n "$NAMESPACE" >/dev/null 2>&1 \
  || { echo "Secret $APP_NAME-db missing: run jobs/backup-restore/k8s/rebound-data.sh provision $APP_NAME" >&2; exit 1; }

echo "::step release"
envsubst '${APP_NAME} ${APP_IMAGE} ${IMAGE_TAG} ${NAMESPACE} ${ALB_GROUP} ${MIN_REPLICAS} ${MAX_REPLICAS} ${CPU_TARGET} ${APP_REPO} ${APP_DESCRIPTION} ${APP_ICON}' \
  < "$HERE/app.yaml" | kubectl apply -f -

if ! kubectl rollout status "deploy/$APP_NAME" -n "$NAMESPACE" --timeout=180s; then
  echo "rollout of $APP_IMAGE failed; rolling back to the previous image" >&2
  kubectl rollout undo "deploy/$APP_NAME" -n "$NAMESPACE"
  kubectl rollout status "deploy/$APP_NAME" -n "$NAMESPACE" --timeout=180s || true
  exit 1
fi
echo "DEPLOY_RESULT {\"status\":\"succeeded\",\"app\":\"$APP_NAME\",\"image\":\"$APP_IMAGE\",\"imageTag\":\"$IMAGE_TAG\"}"
