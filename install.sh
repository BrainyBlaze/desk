#!/usr/bin/env bash
#
# Desk installer — downloads the prebuilt standalone `desk-server` binary from
# the GitHub release and installs it. No Node, no npm, no build: the binary is
# self-contained (UI + LSP servers embedded, Bun-native terminals).
#
#   curl -fsSL https://raw.githubusercontent.com/BrainyBlaze/desk/main/install.sh | bash
#   desk-server                        # serve the web UI + API on http://127.0.0.1:5173
#
# Env overrides:
#   DESK_VERSION=v0.2.0     pin a specific release (default: the latest release)
#   DESK_INSTALL_DIR=/path  install directory (default: /usr/local/bin, else ~/.local/bin)
#
set -euo pipefail

REPO="BrainyBlaze/desk"
BIN="desk-server"

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required."

# --- detect platform → release target (matches .github/workflows/release.yml) ---
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Linux)  os_tag=linux ;;
  Darwin) os_tag=darwin ;;
  *) die "unsupported OS '$os' — Desk ships linux and macOS binaries." ;;
esac
case "$arch" in
  x86_64|amd64)  arch_tag=x64 ;;
  aarch64|arm64) arch_tag=arm64 ;;
  *) die "unsupported architecture '$arch'." ;;
esac
if [ "$os_tag" = darwin ] && [ "$arch_tag" != arm64 ]; then
  die "Desk ships macOS binaries for Apple Silicon (arm64) only; got '$arch'."
fi
target="${os_tag}-${arch_tag}"
asset="${BIN}-${target}"

# --- resolve the release version --------------------------------------------
version="${DESK_VERSION:-}"
if [ -z "$version" ]; then
  info "Resolving the latest release…"
  version="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  [ -n "$version" ] || die "could not resolve the latest release — set DESK_VERSION=vX.Y.Z."
fi
base="https://github.com/${REPO}/releases/download/${version}"
info "Installing Desk ${version} (${target})…"

# --- download + verify checksum ---------------------------------------------
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fSL --progress-bar "${base}/${asset}" -o "${tmp}/${BIN}" \
  || die "download failed: ${base}/${asset} (does the release have this asset?)"

if curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS" 2>/dev/null; then
  want="$(awk -v a="$asset" '$2 == a { print $1 }' "${tmp}/SHA256SUMS")"
  if [ -z "$want" ]; then
    warn "no checksum for ${asset} in SHA256SUMS — skipping verification."
  elif command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "${tmp}/${BIN}" | awk '{print $1}')"
    [ "$want" = "$got" ] || die "checksum mismatch for ${asset} (want ${want}, got ${got})."
    info "checksum verified."
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "${tmp}/${BIN}" | awk '{print $1}')"
    [ "$want" = "$got" ] || die "checksum mismatch for ${asset} (want ${want}, got ${got})."
    info "checksum verified."
  else
    warn "no sha256 tool found — skipping checksum verification."
  fi
else
  warn "SHA256SUMS not found for ${version} — skipping checksum verification."
fi
chmod +x "${tmp}/${BIN}"

# --- install ----------------------------------------------------------------
dir="${DESK_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ "$(id -u)" = 0 ] || { [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; }; then
    dir=/usr/local/bin
  else
    dir="$HOME/.local/bin"
  fi
fi
mkdir -p "$dir" 2>/dev/null || true

if mv "${tmp}/${BIN}" "${dir}/${BIN}" 2>/dev/null; then
  :
elif command -v sudo >/dev/null 2>&1; then
  warn "writing to ${dir} needs elevated permissions — using sudo."
  sudo mkdir -p "$dir"
  sudo mv "${tmp}/${BIN}" "${dir}/${BIN}"
else
  die "cannot write to ${dir}; set DESK_INSTALL_DIR to a writable directory and re-run."
fi

# --- runtime note + next steps ----------------------------------------------
command -v tmux >/dev/null 2>&1 \
  || warn "tmux not found — Desk needs tmux at runtime (apt install tmux / brew install tmux)."

printf '\n\033[32m✓ Desk %s installed → %s/%s\033[0m\n\n' "$version" "$dir" "$BIN"
case ":${PATH}:" in
  *":${dir}:"*) ;;
  *) warn "${dir} is not on your PATH — add it, e.g.  export PATH=\"${dir}:\$PATH\"" ;;
esac
cat <<NEXT
Next:
  ${BIN}                 # serve the web UI + API on http://127.0.0.1:5173
                        # DESK_HOST / DESK_PORT override the bind address / port

Then open the URL and add projects + agents from the UI.
NEXT
