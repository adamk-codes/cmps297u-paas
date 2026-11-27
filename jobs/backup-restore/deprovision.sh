#!/usr/bin/env bash
# Remove an app's database, its restored copies and its login from the shared PostgreSQL server, and its
# credentials from Secrets Manager. Backups in S3 are NOT touched, so the app's data can still be restored.
#   database = role = APP_NAME with '-' -> '_'; restored copies are <db>_restore_<14 digits> (restore.sh),
#   databases set aside by "Undo deploy" are <db>_undo_<14 digits> (swap.sh)
set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_env ADMIN_DATABASE_URL APP_NAME
[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "APP_NAME must be lowercase letters, digits and '-'"
name="$(printf '%s' "$APP_NAME" | tr '-' '_')"
valid_identifier "$name" || die "derived name '$name' is not a valid identifier"
case "$name" in rebound_*|postgres|rdsadmin|template*) die "refusing to remove platform database $name" ;; esac

STEP=database
admin() { psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -qtA "$@"; }

# Exact names only: deleting "notes" must never touch "notes_app", "notes_app_restore_..." or "notes_app_undo_...".
# (Query first, then split: a failed query must stop the script, which a process substitution would hide.)
found="$(admin -c "SELECT datname FROM pg_database
  WHERE datname = '$name' OR datname ~ '^${name:0:40}_(restore|undo)_[0-9]{14}\$' ORDER BY datname")"
mapfile -t dbs <<<"$found"
for db in "${dbs[@]}"; do
  [ -n "$db" ] || continue
  log "dropping database $db"
  admin -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null
done
if [ -n "$(admin -c "SELECT 1 FROM pg_roles WHERE rolname = '$name'")" ]; then
  log "dropping login $name"
  admin -c "DROP ROLE \"$name\"" >/dev/null
fi

STEP=secret
secret_deleted=false
if [ -n "${SECRET_ID:-}" ] && aws secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1; then
  # No recovery window, so the same app name can be deployed again right away.
  aws secretsmanager delete-secret --secret-id "$SECRET_ID" --force-delete-without-recovery >/dev/null
  log "deleted $SECRET_ID from Secrets Manager"
  secret_deleted=true
fi

emit_result DEPROVISION_RESULT "$(jq -cn --arg app "$APP_NAME" --arg dbs "$(IFS=,; echo "${dbs[*]:-}")" \
  --argjson secret "$secret_deleted" \
  '{status: "succeeded", app: $app, droppedDatabases: ($dbs | if . == "" then [] else split(",") end),
    secretDeleted: $secret}')"
