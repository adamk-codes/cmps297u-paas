#!/usr/bin/env bash
# Deploy (or redeploy) an app image to the cluster and wait until it is healthy.
#   deploy/deploy-app.sh <app> <image>          e.g. notes-app 123.dkr.ecr.us-east-1.amazonaws.com/notes-app:3f9c2ab
# Rolls back automatically if the new pods don't become ready. Used by up.sh, the CI pipeline and the API.
#
# Safety backup: before a NEW version replaces a running app that has a database, its data is backed up
# (trigger "pre-deploy", labelled with the version that was live). The Deployment records that backup and
# the previous version, so "Undo deploy" in the dashboard can put back the old version AND its data.
# The backup runs as a Job built from the app's daily backup CronJob, so it needs no extra settings here.
# SAFETY_BACKUP=off skips it (used by "Undo deploy" itself, which saves the data its own way).
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

PRE_SAFETY="$(current safety-backup)"; PRE_PREVIOUS="$(current previous-image-tag)"
PREVIOUS_IMAGE="$(kubectl get deploy "$APP_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
PREVIOUS_TAG="${PREVIOUS_IMAGE##*:}"
SAFETY_BACKUP_KEY=""
if [ -n "$PREVIOUS_IMAGE" ] && [ "$PREVIOUS_IMAGE" = "$APP_IMAGE" ]; then
  # Same image again (re-run): keep what the last real deploy recorded.
  SAFETY_BACKUP_KEY="$(current safety-backup)"; PREVIOUS_TAG="$(current previous-image-tag)"
fi

# Waits for a Job; prints its RESULT line. Non-zero if it failed or timed out.
job_result() { # job marker timeout
  local waited=0 c
  while [ "$waited" -lt "$3" ]; do
    c="$(kubectl get job "$1" -n "$NAMESPACE" -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type} {end}' 2>/dev/null || true)"
    case "$c" in
      *Complete*) kubectl logs "job/$1" -n "$NAMESPACE" | sed -n "s/^$2 //p" | tail -1; return 0 ;;
      *Failed*) kubectl logs "job/$1" -n "$NAMESPACE" --tail=20 >&2 || true; return 1 ;;
    esac
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

if [ "${SAFETY_BACKUP:-on}" != off ] && [ -n "$PREVIOUS_IMAGE" ] && [ "$PREVIOUS_IMAGE" != "$APP_IMAGE" ] \
   && kubectl get cronjob "$APP_NAME-scheduled-backup" -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "::step snapshot"
  job="$(printf '%s' "${APP_NAME:0:30}-predeploy-$(date -u +%Y%m%d%H%M%S)" | tr '[:upper:]' '[:lower:]')"
  echo "safety backup of $APP_NAME (live version $PREVIOUS_TAG) before releasing $IMAGE_TAG: job $job" >&2
  kubectl get cronjob "$APP_NAME-scheduled-backup" -n "$NAMESPACE" -o json | jq --arg name "$job" --arg tag "$PREVIOUS_TAG" '
    .spec.jobTemplate as $t
    | ($t.metadata.labels + {"rebound.io/trigger": "pre-deploy"}) as $labels
    | {apiVersion: "batch/v1", kind: "Job",
       metadata: {name: $name, namespace: .metadata.namespace, labels: $labels},
       spec: ($t.spec
         | .template.metadata.labels = $labels
         | .template.spec.containers[0].env |= (map(select(.name != "BACKUP_TRIGGER" and .name != "IMAGE_TAG_URL"))
             + [{name: "BACKUP_TRIGGER", value: "pre-deploy"}, {name: "IMAGE_TAG", value: $tag}]))}' \
    | kubectl apply -f - >&2
  result="$(job_result "$job" BACKUP_RESULT 900)" || {
    echo "safety backup failed: not releasing $IMAGE_TAG (the live version keeps running; SAFETY_BACKUP=off skips it)" >&2
    exit 1
  }
  SAFETY_BACKUP_KEY="$(jq -r '.s3Key // empty' <<<"$result")"
  echo "safety backup stored: $SAFETY_BACKUP_KEY" >&2
elif [ -n "$PREVIOUS_IMAGE" ] && [ "$PREVIOUS_IMAGE" != "$APP_IMAGE" ]; then
  PREVIOUS_TAG=""   # nothing to undo to: no safety backup was taken (SAFETY_BACKUP=off or no database)
fi
[ -n "$SAFETY_BACKUP_KEY" ] || PREVIOUS_TAG=""
export SAFETY_BACKUP_KEY PREVIOUS_TAG

echo "::step pull"
kubectl get secret "$APP_NAME-db" -n "$NAMESPACE" >/dev/null 2>&1 \
  || { echo "Secret $APP_NAME-db missing: run jobs/backup-restore/k8s/rebound-data.sh provision $APP_NAME" >&2; exit 1; }

echo "::step release"
envsubst '${APP_NAME} ${APP_IMAGE} ${IMAGE_TAG} ${NAMESPACE} ${ALB_GROUP} ${MIN_REPLICAS} ${MAX_REPLICAS} ${CPU_TARGET} ${APP_REPO} ${APP_DESCRIPTION} ${APP_ICON} ${SAFETY_BACKUP_KEY} ${PREVIOUS_TAG}' \
  < "$HERE/app.yaml" | kubectl apply -f -

if ! kubectl rollout status "deploy/$APP_NAME" -n "$NAMESPACE" --timeout=180s; then
  echo "rollout of $APP_IMAGE failed; rolling back to the previous image" >&2
  kubectl rollout undo "deploy/$APP_NAME" -n "$NAMESPACE"
  # rollout undo restores the pod template only: point the deploy metadata back at the version that runs.
  kubectl annotate deploy "$APP_NAME" -n "$NAMESPACE" --overwrite "rebound.io/image-tag=${PREVIOUS_IMAGE##*:}" \
    "rebound.io/safety-backup=$PRE_SAFETY" "rebound.io/previous-image-tag=$PRE_PREVIOUS" >/dev/null || true
  kubectl rollout status "deploy/$APP_NAME" -n "$NAMESPACE" --timeout=180s || true
  exit 1
fi
echo "DEPLOY_RESULT $(jq -cn --arg app "$APP_NAME" --arg image "$APP_IMAGE" --arg tag "$IMAGE_TAG" \
  --arg safety "$SAFETY_BACKUP_KEY" --arg prev "$PREVIOUS_TAG" \
  '{status: "succeeded", app: $app, image: $image, imageTag: $tag}
   + (if $safety == "" then {} else {safetyBackupKey: $safety, previousImageTag: $prev} end)')"
