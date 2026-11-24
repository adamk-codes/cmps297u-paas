#!/usr/bin/env bash
# pg_dump the app database and upload it to S3 as
#   s3://$S3_BUCKET/$S3_PREFIX/<APP_NAME>/<timestamp>-<IMAGE_TAG>.dump
# The image tag and the row count at backup time are also stored as S3 object metadata,
# so a restore can redeploy the matching image and verify that every row came back.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_env DATABASE_URL APP_NAME S3_BUCKET
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
trap 'rm -f "$dump"' EXIT

STEP=dump
log "dumping database for $APP_NAME (image $IMAGE_TAG)"
database="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc 'SELECT current_database()')"
rows="$(count_rows "$DATABASE_URL" "$VERIFY_TABLE" 2>/dev/null || echo "")"
# Custom format (-Fc): compressed, and pg_restore can restore it into any database.
# No owners/ACLs, so it restores cleanly under a different login.
pg_dump --format=custom --no-owner --no-acl --dbname="$DATABASE_URL" --file="$dump"
size=$(stat -c %s "$dump")
log "dump of '$database' is $size bytes${rows:+, $VERIFY_TABLE has $rows rows}"

STEP=store
log "uploading to s3://$S3_BUCKET/$key"
metadata="app=${APP_NAME},image-tag=${safe_tag},database=${database},verify-table=${VERIFY_TABLE}"
[ -n "$rows" ] && metadata="${metadata},row-count=${rows}"
mapfile -t sse < <(sse_args)
s3 s3 cp "$dump" "s3://$S3_BUCKET/$key" --only-show-errors --metadata "$metadata" "${sse[@]}"

duration=$(( $(date +%s) - started ))
log "backup finished in ${duration}s"
emit_result BACKUP_RESULT "$(jq -cn \
  --arg app "$APP_NAME" --arg key "$key" --arg bucket "$S3_BUCKET" --arg tag "$IMAGE_TAG" \
  --arg database "$database" --arg createdAt "$(date -u -d "@$started" +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson size "$size" --argjson duration "$duration" --arg rows "$rows" \
  '{status: "succeeded", app: $app, bucket: $bucket, s3Key: $key, imageTag: $tag, database: $database,
    sizeBytes: $size, rowCount: ($rows | if . == "" then null else tonumber end),
    createdAt: $createdAt, durationSeconds: $duration}')"
