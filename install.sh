#!/usr/bin/env bash
# Desk source installer for supported macOS and Linux x64/arm64 hosts.
# curl is the only bootstrap prerequisite. Required host packages and pinned
# Desk-owned Node/Bun toolchains are provisioned without changing global runtimes.

set -euo pipefail

REPO="BrainyBlaze/desk"
NODE_VERSION="22.23.1"
NPM_VERSION="10.9.8"
BUN_VERSION="1.3.14"
PYTHON_MIN_VERSION="3.6"
LOCK_TOKEN=""
LOCK_OWNED=0
MAIN_COMPLETED=0
WORK_DIR=""
STAGED_RELEASE=""
PROMOTED_RELEASE=""
PYTHON_BIN=""
CXX_BIN=""
PACKAGE_MANAGER=""
OS_TAG=""
ARCH_TAG=""
HOST_LIBC=""
TARGET=""
VERSION=""
VERSION_EXPLICIT=0
RELEASE_BASE=""
LAUNCHER_DIR=""
LAUNCHER_PATH=""
PREVIOUS_RELEASE=""
MISSING_CAPABILITIES=()

info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

canonical_path() {
  local value="$1" existing suffix segment physical
  case "$value" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$value" in
    *$'\n'*|*$'\r'*|*'/../'*|*'/./'*|*'//'*) return 1 ;;
  esac
  existing="$value"
  suffix=""
  while [ ! -e "$existing" ]; do
    [ "$existing" != "/" ] || return 1
    segment="${existing##*/}"
    [ -n "$segment" ] || return 1
    suffix="/$segment$suffix"
    existing="${existing%/*}"
    [ -n "$existing" ] || existing="/"
  done
  [ -d "$existing" ] || return 1
  physical="$(cd -P -- "$existing" && pwd)" || return 1
  printf '%s%s\n' "$physical" "$suffix"
}

validate_install_paths() {
  local default_home canonical parent
  [ -n "${HOME:-}" ] || die "HOME must be set to an absolute path."
  default_home="${XDG_DATA_HOME:-$HOME/.local/share}/desk"
  DESK_HOME="${DESK_HOME:-$default_home}"
  canonical="$(canonical_path "$DESK_HOME")" || die "DESK_HOME must be an absolute canonical path: $DESK_HOME"
  [ "$canonical" = "$DESK_HOME" ] || die "DESK_HOME must already be canonical: $DESK_HOME (resolved $canonical)"
  [ "$DESK_HOME" != "/" ] || die "DESK_HOME may not be the filesystem root."
  if [ -n "${DESK_BIN_DIR:-}" ]; then
    canonical="$(canonical_path "$DESK_BIN_DIR")" || die "DESK_BIN_DIR must be an existing absolute canonical directory: $DESK_BIN_DIR"
    [ "$canonical" = "$DESK_BIN_DIR" ] || die "DESK_BIN_DIR must already be canonical: $DESK_BIN_DIR (resolved $canonical)"
    [ -d "$DESK_BIN_DIR" ] || die "DESK_BIN_DIR must be an existing directory: $DESK_BIN_DIR"
  fi
  parent="${DESK_HOME%/*}"
  [ -n "$parent" ] || parent="/"
  mkdir -p -- "$parent"
  LOCK_DIR="${DESK_HOME}.install-lock"
}

validate_requested_inputs() {
  if [ -n "${DESK_VERSION:-}" ] &&
    ! printf '%s\n' "$DESK_VERSION" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'; then
    die "DESK_VERSION must be a canonical vX.Y.Z release tag: $DESK_VERSION"
  fi
  if [ -n "${DESK_RELEASE_BASE_URL:-}" ]; then
    case "$DESK_RELEASE_BASE_URL" in file:///*) ;; *) die "DESK_RELEASE_BASE_URL supports only an absolute local file:// directory." ;; esac
    case "$DESK_RELEASE_BASE_URL" in *'?'*|*'#'*|*'@'*) die "DESK_RELEASE_BASE_URL contains forbidden URL syntax." ;; esac
    [ -n "${DESK_VERSION:-}" ] || die "DESK_VERSION is required with DESK_RELEASE_BASE_URL."
  fi
}

is_nonnegative_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

detect_target() {
  local os arch libc_output
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) OS_TAG="darwin"; HOST_LIBC="system" ;;
    Linux) OS_TAG="linux" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) die "native Windows is unsupported; use Desk from WSL (Linux)." ;;
    *) die "unsupported operating system: $os (Desk supports macOS and Linux)." ;;
  esac
  case "$arch" in
    x86_64|amd64) ARCH_TAG="x64" ;;
    arm64|aarch64) ARCH_TAG="arm64" ;;
    *) die "unsupported architecture: $arch (Desk supports x64 and arm64)." ;;
  esac
  if [ "$OS_TAG" = "linux" ]; then
    libc_output="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
    if printf '%s' "$libc_output" | grep -qi 'glibc'; then
      HOST_LIBC="glibc"
    elif ldd --version 2>&1 | grep -qi 'musl'; then
      HOST_LIBC="musl"
    else
      HOST_LIBC="unknown"
    fi
  fi
  TARGET="${OS_TAG}-${ARCH_TAG}"
}

detect_package_manager() {
  if [ "$OS_TAG" = "darwin" ]; then
    PACKAGE_MANAGER="brew"
  elif have apt-get; then
    PACKAGE_MANAGER="apt-get"
  elif have dnf; then
    PACKAGE_MANAGER="dnf"
  elif have yum; then
    PACKAGE_MANAGER="yum"
  elif have pacman; then
    PACKAGE_MANAGER="pacman"
  elif have zypper; then
    PACKAGE_MANAGER="zypper"
  elif have apk; then
    PACKAGE_MANAGER="apk"
  else
    PACKAGE_MANAGER=""
  fi
}

lock_field() {
  local field="$1"
  [ -f "$LOCK_DIR/owner" ] || return 0
  awk -F= -v wanted="$field" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$LOCK_DIR/owner"
}

release_install_lock() {
  local found
  [ "$LOCK_OWNED" -eq 1 ] || return 0
  found="$(lock_field token 2>/dev/null || true)"
  if [ "$found" = "$LOCK_TOKEN" ]; then
    rm -rf -- "$LOCK_DIR"
  else
    warn "install lock ownership changed; preserving $LOCK_DIR for inspection."
  fi
  LOCK_OWNED=0
}

acquire_install_lock() {
  local host now owner_host owner_pid owner_started stale
  host="$(uname -n)"
  now="$(date +%s)"
  LOCK_TOKEN="$$-$now-${RANDOM:-0}"
  if ! mkdir -- "$LOCK_DIR" 2>/dev/null; then
    owner_host="$(lock_field host || true)"
    owner_pid="$(lock_field pid || true)"
    owner_started="$(lock_field started || true)"
    if [ "$owner_host" = "$host" ] && is_nonnegative_integer "$owner_pid" && ! kill -0 "$owner_pid" 2>/dev/null &&
      is_nonnegative_integer "$owner_started" && [ $((now - owner_started)) -gt 600 ]; then
      stale="${LOCK_DIR}.stale.$LOCK_TOKEN"
      mv -- "$LOCK_DIR" "$stale" 2>/dev/null || die "install lock changed while checking staleness: $LOCK_DIR"
      rm -rf -- "$stale"
      mkdir -- "$LOCK_DIR" || die "could not acquire install lock: $LOCK_DIR"
    else
      die "another Desk install or uninstall owns $LOCK_DIR (host=${owner_host:-unknown}, pid=${owner_pid:-unknown})."
    fi
  fi
  cat >"$LOCK_DIR/owner" <<LOCK
token=$LOCK_TOKEN
pid=$$
host=$host
started=$now
installer=0.3.0
LOCK
  LOCK_OWNED=1
}

cleanup_on_exit() {
  set -- "$?"
  local status="$1" active=""
  if [ "$status" -eq 0 ] && [ "$MAIN_COMPLETED" -ne 1 ]; then
    status=1
  fi
  trap - EXIT
  if [ -n "$STAGED_RELEASE" ] && [ -e "$STAGED_RELEASE" ]; then
    rm -rf -- "$STAGED_RELEASE"
  fi
  if [ -n "$WORK_DIR" ] && [ -e "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR"
  fi
  if [ "$status" -ne 0 ] && [ -n "$PROMOTED_RELEASE" ] && [ -d "$PROMOTED_RELEASE" ]; then
    active="$(current_release_path 2>/dev/null || true)"
    if [ "$active" != "$PROMOTED_RELEASE" ]; then
      rm -rf -- "$PROMOTED_RELEASE"
    fi
  fi
  release_install_lock
  exit "$status"
}

version_ge() {
  awk -v actual="$1" -v minimum="$2" 'BEGIN {
    gsub(/[^0-9.].*$/, "", actual); gsub(/[^0-9.].*$/, "", minimum);
    na=split(actual,a,"."); nb=split(minimum,b,"."); n=na>nb?na:nb;
    for(i=1;i<=n;i++){av=(i<=na?a[i]:0)+0; bv=(i<=nb?b[i]:0)+0; if(av>bv)exit 0; if(av<bv)exit 1}
    exit 0
  }'
}

probe_python() {
  local candidate value
  PYTHON_BIN=""
  for candidate in python3 python; do
    have "$candidate" || continue
    value="$($candidate -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
    if [ -n "$value" ] && version_ge "$value" "$PYTHON_MIN_VERSION"; then
      PYTHON_BIN="$(command -v "$candidate")"
      return 0
    fi
  done
  return 1
}

probe_compiler() {
  local candidate probe
  CXX_BIN=""
  have make || return 1
  probe="$(mktemp -d "${TMPDIR:-/tmp}/desk-compiler-probe.XXXXXX")" || return 1
  printf '%s\n' 'int main(){return 0;}' >"$probe/probe.cc"
  for candidate in c++ g++ clang++; do
    have "$candidate" || continue
    if "$candidate" "$probe/probe.cc" -o "$probe/probe" >/dev/null 2>&1 && "$probe/probe"; then
      CXX_BIN="$(command -v "$candidate")"
      rm -rf -- "$probe"
      return 0
    fi
  done
  rm -rf -- "$probe"
  return 1
}

probe_sha256() {
  if have sha256sum; then
    SHA256_TOOL="sha256sum"
  elif have shasum && shasum -a 256 /dev/null >/dev/null 2>&1; then
    SHA256_TOOL="shasum"
  else
    return 1
  fi
}

probe_tmux() {
  local value
  have tmux || return 1
  value="$(tmux -V 2>/dev/null | awk '{print $2}')"
  [ -n "$value" ] && version_ge "$value" "3.2"
}

probe_git() {
  local value
  have git || return 1
  value="$(git --version 2>/dev/null | awk '{print $3}')"
  [ -n "$value" ] && version_ge "$value" "2.30"
}

probe_bootstrap_capabilities() {
  have curl || MISSING_CAPABILITIES+=("curl/TLS")
  have tar || MISSING_CAPABILITIES+=("tar")
  have gzip || MISSING_CAPABILITIES+=("gzip")
  probe_sha256 || MISSING_CAPABILITIES+=("SHA-256")
}

probe_host_capabilities() {
  MISSING_CAPABILITIES=()
  probe_bootstrap_capabilities
  probe_tmux || MISSING_CAPABILITIES+=("tmux>=3.2")
  probe_git || MISSING_CAPABILITIES+=("git>=2.30")
  probe_python || MISSING_CAPABILITIES+=("python>=${PYTHON_MIN_VERSION}")
  have make || MISSING_CAPABILITIES+=("make")
  probe_compiler || MISSING_CAPABILITIES+=("working C++ compiler")
}

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    have sudo || die "missing host capabilities require administrator installation, but sudo is unavailable: ${MISSING_CAPABILITIES[*]}"
    sudo "$@"
  fi
}

ensure_macos_tooling() {
  local deadline brew_path bootstrap
  if ! xcode-select -p >/dev/null 2>&1; then
    info "Requesting Apple Command Line Tools…"
    xcode-select --install >/dev/null 2>&1 || true
    deadline=$(( $(date +%s) + 900 ))
    until xcode-select -p >/dev/null 2>&1; do
      [ "$(date +%s)" -lt "$deadline" ] || die "Apple Command Line Tools installation did not finish within 15 minutes."
      sleep 5
    done
  fi
  if ! have brew; then
    info "Installing Homebrew from the official installer…"
    bootstrap="$(mktemp "${TMPDIR:-/tmp}/desk-homebrew.XXXXXX")"
    curl -fsSL --proto '=https' https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$bootstrap"
    NONINTERACTIVE=1 /bin/bash "$bootstrap"
    rm -f -- "$bootstrap"
    for brew_path in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      if [ -x "$brew_path" ]; then
        eval "$("$brew_path" shellenv)"
        break
      fi
    done
  fi
  have brew || die "Homebrew installation completed but brew is not available."
  eval "$(brew shellenv)"
}

install_missing_packages() {
  local packages=()
  [ -n "${MISSING_CAPABILITIES[*]-}" ] || return 0
  detect_package_manager
  [ -n "$PACKAGE_MANAGER" ] || die "missing required host capabilities and no supported package manager was found: ${MISSING_CAPABILITIES[*]}"
  info "Provisioning required host capabilities (${MISSING_CAPABILITIES[*]}) with ${PACKAGE_MANAGER}…"
  case "$PACKAGE_MANAGER" in
    brew)
      ensure_macos_tooling
      packages=(tmux git python coreutils gnu-tar)
      brew install "${packages[@]}"
      ;;
    apt-get)
      packages=(ca-certificates curl tar gzip coreutils tmux git python3 make g++)
      run_privileged apt-get update
      run_privileged apt-get install -y "${packages[@]}"
      ;;
    dnf|yum)
      packages=(ca-certificates curl tar gzip coreutils tmux git python3 make gcc-c++)
      run_privileged "$PACKAGE_MANAGER" install -y "${packages[@]}"
      ;;
    pacman)
      packages=(ca-certificates curl tar gzip coreutils tmux git python make gcc)
      run_privileged pacman -Sy --needed --noconfirm "${packages[@]}"
      ;;
    zypper)
      packages=(ca-certificates curl tar gzip coreutils tmux git python3 make gcc gcc-c++)
      run_privileged zypper --non-interactive install "${packages[@]}"
      ;;
    apk)
      packages=(ca-certificates curl tar gzip coreutils tmux git python3 make build-base)
      run_privileged apk add "${packages[@]}"
      ;;
    *) die "unsupported package manager: $PACKAGE_MANAGER" ;;
  esac
}

verify_host_capabilities() {
  probe_host_capabilities
  [ -z "${MISSING_CAPABILITIES[*]-}" ] || die "host provisioning finished but capabilities remain unsatisfied: ${MISSING_CAPABILITIES[*]}"
}

sha256_file() {
  if [ "$SHA256_TOOL" = "sha256sum" ]; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

validate_release_version() {
  "$PYTHON_BIN" - "$1" <<'PY'
import re, sys
value=sys.argv[1]
pattern=r"v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
match=re.fullmatch(pattern, value)
if match is None:
    raise SystemExit(1)
prerelease=match.group(1)
if prerelease is not None and any(part.isdigit() and len(part) > 1 and part.startswith("0") for part in prerelease.split(".")):
    raise SystemExit(1)
PY
}

current_release_path() {
  local resolved releases
  [ -L "$DESK_HOME/current" ] || return 1
  resolved="$(cd -P -- "$DESK_HOME/current" 2>/dev/null && pwd)" || return 1
  releases="$(cd -P -- "$DESK_HOME/releases" 2>/dev/null && pwd)" || return 1
  case "$resolved/" in
    "$releases"/*) printf '%s\n' "$resolved" ;;
    *) return 1 ;;
  esac
}

current_release_version() {
  local release
  release="$(current_release_path)" || return 1
  "$PYTHON_BIN" - "$release/.desk-release" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f: data=json.load(f)
if data.get("schemaVersion") != 1 or data.get("managedBy") != "desk-installer": raise SystemExit(1)
print(data["version"])
PY
}

semver_compare() {
  "$PYTHON_BIN" - "$1" "$2" <<'PY'
import re, sys
def parse(value):
    m=re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?", value)
    if not m: raise SystemExit(2)
    base=tuple(map(int,m.group(1,2,3)))
    pre=m.group(4)
    return base, None if pre is None else pre.split(".")
def compare_identifiers(left, right):
    for a, b in zip(left, right):
        if a == b: continue
        a_numeric, b_numeric = a.isdigit(), b.isdigit()
        if a_numeric and b_numeric: return -1 if int(a) < int(b) else 1
        if a_numeric != b_numeric: return -1 if a_numeric else 1
        return -1 if a < b else 1
    return (len(left) > len(right)) - (len(left) < len(right))
a, b=parse(sys.argv[1]), parse(sys.argv[2])
if a[0] != b[0]: result=-1 if a[0] < b[0] else 1
elif a[1] == b[1]: result=0
elif a[1] is None: result=1
elif b[1] is None: result=-1
else: result=compare_identifiers(a[1], b[1])
print(result)
PY
}

resolve_release_version() {
  local latest_json current comparison
  VERSION="${DESK_VERSION:-}"
  if [ -n "$VERSION" ]; then
    VERSION_EXPLICIT=1
  else
    [ -z "${DESK_RELEASE_BASE_URL:-}" ] || die "DESK_VERSION is required with DESK_RELEASE_BASE_URL."
    info "Resolving the latest Desk release…"
    latest_json="$WORK_DIR/latest.json"
    curl -fsSL --proto '=https' "https://api.github.com/repos/${REPO}/releases/latest" -o "$latest_json"
    VERSION="$($PYTHON_BIN - "$latest_json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f: data=json.load(f)
value=data.get("tag_name")
if not isinstance(value, str): raise SystemExit(1)
print(value)
PY
)" || die "could not resolve the latest release; set DESK_VERSION=vX.Y.Z."
  fi
  validate_release_version "$VERSION" || die "DESK_VERSION must be a canonical vX.Y.Z release tag: $VERSION"
  if [ "$VERSION_EXPLICIT" -eq 0 ] && current="$(current_release_version 2>/dev/null)"; then
    comparison="$(semver_compare "$VERSION" "$current")"
    [ "$comparison" -ge 0 ] || die "latest resolution returned $VERSION, older than installed $current; refusing a silent downgrade. Set DESK_VERSION explicitly to downgrade."
  fi
  if [ -n "${DESK_RELEASE_BASE_URL:-}" ]; then
    case "$DESK_RELEASE_BASE_URL" in
      file:///*) ;;
      *) die "DESK_RELEASE_BASE_URL supports only an absolute local file:// directory." ;;
    esac
    case "$DESK_RELEASE_BASE_URL" in *'?'*|*'#'*|*'@'*) die "DESK_RELEASE_BASE_URL contains forbidden URL syntax." ;; esac
    RELEASE_BASE="${DESK_RELEASE_BASE_URL%/}"
  else
    RELEASE_BASE="https://github.com/${REPO}/releases/download/${VERSION}"
  fi
}

download_file() {
  local url="$1" destination="$2"
  case "$url" in
    https://*|file:///*) ;;
    *) die "refusing non-HTTPS/non-local download: $url" ;;
  esac
  curl -fsSL --retry 3 --connect-timeout 30 "$url" -o "$destination"
}

checksum_entry() {
  "$PYTHON_BIN" - "$1" "$2" <<'PY'
import re, sys
path, wanted=sys.argv[1:]
matches=[]
with open(path, encoding="ascii") as f:
    for line in f:
        m=re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)\n?", line)
        if m is None: raise SystemExit("invalid SHA256SUMS line")
        if m.group(2)==wanted: matches.append(m.group(1))
if len(matches)!=1: raise SystemExit(f"expected one checksum for {wanted}, found {len(matches)}")
print(matches[0])
PY
}

download_release_metadata() {
  local manifest_digest actual
  CHECKSUMS_FILE="$WORK_DIR/SHA256SUMS"
  INSTALL_MANIFEST_FILE="$WORK_DIR/desk-install-manifest.json"
  download_file "$RELEASE_BASE/SHA256SUMS" "$CHECKSUMS_FILE"
  download_file "$RELEASE_BASE/desk-install-manifest.json" "$INSTALL_MANIFEST_FILE"
  manifest_digest="$(checksum_entry "$CHECKSUMS_FILE" desk-install-manifest.json)" || die "release checksum manifest has no unique install-manifest checksum."
  actual="$(sha256_file "$INSTALL_MANIFEST_FILE")"
  [ "$actual" = "$manifest_digest" ] || die "checksum mismatch for desk-install-manifest.json."
}

expected_node_sha() {
  case "$TARGET" in
    darwin-arm64) printf '%s\n' ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953 ;;
    darwin-x64) printf '%s\n' b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81 ;;
    linux-arm64) printf '%s\n' 543fa39e57d4c07855939459a323f4deb9a79dd1bb45e6e99458b0f2de10db8d ;;
    linux-x64) printf '%s\n' 7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129 ;;
    *) return 1 ;;
  esac
}

expected_bun_sha() {
  case "$TARGET" in
    darwin-arm64) printf '%s\n' d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620 ;;
    darwin-x64) printf '%s\n' 3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076 ;;
    linux-arm64) printf '%s\n' a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b ;;
    linux-x64) printf '%s\n' a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7 ;;
    *) return 1 ;;
  esac
}

validate_install_manifest() {
  local values manifest_node_sha manifest_bun_sha sums_source
  values="$($PYTHON_BIN - "$INSTALL_MANIFEST_FILE" "$VERSION" "$TARGET" "$HOST_LIBC" <<'PY'
import json, re, sys
path, version, target, host_libc=sys.argv[1:]
asset_re=re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
digest_re=re.compile(r"[0-9a-f]{64}")
def exact(obj, keys, label):
    if not isinstance(obj, dict) or set(obj) != set(keys): raise SystemExit(f"invalid {label} keys")
with open(path, encoding="utf-8") as f: data=json.load(f)
exact(data, ["schemaVersion","version","source","node","bun"], "manifest")
if data["schemaVersion"] != 1 or data["version"] != version: raise SystemExit("manifest schema/version mismatch")
exact(data["source"], ["asset","sha256"], "source")
exact(data["node"], ["version","npmVersion","targets"], "node")
exact(data["bun"], ["version","tag","targets"], "bun")
if data["node"]["version"]!="22.23.1" or data["node"]["npmVersion"]!="10.9.8": raise SystemExit("unexpected Node/npm pin")
if data["bun"]["version"]!="1.3.14" or data["bun"]["tag"]!="bun-v1.3.14": raise SystemExit("unexpected Bun pin")
source=data["source"]
if source["asset"] != f"desk-{version}-source.tar.gz": raise SystemExit("unexpected source asset")
for value in (source["asset"],):
    if asset_re.fullmatch(value) is None: raise SystemExit("invalid asset basename")
if digest_re.fullmatch(source["sha256"]) is None: raise SystemExit("invalid source digest")
expected_targets={"darwin-arm64","darwin-x64","linux-arm64","linux-x64"}
for kind in ("node","bun"):
    targets=data[kind]["targets"]
    if set(targets) != expected_targets: raise SystemExit(f"invalid {kind} target set")
    for name, entry in targets.items():
        exact(entry, ["os","arch","libc","asset","sha256"], f"{kind}.{name}")
        expected_os, expected_arch=name.split("-")
        expected_libc="glibc" if expected_os=="linux" else "system"
        if (entry["os"],entry["arch"],entry["libc"]) != (expected_os,expected_arch,expected_libc): raise SystemExit(f"invalid {kind}.{name} identity")
        if asset_re.fullmatch(entry["asset"]) is None or digest_re.fullmatch(entry["sha256"]) is None: raise SystemExit(f"invalid {kind}.{name} asset")
if host_libc != ("glibc" if target.startswith("linux-") else "system"):
    raise SystemExit(f"unsupported libc {host_libc} for {target}; no compatible Node toolchain is published")
node=data["node"]["targets"][target]; bun=data["bun"]["targets"][target]
print("\t".join([source["asset"],source["sha256"],node["asset"],node["sha256"],bun["asset"],bun["sha256"]]))
PY
)" || die "release install manifest is invalid for $TARGET/$HOST_LIBC."
  IFS=$'\t' read -r SOURCE_ASSET SOURCE_SHA NODE_ASSET NODE_SHA BUN_ASSET BUN_SHA <<<"$values"
  manifest_node_sha="$(expected_node_sha)"
  manifest_bun_sha="$(expected_bun_sha)"
  [ "$NODE_SHA" = "$manifest_node_sha" ] || die "manifest Node checksum does not match the pinned $TARGET toolchain."
  [ "$BUN_SHA" = "$manifest_bun_sha" ] || die "manifest Bun checksum does not match the pinned $TARGET toolchain."
  sums_source="$(checksum_entry "$CHECKSUMS_FILE" "$SOURCE_ASSET")" || die "release checksum manifest has no unique source checksum."
  [ "$sums_source" = "$SOURCE_SHA" ] || die "source checksum disagrees between release manifests."
}

download_and_verify_asset() {
  local url="$1" destination="$2" expected="$3" label="$4" actual
  download_file "$url" "$destination"
  actual="$(sha256_file "$destination")"
  [ "$actual" = "$expected" ] || die "checksum mismatch for $label (expected $expected, got $actual)."
}

safe_extract() {
  "$PYTHON_BIN" - "$1" "$2" "$3" <<'PY'
import os, pathlib, shutil, stat, sys, tarfile, zipfile
archive, kind, destination=sys.argv[1:]
dest=os.path.realpath(destination)
os.makedirs(dest, mode=0o700, exist_ok=False)
seen=set(); roots=set(); records=[]
def normalized(name):
    if "\\" in name or name.startswith("/") or "\x00" in name: raise ValueError(f"unsafe archive path: {name!r}")
    parts=[p for p in pathlib.PurePosixPath(name).parts if p not in ("", ".")]
    if not parts or ".." in parts: raise ValueError(f"unsafe archive path: {name!r}")
    value="/".join(parts)
    if value in seen: raise ValueError(f"duplicate archive path: {value}")
    seen.add(value); roots.add(parts[0]); return value
def safe_mode(mode, is_dir=False):
    if mode & 0o7000 or mode & 0o002: raise ValueError(f"unsafe archive mode: {mode:o}")
    return (mode & 0o755) or (0o755 if is_dir else 0o644)
def inside(path):
    resolved=os.path.realpath(path)
    if os.path.commonpath([dest,resolved]) != dest: raise ValueError(f"archive path escaped staging: {path}")
def safe_link(member_name, target, relative):
    if not target or target.startswith("/") or "\\" in target: raise ValueError("unsafe archive link")
    base=pathlib.PurePosixPath(member_name).parent if relative else pathlib.PurePosixPath()
    parts=[]
    for part in (base / target).parts:
        if part in ("", "."): continue
        if part=="..":
            if not parts: raise ValueError("archive link escaped root")
            parts.pop()
        else: parts.append(part)
    if not parts or parts[0] not in roots: raise ValueError("archive link escaped root")
    return "/".join(parts)
if kind=="tar":
    with tarfile.open(archive, "r:*") as source:
        for member in source.getmembers():
            name=normalized(member.name)
            if member.isdev(): raise ValueError("special archive entry rejected")
            if not (member.isdir() or member.isfile() or member.issym() or member.islnk()): raise ValueError("unsupported archive entry")
            mode=0o777 if (member.issym() or member.islnk()) else safe_mode(member.mode, member.isdir())
            link=None
            if member.issym(): link=safe_link(name, member.linkname, True)
            if member.islnk(): link=safe_link(name, member.linkname, False)
            records.append((name,member,mode,link))
        if len(roots)!=1: raise ValueError("archive must contain exactly one root")
        for name,member,mode,link in records:
            target=os.path.join(dest,*name.split("/")); inside(os.path.dirname(target)); os.makedirs(os.path.dirname(target),mode=0o755,exist_ok=True)
            if member.isdir(): os.makedirs(target,mode=mode,exist_ok=True); os.chmod(target,mode)
            elif member.isfile():
                stream=source.extractfile(member)
                if stream is None: raise ValueError("archive file has no data")
                with stream, open(target,"xb") as output: shutil.copyfileobj(stream,output)
                os.chmod(target,mode)
        for name,member,mode,link in records:
            if link is None: continue
            target=os.path.join(dest,*name.split("/")); link_target=os.path.join(dest,*link.split("/")); inside(link_target)
            if member.issym(): os.symlink(member.linkname,target)
            else:
                if not os.path.isfile(link_target): raise ValueError("hardlink target is not a file")
                os.link(link_target,target)
elif kind=="zip":
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            name=normalized(member.filename)
            raw_mode=(member.external_attr >> 16) & 0xffff
            file_type=stat.S_IFMT(raw_mode)
            is_dir=member.is_dir()
            if file_type not in (0,stat.S_IFREG,stat.S_IFDIR): raise ValueError("special ZIP entry rejected")
            mode=safe_mode(raw_mode & 0o777 if raw_mode else (0o755 if is_dir else 0o644),is_dir)
            records.append((name,member,mode,is_dir))
        if len(roots)!=1: raise ValueError("archive must contain exactly one root")
        for name,member,mode,is_dir in records:
            target=os.path.join(dest,*name.split("/")); inside(os.path.dirname(target)); os.makedirs(os.path.dirname(target),mode=0o755,exist_ok=True)
            if is_dir: os.makedirs(target,mode=mode,exist_ok=True); os.chmod(target,mode)
            else:
                with source.open(member) as stream, open(target,"xb") as output: shutil.copyfileobj(stream,output)
                os.chmod(target,mode)
else: raise ValueError("unknown archive kind")
for root, dirs, files in os.walk(dest, followlinks=False):
    inside(root)
    for name in dirs+files: inside(os.path.join(root,name))
PY
}

write_toolchain_manifest() {
  "$PYTHON_BIN" - "$1" "$2" "$3" "$4" "$5" "$6" "$7" <<'PY'
import json, os, sys
path,kind,version,target,libc,asset,digest=sys.argv[1:]
data={"schemaVersion":1,"managedBy":"desk-installer","kind":kind,"version":version,"target":target,"libc":libc,"asset":asset,"sha256":digest}
if kind=="node": data["npmVersion"]="10.9.8"
with open(path,"x",encoding="utf-8") as f: json.dump(data,f,sort_keys=True,indent=2); f.write("\n")
os.chmod(path,0o600)
PY
}

verify_toolchain_manifest() {
  "$PYTHON_BIN" - "$1" "$2" "$3" "$4" "$5" "$6" <<'PY'
import json, os, sys
path,kind,version,target,libc,digest=sys.argv[1:]
with open(path,encoding="utf-8") as f: data=json.load(f)
expected={"schemaVersion":1,"managedBy":"desk-installer","kind":kind,"version":version,"target":target,"libc":libc,"sha256":digest}
if any(data.get(k)!=v for k,v in expected.items()): raise SystemExit(1)
if os.stat(path).st_uid != os.getuid(): raise SystemExit(1)
PY
}

probe_node_toolchain() {
  local root="$1"
  [ "$($root/bin/node --version 2>/dev/null)" = "v$NODE_VERSION" ] &&
    [ "$($root/bin/npm --version 2>/dev/null)" = "$NPM_VERSION" ]
}

probe_bun_toolchain() {
  local root="$1" probe status
  [ "$($root/bun --version 2>/dev/null)" = "$BUN_VERSION" ] || return 1
  probe="$(mktemp -d "$DESK_HOME/.bun-probe.XXXXXX")"
  printf '%s\n' 'console.log("desk-bun-probe")' >"$probe/input.ts"
  status=0
  "$root/bun" build --compile "$probe/input.ts" --outfile "$probe/probe" >/dev/null 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then "$probe/probe" >/dev/null 2>&1 || status=$?; fi
  rm -rf -- "$probe"
  [ "$status" -eq 0 ]
}

ensure_node_toolchain() {
  local final archive extract root stage expected_root url
  final="$DESK_HOME/toolchains/node-$NODE_VERSION"
  if [ -d "$final" ]; then
    verify_toolchain_manifest "$final/.desk-toolchain" node "$NODE_VERSION" "$TARGET" "$HOST_LIBC" "$NODE_SHA" && probe_node_toolchain "$final" ||
      die "cached Desk Node toolchain is invalid: $final (run the ownership-safe uninstall before reinstalling)."
    NODE_ROOT="$final"
    return
  fi
  archive="$WORK_DIR/$NODE_ASSET"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ASSET}"
  download_and_verify_asset "$url" "$archive" "$NODE_SHA" "$NODE_ASSET"
  extract="$WORK_DIR/node-extract"
  safe_extract "$archive" tar "$extract" || die "unsafe or invalid Node archive: $NODE_ASSET"
  expected_root="${NODE_ASSET%.tar.gz}"
  root="$extract/$expected_root"
  [ -d "$root" ] || die "Node archive root mismatch: expected $expected_root"
  probe_node_toolchain "$root" || die "downloaded Node/npm toolchain failed exact version probes."
  write_toolchain_manifest "$root/.desk-toolchain" node "$NODE_VERSION" "$TARGET" "$HOST_LIBC" "$NODE_ASSET" "$NODE_SHA"
  stage="$DESK_HOME/toolchains/.node-$LOCK_TOKEN"
  mv -- "$root" "$stage"
  mv -- "$stage" "$final"
  NODE_ROOT="$final"
}

ensure_bun_toolchain() {
  local final archive extract root stage expected_root url
  final="$DESK_HOME/toolchains/bun-$BUN_VERSION"
  if [ -d "$final" ]; then
    verify_toolchain_manifest "$final/.desk-toolchain" bun "$BUN_VERSION" "$TARGET" "$HOST_LIBC" "$BUN_SHA" && probe_bun_toolchain "$final" ||
      die "cached Desk Bun toolchain is invalid: $final (run the ownership-safe uninstall before reinstalling)."
    BUN_ROOT="$final"
    return
  fi
  archive="$WORK_DIR/$BUN_ASSET"
  url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ASSET}"
  download_and_verify_asset "$url" "$archive" "$BUN_SHA" "$BUN_ASSET"
  extract="$WORK_DIR/bun-extract"
  safe_extract "$archive" zip "$extract" || die "unsafe or invalid Bun archive: $BUN_ASSET"
  expected_root="${BUN_ASSET%.zip}"
  root="$extract/$expected_root"
  [ -x "$root/bun" ] || die "Bun archive root mismatch: expected $expected_root/bun"
  probe_bun_toolchain "$root" || die "downloaded Bun toolchain failed exact version/compile probes."
  write_toolchain_manifest "$root/.desk-toolchain" bun "$BUN_VERSION" "$TARGET" "$HOST_LIBC" "$BUN_ASSET" "$BUN_SHA"
  stage="$DESK_HOME/toolchains/.bun-$LOCK_TOKEN"
  mv -- "$root" "$stage"
  mv -- "$stage" "$final"
  BUN_ROOT="$final"
}

build_release() {
  local archive extract source_root install_id version_dir final runtime_path
  archive="$WORK_DIR/$SOURCE_ASSET"
  download_and_verify_asset "$RELEASE_BASE/$SOURCE_ASSET" "$archive" "$SOURCE_SHA" "$SOURCE_ASSET"
  extract="$WORK_DIR/source-extract"
  safe_extract "$archive" tar "$extract" || die "unsafe or invalid Desk source archive: $SOURCE_ASSET"
  source_root="$extract/desk-$VERSION"
  [ -f "$source_root/package.json" ] || die "Desk source archive root mismatch: expected desk-$VERSION"
  install_id="$(date +%Y%m%d%H%M%S)-$$-${RANDOM:-0}"
  version_dir="$DESK_HOME/releases/$VERSION"
  mkdir -p -- "$version_dir"
  STAGED_RELEASE="$DESK_HOME/releases/.staging-$install_id"
  mv -- "$source_root" "$STAGED_RELEASE"
  info "Installing locked application dependencies with Desk Node ${NODE_VERSION}…"
  (
    cd "$STAGED_RELEASE"
    PATH="$NODE_ROOT/bin:$BUN_ROOT:$PATH" "$NODE_ROOT/bin/npm" ci
    PATH="$NODE_ROOT/bin:$BUN_ROOT:$PATH" "$NODE_ROOT/bin/npm" run build:distribution
  )
  [ -x "$STAGED_RELEASE/dist/cli/main.js" ] || die "distribution build did not produce dist/cli/main.js."
  [ -x "$STAGED_RELEASE/libexec/desk-standalone" ] || die "distribution build did not produce libexec/desk-standalone."
  mkdir -p -- "$STAGED_RELEASE/runtime"
  runtime_path="$NODE_ROOT/bin/node"
  ln -s -- "$runtime_path" "$STAGED_RELEASE/runtime/node"
  "$PYTHON_BIN" - "$STAGED_RELEASE/.desk-release" "$VERSION" "$install_id" "$TARGET" "$HOST_LIBC" "$SOURCE_SHA" <<'PY'
import json, os, sys
path,version,install_id,target,libc,source_sha=sys.argv[1:]
data={"schemaVersion":1,"managedBy":"desk-installer","version":version,"installId":install_id,"target":target,"libc":libc,"sourceSha256":source_sha,"nodeVersion":"22.23.1","bunVersion":"1.3.14"}
with open(path,"x",encoding="utf-8") as f: json.dump(data,f,sort_keys=True,indent=2); f.write("\n")
os.chmod(path,0o600)
PY
  HOME="$HOME" DESK_HOME="$DESK_HOME" "$STAGED_RELEASE/runtime/node" "$STAGED_RELEASE/dist/cli/main.js" help >/dev/null
  final="$version_dir/$install_id"
  mv -- "$STAGED_RELEASE" "$final"
  STAGED_RELEASE=""
  PROMOTED_RELEASE="$final"
}

directory_permissions() {
  if stat -c '%a %u' "$1" >/dev/null 2>&1; then stat -c '%a %u' "$1"; else stat -f '%Lp %u' "$1"; fi
}

safe_path_directory() {
  local directory="$1" canonical permissions mode owner group_digit world_digit
  case "$directory" in /*) ;; *) return 1 ;; esac
  [ -d "$directory" ] || return 1
  canonical="$(cd -P -- "$directory" && pwd)" || return 1
  [ "$canonical" = "$directory" ] || return 1
  permissions="$(directory_permissions "$directory")" || return 1
  mode="${permissions%% *}"; owner="${permissions##* }"
  group_digit="${mode: -2:1}"; world_digit="${mode: -1}"
  case "$group_digit$world_digit" in *[2367]*) return 1 ;; esac
  [ "$owner" = "$(id -u)" ] || [ "$owner" = "0" ] || return 1
}

path_contains_directory() {
  local wanted="$1" entry old_ifs="$IFS"
  IFS=:
  for entry in $PATH; do
    [ -n "$entry" ] || continue
    if [ "$entry" = "$wanted" ]; then IFS="$old_ifs"; return 0; fi
  done
  IFS="$old_ifs"
  return 1
}

recognized_desk_candidate() {
  local candidate="$1" marker_home
  if [ -f "$candidate" ] && grep -Fqx '# desk-managed-launcher-v1' "$candidate"; then
    marker_home="$(awk -F': ' '$1 == "# desk-home" {print substr($0,index($0,": ")+2); exit}' "$candidate")"
    [ "$marker_home" = "$DESK_HOME" ]
    return
  fi
  [ -L "$candidate" ] || return 1
  "$PYTHON_BIN" - "$candidate" <<'PY'
import json, os, sys
path=os.path.realpath(sys.argv[1]); current=os.path.dirname(path)
for _ in range(10):
    package=os.path.join(current,"package.json")
    try:
        with open(package,encoding="utf-8") as f: data=json.load(f)
        if data.get("name")=="desk": raise SystemExit(0)
    except (OSError,ValueError): pass
    parent=os.path.dirname(current)
    if parent==current: break
    current=parent
raise SystemExit(1)
PY
}

select_launcher_destination() {
  local entry old_ifs="$IFS" first_writable="" system_candidate="" candidate unsafe_directory override_seen=0
  if [ -n "${DESK_BIN_DIR:-}" ]; then
    path_contains_directory "$DESK_BIN_DIR" || die "DESK_BIN_DIR must already be present on PATH for immediate command resolution: $DESK_BIN_DIR"
    safe_path_directory "$DESK_BIN_DIR" || die "DESK_BIN_DIR is not a safe canonical PATH directory: $DESK_BIN_DIR"
  fi
  IFS=:
  for entry in $PATH; do
    case "$entry" in
      '') unsafe_directory="$PWD" ;;
      .) unsafe_directory="$PWD" ;;
      /*) unsafe_directory="$entry" ;;
      *) unsafe_directory="$PWD/$entry" ;;
    esac
    if [ -z "$entry" ] || [ "$entry" = "." ] || ! safe_path_directory "$entry"; then
      if [ -e "$unsafe_directory/desk" ] || [ -L "$unsafe_directory/desk" ]; then
        IFS="$old_ifs"
        die "unsafe PATH entry contains a shadowing Desk command: $unsafe_directory/desk"
      fi
      continue
    fi
    if [ -n "${DESK_BIN_DIR:-}" ] && [ "$entry" = "$DESK_BIN_DIR" ]; then override_seen=1; fi
    candidate="$entry/desk"
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      if [ -n "${DESK_BIN_DIR:-}" ] && [ "$override_seen" -eq 1 ] && [ "$entry" != "$DESK_BIN_DIR" ]; then
        continue
      fi
      if ! recognized_desk_candidate "$candidate"; then
        IFS="$old_ifs"
        die "unidentified Desk command shadows installation at $candidate; move it or set PATH safely before installing."
      fi
      if [ -n "${DESK_BIN_DIR:-}" ] && [ "$entry" != "$DESK_BIN_DIR" ]; then
        if [ "$override_seen" -eq 0 ]; then
          IFS="$old_ifs"
          die "recognized Desk command at $candidate would shadow DESK_BIN_DIR=$DESK_BIN_DIR."
        fi
        continue
      fi
      LAUNCHER_DIR="$entry"; LAUNCHER_PATH="$candidate"; IFS="$old_ifs"; return
    fi
    if [ -z "$first_writable" ] && [ -w "$entry" ]; then first_writable="$entry"; fi
    if [ -z "$system_candidate" ] && { [ "$entry" = "/usr/local/bin" ] || [ "$entry" = "/opt/homebrew/bin" ]; }; then system_candidate="$entry"; fi
  done
  IFS="$old_ifs"
  if [ -n "${DESK_BIN_DIR:-}" ]; then
    LAUNCHER_DIR="$DESK_BIN_DIR"
  elif [ -n "$first_writable" ]; then
    LAUNCHER_DIR="$first_writable"
  elif [ -n "$system_candidate" ] && { [ "$(id -u)" -eq 0 ] || have sudo; }; then
    LAUNCHER_DIR="$system_candidate"
  else
    die "no safe launcher directory on PATH is writable; add a safe directory to PATH or set DESK_BIN_DIR to one already present."
  fi
  LAUNCHER_PATH="$LAUNCHER_DIR/desk"
}

create_launcher_file() {
  "$PYTHON_BIN" - "$1" "$DESK_HOME" <<'PY'
import os, shlex, sys
path, home=sys.argv[1:]
text=f'''#!/bin/sh
# desk-managed-launcher-v1
# desk-home: {home}
set -eu
managed_home={shlex.quote(home)}
if [ "${{DESK_HOME:-$managed_home}}" != "$managed_home" ]; then
  printf 'desk: DESK_HOME does not match this managed launcher\\n' >&2
  exit 1
fi
release=$(cd -P -- "$managed_home/current" 2>/dev/null && pwd) || {{ printf 'desk: no active release; reinstall Desk\\n' >&2; exit 1; }}
releases=$(cd -P -- "$managed_home/releases" 2>/dev/null && pwd) || exit 1
case "$release/" in "$releases"/*) ;; *) printf 'desk: active release escapes managed home\\n' >&2; exit 1 ;; esac
[ -f "$release/.desk-release" ] || {{ printf 'desk: active release is not managed\\n' >&2; exit 1; }}
[ -x "$release/runtime/node" ] || {{ printf 'desk: release Node runtime is missing\\n' >&2; exit 1; }}
[ -x "$release/dist/cli/main.js" ] || {{ printf 'desk: release CLI is missing\\n' >&2; exit 1; }}
exec "$release/runtime/node" "$release/dist/cli/main.js" "$@"
'''
with open(path,"x",encoding="utf-8") as f: f.write(text)
os.chmod(path,0o755)
PY
}

remove_launcher_path() {
  if [ -w "$LAUNCHER_DIR" ]; then rm -f -- "$LAUNCHER_PATH"; else run_privileged rm -f -- "$LAUNCHER_PATH"; fi
}

install_launcher_file() {
  local source="$1" temporary
  if [ -w "$LAUNCHER_DIR" ]; then
    temporary="$(mktemp "$LAUNCHER_DIR/.desk-launcher.XXXXXX")"
    install -m 0755 "$source" "$temporary"
    mv -f -- "$temporary" "$LAUNCHER_PATH"
  else
    temporary="$LAUNCHER_DIR/.desk-launcher.$LOCK_TOKEN"
    run_privileged install -m 0755 "$source" "$temporary"
    run_privileged mv -f -- "$temporary" "$LAUNCHER_PATH"
  fi
}

restore_launcher() {
  local type="$1" backup="$2" link_target="$3" temporary
  case "$type" in
    none) remove_launcher_path ;;
    file) install_launcher_file "$backup" ;;
    symlink)
      temporary="$LAUNCHER_DIR/.desk-rollback.$LOCK_TOKEN"
      if [ -w "$LAUNCHER_DIR" ]; then
        ln -s -- "$link_target" "$temporary"
        "$PYTHON_BIN" - "$temporary" "$LAUNCHER_PATH" <<'PY'
import os, sys
os.replace(sys.argv[1],sys.argv[2])
PY
      else
        run_privileged ln -s -- "$link_target" "$temporary"
        run_privileged "$PYTHON_BIN" - "$temporary" "$LAUNCHER_PATH" <<'PY'
import os, sys
os.replace(sys.argv[1],sys.argv[2])
PY
      fi
      ;;
    *) return 1 ;;
  esac
}

swap_current() {
  local target="$1" temporary="$DESK_HOME/.current.$LOCK_TOKEN"
  ln -s -- "$target" "$temporary"
  "$PYTHON_BIN" - "$temporary" "$DESK_HOME/current" <<'PY'
import os, sys
os.replace(sys.argv[1], sys.argv[2])
PY
}

activate_release() {
  local launcher_candidate launcher_backup launcher_type="none" launcher_link="" old_current="" new_target status=0
  select_launcher_destination
  launcher_candidate="$WORK_DIR/desk-launcher"
  create_launcher_file "$launcher_candidate"
  launcher_backup="$WORK_DIR/launcher-backup"
  if [ -e "$LAUNCHER_PATH" ] || [ -L "$LAUNCHER_PATH" ]; then
    recognized_desk_candidate "$LAUNCHER_PATH" || die "refusing to replace unidentified launcher: $LAUNCHER_PATH"
    if [ -L "$LAUNCHER_PATH" ]; then
      launcher_type="symlink"
      launcher_link="$(readlink "$LAUNCHER_PATH")"
    else
      launcher_type="file"
      cp -p -- "$LAUNCHER_PATH" "$launcher_backup"
    fi
  fi
  if [ -e "$DESK_HOME/current" ] || [ -L "$DESK_HOME/current" ]; then
    [ -L "$DESK_HOME/current" ] || die "managed current path is not a symlink: $DESK_HOME/current"
    old_current="$(readlink "$DESK_HOME/current")"
    PREVIOUS_RELEASE="$(current_release_path)" || die "active release escapes or is invalid under $DESK_HOME/releases."
  fi
  new_target="releases/$VERSION/${PROMOTED_RELEASE##*/}"
  if ! swap_current "$new_target"; then status=1; fi
  if [ "$status" -eq 0 ] && ! install_launcher_file "$launcher_candidate"; then status=1; fi
  if [ "$status" -eq 0 ] && ! HOME="$HOME" DESK_HOME="$DESK_HOME" "$LAUNCHER_PATH" help >/dev/null; then status=1; fi
  if [ "$status" -ne 0 ]; then
    if [ -n "$old_current" ]; then swap_current "$old_current" || true; else rm -f -- "$DESK_HOME/current"; fi
    restore_launcher "$launcher_type" "$launcher_backup" "$launcher_link" || true
    die "activation smoke failed; the previous Desk release and launcher were restored."
  fi
  "$PYTHON_BIN" - "$DESK_HOME/.desk-install" "$DESK_HOME" "$LAUNCHER_PATH" <<'PY'
import json, os, sys
path,home,launcher=sys.argv[1:]
temporary=path+".tmp"
with open(temporary,"w",encoding="utf-8") as f: json.dump({"schemaVersion":1,"managedBy":"desk-installer","home":home,"launcher":launcher},f,sort_keys=True,indent=2); f.write("\n")
os.chmod(temporary,0o600); os.replace(temporary,path)
PY
}

cleanup_legacy_launcher() {
  local legacy_name legacy_path
  legacy_name="desk""-server"
  legacy_path="$LAUNCHER_DIR/$legacy_name"
  if [ -e "$legacy_path" ] || [ -L "$legacy_path" ]; then
    warn "preserving unidentified retired Desk launcher for manual inspection: $legacy_path"
  fi
}

prune_releases() {
  "$PYTHON_BIN" - "$DESK_HOME" "$PROMOTED_RELEASE" "${PREVIOUS_RELEASE:-}" <<'PY'
import json, os, shutil, sys
home,current,previous=sys.argv[1:]
releases=os.path.join(home,"releases"); keep={os.path.realpath(current)}
if previous: keep.add(os.path.realpath(previous))
uid=os.getuid()
for version in os.listdir(releases):
    version_path=os.path.join(releases,version)
    if version.startswith(".staging-"): shutil.rmtree(version_path); continue
    if not os.path.isdir(version_path): raise SystemExit(f"unidentified release entry: {version_path}")
    for install_id in os.listdir(version_path):
        path=os.path.join(version_path,install_id); manifest=os.path.join(path,".desk-release")
        if not os.path.isdir(path) or os.stat(path).st_uid != uid: raise SystemExit(f"unowned release entry: {path}")
        try:
            with open(manifest,encoding="utf-8") as f: data=json.load(f)
        except Exception as error: raise SystemExit(f"invalid release ownership manifest: {path}: {error}")
        if data.get("schemaVersion")!=1 or data.get("managedBy")!="desk-installer" or data.get("installId")!=install_id or data.get("version")!=version:
            raise SystemExit(f"invalid release ownership: {path}")
        if os.path.realpath(path) not in keep: shutil.rmtree(path)
    if not os.listdir(version_path): os.rmdir(version_path)
required=set()
for path in keep:
    if not os.path.isdir(path): continue
    with open(os.path.join(path,".desk-release"),encoding="utf-8") as f: data=json.load(f)
    required.add("node-"+data["nodeVersion"]); required.add("bun-"+data["bunVersion"])
toolchains=os.path.join(home,"toolchains")
for name in os.listdir(toolchains):
    path=os.path.join(toolchains,name); manifest=os.path.join(path,".desk-toolchain")
    if not os.path.isdir(path) or os.stat(path).st_uid != uid: raise SystemExit(f"unowned toolchain entry: {path}")
    try:
        with open(manifest,encoding="utf-8") as f: data=json.load(f)
    except Exception as error: raise SystemExit(f"invalid toolchain ownership manifest: {path}: {error}")
    if data.get("schemaVersion")!=1 or data.get("managedBy")!="desk-installer" or f'{data.get("kind")}-{data.get("version")}' != name:
        raise SystemExit(f"invalid toolchain ownership: {path}")
    if name not in required: shutil.rmtree(path)
PY
}

report_optional_integrations() {
  local command missing=()
  for command in codex claude opencode gh nvidia-smi; do have "$command" || missing+=("$command"); done
  [ -z "${missing[*]-}" ] || info "Optional integrations not installed (Desk still works): ${missing[*]}"
}

validate_uninstall_tree() {
  "$PYTHON_BIN" - "$DESK_HOME" "$LAUNCHER_PATH" <<'PY'
import json, os, sys
home,launcher=sys.argv[1:]; uid=os.getuid()
if not os.path.isdir(home) or os.path.islink(home): raise SystemExit("Desk home is absent or not a directory")
if os.stat(home).st_uid != uid: raise SystemExit("Desk home is not owned by the invoking user")
allowed={"releases","toolchains","current",".desk-install"}
unknown=set(os.listdir(home))-allowed
if unknown: raise SystemExit("unidentified Desk home entries: "+", ".join(sorted(unknown)))
with open(os.path.join(home,".desk-install"),encoding="utf-8") as f: install=json.load(f)
if install!={"schemaVersion":1,"managedBy":"desk-installer","home":home,"launcher":launcher}: raise SystemExit("invalid install ownership metadata")
current=os.path.join(home,"current")
if not os.path.islink(current): raise SystemExit("current is not a managed symlink")
resolved=os.path.realpath(current); releases=os.path.realpath(os.path.join(home,"releases"))
if os.path.commonpath([resolved,releases]) != releases: raise SystemExit("current escapes managed releases")
if not os.path.isdir(releases): raise SystemExit("managed releases directory is missing")
for version in os.listdir(releases):
    version_path=os.path.join(releases,version)
    if not os.path.isdir(version_path): raise SystemExit("unidentified release entry: "+version_path)
    for install_id in os.listdir(version_path):
        path=os.path.join(version_path,install_id); manifest=os.path.join(path,".desk-release")
        if not os.path.isdir(path) or not os.path.isfile(manifest): raise SystemExit("unidentified release instance: "+path)
        with open(manifest,encoding="utf-8") as f: data=json.load(f)
        if data.get("schemaVersion")!=1 or data.get("managedBy")!="desk-installer" or data.get("version")!=version or data.get("installId")!=install_id:
            raise SystemExit("invalid release ownership: "+path)
for root, dirs, files in os.walk(releases):
    if os.stat(root).st_uid != uid: raise SystemExit("unowned release path: "+root)
toolchains=os.path.join(home,"toolchains")
if not os.path.isdir(toolchains): raise SystemExit("managed toolchains directory is missing")
for name in os.listdir(toolchains):
    path=os.path.join(toolchains,name); manifest=os.path.join(path,".desk-toolchain")
    if not os.path.isdir(path) or not os.path.isfile(manifest): raise SystemExit("unidentified toolchain entry: "+path)
    with open(manifest,encoding="utf-8") as f: data=json.load(f)
    if data.get("schemaVersion")!=1 or data.get("managedBy")!="desk-installer" or f'{data.get("kind")}-{data.get("version")}' != name:
        raise SystemExit("invalid toolchain ownership: "+path)
for root, dirs, files in os.walk(toolchains):
    if os.stat(root).st_uid != uid: raise SystemExit("unowned toolchain path: "+root)
PY
}

uninstall_desk() {
  [ -d "$DESK_HOME" ] || die "Desk is not installed at $DESK_HOME."
  probe_python || die "Python ${PYTHON_MIN_VERSION}+ is required to verify ownership before uninstalling."
  select_launcher_destination
  [ -f "$LAUNCHER_PATH" ] && grep -Fqx '# desk-managed-launcher-v1' "$LAUNCHER_PATH" || die "refusing uninstall: launcher is absent or unidentified at $LAUNCHER_PATH"
  validate_uninstall_tree || die "refusing uninstall because managed ownership validation failed."
  remove_launcher_path
  rm -f -- "$DESK_HOME/current" "$DESK_HOME/.desk-install"
  rm -rf -- "$DESK_HOME/releases" "$DESK_HOME/toolchains"
  rmdir -- "$DESK_HOME" || die "Desk home contains unidentified paths and was preserved: $DESK_HOME"
  printf '\n\033[32m✓ Desk application uninstalled. User configuration and projects were preserved.\033[0m\n'
}

install_desk() {
  probe_host_capabilities
  install_missing_packages
  verify_host_capabilities
  mkdir -p -- "$DESK_HOME" "$DESK_HOME/releases" "$DESK_HOME/toolchains"
  WORK_DIR="$(mktemp -d "$DESK_HOME/.install-work.XXXXXX")"
  resolve_release_version
  info "Installing Desk $VERSION for $TARGET/${HOST_LIBC}…"
  download_release_metadata
  validate_install_manifest
  ensure_node_toolchain
  ensure_bun_toolchain
  build_release
  activate_release
  cleanup_legacy_launcher
  prune_releases
  report_optional_integrations
  printf '\n\033[32m✓ Desk %s installed → %s\033[0m\n\n' "$VERSION" "$LAUNCHER_PATH"
  cat <<NEXT
Next:
  desk serve                 # private Bun server on http://127.0.0.1:5173
  desk serve --dev           # Vite development server

Both modes accept --host and --port. Neither mode falls back to the other.
NEXT
}

main() {
  case "${1:-}" in
    '') [ "$#" -eq 0 ] || die "unexpected installer arguments" ;;
    --uninstall) [ "$#" -eq 1 ] || die "--uninstall accepts no arguments" ;;
    *) die "unexpected installer argument: $1" ;;
  esac
  have curl || die "curl with working TLS trust is required to bootstrap Desk."
  validate_install_paths
  validate_requested_inputs
  detect_target
  detect_package_manager
  acquire_install_lock
  trap cleanup_on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ "${1:-}" = "--uninstall" ]; then uninstall_desk; else install_desk; fi
  MAIN_COMPLETED=1
}

main "$@"
