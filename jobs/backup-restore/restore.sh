#!/usr/bin/env bash
# Download a backup from S3, create a NEW database, pg_restore into it, and verify the row count.
# Never touches the live database: the target must not exist yet.
# Content: when the backup carries a content fingerprint (backup.sh, databases up to 1 GB), the restored copy
# must produce exactly the same one, so every value in every row is proven, not just the number of rows.
# DROP_AFTER_CHECK=true (the nightly recovery drill) drops the new database again once it has been counted.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_env ADMIN_DATABASE_URL S3_BUCKET BACKUP_KEY
MIN_ROWS="${MIN_ROWS:-100}"

started=$(date +%s)
dump="$(mktemp /tmp/restore.XXXXXX.dump)"
trap 'rm -f "$dump"' EXIT

STEP=download
log "reading s3://$S3_BUCKET/$BACKUP_KEY"
meta="$(s3 s3api head-object --bucket "$S3_BUCKET" --key "$BACKUP_KEY" --query Metadata --output json)" \
  || die "backup s3://$S3_BUCKET/$BACKUP_KEY not found"
expected_rows="$(jq -r '."row-count" // empty' <<<"$meta")"           # VERIFY_TABLE only (notes-app)
expected_total="$(jq -r '."total-rows" // empty' <<<"$meta")"         # every table (any app)
expected_tables="$(jq -r '."table-count" // empty' <<<"$meta")"
expected_hash="$(jq -r '."content-hash" // empty' <<<"$meta")"
image_tag="$(jq -r '."image-tag" // empty' <<<"$meta")"
source_db="$(jq -r '.database // empty' <<<"$meta")"
VERIFY_TABLE="${VERIFY_TABLE:-$(jq -r '."verify-table" // "notes"' <<<"$meta")}"
valid_table "$VERIFY_TABLE" || die "VERIFY_TABLE is not a valid table name"
s3 s3 cp "s3://$S3_BUCKET/$BACKUP_KEY" "$dump" --only-show-errors

# Default target: <source db>_restore_<YYYYMMDDHHMMSS>, e.g. notes_app_restore_20261124183005.
if [ -z "${TARGET_DB:-}" ]; then
  base="${source_db:-$(basename "$(dirname "$BACKUP_KEY")" | tr '-' '_')}"
  TARGET_DB="${base:0:40}_restore_$(date -u +%Y%m%d%H%M%S)"
fi
valid_identifier "$TARGET_DB" || die "TARGET_DB '$TARGET_DB' must be a lowercase identifier"
[ -z "${TARGET_OWNER:-}" ] || valid_identifier "$TARGET_OWNER" || die "TARGET_OWNER must be a lowercase identifier"

STEP=restore
exists="$(psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'")"
[ -z "$exists" ] || die "database $TARGET_DB already exists; restores never overwrite a database"

log "creating database $TARGET_DB${TARGET_OWNER:+ owned by $TARGET_OWNER}"
if [ -n "${TARGET_OWNER:-}" ]; then
  # Needed on RDS (master is not a superuser); a no-op where the admin already has the role.
  psql "$ADMIN_DATABASE_URL" -qc "GRANT \"$TARGET_OWNER\" TO CURRENT_USER" >/dev/null 2>&1 || true
fi
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -qc \
  "CREATE DATABASE \"$TARGET_DB\"${TARGET_OWNER:+ OWNER \"$TARGET_OWNER\"}"
# Same isolation as the live database: only the owner (and the admin) may connect.
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -qc "REVOKE ALL ON DATABASE \"$TARGET_DB\" FROM PUBLIC"

target_url="$(url_with_db "$ADMIN_DATABASE_URL" "$TARGET_DB")"
log "pg_restore into $TARGET_DB"
# --role makes the restored tables belong to the app's login, so the recovery app can use them.
# On RDS the admin (master) user must be a member of that role: GRANT <owner> TO <master>.
if ! pg_restore --no-owner --no-acl --exit-on-error ${TARGET_OWNER:+--role="$TARGET_OWNER"} \
     --dbname="$target_url" "$dump"; then
  if [ "${KEEP_FAILED:-false}" != "true" ]; then
    log "restore failed; dropping $TARGET_DB"
    psql "$ADMIN_DATABASE_URL" -qc "DROP DATABASE IF EXISTS \"$TARGET_DB\"" || true
  fi
  die "pg_restore failed"
fi

STEP=check
# Any app: every table must come back with exactly the rows the backup had. Backups taken before
# table-count/total-rows existed fall back to the single VERIFY_TABLE count (+ MIN_ROWS).
read -r tables total < <(count_all_rows "$target_url")
table_rows="$(count_rows "$target_url" "$VERIFY_TABLE" 2>/dev/null || echo "")"
status=succeeded
reason=""
if [ -n "$expected_total" ]; then
  log "$tables tables, $total rows in $TARGET_DB (backup had $expected_tables tables, $expected_total rows)"
  records="$total"; expected="$expected_total"
  if [ "$tables" -ne "$expected_tables" ]; then
    status=failed; reason="expected $expected_tables tables, found $tables"
  elif [ "$total" -ne "$expected_total" ]; then
    status=failed; reason="expected $expected_total rows, found $total"
  fi
else
  [ -n "$table_rows" ] || die "table $VERIFY_TABLE not found in the restored database (old backup without row counts)"
  log "$VERIFY_TABLE has $table_rows rows in $TARGET_DB${expected_rows:+ (backup had $expected_rows)}"
  records="$table_rows"; expected="$expected_rows"
  if [ -n "$expected_rows" ] && [ "$table_rows" -ne "$expected_rows" ]; then
    status=failed; reason="expected $expected_rows rows, found $table_rows"
  elif [ "$table_rows" -lt "$MIN_ROWS" ]; then
    status=failed; reason="found $table_rows rows, fewer than MIN_ROWS=$MIN_ROWS"
  fi
fi

content_checked=false
content_note=""
if [ -n "$expected_hash" ]; then
  if [ "$status" = succeeded ]; then
    fp_started=$(date +%s%N)
    actual_hash="$(content_fingerprint "$target_url")"
    log "content fingerprint $actual_hash, backup had $expected_hash ($(( ($(date +%s%N) - fp_started) / 1000000 )) ms)"
    if [ "$actual_hash" = "$expected_hash" ]; then
      content_checked=true
    else
      status=failed; reason="row contents differ from the backup (content fingerprint mismatch)"
    fi
  fi
elif [ "$(jq -r '."content-check" // empty' <<<"$meta")" = skipped-size ]; then
  content_note="content check skipped: database over the size limit; tables and rows counted"
else
  content_note="no content fingerprint in this backup (taken before content checks); tables and rows counted"
fi
[ -z "$content_note" ] || log "$content_note"

dropped=false
if [ "${DROP_AFTER_CHECK:-false}" = "true" ]; then
  STEP=cleanup
  log "drill: dropping $TARGET_DB"
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE)" && dropped=true
fi

duration=$(( $(date +%s) - started ))
emit_result RESTORE_RESULT "$(jq -cn \
  --arg status "$status" --arg reason "$reason" --arg key "$BACKUP_KEY" --arg db "$TARGET_DB" \
  --arg tag "$image_tag" --arg table "$VERIFY_TABLE" --argjson records "$records" \
  --arg expected "$expected" --argjson duration "$duration" --argjson dropped "$dropped" \
  --argjson tables "$tables" --arg tableRows "$table_rows" \
  --argjson content "$content_checked" --arg contentNote "$content_note" \
  '{status: $status, backupKey: $key, targetDatabase: $db, imageTag: $tag, verifyTable: $table,
    recordsChecked: $records, expectedRecords: ($expected | if . == "" then null else tonumber end),
    tablesChecked: $tables, verifyTableRows: ($tableRows | if . == "" then null else tonumber end),
    durationSeconds: $duration, dropped: $dropped, contentChecked: $content}
   + (if $reason == "" then {} else {reason: $reason} end)
   + (if $contentNote == "" then {} else {contentNote: $contentNote} end)')"

[ "$status" = succeeded ] || die "verification failed: $reason"
log "restore verified in ${duration}s"
