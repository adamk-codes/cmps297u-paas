#!/usr/bin/env bash
# Rebound data operations on EKS: provision, backup, restore + recovery URL, isolation check.
# Runs from a workstation with kubectl (pointed at the cluster), aws CLI, jq and envsubst.
# Settings come from k8s/.env (copy .env.example); every command prints a final *_RESULT JSON line.
#
#   rebound-data.sh bootstrap                     namespace, service account, admin DB secret
#   rebound-data.sh push-image                    build + push the jobs image to ECR
#   rebound-data.sh provision <app>               own database + login; <app>-db Secret
#   rebound-data.sh backup <app>                  manual backup Job
#   rebound-data.sh schedule <app>                daily backup CronJob
#   rebound-data.sh list <app>                    backups in S3, newest last
#   rebound-data.sh restore <app> [key|latest]    new DB + recovery app at /apps/<app>-recovery, verified
#   rebound-data.sh isolation <app> <other_db>    prove <app>'s login can't open other_db
#   rebound-data.sh cleanup-recovery <app>        remove the recovery app
#   rebound-data.sh delete <app>                  remove the app, its recovery copy and database (backups kept)
#   rebound-data.sh drill <app> [key|latest]      recovery drill: restore into a temp DB, count rows, drop it
#   rebound-data.sh undo <app> <key> <image>      undo a deploy: <image> back live on the data in backup <key>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${REBOUND_ENV:-$HERE/.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && source "$ENV_FILE" && set +a

: "${NAMESPACE:=apps}" "${AWS_REGION:=us-east-1}" "${ALB_GROUP:=rebound}" "${MIN_ROWS:=100}"
: "${BACKUP_SCHEDULE:=0 2 * * *}" "${S3_KMS_KEY_ID:=}" "${SECRETS_KMS_KEY_ID:=}" "${DB_PORT:=5432}" "${DROP_AFTER_CHECK:=false}"
: "${BACKUP_TRIGGER:=manual}" "${KEEP_AS:=}"
export NAMESPACE AWS_REGION ALB_GROUP MIN_ROWS BACKUP_SCHEDULE S3_KMS_KEY_ID SECRETS_KMS_KEY_ID DROP_AFTER_CHECK
export BACKUP_TRIGGER KEEP_AS

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
need() { for v in "$@"; do [ -n "${!v:-}" ] || die "$v is not set (see k8s/.env.example)"; done; }
k() { kubectl -n "$NAMESPACE" "$@"; }

TEMPLATE_VARS='${NAMESPACE} ${JOB_NAME} ${OPERATION_ID} ${APP_NAME} ${DB_NAME} ${IMAGE_TAG} ${JOBS_IMAGE}
${APP_IMAGE} ${S3_BUCKET} ${S3_KMS_KEY_ID} ${SECRETS_KMS_KEY_ID} ${AWS_REGION} ${BACKUP_KEY} ${TARGET_DB}
${MIN_ROWS} ${OTHER_DATABASE} ${ALB_GROUP} ${BACKUP_SCHEDULE} ${DATA_JOBS_ROLE_ARN} ${DROP_AFTER_CHECK}
${BACKUP_TRIGGER} ${KEEP_AS}'
render() { envsubst "$TEMPLATE_VARS" < "$HERE/$1"; }
apply() { render "$1" | kubectl apply -f - >&2; }

new_operation() {
  OPERATION_ID="$(date -u +%Y%m%d%H%M%S)-$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  JOB_NAME="$(printf '%s' "${APP_NAME:0:30}-$1-$OPERATION_ID" | tr '[:upper:]' '[:lower:]')"
  export OPERATION_ID JOB_NAME
}

set_app() {
  APP_NAME="${1:-}"
  [[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "app name must be lowercase letters, digits and '-'"
  DB_NAME="${APP_NAME//-/_}"
  export APP_NAME DB_NAME
}

# Waits until the Job completes or fails; returns non-zero on failure or timeout.
wait_job() {
  local name="$1" timeout="${2:-900}" waited=0 conditions
  while [ "$waited" -lt "$timeout" ]; do
    conditions="$(k get job "$name" -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type} {end}' 2>/dev/null || true)"
    case "$conditions" in
      *Complete*) return 0 ;;
      *Failed*) log "job $name failed:"; k logs "job/$name" --tail=20 >&2 || true; return 1 ;;
    esac
    sleep 3; waited=$((waited + 3))
  done
  log "job $name timed out after ${timeout}s"; return 1
}

job_result() { k logs "job/$1" 2>/dev/null | sed -n "s/^$2 //p" | tail -1; }

# Replace the database name in a postgres:// URL.
url_with_db() {
  local url="$1" db="$2" rest query=""
  rest="${url#*://}"
  case "$rest" in *\?*) query="?${rest#*\?}" ;; esac
  printf '%s://%s/%s%s' "${url%%://*}" "${rest%%/*}" "$db" "$query"
}

# Secret values go through stdin as YAML: never on a command line, and works with kubectl.exe on Windows.
put_secret() { # name key value
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\n  labels: {app.kubernetes.io/part-of: rebound}\ntype: Opaque\ndata:\n  %s: %s\n' \
    "$1" "$NAMESPACE" "$2" "$(printf '%s' "$3" | base64 | tr -d '\n')" | kubectl apply -f - >&2
}

secret_value() { k get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }

cmd_bootstrap() {
  need DATA_JOBS_ROLE_ARN RDS_MASTER_SECRET_ID RDS_HOST
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >&2
  apply serviceaccount.yaml
  local s user pw
  s="$(aws secretsmanager get-secret-value --secret-id "$RDS_MASTER_SECRET_ID" --query SecretString --output text)"
  user="$(jq -r .username <<<"$s")"; pw="$(jq -r '.password | @uri' <<<"$s")"
  put_secret rebound-db-admin ADMIN_DATABASE_URL \
    "$(printf 'postgres://%s:%s@%s:%s/postgres?sslmode=require' "$user" "$pw" "$RDS_HOST" "$DB_PORT")"
  log "namespace $NAMESPACE, service account rebound-data-jobs and secret rebound-db-admin are ready"
  echo "BOOTSTRAP_RESULT {\"status\":\"succeeded\",\"namespace\":\"$NAMESPACE\"}"
}

cmd_push_image() {
  need ECR_REGISTRY
  local tag="${1:-$(git -C "$HERE" rev-parse --short HEAD)}" repo="$ECR_REGISTRY/rebound/backup-restore"
  aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY" >&2
  docker build ${PG_MAJOR:+--build-arg PG_MAJOR="$PG_MAJOR"} -t "$repo:$tag" "$HERE/.." >&2
  docker push "$repo:$tag" >&2
  log "set JOBS_IMAGE=$repo:$tag in $ENV_FILE"
  echo "PUSH_RESULT {\"status\":\"succeeded\",\"image\":\"$repo:$tag\"}"
}

cmd_provision() {
  set_app "${1:-}"; need JOBS_IMAGE
  new_operation provision
  apply provision-job.yaml
  wait_job "$JOB_NAME" 300 || die "provision failed"
  local url
  url="$(aws secretsmanager get-secret-value --secret-id "rebound/apps/$APP_NAME/db" \
    --query SecretString --output text | jq -r .DATABASE_URL)"
  put_secret "$APP_NAME-db" DATABASE_URL "$url"
  log "database $DB_NAME ready; Secret $APP_NAME-db holds DATABASE_URL (use it in the app's Deployment)"
  echo "PROVISION_RESULT $(job_result "$JOB_NAME" PROVISION_RESULT)"
}

cmd_backup() {
  set_app "${1:-}"; need JOBS_IMAGE S3_BUCKET
  if [ -z "${IMAGE_TAG:-}" ]; then
    IMAGE_TAG="$(k get deploy "$APP_NAME" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | sed -n 's/.*:\([^:/]*\)$/\1/p')"
  fi
  export IMAGE_TAG="${IMAGE_TAG:-unknown}"
  new_operation backup
  log "::step dump"
  log "operation $OPERATION_ID: backing up $APP_NAME (image $IMAGE_TAG)"
  apply backup-job.yaml
  wait_job "$JOB_NAME" 900 || die "backup failed"
  echo "BACKUP_RESULT $(job_result "$JOB_NAME" BACKUP_RESULT | jq -c --arg op "$OPERATION_ID" '. + {operationId: $op, trigger: env.BACKUP_TRIGGER}')"
}

cmd_schedule() {
  set_app "${1:-}"; need JOBS_IMAGE S3_BUCKET
  apply backup-cronjob.yaml
  echo "SCHEDULE_RESULT {\"status\":\"succeeded\",\"app\":\"$APP_NAME\",\"schedule\":\"$BACKUP_SCHEDULE\"}"
}

cmd_list() {
  set_app "${1:-}"; need S3_BUCKET
  aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "backups/$APP_NAME/" \
    --query 'sort_by(Contents, &LastModified)[].[LastModified, Size, Key]' --output text
}

cmd_restore() {
  set_app "${1:-}"; need JOBS_IMAGE S3_BUCKET
  local key="${2:-latest}" started active result image_tag app_url records stats served url total table_rows
  started=$(date +%s)

  # One restore at a time, across all apps in the namespace.
  active="$(k get jobs -l rebound.io/kind=restore -o jsonpath='{range .items[*]}{.status.active}{end}')"
  [ -z "${active//0/}" ] || die "a restore is already running; restores run one at a time"

  if [ "$key" = latest ]; then
    key="$(aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "backups/$APP_NAME/" \
      --query 'sort_by(Contents, &LastModified)[-1].Key' --output text)"
    [ -n "$key" ] && [ "$key" != None ] || die "no backups for $APP_NAME"
  fi
  export BACKUP_KEY="$key"
  export TARGET_DB="${DB_NAME:0:40}_restore_$(date -u +%Y%m%d%H%M%S)"
  new_operation restore
  log "::step restore"
  log "operation $OPERATION_ID: restoring $BACKUP_KEY into $TARGET_DB"
  apply restore-job.yaml
  wait_job "$JOB_NAME" 1200 || die "restore failed (live database untouched)"
  result="$(job_result "$JOB_NAME" RESTORE_RESULT)"
  records="$(jq -r .recordsChecked <<<"$result")"
  image_tag="$(jq -r '.imageTag // empty' <<<"$result")"

  # Recovery app: the image recorded with the backup, on the restored database.
  app_url="$(secret_value "$APP_NAME-db" DATABASE_URL)" || die "Secret $APP_NAME-db not found"
  put_secret "$APP_NAME-recovery-db" DATABASE_URL "$(url_with_db "$app_url" "$TARGET_DB")"
  if [ -n "$image_tag" ] && [ "$image_tag" != unknown ] && [ -n "${ECR_REGISTRY:-}" ]; then
    APP_IMAGE="${APP_IMAGE_REPO:-$ECR_REGISTRY/$APP_NAME}:$image_tag"
  else
    APP_IMAGE="$(k get deploy "$APP_NAME" -o jsonpath='{.spec.template.spec.containers[0].image}')"
    log "backup has no usable image tag; using the live image $APP_IMAGE"
  fi
  export APP_IMAGE
  log "::step run"
  log "starting recovery app ($APP_IMAGE) at /apps/$APP_NAME-recovery"
  apply recovery-app.yaml
  k rollout status "deploy/$APP_NAME-recovery" --timeout=300s >&2 || die "recovery app did not become ready"

  log "::step check"
  # Check through the running recovery app, not just the database. Every app must answer /healthz
  # (it returns 200 only when its database works). Apps that also report a record count in
  # /api/stats (notes-app: {"notes": N}) must serve exactly what the restore counted in that table.
  k exec "deploy/$APP_NAME-recovery" -- wget -qO- "http://127.0.0.1:3000/apps/$APP_NAME-recovery/healthz" >/dev/null \
    || die "recovery app is running but its /healthz fails"
  stats="$(k exec "deploy/$APP_NAME-recovery" -- wget -qO- "http://127.0.0.1:3000/apps/$APP_NAME-recovery/api/stats" 2>/dev/null || true)"
  served="$(jq -r '.notes // empty' <<<"$stats" 2>/dev/null || true)"
  table_rows="$(jq -r '.verifyTableRows // empty' <<<"$result")"
  if [ -n "$served" ] && [ -n "$table_rows" ]; then
    [ "$served" = "$table_rows" ] || die "recovery app serves $served records, the restore counted $table_rows"
  else
    served="$records"   # no record count to compare: healthy + every table's rows verified by the restore
  fi

  url="${ALB_URL:-}"
  if [ -z "$url" ]; then
    url="http://$(k get ingress "$APP_NAME-recovery" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)"
  fi
  total=$(( $(date +%s) - started ))
  log "RECOVERY VERIFIED: $served rows served by the recovery app, ${total}s end to end"
  echo "RECOVERY_RESULT $(jq -c --arg op "$OPERATION_ID" --arg url "${url%/}/apps/$APP_NAME-recovery/" \
    --arg image "$APP_IMAGE" --argjson total "$total" --argjson served "$served" \
    '{operationId: $op, status: "succeeded", backupKey, targetDatabase, recoveryUrl: $url, image: $image,
      recordsChecked, expectedRecords, recordsServed: $served, restoreSeconds: .durationSeconds,
      durationSeconds: $total}' <<<"$result")"
}

cmd_isolation() {
  set_app "${1:-}"; need JOBS_IMAGE
  export OTHER_DATABASE="${2:?usage: isolation <app> <other_database>}"
  new_operation isolation
  apply isolation-job.yaml
  wait_job "$JOB_NAME" 120 || true
  local r; r="$(job_result "$JOB_NAME" ISOLATION_RESULT)"
  echo "ISOLATION_RESULT $r"
  [ "$(jq -r .status <<<"$r")" = succeeded ]
}

cmd_cleanup_recovery() {
  set_app "${1:-}"
  k delete deploy,svc,ingress -l "rebound.io/kind=recovery,rebound.io/app=$APP_NAME" --ignore-not-found >&2
  k delete secret "$APP_NAME-recovery-db" --ignore-not-found >&2
  log "recovery app removed (restored databases are kept; drop them with psql if not needed)"
}

# Recovery drill (run nightly by the API, or from the dashboard): prove the backup restores, without a
# recovery app and without keeping anything. Restore into a NEW temporary database, count the rows
# against the backup's own count, then drop it. The live database is never touched.
cmd_drill() {
  set_app "${1:-}"; need JOBS_IMAGE S3_BUCKET
  local key="${2:-latest}" active result
  active="$(k get jobs -l rebound.io/kind=restore -o jsonpath='{range .items[*]}{.status.active}{end}')"
  [ -z "${active//0/}" ] || die "a restore is already running; restores run one at a time"
  if [ "$key" = latest ]; then
    key="$(aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "backups/$APP_NAME/" \
      --query 'sort_by(Contents, &LastModified)[-1].Key' --output text)"
    [ -n "$key" ] && [ "$key" != None ] || die "no backups for $APP_NAME"
  fi
  export BACKUP_KEY="$key" DROP_AFTER_CHECK=true
  export TARGET_DB="${DB_NAME:0:40}_restore_$(date -u +%Y%m%d%H%M%S)"
  new_operation restore
  log "::step restore"
  log "drill $OPERATION_ID: restoring $BACKUP_KEY into temporary database $TARGET_DB"
  apply restore-job.yaml
  wait_job "$JOB_NAME" 1200 || true
  result="$(job_result "$JOB_NAME" RESTORE_RESULT)"
  [ -n "$result" ] || die "drill failed: the backup did not restore cleanly (live database untouched)"
  log "::step check"
  [ "$(jq -r .status <<<"$result")" = succeeded ] || die "drill failed: $(jq -r '.reason // "row count check failed"' <<<"$result")"
  log "::step cleanup"
  [ "$(jq -r .dropped <<<"$result")" = true ] || log "WARNING: temporary database $TARGET_DB was not dropped"
  log "DRILL PASSED: $(jq -r .recordsChecked <<<"$result") of $(jq -r '.expectedRecords // "?"' <<<"$result") rows restored from $BACKUP_KEY"
  echo "DRILL_RESULT $(jq -c --arg op "$OPERATION_ID" '. + {operationId: $op}' <<<"$result")"
}

# Delete an app: everything in the cluster, then its database + login (deprovision Job). S3 backups stay.
cmd_delete() {
  set_app "${1:-}"; need JOBS_IMAGE
  case "$APP_NAME" in rebound*|*-recovery) die "refusing to delete platform or recovery app $APP_NAME" ;; esac
  log "::step stop"
  k delete cronjob "$APP_NAME-scheduled-backup" --ignore-not-found >&2
  k delete deploy,svc,ingress -l "rebound.io/kind=recovery,rebound.io/app=$APP_NAME" --ignore-not-found >&2
  k delete hpa "$APP_NAME" --ignore-not-found >&2   # the HPA has no rebound.io/kind label
  k delete deploy,svc,ingress -l "rebound.io/kind=app,rebound.io/app=$APP_NAME" --ignore-not-found >&2
  k delete secret "$APP_NAME-recovery-db" --ignore-not-found >&2
  log "::step database"
  new_operation deprovision
  apply deprovision-job.yaml
  wait_job "$JOB_NAME" 300 || die "dropping the database failed"
  k delete secret "$APP_NAME-db" --ignore-not-found >&2
  local r; r="$(job_result "$JOB_NAME" DEPROVISION_RESULT)"; [ -n "$r" ] || r='{"status":"succeeded"}'
  log "$APP_NAME deleted (backups in S3 are kept)"
  echo "DELETE_RESULT $(jq -c --arg op "$OPERATION_ID" --arg app "$APP_NAME" '. + {operationId: $op, app: $app}' <<<"$r")"
}

# Undo a deploy: the previous image back live, on the data from the safety backup taken just before
# that deploy (deploy-app.sh). Nothing is deleted on the way:
#   1 restore  the safety backup into a NEW database, verified like any restore (app still live)
#   2 save     stop the app, back up the data as it is now ("before undo": what users did since the deploy)
#   3 switch   rename the live database aside (<db>_undo_<ts>, kept), the restored copy takes its name,
#              release <image> (no new safety backup) and start the app again
#   4 check    rollout healthy and /healthz answers
# If anything fails before the switch, the app is started again on its untouched database.
cmd_undo() {
  set_app "${1:-}"; need JOBS_IMAGE S3_BUCKET
  local key="${2:?usage: undo <app> <backup-key> <image>}" image="${3:?usage: undo <app> <backup-key> <image>}"
  local started active result replicas current_tag saved_key keep stopped_at downtime total records deploy_script
  started=$(date +%s)
  deploy_script="${DEPLOY_SCRIPT:-$HERE/../../../deploy/deploy-app.sh}"
  [ -f "$deploy_script" ] || die "deploy script not found at $deploy_script (set DEPLOY_SCRIPT)"
  case "$key" in "backups/$APP_NAME/"*.dump) ;; *) die "$key is not a backup of $APP_NAME" ;; esac
  k get deploy "$APP_NAME" >/dev/null || die "app $APP_NAME is not deployed"
  active="$(k get jobs -l rebound.io/kind=restore -o jsonpath='{range .items[*]}{.status.active}{end}')"
  [ -z "${active//0/}" ] || die "a restore is already running; restores run one at a time"

  log "::step restore"
  export BACKUP_KEY="$key" DROP_AFTER_CHECK=false
  export TARGET_DB="${DB_NAME:0:40}_restore_$(date -u +%Y%m%d%H%M%S)"
  new_operation restore
  local undo_id="$OPERATION_ID"
  log "undo $OPERATION_ID: restoring $BACKUP_KEY into $TARGET_DB (the live app keeps running)"
  apply restore-job.yaml
  wait_job "$JOB_NAME" 1200 || die "restoring the safety backup failed (nothing was changed)"
  result="$(job_result "$JOB_NAME" RESTORE_RESULT)"
  [ "$(jq -r .status <<<"$result")" = succeeded ] || die "the safety backup did not verify (nothing was changed)"
  records="$(jq -r .recordsChecked <<<"$result")"

  log "::step save"
  replicas="$(k get deploy "$APP_NAME" -o jsonpath='{.spec.replicas}')"; [ "${replicas:-0}" -gt 0 ] || replicas=1
  current_tag="$(k get deploy "$APP_NAME" -o jsonpath='{.spec.template.spec.containers[0].image}' | sed -n 's/.*:\([^:/]*\)$/\1/p')"
  restart() { log "starting $APP_NAME again on its own database"; k scale deploy "$APP_NAME" --replicas="$replicas" >&2 || true; }
  log "stopping $APP_NAME so nothing changes while its data is saved and switched"
  k scale deploy "$APP_NAME" --replicas=0 >&2
  stopped_at=$(date +%s)
  k wait --for=delete pod -l "app.kubernetes.io/name=$APP_NAME" --timeout=120s >&2 || true
  export IMAGE_TAG="${current_tag:-unknown}" BACKUP_TRIGGER=pre-undo
  new_operation backup
  apply backup-job.yaml
  if ! wait_job "$JOB_NAME" 900; then restart; die "could not save the current data first (nothing was changed)"; fi
  saved_key="$(job_result "$JOB_NAME" BACKUP_RESULT | jq -r .s3Key)"
  log "current data saved as $saved_key"

  log "::step switch"
  export KEEP_AS="${DB_NAME:0:40}_undo_$(date -u +%Y%m%d%H%M%S)"
  keep="$KEEP_AS"
  new_operation swap
  apply swap-job.yaml
  if ! wait_job "$JOB_NAME" 120; then restart; die "switching databases failed (live database unchanged)"; fi
  # Release the previous image while stopped; SAFETY_BACKUP=off: the "before undo" backup was just taken.
  SAFETY_BACKUP=off "$deploy_script" "$APP_NAME" "$image" >&2 \
    || { restart; die "releasing $image failed (data switched; previous data kept in $keep)"; }
  k scale deploy "$APP_NAME" --replicas="$replicas" >&2

  log "::step check"
  k rollout status "deploy/$APP_NAME" --timeout=300s >&2 || die "$APP_NAME did not become ready on the restored data"
  downtime=$(( $(date +%s) - stopped_at ))
  k exec "deploy/$APP_NAME" -- wget -qO- "http://127.0.0.1:3000/apps/$APP_NAME/healthz" >/dev/null \
    || die "$APP_NAME is running but its /healthz fails"
  total=$(( $(date +%s) - started ))
  log "UNDO DONE: $image is live on the data from $key; previous data kept in $keep and $saved_key"
  echo "UNDO_RESULT $(jq -cn --arg op "$undo_id" --arg app "$APP_NAME" --arg image "$image" --arg key "$key" \
    --arg saved "$saved_key" --arg kept "$keep" --argjson records "$records" --argjson down "$downtime" \
    --argjson total "$total" \
    '{operationId: $op, status: "succeeded", app: $app, image: $image, imageTag: ($image | split(":") | last),
      restoredFrom: $key, recordsRestored: $records, beforeUndoBackupKey: $saved, keptDatabase: $kept,
      downtimeSeconds: $down, durationSeconds: $total}')"
}

case "${1:-help}" in
  bootstrap) shift; cmd_bootstrap "$@" ;;
  push-image) shift; cmd_push_image "$@" ;;
  provision) shift; cmd_provision "$@" ;;
  backup) shift; cmd_backup "$@" ;;
  schedule) shift; cmd_schedule "$@" ;;
  list) shift; cmd_list "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  isolation) shift; cmd_isolation "$@" ;;
  cleanup-recovery) shift; cmd_cleanup_recovery "$@" ;;
  delete) shift; cmd_delete "$@" ;;
  drill) shift; cmd_drill "$@" ;;
  undo) shift; cmd_undo "$@" ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
