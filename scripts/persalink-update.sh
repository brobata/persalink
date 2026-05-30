#!/usr/bin/env bash
#
# @file persalink-update.sh
# @description Gated, manual OS update for the PersaLink host. Refuses to
#   upgrade while ANY PersaLink (`pl-`) tmux session is active, so an update can
#   never wipe live terminal sessions again. Installed to /usr/local/bin and run
#   with sudo. This is the ONLY sanctioned path to OS updates on this box —
#   automatic unattended-upgrades are masked (see scripts/host/README.md).
#
# Background: on 2026-05-28, the daily unattended-upgrades run pulled in
# libgcrypt20, and `needrestart` (default = auto-restart) bounced every service
# on the old lib — including the PM2 daemon and the tmux server — wiping all
# active pl- sessions. needrestart is now list-only, and OS updates are manual
# and session-gated via this script.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo persalink-update" >&2
  exit 1
fi

# --exclude <session>: ignore one session when checking for active work. Used by
# the "System Update" PersaLink profile, which runs this from inside its OWN pl-
# session (pl-host-update) — without this it would forever refuse to run itself.
EXCLUDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --exclude) EXCLUDE="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The human who owns the tmux sessions — not root. Falls back to the box owner.
TARGET_USER="${SUDO_USER:-disdiqqq}"

# List active PersaLink session NAMES belonging to that user. tmux runs as a
# per-user daemon on its own socket, so we must query it AS the user, not root.
active="$(runuser -l "$TARGET_USER" -c "tmux list-sessions -F '#{session_name}' 2>/dev/null" | grep '^pl-' || true)"
if [ -n "$EXCLUDE" ]; then
  active="$(printf '%s\n' "$active" | grep -vxF "$EXCLUDE" || true)"
fi

if [ -n "$active" ]; then
  echo "Refusing to update — active PersaLink sessions:" >&2
  printf '%s\n' "$active" | sed 's/^/  /' >&2
  echo >&2
  echo "Close them all first, then re-run. To drop everything at once:" >&2
  echo "  runuser -l $TARGET_USER -c 'tmux kill-server'" >&2
  exit 1
fi

echo "No active PersaLink sessions — proceeding with update."
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get -y upgrade
apt-get -y autoremove --purge

# Stamp success (owned by the user, not root) so the "System Update" profile's
# health check can nag when the box hasn't been updated in a while.
runuser -l "$TARGET_USER" -c 'mkdir -p ~/.persalink && touch ~/.persalink/last-update' || true

if [ -f /var/run/reboot-required ]; then
  echo
  echo "A reboot is required to finish:"
  cat /var/run/reboot-required.pkgs 2>/dev/null | sed 's/^/  /' || true
  read -rp "Reboot now? [y/N] " ans
  case "${ans:-}" in
    y|Y|yes|YES) echo "Rebooting…"; systemctl reboot ;;
    *) echo "Skipping reboot. Run 'sudo systemctl reboot' when you're ready." ;;
  esac
else
  echo "Done. No reboot required."
fi
