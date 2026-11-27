#!/usr/bin/env bash
set -euo pipefail
DIR=/usr/local/bin/rebound

case "${1:-help}" in
  backup)  shift; exec "$DIR/backup.sh" "$@" ;;
  restore) shift; exec "$DIR/restore.sh" "$@" ;;
  provision) shift; exec "$DIR/provision.sh" "$@" ;;
  deprovision) shift; exec "$DIR/deprovision.sh" "$@" ;;
  isolation-check) shift; exec "$DIR/isolation-check.sh" "$@" ;;
  help|-h|--help)
    cat <<'EOF'
rebound backup-restore

  provision        create the app's own database + restricted login, store the URL
                   in Secrets Manager (SECRET_ID) and/or a file (SECRET_FILE)
  deprovision      drop the app's database, restored copies and login, and delete
                   its Secrets Manager entry (backups in S3 are kept)
  backup           pg_dump the app database and upload it to S3
                   as backups/<APP_NAME>/<timestamp>-<IMAGE_TAG>.dump
  restore          download BACKUP_KEY, create a NEW database, pg_restore into it,
                   and verify the row count
  isolation-check  prove DATABASE_URL's login cannot open OTHER_DATABASE

See jobs/backup-restore/README.md for the environment variables.
EOF
    ;;
  *) exec "$@" ;;
esac
