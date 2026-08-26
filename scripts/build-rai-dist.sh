#!/bin/sh
# Cross-compile rai for every client OS/arch the site can serve.
set -eu
OUT="${1:?usage: build-rai-dist.sh <outdir> [version]}"
VERSION="${2:-}"
if [ -z "$VERSION" ]; then
  VERSION="0.2.0"
fi
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p "$OUT"
printf '%s\n' "$VERSION" > "$OUT/version"
LDFLAGS="-s -w -X github.com/4627488/RelayAPI/internal/rai.Version=${VERSION}"

build_one() {
  os="$1"
  arch="$2"
  name="rai-${os}-${arch}"
  if [ "$os" = windows ]; then
    name="${name}.exe"
  fi
  echo "building $name"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags="$LDFLAGS" -o "$OUT/$name" "$ROOT/cmd/rai"
}

build_one darwin amd64
build_one darwin arm64
build_one linux amd64
build_one linux arm64
build_one windows amd64
build_one windows arm64
