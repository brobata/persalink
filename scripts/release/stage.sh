#!/usr/bin/env bash
# @file stage.sh
# @description Builds every release artifact for a version tag into
#   dist-release/: the npm package dir (dist-release/npm — publish with
#   `npm publish dist-release/npm`), the manual-install tarball + zip,
#   the versioned setup.sh, checksums.txt, and notes.md for the GitHub
#   release body. Replicates the hand-assembled v1.0.1–v1.0.3 release
#   shape exactly. Run by .github/workflows/release.yml on tag push;
#   equally runnable by hand: scripts/release/stage.sh v1.0.4
set -euo pipefail

TAG="${1:?usage: stage.sh vX.Y.Z}"
# Strict: digits and dots only. Guards npm's semver requirement AND ensures the
# tag is inert when later used in sed/filenames (a glob like v[0-9]* would
# happily pass "v1;evil.2.3").
if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Tag must look like vX.Y.Z (npm needs strict semver, got: $TAG)" >&2
  exit 1
fi
VERSION="${TAG#v}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/dist-release"

echo "==> Staging PersaLink $TAG"
rm -rf "$OUT"
mkdir -p "$OUT"

# --- Build ---------------------------------------------------------------------
echo "==> Building server + client"
(cd "$ROOT" && npm run build:server && npm run build:client)

# --- npm package (dist-release/npm) --------------------------------------------
# Prebuilt server + client, tiny bin launcher, runtime deps only. The shared
# package is compiled INTO the server dist, so it isn't a dependency here.
echo "==> Staging npm package"
NPM_DIR="$OUT/npm"
mkdir -p "$NPM_DIR/bin" "$NPM_DIR/apps/server" "$NPM_DIR/apps/client"
cp -R "$ROOT/apps/server/dist" "$NPM_DIR/apps/server/dist"
cp -R "$ROOT/apps/client/dist" "$NPM_DIR/apps/client/dist"
cp "$ROOT/bin/persalink.js" "$NPM_DIR/bin/persalink.js"
cp "$ROOT/README.md" "$ROOT/LICENSE" "$NPM_DIR/"

VERSION="$VERSION" ROOT="$ROOT" NPM_DIR="$NPM_DIR" node <<'EOF'
const fs = require('fs');
const root = JSON.parse(fs.readFileSync(process.env.ROOT + '/package.json', 'utf8'));
const server = JSON.parse(fs.readFileSync(process.env.ROOT + '/apps/server/package.json', 'utf8'));
// Runtime deps come from the server workspace so they can never drift;
// @persalink/shared is compiled into the dist and must not be declared.
const dependencies = { ...server.dependencies };
delete dependencies['@persalink/shared'];
const pkg = {
  name: 'persalink',
  version: process.env.VERSION,
  description: 'Tmux session orchestrator — manage terminal sessions from any device through your browser',
  keywords: root.keywords,
  license: root.license,
  author: root.author,
  homepage: root.homepage,
  repository: { type: 'git', url: 'git+https://github.com/brobata/persalink.git' },
  bugs: root.bugs,
  bin: { persalink: 'bin/persalink.js' },
  main: 'apps/server/dist/apps/server/src/main/index.js',
  files: ['bin', 'apps/server/dist', 'apps/client/dist', 'README.md', 'LICENSE'],
  engines: { node: '>=20' },
  os: ['linux', 'darwin'],
  dependencies,
};
fs.writeFileSync(process.env.NPM_DIR + '/package.json', JSON.stringify(pkg, null, 2) + '\n');
EOF

# --- Manual-install tarball + zip ----------------------------------------------
# Same layout as prior releases: root workspace package.json (version stamped)
# + lockfile so install.sh's `npm ci --omit=dev` works, shared package source
# (workspace member), prebuilt dists, install.sh, pm2 ecosystem config.
echo "==> Staging release tarball"
PKG_NAME="persalink-$TAG"
PKG_DIR="$OUT/$PKG_NAME"
mkdir -p "$PKG_DIR/apps/server" "$PKG_DIR/apps/client" "$PKG_DIR/packages"
cp "$ROOT/LICENSE" "$ROOT/README.md" "$ROOT/ecosystem.config.js" "$ROOT/package-lock.json" "$PKG_DIR/"
cp "$ROOT/install.sh" "$PKG_DIR/install.sh"
chmod +x "$PKG_DIR/install.sh"
cp -R "$ROOT/packages/shared" "$PKG_DIR/packages/shared"
rm -rf "$PKG_DIR/packages/shared/node_modules"
cp "$ROOT/apps/server/package.json" "$PKG_DIR/apps/server/"
cp -R "$ROOT/apps/server/dist" "$PKG_DIR/apps/server/dist"
cp "$ROOT/apps/client/package.json" "$PKG_DIR/apps/client/"
cp -R "$ROOT/apps/client/dist" "$PKG_DIR/apps/client/dist"

VERSION="$VERSION" ROOT="$ROOT" PKG_DIR="$PKG_DIR" node <<'EOF'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(process.env.ROOT + '/package.json', 'utf8'));
pkg.version = process.env.VERSION;
fs.writeFileSync(process.env.PKG_DIR + '/package.json', JSON.stringify(pkg, null, 2) + '\n');
EOF

(cd "$OUT" && tar czf "$PKG_NAME.tar.gz" "$PKG_NAME" && zip -qr "$PKG_NAME.zip" "$PKG_NAME")

# --- setup.sh + checksums ------------------------------------------------------
sed "s/@VERSION@/$TAG/g" "$ROOT/scripts/release/setup.sh" > "$OUT/setup.sh"
chmod +x "$OUT/setup.sh"
(cd "$OUT" && sha256sum "$PKG_NAME.tar.gz" "$PKG_NAME.zip" setup.sh > checksums.txt)

# --- GitHub release notes ------------------------------------------------------
# Install instructions with the version baked in; the workflow appends
# auto-generated changelog notes via gh --generate-notes.
cat > "$OUT/notes.md" <<EOF
**Your terminal. Any device. Always.**

PersaLink is a lightweight daemon that bridges \`tmux\` sessions to a responsive web UI. Run it on your dev box, connect from your phone, tablet, or any browser on your network, and pick up exactly where you left off — sessions survive server restarts, network drops, and device switches.

## 🚀 Install

**From npm** (easiest — one command, works anywhere Node.js does):

\`\`\`bash
npm install -g persalink
persalink
\`\`\`

**Shell installer** (no npm required):

\`\`\`bash
curl -fsSL https://github.com/brobata/persalink/releases/download/$TAG/setup.sh | bash
\`\`\`

Prefer to inspect first? Download [\`setup.sh\`](https://github.com/brobata/persalink/releases/download/$TAG/setup.sh), read it, then run it.

### Manual install

1. Grab [\`$PKG_NAME.tar.gz\`](https://github.com/brobata/persalink/releases/download/$TAG/$PKG_NAME.tar.gz) (or the [zip](https://github.com/brobata/persalink/releases/download/$TAG/$PKG_NAME.zip))
2. \`tar xzf $PKG_NAME.tar.gz && cd $PKG_NAME\`
3. \`./install.sh\`
4. \`npm run start:server\` — or \`pm2 start ecosystem.config.js\` for auto-restart

Verify downloads against \`checksums.txt\` (sha256).
EOF

echo "==> Done. Artifacts in dist-release/:"
ls -la "$OUT" | grep -v "^d" | grep -v "^total"
