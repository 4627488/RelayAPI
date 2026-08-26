#!/usr/bin/env bash
# Install rai from this RelayAPI deployment and sign in.
set -euo pipefail

SERVER='{{.Server}}'
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
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
if ! curl -fsSL -H "User-Agent: rai-installer" "$SERVER/rai/download/${OS}-${ARCH}" -o "$tmp"; then
  echo "This deployment did not serve a rai binary for ${OS}/${ARCH}." >&2
  echo "The published RelayAPI image ships these binaries at /rai/download." >&2
  exit 1
fi
chmod 755 "$tmp"
mv "$tmp" "$dir/rai"
trap - EXIT
echo "installed $dir/rai"
export PATH="$dir:$PATH"
if [ "${RAI_SKIP_LOGIN:-}" = "1" ]; then
  echo "next: rai login --server $SERVER"
  exit 0
fi
exec "$dir/rai" login --server "$SERVER"
