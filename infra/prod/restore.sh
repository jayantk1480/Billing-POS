#!/usr/bin/env sh
# Puts the database and the uploaded images back from one backup folder made by backup.sh.
# EVERYTHING now in the database and the uploads is replaced by what is in the backup.
#
#   ./restore.sh backups/2026-11-23_021500
#   ./restore.sh backups/2026-11-23_021500 --yes      skip the question (for a rehearsal)
#
# COMPOSE can be set to use different compose files, as the laptop rehearsal does.
set -eu
cd "$(dirname "$0")"
[ -f .env ] && . ./.env

COMPOSE="${COMPOSE:-docker compose}"
SOURCE="${1:-}"
[ -n "$SOURCE" ] || { echo "Usage: ./restore.sh <backup folder> [--yes]" >&2; exit 2; }
[ -s "$SOURCE/database.dump" ] || { echo "No database.dump in $SOURCE" >&2; exit 2; }
[ -s "$SOURCE/uploads.tar.gz" ] || { echo "No uploads.tar.gz in $SOURCE" >&2; exit 2; }

if [ "${2:-}" != "--yes" ]; then
  echo "This replaces the whole database and all uploaded images with the backup in $SOURCE."
  echo "Bills made since that backup will be gone. Type RESTORE to go on:"
  read -r answer
  [ "$answer" = "RESTORE" ] || { echo "Nothing was changed."; exit 1; }
fi

echo "Stopping the apps (the database stays up)..."
$COMPOSE stop caddy api web pos kds admin

echo "Restoring the database..."
# A fresh database, so nothing of the old one is left behind.
$COMPOSE exec -T postgres dropdb -U pos --if-exists --force pos
$COMPOSE exec -T postgres createdb -U pos pos
$COMPOSE exec -T postgres pg_restore -U pos -d pos --no-owner --exit-on-error < "$SOURCE/database.dump"

echo "Restoring the uploaded images..."
$COMPOSE run --rm --no-deps -T --entrypoint sh api -c 'find /app/storage -mindepth 1 -delete && tar -C /app/storage -xzf -' < "$SOURCE/uploads.tar.gz"

echo "Starting the apps (any newer database migrations are applied first)..."
$COMPOSE up -d
echo "Restored from $SOURCE. Sign in and check the latest bills before letting restaurants back in."
