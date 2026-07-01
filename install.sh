#!/usr/bin/env bash
#
# Desk installer — installs the `desk` CLI globally from this checkout, so a new
# user can then run `desk serve` (web server + UI) from anywhere.
#
#   git clone <repo> && cd desk && ./install.sh
#   desk serve
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node is required (https://nodejs.org). Install Node 20+ and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || warn "Node ${NODE_MAJOR} detected; Desk targets Node 20+."
command -v npm  >/dev/null 2>&1 || die "npm is required."
command -v tmux >/dev/null 2>&1 || warn "tmux not found — Desk needs tmux at runtime (apt install tmux / brew install tmux)."

# --- dependencies ------------------------------------------------------------
info "Installing dependencies (this builds node-pty natively)…"
if [ -f package-lock.json ]; then
  npm ci || npm install
else
  npm install
fi

# --- build the CLI -----------------------------------------------------------
info "Building the desk CLI…"
npm run build
# tsc does not set the executable bit; npm link only symlinks to this file, so
# without +x the global `desk` command fails with "Permission denied".
chmod +x dist/cli/main.js

# --- global link -------------------------------------------------------------
info "Linking the global \`desk\` command…"
if npm link 2>/dev/null; then
  :
else
  warn "npm link needed elevated permissions; retrying with sudo."
  sudo npm link
fi

command -v desk >/dev/null 2>&1 || die "Install finished but \`desk\` is not on PATH. Ensure your npm global bin dir is on PATH."

printf '\n\033[32m✓ Desk installed.\033[0m\n\n'
cat <<'NEXT'
Next:
  desk serve            # start the web server + UI on http://127.0.0.1:5173
  desk up               # start all configured agent sessions
  desk help             # all commands

Open the printed URL, then add projects and agents from the UI.
NEXT
