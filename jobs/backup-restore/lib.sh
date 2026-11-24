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

count_rows() {
  local url="$1" table="$2"
  psql "$url" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM $table"
}

# The last line of a job's log is machine-readable, so the platform API can read the result.
emit_result() {
  local marker="$1" json="$2"
  printf '%s %s\n' "$marker" "$json"
}
