#!/usr/bin/env bash
# Install rai from a running RelayAPI site (RAI_SERVER), or go install for
# developers building from this repository.
set -euo pipefail

SERVER="${RAI_SERVER:-}"
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

dir="$(install_dir)"
mkdir -p "$dir"
if [ -n "$SERVER" ]; then
  SERVER="${SERVER%/}"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL -H "User-Agent: rai-installer" "$SERVER/rai/download/${OS}-${ARCH}" -o "$tmp"
  chmod 755 "$tmp"
  mv "$tmp" "$dir/rai"
  trap - EXIT
  echo "installed $dir/rai from $SERVER"
  exit 0
fi
if command -v go >/dev/null 2>&1; then
  GOBIN="$dir" go install "github.com/${REPO}/cmd/rai@latest"
  echo "installed $dir/rai via go install"
  echo "next: rai login --server <your RelayAPI URL>"
  exit 0
fi
echo "Set RAI_SERVER to a running RelayAPI URL, or install Go and retry." >&2
exit 1
