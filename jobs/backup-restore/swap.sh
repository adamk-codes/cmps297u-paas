#!/usr/bin/env bash
# "Undo deploy": put a restored copy in place of the app's live database, in one transaction.
#   live <db>              -> KEEP_AS  (kept, nothing is deleted; "Delete app" drops it later)
#   restored RESTORED_DB   -> <db>     (same name, so the app's login, Secret and backups don't change)
# The app must be stopped first (rebound-data.sh undo scales it to 0); leftover sessions are ended.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_env ADMIN_DATABASE_URL APP_NAME RESTORED_DB KEEP_AS
[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "APP_NAME must be lowercase letters, digits and '-'"
live="$(printf '%s' "$APP_NAME" | tr '-' '_')"
for n in "$live" "$RESTORED_DB" "$KEEP_AS"; do valid_identifier "$n" || die "'$n' is not a valid database name"; done
case "$live" in rebound_*|postgres|rdsadmin|template*) die "refusing to swap platform database $live" ;; esac
[[ "$RESTORED_DB" == "${live:0:40}_restore_"* ]] || die "$RESTORED_DB is not a restored copy of $live"

STEP=swap
admin() { psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -qtA "$@"; }
[ -n "$(admin -c "SELECT 1 FROM pg_database WHERE datname = '$RESTORED_DB'")" ] || die "$RESTORED_DB does not exist"
[ -n "$(admin -c "SELECT 1 FROM pg_database WHERE datname = '$live'")" ] || die "live database $live does not exist"
[ -z "$(admin -c "SELECT 1 FROM pg_database WHERE datname = '$KEEP_AS'")" ] || die "$KEEP_AS already exists"

# Renaming needs ownership (RDS master: membership in the app role, as in provision.sh).
admin -c "GRANT \"$live\" TO CURRENT_USER" >/dev/null 2>&1 || true
log "ending leftover sessions on $live and $RESTORED_DB"
admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname IN ('$live', '$RESTORED_DB') AND pid <> pg_backend_pid()" >/dev/null
log "renaming $live -> $KEEP_AS and $RESTORED_DB -> $live"
admin -c "BEGIN;
  ALTER DATABASE \"$live\" RENAME TO \"$KEEP_AS\";
  ALTER DATABASE \"$RESTORED_DB\" RENAME TO \"$live\";
  COMMIT;" >/dev/null
# Same isolation as provision.sh: only the app's login (and the admin) may connect.
admin -c "REVOKE ALL ON DATABASE \"$live\" FROM PUBLIC" >/dev/null
admin -c "GRANT CONNECT, TEMPORARY ON DATABASE \"$live\" TO \"$live\"" >/dev/null

emit_result SWAP_RESULT "$(jq -cn --arg app "$APP_NAME" --arg live "$live" --arg kept "$KEEP_AS" --arg from "$RESTORED_DB" \
  '{status: "succeeded", app: $app, liveDatabase: $live, restoredFrom: $from, keptDatabase: $kept}')"
