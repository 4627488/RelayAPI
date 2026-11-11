#!/bin/sh
# Cross-compile rai for every client OS/arch the site can serve.
set -eu
OUT="${1:?usage: build-rai-dist.sh <outdir> [version]}"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
# Identify launcher inputs, not unrelated server/frontend commits. Hash the
# actual package dependency closure so shared internal packages are covered too.
VERSION="${2:-}"
if [ -z "$VERSION" ]; then
  inputs_dir=$(mktemp -d)
  trap 'rm -rf "$inputs_dir"' EXIT HUP INT TERM
  for platform in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64; do
    CGO_ENABLED=0 GOOS=${platform%/*} GOARCH=${platform#*/} \
      go list -deps -f '{{if not .Standard}}{{$dir := .Dir}}{{range .GoFiles}}{{$dir}}/{{.}}{{"\n"}}{{end}}{{range .SFiles}}{{$dir}}/{{.}}{{"\n"}}{{end}}{{range .HFiles}}{{$dir}}/{{.}}{{"\n"}}{{end}}{{range .SysoFiles}}{{$dir}}/{{.}}{{"\n"}}{{end}}{{range .EmbedFiles}}{{$dir}}/{{.}}{{"\n"}}{{end}}{{end}}' \
      ./cmd/rai >> "$inputs_dir/files" || exit 1
  done
  sort -u "$inputs_dir/files" | sed '/^$/d' > "$inputs_dir/sorted-files"
  while IFS= read -r file; do
    hash=$(sha256sum "$file") || exit 1
    printf '%s %s\n' "${hash%% *}" "${file##*/}" >> "$inputs_dir/hashes"
  done < "$inputs_dir/sorted-files"
  VERSION="rai-$(
    {
      # Keep file names (including GOOS/GOARCH suffixes), not absolute paths.
      sort "$inputs_dir/hashes"
      cat go.mod go.sum scripts/build-rai-dist.sh
      go env GOVERSION
    } | sha256sum | cut -c1-20
  )"
  rm -rf "$inputs_dir"
  trap - EXIT HUP INT TERM
fi
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
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -buildvcs=false -trimpath -ldflags="$LDFLAGS" -o "$OUT/$name" "$ROOT/cmd/rai"
}

build_one darwin amd64
build_one darwin arm64
build_one linux amd64
build_one linux arm64
build_one windows amd64
build_one windows arm64
