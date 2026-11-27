#!/usr/bin/env sh
# Backs up the database and the uploaded images into a dated folder, and removes backups older than
# BACKUP_KEEP_DAYS. With BACKUP_REMOTE set, the new backup is also copied off this server with rclone:
# a backup that only exists on the server is lost with the server.
#
#   ./backup.sh                     run by hand
#   15 2 * * * /srv/pos/infra/prod/backup.sh >> /var/log/pos-backup.log 2>&1      every night at 2:15
#
# COMPOSE can be set to use different compose files, as the laptop rehearsal does.
set -eu
cd "$(dirname "$0")"
[ -f .env ] && . ./.env

COMPOSE="${COMPOSE:-docker compose}"
ROOT="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
TARGET="$ROOT/$STAMP"
mkdir -p "$TARGET"

fail() {
  echo "Backup FAILED: $1" >&2
  # A half-written backup must never look like a good one.
  rm -rf "$TARGET"
  exit 1
}

# The database, in PostgreSQL's own compressed format. It is a consistent snapshot even while the restaurant is billing.
$COMPOSE exec -T postgres pg_dump -U pos -d pos -Fc > "$TARGET/database.dump" || fail "could not dump the database"
[ -s "$TARGET/database.dump" ] || fail "the database dump is empty"

# The uploaded images (product photos).
$COMPOSE exec -T api tar -C /app/storage -czf - . > "$TARGET/uploads.tar.gz" || fail "could not archive the uploaded images"
[ -s "$TARGET/uploads.tar.gz" ] || fail "the archive of uploaded images is empty"

echo "$(date '+%Y-%m-%d %H:%M:%S') backup written to $TARGET ($(du -sh "$TARGET" | cut -f1))"

if [ -n "${BACKUP_REMOTE:-}" ]; then
  command -v rclone >/dev/null 2>&1 || fail "BACKUP_REMOTE is set but rclone is not installed"
  rclone copy "$TARGET" "$BACKUP_REMOTE/$STAMP" || fail "could not copy the backup to $BACKUP_REMOTE"
  echo "$(date '+%Y-%m-%d %H:%M:%S') copied to $BACKUP_REMOTE/$STAMP"
fi

# Old backups go only after a new one has been written.
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP" -exec rm -rf {} +
