#!/usr/bin/env bash
# pg_dump the app database and upload it to S3 as
#   s3://$S3_BUCKET/$S3_PREFIX/<APP_NAME>/<timestamp>-<IMAGE_TAG>.dump
# The image tag and the row counts at backup time are also stored as S3 object metadata, so a restore
# can redeploy the matching image and verify that every row came back. Counts cover EVERY table (works
# for any app); VERIFY_TABLE (default notes) is an extra per-table count used by notes-app's recovery check.
# Content check: databases up to CONTENT_CHECK_MAX_BYTES (default 1 GB, 0 = never) also get a fingerprint of
# every value in every row, so a restore proves the data itself came back, not just the number of rows.
# Larger databases skip it (one more full read) and say so. Counts, fingerprint and pg_dump all read the same
# exported snapshot, so writes while the backup runs can't make them disagree.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_env DATABASE_URL APP_NAME S3_BUCKET
# Scheduled backups don't know which image is live, so ask the running app: its /healthz reports
# imageTag (IMAGE_TAG_URL, e.g. http://notes-app.apps.svc.cluster.local/apps/notes-app/healthz).
if [ -z "${IMAGE_TAG:-}" ] && [ -n "${IMAGE_TAG_URL:-}" ]; then
  IMAGE_TAG="$(wget -qO- -T 5 "$IMAGE_TAG_URL" 2>/dev/null | jq -r '.imageTag // empty' 2>/dev/null || true)"
  [ -n "$IMAGE_TAG" ] && log "running app reports image $IMAGE_TAG" || log "could not read image tag from $IMAGE_TAG_URL"
fi
IMAGE_TAG="${IMAGE_TAG:-unknown}"
S3_PREFIX="${S3_PREFIX:-backups}"
VERIFY_TABLE="${VERIFY_TABLE:-notes}"

[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "APP_NAME must be lowercase letters, digits and '-'"
valid_table "$VERIFY_TABLE" || die "VERIFY_TABLE is not a valid table name"
# Image tags may contain characters that are awkward in keys (e.g. '/', ':').
safe_tag="$(printf '%s' "$IMAGE_TAG" | tr -c 'A-Za-z0-9._-' '-')"

started=$(date +%s)
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
key="${S3_PREFIX}/${APP_NAME}/${timestamp}-${safe_tag}.dump"
dump="$(mktemp /tmp/backup.XXXXXX.dump)"
close_snapshot() { # end the snapshot session: COMMIT, then end its input so psql exits
  if [ -n "${SNAP_PID:-}" ]; then
    { echo "COMMIT;" >&"${SNAP[1]}"; } 2>/dev/null || true
    local fd="${SNAP[1]:-}"; [ -z "$fd" ] || exec {fd}>&-
    wait "$SNAP_PID" 2>/dev/null || true
    SNAP_PID=""
  fi
}
trap 'close_snapshot; rm -f "$dump"' EXIT

STEP=dump
log "dumping database for $APP_NAME (image $IMAGE_TAG)"
database="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc 'SELECT current_database()')"
db_bytes="$(database_bytes "$DATABASE_URL")"

# One moment in time for everything below: a session holds a snapshot open until the dump is done.
coproc SNAP { psql "$DATABASE_URL" -qtAX -v ON_ERROR_STOP=1; }
SNAP_PID=$!
echo "BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT pg_export_snapshot();" >&"${SNAP[1]}"
read -t 30 -r SNAPSHOT <&"${SNAP[0]}" && [ -n "$SNAPSHOT" ] || die "could not open a consistent snapshot"
export SNAPSHOT

rows="$(count_rows "$DATABASE_URL" "$VERIFY_TABLE" 2>/dev/null || echo "")"
read -r table_count total_rows < <(count_all_rows "$DATABASE_URL")
max_bytes="${CONTENT_CHECK_MAX_BYTES:-1073741824}"
content_hash=""
content_note=""
if [ "$max_bytes" -gt 0 ] && [ "$db_bytes" -le "$max_bytes" ]; then
  fp_started=$(date +%s%N)
  content_hash="$(content_fingerprint "$DATABASE_URL")"
  log "content fingerprint $content_hash ($(( ($(date +%s%N) - fp_started) / 1000000 )) ms)"
else
  content_note="content check skipped: database is $(( db_bytes / 1048576 )) MB, over the $(( max_bytes / 1048576 )) MB limit"
  log "$content_note; the restore check will compare table and row counts only"
fi
# Custom format (-Fc): compressed, and pg_restore can restore it into any database.
# No owners/ACLs, so it restores cleanly under a different login.
pg_dump --format=custom --no-owner --no-acl --snapshot="$SNAPSHOT" --dbname="$DATABASE_URL" --file="$dump"
close_snapshot
size=$(stat -c %s "$dump")
log "dump of '$database' is $size bytes: $table_count tables, $total_rows rows${rows:+ ($VERIFY_TABLE has $rows)}"

STEP=store
log "uploading to s3://$S3_BUCKET/$key"
metadata="app=${APP_NAME},image-tag=${safe_tag},database=${database},verify-table=${VERIFY_TABLE},trigger=${BACKUP_TRIGGER:-manual}"
metadata="${metadata},table-count=${table_count},total-rows=${total_rows}"
[ -n "$rows" ] && metadata="${metadata},row-count=${rows}"
[ -n "$content_hash" ] && metadata="${metadata},content-hash=${content_hash}"
[ -z "$content_hash" ] && metadata="${metadata},content-check=skipped-size"
mapfile -t sse < <(sse_args)
s3 s3 cp "$dump" "s3://$S3_BUCKET/$key" --only-show-errors --metadata "$metadata" "${sse[@]}"

duration=$(( $(date +%s) - started ))
log "backup finished in ${duration}s"
emit_result BACKUP_RESULT "$(jq -cn \
  --arg app "$APP_NAME" --arg key "$key" --arg bucket "$S3_BUCKET" --arg tag "$IMAGE_TAG" \
  --arg database "$database" --arg createdAt "$(date -u -d "@$started" +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson size "$size" --argjson duration "$duration" --argjson total "$total_rows" --argjson tables "$table_count" \
  --arg hash "$content_hash" --arg note "$content_note" \
  '{status: "succeeded", app: $app, bucket: $bucket, s3Key: $key, imageTag: $tag, database: $database,
    sizeBytes: $size, rowCount: $total, tableCount: $tables,
    createdAt: $createdAt, durationSeconds: $duration, contentChecked: ($hash != "")}
   + (if $note == "" then {} else {contentNote: $note} end)')"
