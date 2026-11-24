#!/usr/bin/env bash
# Full local recovery drill against docker-compose (no AWS):
#   start stack -> back up -> simulate data loss -> restore into a new DB -> verify -> run recovery app
# Usage: jobs/backup-restore/demo-local.sh            (from anywhere in the repo)
set -euo pipefail
cd "$(dirname "$0")/../../sample-apps/notes-app"

APP=http://localhost:3000/apps/notes-app
REC=http://localhost:3001/apps/notes-app-recovery
step() { printf '\n==> %s\n' "$*"; }
notes() { curl -fsS "$1/api/stats" | sed -E 's/.*"notes":([0-9]+).*/\1/'; }

step "Starting app, Postgres and local S3"
docker compose up --build -d --wait notes-app s3
docker compose run --rm s3-init >/dev/null
before=$(notes "$APP")
echo "live app has $before notes"

step "Backup"
backup_out=$(docker compose run --rm backup)
echo "$backup_out"
key=$(printf '%s\n' "$backup_out" | sed -n 's/^BACKUP_RESULT .*"s3Key":"\([^"]*\)".*/\1/p')
[ -n "$key" ] || { echo "no backup key in output"; exit 1; }

step "Simulated incident: deleting 80% of notes in the live app"
curl -fsS -X POST -H 'content-type: application/json' -d '{"percent":80}' "$APP/api/demo/data-loss"
echo; echo "live app now has $(notes "$APP") notes"

step "Restore $key into a new database"
restore_out=$(docker compose run --rm -e BACKUP_KEY="$key" restore)
echo "$restore_out"
db=$(printf '%s\n' "$restore_out" | sed -n 's/^RESTORE_RESULT .*"targetDatabase":"\([^"]*\)".*/\1/p')

step "Starting the recovery app on $db"
RECOVERY_DB="$db" docker compose --profile recovery up -d --wait notes-app-recovery
after=$(notes "$REC")
echo "recovery app has $after notes (live app had $before before the incident)"
[ "$after" -eq "$before" ] && echo "RECOVERY VERIFIED" || { echo "MISMATCH"; exit 1; }
echo "Open $REC/ to see it. Clean up with: docker compose --profile recovery down -v"
