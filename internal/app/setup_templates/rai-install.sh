#!/usr/bin/env bash
# Install rai and sign in to this RelayAPI deployment.
set -euo pipefail

SERVER='{{.Server}}'
REPO="${RAI_REPO:-4627488/RelayAPI}"
PREFIX="${RAI_PREFIX:-}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

install_dir() {
  if [ -n "$PREFIX" ]; then
    printf '%s\n' "$PREFIX"
    return
  fi
  if [ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
    printf '%s\n' "$HOME/.local/bin"
    return
  fi
  printf '%s\n' "/usr/local/bin"
}

download_release() {
  local dest="$1"
  local api="https://api.github.com/repos/${REPO}/releases/latest"
  local json url
  json="$(curl -fsSL -H "User-Agent: rai-installer" "$api" || true)"
  [ -n "$json" ] || return 1
  url="$(printf '%s' "$json" | python3 -c "
import json,sys
doc=json.load(sys.stdin)
need=f'rai-${OS}-${ARCH}'
for asset in doc.get('assets') or []:
    name=(asset.get('name') or '').lower()
    if need in name:
        print(asset.get('browser_download_url',''))
        break
" 2>/dev/null || true)"
  [ -n "$url" ] || return 1
  curl -fsSL "$url" -o "$dest"
}

dir="$(install_dir)"
mkdir -p "$dir"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
if download_release "$tmp"; then
  chmod 755 "$tmp"
  mv "$tmp" "$dir/rai"
  trap - EXIT
  echo "installed $dir/rai"
elif command -v go >/dev/null 2>&1; then
  GOBIN="$dir" go install "github.com/${REPO}/cmd/rai@latest"
  echo "installed $dir/rai via go install"
else
  echo "No published rai binary for ${OS}/${ARCH}, and go is not on PATH." >&2
  echo "Install Go, then: go install github.com/${REPO}/cmd/rai@latest" >&2
  exit 1
fi

export PATH="$dir:$PATH"
if [ "${RAI_SKIP_LOGIN:-}" = "1" ]; then
  echo "next: rai login --server $SERVER"
  exit 0
fi
exec "$dir/rai" login --server "$SERVER"
