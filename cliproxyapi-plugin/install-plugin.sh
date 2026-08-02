#!/bin/sh
set -eu

target=/plugins/relayapi-bridge.so
temporary=/plugins/.relayapi-bridge.so.$$
trap 'rm -f "$temporary"' EXIT

cp /relayapi-bridge.so "$temporary"
chmod 0755 "$temporary"
sync
mv -f "$temporary" "$target"
trap - EXIT
