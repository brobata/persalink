#!/usr/bin/env bash
# PersaLink one-line installer
#   curl -fsSL https://github.com/brobata/persalink/releases/download/@VERSION@/setup.sh | bash
#
# Downloads the release tarball, extracts it to ~/.persalink/app, and runs
# the bundled installer. Safe to re-run — upgrades in place.
#
# TEMPLATE: @VERSION@ is stamped by scripts/release/stage.sh at release time.

set -euo pipefail

VERSION="${PERSALINK_VERSION:-@VERSION@}"
INSTALL_DIR="${PERSALINK_HOME:-$HOME/.persalink/app}"
TARBALL="persalink-${VERSION}.tar.gz"
URL="https://github.com/brobata/persalink/releases/download/${VERSION}/${TARBALL}"

cyan='\033[0;36m'; green='\033[0;32m'; red='\033[0;31m'; reset='\033[0m'
say() { printf "${cyan}==>${reset} %s\n" "$*"; }
die() { printf "${red} ✗${reset}  %s\n" "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v tar  >/dev/null 2>&1 || die "tar is required."

say "Downloading PersaLink ${VERSION}"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

curl -fsSL "$URL" -o "$TMPDIR/$TARBALL" || die "Download failed: $URL"

say "Extracting to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMPDIR/$TARBALL" -C "$TMPDIR"
rm -rf "$INSTALL_DIR"
mv "$TMPDIR/persalink-${VERSION}" "$INSTALL_DIR"

say "Running installer"
cd "$INSTALL_DIR"
bash ./install.sh

printf "\n${green}PersaLink installed to${reset} %s\n" "$INSTALL_DIR"
printf "Run it with:  ${cyan}cd %s && npm run start:server${reset}\n" "$INSTALL_DIR"
