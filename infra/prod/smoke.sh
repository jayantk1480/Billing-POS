#!/usr/bin/env sh
# Checks the running installation from the outside: see smoke.mjs for what is checked.
# On a live server it changes nothing. Uses Node if it is installed here, otherwise the api container.
set -eu
cd "$(dirname "$0")"
[ -f .env ] && . ./.env

export API_URL="${API_URL:-https://$API_DOMAIN}"
export APP_URL="${APP_URL:-https://$APP_DOMAIN}"
export POS_URL="${POS_URL:-https://$POS_DOMAIN}"
export KDS_URL="${KDS_URL:-https://$KDS_DOMAIN}"
export ADMIN_URL="${ADMIN_URL:-https://$ADMIN_DOMAIN}"
export PLATFORM_ADMIN_EMAIL="${PLATFORM_ADMIN_EMAIL:-}" PLATFORM_ADMIN_PASSWORD="${PLATFORM_ADMIN_PASSWORD:-}"

if command -v node >/dev/null 2>&1; then
  exec node smoke.mjs
fi
exec ${COMPOSE:-docker compose} exec -T \
  -e API_URL -e APP_URL -e POS_URL -e KDS_URL -e ADMIN_URL -e PLATFORM_ADMIN_EMAIL -e PLATFORM_ADMIN_PASSWORD \
  api node --input-type=module - < smoke.mjs
