#!/bin/sh
set -eu

install_plugin() {
  source=$1
  target=$2
  temporary="/plugins/.$(basename "$target").$$"
  trap 'rm -f "$temporary"' EXIT
  cp "$source" "$temporary"
  chmod 0755 "$temporary"
  sync
  mv -f "$temporary" "$target"
  trap - EXIT
}

install_plugin /relayapi-bridge.so /plugins/relayapi-bridge.so
install_plugin /claude-web-search-router.so /plugins/claude-web-search-router.so
