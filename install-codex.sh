#!/bin/sh
# One-line installer for the Codex plugin `agy` (macOS / Linux):
#
#   curl -fsSL https://raw.githubusercontent.com/lvdoushacc/antigravity-acp/main/install-codex.sh | sh
#
# It copies codex/agy to ~/.codex/plugins/agy, lists it in
# ~/.agents/plugins/marketplace.json and enables it in ~/.codex/config.toml.
# Codex still asks you to trust the plugin's hook once (Settings > Hooks).
#
# Testing overrides: AGY_INSTALL_HOME (instead of $HOME), AGY_SOURCE_DIR (a
# local checkout instead of downloading from GitHub).
set -eu

REPO=lvdoushacc/antigravity-acp
BRANCH=main
NAME=agy
H=${AGY_INSTALL_HOME:-$HOME}
PLUGIN_DIR="$H/.codex/plugins/$NAME"

echo "== Antigravity (agy) for Codex =="

command -v node >/dev/null 2>&1 || { echo "error: node (Node.js 18+) is required" >&2; exit 1; }
command -v agy >/dev/null 2>&1 || echo "warning: 'agy' (Antigravity CLI) is not on PATH; the plugin needs it" >&2

TMP=""
if [ -n "${AGY_SOURCE_DIR:-}" ]; then
  SRC="$AGY_SOURCE_DIR/codex/$NAME"
else
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  echo "Downloading $REPO ($BRANCH)..."
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz -C "$TMP"
  SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)/codex/$NAME
fi
[ -f "$SRC/hooks/hooks.json" ] || { echo "error: plugin files not found at $SRC" >&2; exit 1; }

mkdir -p "$H/.codex/plugins"
rm -rf "$PLUGIN_DIR"
cp -R "$SRC" "$PLUGIN_DIR"
echo "Copied plugin to $PLUGIN_DIR"

# Marketplace entry and config.toml table, merged with node (already required).
AGY_H="$H" AGY_NAME="$NAME" node <<'EOF'
const fs = require('fs'), path = require('path');
const H = process.env.AGY_H, NAME = process.env.AGY_NAME;
const marketFile = path.join(H, '.agents', 'plugins', 'marketplace.json');
const configFile = path.join(H, '.codex', 'config.toml');
const entry = {
  name: NAME,
  source: { source: 'local', path: `./.codex/plugins/${NAME}` },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  category: 'Productivity',
};
let market = { name: 'personal-local', interface: { displayName: 'Personal Local' }, plugins: [] };
if (fs.existsSync(marketFile)) market = JSON.parse(fs.readFileSync(marketFile, 'utf8'));
market.name = market.name || 'personal-local';
market.plugins = (market.plugins || []).filter((p) => p && p.name !== NAME).concat(entry);
fs.mkdirSync(path.dirname(marketFile), { recursive: true });
fs.writeFileSync(marketFile, JSON.stringify(market, null, 2) + '\n');
console.log(`Listed in ${marketFile} (marketplace '${market.name}')`);

const table = `[plugins."${NAME}@${market.name}"]`;
let config = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
if (config.includes(table)) {
  console.log(`Already enabled in ${configFile}`);
} else {
  const sep = config && !config.endsWith('\n') ? '\n\n' : config ? '\n' : '';
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, config + sep + table + '\nenabled = true\n');
  console.log(`Enabled in ${configFile}`);
}
EOF

echo
echo "Done. Next:"
echo "  1. Restart Codex."
echo "  2. Trust the plugin hook: Settings > Hooks (desktop) or /hooks (CLI)."
echo "  3. Make sure agy is logged in once: agy acp --login"
echo "  4. In a Codex chat type:  /agy hello   (or  agy: hello)"
