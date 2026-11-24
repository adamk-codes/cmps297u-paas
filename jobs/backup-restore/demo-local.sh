#!/usr/bin/env bash
# Full local drill against docker-compose (no AWS):
#   provision -> isolation check -> back up -> simulate data loss -> restore into a new DB -> verify ->
#   run the recovery app, and report the measured recovery time.
# Usage: jobs/backup-restore/demo-local.sh [--fresh]     (--fresh wipes the local database first)
set -euo pipefail
cd "$(dirname "$0")/../../sample-apps/notes-app"

APP=http://localhost:3000/apps/notes-app
REC=http://localhost:3001/apps/notes-app-recovery
step() { printf '\n==> %s\n' "$*"; }
notes() { curl -fsS "$1/api/stats" | sed -E 's/.*"notes":([0-9]+).*/\1/'; }
result() { printf '%s\n' "$2" | sed -n "s/^$1 //p"; }
field() { printf '%s\n' "$2" | sed -n "s/.*\"$1\":\"\\{0,1\\}\\([^\",}]*\\).*/\\1/p"; }

if [ "${1:-}" = "--fresh" ]; then
  step "Removing the previous local stack and data"
  docker compose --profile recovery --profile tools down -v --remove-orphans
fi

step "Starting Postgres, provisioning notes_app, starting the app and local S3"
docker compose up --build -d --wait notes-app s3
docker compose run --rm s3-init >/dev/null
before=$(notes "$APP")
echo "live app has $before notes"

step "Isolation: a second app gets its own database; notes_app must not be able to open it"
docker compose run --rm -e APP_NAME=shop-api -e DB_PASSWORD=shop_api_local_pw provision | grep PROVISION_RESULT
docker compose run --rm -e OTHER_DATABASE=shop_api isolation-check | grep ISOLATION_RESULT

step "Backup"
backup_out=$(docker compose run --rm backup)
result BACKUP_RESULT "$backup_out"
key=$(field s3Key "$backup_out")
[ -n "$key" ] || { echo "no backup key in output"; exit 1; }

step "Simulated incident: deleting 80% of notes in the live app"
curl -fsS -X POST -H 'content-type: application/json' -d '{"percent":80}' "$APP/api/demo/data-loss"
echo; echo "live app now has $(notes "$APP") notes"

step "Restore $key into a new database"
t0=$(date +%s)
restore_out=$(docker compose run --rm -e BACKUP_KEY="$key" restore)
result RESTORE_RESULT "$restore_out"
db=$(field targetDatabase "$restore_out")

step "Starting the recovery app on $db"
RECOVERY_DB="$db" docker compose --profile recovery up -d --wait --force-recreate notes-app-recovery
after=$(notes "$REC")
total=$(( $(date +%s) - t0 ))
echo "recovery app has $after notes (live app had $before before the incident)"
[ "$after" -eq "$before" ] || { echo "MISMATCH"; exit 1; }
echo "RECOVERY VERIFIED: $after/$before notes back, ${total}s from restore start to verified recovery URL"
echo "Open $REC/ to see it. Clean up with: docker compose --profile recovery --profile tools down -v"
