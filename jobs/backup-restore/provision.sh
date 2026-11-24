#!/usr/bin/env bash
# Create (or update) an app's own database and restricted login on the shared PostgreSQL server.
#   database = role = APP_NAME with '-' -> '_'   (notes-app -> notes_app)
# The role owns only its database; CONNECT is revoked from PUBLIC so other apps' logins can't get in.
# The connection URL is stored in Secrets Manager (SECRET_ID) and/or a file (SECRET_FILE); the password
# is never written to the logs. Re-running sets the password again (DB_PASSWORD or a new random one).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_env ADMIN_DATABASE_URL APP_NAME
[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "APP_NAME must be lowercase letters, digits and '-'"
name="$(printf '%s' "$APP_NAME" | tr '-' '_')"
valid_identifier "$name" || die "derived name '$name' is not a valid identifier"
password="${DB_PASSWORD:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)}"
[[ "$password" =~ ^[A-Za-z0-9._~-]{12,}$ ]] || die "DB_PASSWORD must be 12+ URL-safe characters"

STEP=provision
admin() { psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -qtA "$@"; }

if [ -n "$(admin -c "SELECT 1 FROM pg_roles WHERE rolname = '$name'")" ]; then
  log "role $name exists; setting its password"
  admin -c "ALTER ROLE \"$name\" WITH LOGIN PASSWORD '$password'" >/dev/null
else
  log "creating role $name"
  admin -c "CREATE ROLE \"$name\" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$password'" >/dev/null
fi
# The admin must be a member of the app role to create databases owned by it (needed on RDS,
# where the master user is not a real superuser). Harmless where it already is.
admin -c "GRANT \"$name\" TO CURRENT_USER" >/dev/null 2>&1 || true

if [ -z "$(admin -c "SELECT 1 FROM pg_database WHERE datname = '$name'")" ]; then
  log "creating database $name"
  admin -c "CREATE DATABASE \"$name\" OWNER \"$name\"" >/dev/null
else
  log "database $name exists"
fi
admin -c "REVOKE ALL ON DATABASE \"$name\" FROM PUBLIC" >/dev/null
admin -c "GRANT CONNECT, TEMPORARY ON DATABASE \"$name\" TO \"$name\"" >/dev/null

# Host the apps should use (defaults to the admin URL's host).
admin_db_url="$(url_with_db "$ADMIN_DATABASE_URL" "$name")"
authority_and_rest="${admin_db_url#*://}"
host_part="${authority_and_rest#*@}"         # host:port/db?params
[ "$host_part" = "$authority_and_rest" ] && host_part="$authority_and_rest"
host_port="${host_part%%/*}"
query=""
case "$host_part" in *\?*) query="?${host_part#*\?}" ;; esac
app_url="postgres://${name}:${password}@${APP_DB_HOST:-$host_port}/${name}${query}"

STEP=secret
stored=()
if [ -n "${SECRET_ID:-}" ]; then
  payload="$(jq -cn --arg url "$app_url" --arg user "$name" --arg db "$name" --arg pw "$password" \
    '{DATABASE_URL: $url, username: $user, password: $pw, dbname: $db}')"
  if aws secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "$payload" >/dev/null
  else
    aws secretsmanager create-secret --name "$SECRET_ID" --secret-string "$payload" \
      ${SECRETS_KMS_KEY_ID:+--kms-key-id "$SECRETS_KMS_KEY_ID"} >/dev/null
  fi
  log "stored credentials in Secrets Manager: $SECRET_ID"
  stored+=("secretsmanager:$SECRET_ID")
fi
if [ -n "${SECRET_FILE:-}" ]; then
  umask 077
  printf '%s\n' "$app_url" > "$SECRET_FILE"
  log "wrote DATABASE_URL to $SECRET_FILE"
  stored+=("file:$SECRET_FILE")
fi
[ ${#stored[@]} -gt 0 ] || log "WARNING: neither SECRET_ID nor SECRET_FILE set; the password is not stored anywhere"

emit_result PROVISION_RESULT "$(jq -cn --arg app "$APP_NAME" --arg db "$name" --arg role "$name" \
  --arg host "${APP_DB_HOST:-$host_port}" --arg stored "$(IFS=,; echo "${stored[*]:-}")" \
  '{status: "succeeded", app: $app, database: $db, role: $role, host: $host,
    storedIn: ($stored | if . == "" then [] else split(",") end)}')"
