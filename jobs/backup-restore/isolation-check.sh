#!/usr/bin/env bash
# Proves that one app's database login cannot reach another app's data.
#   DATABASE_URL     the login under test (e.g. notes-app's)
#   OTHER_DATABASE   a database it must NOT be able to open (e.g. shop_api)
# Checks: (1) it can use its own database, (2) connecting to OTHER_DATABASE is refused.
# Exit 0 only if isolation holds.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_env DATABASE_URL OTHER_DATABASE
valid_identifier "$OTHER_DATABASE" || die "OTHER_DATABASE must be a lowercase identifier"

STEP=own
own_db="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc 'SELECT current_database()')" \
  || die "the login cannot open its own database"
user="$(psql "$DATABASE_URL" -tAc 'SELECT current_user')"
log "$user can open its own database $own_db"

STEP=other
other_url="$(url_with_db "$DATABASE_URL" "$OTHER_DATABASE")"
if out="$(psql "$other_url" -v ON_ERROR_STOP=1 -tAc 'SELECT current_database()' 2>&1)"; then
  status=failed
  detail="$user CONNECTED to $OTHER_DATABASE"
  log "FAIL: $detail"
else
  status=succeeded
  # e.g. FATAL:  permission denied for database "shop_api"  ->  permission denied for database shop_api
  detail="$(printf '%s' "$out" | grep -oE 'permission denied for database "?[a-z0-9_]+"?|database "?[a-z0-9_]+"? does not exist|no pg_hba.conf entry[^,]*' | head -1 | tr -d '"')"
  log "OK: $user was refused by $OTHER_DATABASE (${detail:-refused})"
fi

emit_result ISOLATION_RESULT "$(jq -cn --arg status "$status" --arg user "$user" --arg own "$own_db" \
  --arg other "$OTHER_DATABASE" --arg detail "$detail" \
  '{status: $status, login: $user, ownDatabase: $own, otherDatabase: $other, detail: $detail}')"
[ "$status" = succeeded ]
