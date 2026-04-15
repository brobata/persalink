#!/usr/bin/env bash
# PersaLink installer — installs production dependencies, then offers to
# install missing system deps (tmux, pm2) with your consent.

set -euo pipefail

cyan='\033[0;36m'; green='\033[0;32m'; yellow='\033[0;33m'; red='\033[0;31m'; reset='\033[0m'

say()  { printf "${cyan}==>${reset} %s\n" "$*"; }
ok()   { printf "${green} ✓${reset}  %s\n" "$*"; }
warn() { printf "${yellow} !${reset}  %s\n" "$*"; }
die()  { printf "${red} ✗${reset}  %s\n" "$*" >&2; exit 1; }

# When this script is piped through `bash` (curl | bash), stdin is the script
# content, not the terminal — so `read` would read nothing. Point it at /dev/tty.
if [ -t 0 ]; then TTY=/dev/stdin; else TTY=/dev/tty; fi

prompt_yes() {
  # $1 = question. Returns 0 (yes) or 1 (no). Default yes.
  local reply
  printf "${yellow}?${reset}  %s [Y/n] " "$1" >&2
  if [ -r "$TTY" ]; then read -r reply < "$TTY"; else reply=""; fi
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

detect_pkg_install_cmd() {
  # Echoes the install command for the current OS's package manager, or empty.
  if   command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y"
  elif command -v brew    >/dev/null 2>&1; then echo "brew install"
  elif command -v pacman  >/dev/null 2>&1; then echo "sudo pacman -S --noconfirm"
  elif command -v dnf     >/dev/null 2>&1; then echo "sudo dnf install -y"
  elif command -v zypper  >/dev/null 2>&1; then echo "sudo zypper install -y"
  elif command -v apk     >/dev/null 2>&1; then echo "sudo apk add"
  fi
}

say "PersaLink installer"

# --- Node + npm ----------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js 20+ is required. Install from https://nodejs.org/"
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required (found v$(node -v))."
ok "Node.js $(node -v) detected"

command -v npm >/dev/null 2>&1 || die "npm is required."
ok "npm $(npm -v) detected"

# --- tmux ----------------------------------------------------------------------
if command -v tmux >/dev/null 2>&1; then
  ok "tmux $(tmux -V | awk '{print $2}') detected"
else
  warn "tmux is not installed — PersaLink requires it."
  PKG_INSTALL=$(detect_pkg_install_cmd)
  if [ -n "$PKG_INSTALL" ]; then
    if prompt_yes "Install tmux now with '$PKG_INSTALL tmux'?"; then
      $PKG_INSTALL tmux || die "tmux install failed. Please install it manually and re-run."
      ok "tmux installed: $(tmux -V | awk '{print $2}')"
    else
      die "Install tmux manually before running PersaLink."
    fi
  else
    die "No supported package manager detected. Install tmux manually, then re-run."
  fi
fi

# --- PersaLink runtime deps (node-pty, ws) ------------------------------------
say "Installing production dependencies (this compiles node-pty natively)..."
npm ci --omit=dev --ignore-scripts=false
ok "Dependencies installed"

# --- pm2 (optional) -----------------------------------------------------------
USE_PM2=0
if command -v pm2 >/dev/null 2>&1; then
  ok "pm2 $(pm2 -v) detected"
  USE_PM2=1
else
  if prompt_yes "Install pm2 for auto-restart on crash and boot?"; then
    npm install -g pm2 && ok "pm2 installed: $(pm2 -v)" && USE_PM2=1 \
      || warn "pm2 install failed — continuing without it."
  fi
fi

# --- Offer to start on boot with pm2 ------------------------------------------
if [ "$USE_PM2" = 1 ]; then
  if prompt_yes "Start PersaLink now (in the background) via pm2?"; then
    pm2 start ecosystem.config.js && pm2 save \
      || warn "pm2 start failed — run 'pm2 start ecosystem.config.js' manually."
    warn "To auto-start PersaLink on system boot, run:  pm2 startup  (needs sudo)"
  fi
fi

cat <<EOF

${green}PersaLink is ready.${reset}

  Manual start:
    ${cyan}npm run start:server${reset}

  First launch:
    1. Server listens on port 9877 (see ~/.persalink/config.json).
    2. Open http://<server-ip>:9877 from any browser on your network.
    3. Set a password on first connection — that's it.

  Docs:  https://github.com/brobata/persalink
EOF
