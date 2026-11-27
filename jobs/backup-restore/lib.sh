#!/usr/bin/env bash
# Shared helpers for backup.sh and restore.sh.

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${STEP:-main}" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

require_env() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "$name is required"
  done
}

# aws CLI with an optional custom endpoint (local S3 stand-in, real S3 when unset).
s3() {
  if [ -n "${S3_ENDPOINT:-}" ]; then
    aws --endpoint-url "$S3_ENDPOINT" "$@"
  else
    aws "$@"
  fi
}

# Server-side encryption flags: SSE-KMS by default, with an optional key id. S3_SSE="" disables.
sse_args() {
  local sse="${S3_SSE-aws:kms}"
  [ -z "$sse" ] && return 0
  printf '%s\n' --sse "$sse"
  if [ "$sse" = "aws:kms" ] && [ -n "${S3_KMS_KEY_ID:-}" ]; then
    printf '%s\n' --sse-kms-key-id "$S3_KMS_KEY_ID"
  fi
}

# Replace the database name in a postgres:// URL, keeping user, password, host, port and ?params.
url_with_db() {
  local url="$1" db="$2"
  local scheme_rest="${url#*://}" scheme="${url%%://*}"
  local authority="${scheme_rest%%/*}"
  local query=""
  case "$scheme_rest" in *\?*) query="?${scheme_rest#*\?}" ;; esac
  # URL without a path: authority may still carry the query.
  authority="${authority%%\?*}"
  printf '%s://%s/%s%s\n' "$scheme" "$authority" "$db" "$query"
}

# Only lowercase identifiers: these names end up in SQL and in URLs.
valid_identifier() { [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }

# Table names may be schema-qualified (public.notes).
valid_table() { [[ "$1" =~ ^([a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$ ]]; }

# One query, inside the exported snapshot SNAPSHOT when set (backup.sh: the counts, the fingerprint and
# pg_dump all see the same moment, so writes during a backup can't make them disagree).
query() {
  local url="$1" sql="$2"
  if [ -n "${SNAPSHOT:-}" ]; then
    psql "$url" -v ON_ERROR_STOP=1 -qtAX -F ' ' -c "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" \
      -c "SET TRANSACTION SNAPSHOT '$SNAPSHOT'" -c "$sql" -c "COMMIT"
  else
    psql "$url" -v ON_ERROR_STOP=1 -qtAX -F ' ' -c "$sql"
  fi
}

count_rows() {
  local url="$1" table="$2"
  query "$url" "SELECT count(*) FROM $table"
}

# Works for any app: exact row count of EVERY table in the database (all schemas except the system
# ones), printed as "<tables> <rows>". Used to check a restore brought back everything the backup had.
count_all_rows() {
  query "$1" "
    SELECT count(*), coalesce(sum((xpath('/row/c/text()',
             query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')
           ))[1]::text::bigint), 0)
    FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')"
}

# Content fingerprint of the WHOLE database (any app): one code that changes if any value in any row of any
# table changes. Per table: every row's text is hashed with md5 and the hashes are summed (two 60-bit halves),
# so rows can come back in any order, memory stays constant and it streams like count(*). The per-table
# results, sorted by table name, are hashed once more. Costs one more read of the data (backups already
# read everything), so callers skip it for very large databases (see CONTENT_CHECK_MAX_BYTES).
content_fingerprint() {
  query "$1" "
    SELECT md5(coalesce(string_agg(t || ':' || h, ',' ORDER BY t), ''))
    FROM (
      SELECT format('%I.%I', schemaname, tablename) AS t,
             (xpath('/row/h/text()', query_to_xml(format(
               'SELECT count(*) || ''-'' || coalesce(sum((''x'' || substr(m, 1, 15))::bit(60)::bigint), 0)
                                 || ''-'' || coalesce(sum((''x'' || substr(m, 16, 15))::bit(60)::bigint), 0) AS h
                FROM (SELECT md5(x::text) AS m FROM %I.%I x) s', schemaname, tablename), false, true, '')))[1]::text AS h
      FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ) per_table"
}

database_bytes() { psql "$1" -v ON_ERROR_STOP=1 -tAc 'SELECT pg_database_size(current_database())'; }

# The last line of a job's log is machine-readable, so the platform API can read the result.
emit_result() {
  local marker="$1" json="$2"
  printf '%s %s\n' "$marker" "$json"
}
