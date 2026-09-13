#!/usr/bin/env bash

set -euo pipefail

readonly DEPLOY_ROOT=/opt/lexloop
readonly BACKUP_ROOT="${DEPLOY_ROOT}/backups"
readonly STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly DAILY_BACKUP="${BACKUP_ROOT}/daily/lexloop-${STAMP}.dump"

set -a
# shellcheck disable=SC1091
source "${DEPLOY_ROOT}/config/production.env"
set +a

install -d -m 0700 "${BACKUP_ROOT}/daily" "${BACKUP_ROOT}/weekly"
temporary="${DAILY_BACKUP}.tmp"
trap 'rm -f "$temporary"' EXIT

docker exec lexloop-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc >"$temporary"
chmod 0600 "$temporary"
mv "$temporary" "$DAILY_BACKUP"

if [ "$(date -u +%u)" -eq 7 ]; then
  cp -p "$DAILY_BACKUP" "${BACKUP_ROOT}/weekly/lexloop-${STAMP}.dump"
fi

find "${BACKUP_ROOT}/daily" -type f -name 'lexloop-*.dump' -mtime +7 -delete
find "${BACKUP_ROOT}/weekly" -type f -name 'lexloop-*.dump' -mtime +28 -delete

if [ -x "${DEPLOY_ROOT}/config/backup-sync" ]; then
  "${DEPLOY_ROOT}/config/backup-sync" "$DAILY_BACKUP"
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup=${DAILY_BACKUP}"
