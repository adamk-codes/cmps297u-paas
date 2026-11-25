#!/usr/bin/env bash
# Load test an app and record how its HorizontalPodAutoscaler reacts: the scalability evidence for the report.
#
#   loadtest/run.sh [options]
#     --app NAME           app to test (default notes-app)
#     --vus N              virtual users at peak (default 40); each sends requests back to back
#     --ramp D --hold D    ramp-up and hold durations for k6 (default 30s, 3m)
#     --baseline Ns        low-load phase before the ramp, in seconds (default 30s)
#     --public             go through CloudFront + the ALB ($ALB_URL) instead of the in-cluster Service
#     --scale-down         after the test, keep watching until the HPA is back at its minimum (up to 8 min)
#     --local URL          no cluster: run k6 in Docker against URL (e.g. http://host.docker.internal:3000/apps/notes-app)
#
# Cluster mode needs kubectl pointed at the cluster (infra/scripts/up.sh does that) and reads
# jobs/backup-restore/k8s/.env for NAMESPACE / ALB_URL. Results go to loadtest/results/<UTC time>/:
#   k6.log      k6 output (human summary + K6_RESULT line)
#   hpa.csv     every SAMPLE_SECONDS (5): seconds since start, HPA current/desired replicas, ready pods, average CPU % of request
#   result.json the LOADTEST_RESULT line (k6 numbers + scaling numbers), also printed last
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENV_FILE="${REBOUND_ENV:-$ROOT/jobs/backup-restore/k8s/.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && source "$ENV_FILE" && set +a

APP_NAME=notes-app VUS=40 RAMP=30s HOLD=3m BASELINE=30s PUBLIC="" SCALE_DOWN="" LOCAL_URL=""
K6_IMAGE="${K6_IMAGE:-grafana/k6:1.8.2}"
SAMPLE_SECONDS="${SAMPLE_SECONDS:-5}"   # how often the HPA is sampled
: "${NAMESPACE:=apps}"
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP_NAME="$2"; shift ;;
    --vus) VUS="$2"; shift ;;
    --ramp) RAMP="$2"; shift ;;
    --hold) HOLD="$2"; shift ;;
    --baseline) BASELINE="$2"; shift ;;
    --public) PUBLIC=1 ;;
    --scale-down) SCALE_DOWN=1 ;;
    --local) LOCAL_URL="$2"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || { echo "invalid app name" >&2; exit 1; }
[[ "$VUS" =~ ^[0-9]+$ ]] || { echo "--vus must be a number" >&2; exit 1; }
[[ "$BASELINE" =~ ^[0-9]+s$ ]] || { echo "--baseline must look like 30s" >&2; exit 1; }

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
OUT="$HERE/results/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

# Pull the single-line JSON after a marker (e.g. K6_RESULT) out of a log file.
result_line() { sed -n "s/^.*$1 \([{].*[}]\)[[:space:]]*\$/\1/p" "$2" | tr -d '\r' | tail -n 1; }

if [ -n "$LOCAL_URL" ]; then
  log "k6 in Docker against $LOCAL_URL ($VUS VUs, ramp $RAMP, hold $HOLD)"
  docker run --rm -i -e TARGET_URL="$LOCAL_URL" -e VUS="$VUS" -e RAMP="$RAMP" -e HOLD="$HOLD" \
    -e BASELINE="$BASELINE" -e K6_NO_USAGE_REPORT=true "$K6_IMAGE" run --quiet - <"$HERE/script.js" \
    | tee "$OUT/k6.log" || log "k6 exited non-zero (threshold crossed?): see $OUT/k6.log"
  K6="$(result_line K6_RESULT "$OUT/k6.log")"
  [ -n "$K6" ] || { echo "no K6_RESULT in $OUT/k6.log" >&2; exit 1; }
  printf '%s\n' "${K6%\}},\"mode\":\"local\"}" >"$OUT/result.json"
  echo "LOADTEST_RESULT $(cat "$OUT/result.json")"
  exit 0
fi

# ---- cluster mode ----
k() { kubectl -n "$NAMESPACE" "$@"; }
k get hpa "$APP_NAME" >/dev/null || { echo "no HPA $APP_NAME in namespace $NAMESPACE (deploy the app first)" >&2; exit 1; }
if [ -n "$PUBLIC" ]; then
  : "${ALB_URL:?ALB_URL not set (run infra/scripts/up.sh, or export it)}"
  TARGET_URL="${ALB_URL%/}/apps/$APP_NAME"
else
  TARGET_URL="http://$APP_NAME.$NAMESPACE.svc.cluster.local/apps/$APP_NAME"
fi
MIN_REPLICAS="$(k get hpa "$APP_NAME" -o jsonpath='{.spec.minReplicas}')"
MAX_REPLICAS="$(k get hpa "$APP_NAME" -o jsonpath='{.spec.maxReplicas}')"
CPU_TARGET="$(k get hpa "$APP_NAME" -o jsonpath='{.spec.metrics[0].resource.target.averageUtilization}')"

JOB_NAME="loadtest-$APP_NAME-$(date -u +%H%M%S)"
JOB_NAME="${JOB_NAME:0:63}"
export JOB_NAME NAMESPACE APP_NAME TARGET_URL VUS RAMP HOLD BASELINE K6_IMAGE
log "HPA $APP_NAME: min $MIN_REPLICAS, max $MAX_REPLICAS, target ${CPU_TARGET}% CPU; now $(k get deploy "$APP_NAME" -o jsonpath='{.status.readyReplicas}') ready"
log "Job $JOB_NAME: $VUS VUs against $TARGET_URL (baseline $BASELINE, ramp $RAMP, hold $HOLD)"

k create configmap "$JOB_NAME" --from-file=script.js="$HERE/script.js" >/dev/null
envsubst '${JOB_NAME} ${NAMESPACE} ${APP_NAME} ${TARGET_URL} ${VUS} ${RAMP} ${HOLD} ${BASELINE} ${K6_IMAGE}' \
  <"$HERE/k8s/k6-job.yaml" | kubectl apply -f - >/dev/null
cleanup() { k delete configmap "$JOB_NAME" --ignore-not-found >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "seconds,current_replicas,desired_replicas,ready_pods,cpu_percent" >"$OUT/hpa.csv"
sample() { # one CSV row; CPU is "" until metrics-server has a value
  local h ready
  h="$(k get hpa "$APP_NAME" -o jsonpath='{.status.currentReplicas},{.status.desiredReplicas},{.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null || echo ',,')"
  ready="$(k get deploy "$APP_NAME" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
  IFS=, read -r cur des cpu <<<"$h"
  echo "$(( $(date +%s) - START )),${cur:-},${des:-},${ready:-0},${cpu:-}" >>"$OUT/hpa.csv"
  printf '\r  t=%4ss  replicas %s→%s  ready %s  cpu %s%%   ' "$(( $(date +%s) - START ))" "${cur:-?}" "${des:-?}" "${ready:-0}" "${cpu:-?}" >&2
}

START=$(date +%s)
STATUS=running
while :; do
  sample
  s="$(k get job "$JOB_NAME" -o jsonpath='{.status.succeeded}/{.status.failed}' 2>/dev/null || echo /)"
  case "$s" in 1/*) STATUS=succeeded; break ;; */1) STATUS=failed; break ;; esac
  [ $(( $(date +%s) - START )) -lt 1800 ] || { STATUS=timeout; break; }
  sleep "$SAMPLE_SECONDS"
done
TEST_END=$(( $(date +%s) - START ))
echo >&2
log "k6 Job $STATUS after ${TEST_END}s"
k logs "job/$JOB_NAME" >"$OUT/k6.log" 2>&1 || true
grep -v '^K6_RESULT' "$OUT/k6.log" | sed '/^[[:space:]]*$/d' | tail -n 8 >&2 || true

if [ -n "$SCALE_DOWN" ]; then
  log "watching scale-down (the HPA waits 120 s of low CPU before removing pods)"
  until [ "$(k get hpa "$APP_NAME" -o jsonpath='{.status.currentReplicas}')" -le "$MIN_REPLICAS" ] \
    || [ $(( $(date +%s) - START - TEST_END )) -ge 480 ]; do
    sample; sleep "$SAMPLE_SECONDS"
  done
  sample; echo >&2
fi

# Scaling numbers from the timeline (awk, so no jq needed).
SCALING="$(awk -F, -v base="${BASELINE%s}" -v end="$TEST_END" '
  NR == 1 { next }
  NR == 2 { start = $2 + 0 }
  { cur = $2 + 0; des = $3 + 0; ready = $4 + 0; cpu = $5
    if (cpu != "" && cpu + 0 > peakcpu) peakcpu = cpu + 0
    if (ready > maxready) { maxready = ready; tmax = $1 }
    if (firstup == "" && des > start) firstup = $1
    if ($1 > end && ready <= start && downat == "" && maxready > start) downat = $1 }
  END {
    fu = (firstup == "" ? "null" : firstup - base); tm = (maxready > start ? tmax - base : "null")
    dn = (downat == "" ? "null" : downat - end)
    printf "\"startReplicas\":%d,\"maxReadyPods\":%d,\"peakCpuPercent\":%d,", start, maxready, peakcpu
    printf "\"secondsToFirstScaleUp\":%s,\"secondsToMaxPods\":%s,\"secondsToScaleDownAfterTest\":%s", fu, tm, dn
  }' "$OUT/hpa.csv")"

K6="$(result_line K6_RESULT "$OUT/k6.log")"
[ -n "$K6" ] || K6='{"k6":"no result, see k6.log"}'
printf '%s\n' "${K6%\}},\"mode\":\"cluster\",\"job\":\"$JOB_NAME\",\"status\":\"$STATUS\",\"minReplicas\":$MIN_REPLICAS,\"maxReplicas\":$MAX_REPLICAS,\"cpuTargetPercent\":$CPU_TARGET,$SCALING}" >"$OUT/result.json"

log "results in ${OUT#"$ROOT"/}  (timings count from the start of the load phase, after the ${BASELINE} baseline)"
echo "LOADTEST_RESULT $(cat "$OUT/result.json")"
[ "$STATUS" = succeeded ]
