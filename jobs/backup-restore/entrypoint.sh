#!/usr/bin/env bash
set -euo pipefail
DIR=/usr/local/bin/rebound

case "${1:-help}" in
  backup)  shift; exec "$DIR/backup.sh" "$@" ;;
  restore) shift; exec "$DIR/restore.sh" "$@" ;;
  help|-h|--help)
    cat <<'EOF'
rebound backup-restore

  backup    pg_dump the app database and upload it to S3
            as backups/<APP_NAME>/<timestamp>-<IMAGE_TAG>.dump
  restore   download BACKUP_KEY, create a NEW database, pg_restore into it,
            and verify the row count

See jobs/backup-restore/README.md for the environment variables.
EOF
    ;;
  *) exec "$@" ;;
esac
