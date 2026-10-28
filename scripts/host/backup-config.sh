#!/usr/bin/env bash
# @file backup-config.sh
# @description Nightly tarball of ~/.persalink (password hash, tokens, profiles,
#   VAPID keys, session names) into ~/backups/persalink, keeping 14 days.
#   Logs are skipped. Install: crontab line in scripts/host/README.md.
set -euo pipefail
SRC="${PERSALINK_CONFIG_DIR:-$HOME/.persalink}"
DEST="${PERSALINK_BACKUP_DIR:-$HOME/backups/persalink}"
mkdir -p -m 700 "$DEST"
umask 077
tar -czf "$DEST/persalink-$(date +%F).tgz" -C "$(dirname "$SRC")" --exclude="$(basename "$SRC")/logs" "$(basename "$SRC")" \
  || [ $? -eq 1 ]  # 1 = "file changed as we read it" (live tokens.json); archive is still written
find "$DEST" -name 'persalink-*.tgz' -mtime +14 -delete
