#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then CHECK_ONLY=1; fi

ENDPOINT_B64='{{.EndpointBase64}}'
API_KEY_B64='{{.APIKeyBase64}}'
CLAUDE_PATCH_B64='{{.ClaudePatchBase64}}'
OPENCODE_PATCH_B64='{{.OpenCodePatchBase64}}'
CODEX_EDITS_B64='{{.CodexEditsBase64}}'
DO_CODEX={{if .Codex}}1{{else}}0{{end}}
DO_CLAUDE={{if .Claude}}1{{else}}0{{end}}
DO_OPENCODE={{if .OpenCode}}1{{else}}0{{end}}
INSTALL_MISSING={{if .InstallMissing}}1{{else}}0{{end}}
VERIFY_CONNECTION={{if .VerifyConnection}}1{{else}}0{{end}}

info() { printf '  %s\n' "$*"; }
ok() { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
fail() { printf '✗ %s\n' "$*" >&2; return 1; }

decode_text() {
  if printf '%s' "$1" | base64 --decode >/dev/null 2>&1; then
    printf '%s' "$1" | base64 --decode
  else
    printf '%s' "$1" | base64 -D
  fi
}

decode_file() {
  _df_value=$1
  _df_path=$2
  if printf '%s' "$_df_value" | base64 --decode >"$_df_path" 2>/dev/null; then return; fi
  printf '%s' "$_df_value" | base64 -D >"$_df_path"
}

ENDPOINT=$(decode_text "$ENDPOINT_B64")
API_KEY=$(decode_text "$API_KEY_B64")
export PATH="$HOME/.local/bin:$PATH"

if ! command -v curl >/dev/null 2>&1; then fail 'curl is required.'; exit 1; fi

verify_gateway() {
  info "Checking $ENDPOINT/v1/models"
  curl -fsS --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $API_KEY" "$ENDPOINT/v1/models" >/dev/null
  ok 'Gateway and API Key are reachable.'
}

if [ "$VERIFY_CONNECTION" = 1 ]; then verify_gateway; fi

show_cli() {
  _sc_name=$1
  if command -v "$_sc_name" >/dev/null 2>&1; then
    _sc_version=$("$_sc_name" --version 2>/dev/null | head -n 1 || true)
    ok "$_sc_name ${_sc_version:-is installed}"
  else
    warn "$_sc_name is not installed."
  fi
}

if [ "$CHECK_ONLY" = 1 ]; then
  [ "$DO_CODEX" = 1 ] && show_cli codex
  [ "$DO_CLAUDE" = 1 ] && show_cli claude
  [ "$DO_OPENCODE" = 1 ] && show_cli opencode
  ok 'Preflight completed; no files were changed.'
  exit 0
fi

install_cli() {
  _ic_name=$1
  if command -v "$_ic_name" >/dev/null 2>&1; then return; fi
  if [ "$INSTALL_MISSING" != 1 ]; then fail "$_ic_name is missing and automatic installation is disabled."; return 1; fi
  case "$_ic_name" in
    codex)
      info 'Installing Codex with the official installer.'
      curl -fsSL https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.sh | CODEX_NON_INTERACTIVE=1 sh
      ;;
    claude)
      info 'Installing Claude Code with the official installer.'
      curl -fsSL https://claude.ai/install.sh | bash
      ;;
    opencode)
      info 'Installing OpenCode with the official installer.'
      curl -fsSL https://opencode.ai/install | bash
      ;;
  esac
  hash -r
  command -v "$_ic_name" >/dev/null 2>&1 || fail "$_ic_name was installed but is not on PATH; open a new terminal and run this setup again."
}

[ "$DO_CODEX" = 1 ] && install_cli codex
[ "$DO_CLAUDE" = 1 ] && install_cli claude
[ "$DO_OPENCODE" = 1 ] && install_cli opencode

JSON_TOOL=''
if [ "$DO_CLAUDE" = 1 ] || [ "$DO_OPENCODE" = 1 ]; then
  if command -v python3 >/dev/null 2>&1; then JSON_TOOL=python3
  elif command -v node >/dev/null 2>&1; then JSON_TOOL=node
  else fail 'Python 3 or Node.js is required to merge existing JSON settings safely.'; exit 1
  fi
fi

TMPDIR_SETUP=$(mktemp -d "${TMPDIR:-/tmp}/relayapi-setup.XXXXXX")
BACKUP_TARGETS=()
BACKUP_FILES=()
BACKUP_EXISTED=()
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

cleanup() { rm -rf "$TMPDIR_SETUP"; }
trap cleanup EXIT

backup_target() {
  _bt_target=$1
  mkdir -p "$(dirname "$_bt_target")"
  BACKUP_TARGETS+=("$_bt_target")
  if [ -e "$_bt_target" ]; then
    _bt_backup="$_bt_target.relayapi-backup.$STAMP.$$"
    cp -p "$_bt_target" "$_bt_backup"
    BACKUP_FILES+=("$_bt_backup")
    BACKUP_EXISTED+=(1)
  else
    BACKUP_FILES+=("")
    BACKUP_EXISTED+=(0)
  fi
}

rollback() {
  _rb_status=$?
  trap - ERR
  warn 'Setup failed; restoring every configuration changed in this run.'
  _rb_i=$((${#BACKUP_TARGETS[@]} - 1))
  while [ "$_rb_i" -ge 0 ]; do
    _rb_target=${BACKUP_TARGETS[$_rb_i]}
    if [ "${BACKUP_EXISTED[$_rb_i]}" = 1 ]; then
      cp -p "${BACKUP_FILES[$_rb_i]}" "$_rb_target"
    else
      rm -f "$_rb_target"
    fi
    _rb_i=$((_rb_i - 1))
  done
  exit "$_rb_status"
}

KEY_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/relayapi"
KEY_PATH="$KEY_DIR/api-key"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="$CODEX_HOME_DIR/config.toml"
CLAUDE_CONFIG="$HOME/.claude/settings.json"
OPENCODE_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"

backup_target "$KEY_PATH"
[ "$DO_CODEX" = 1 ] && backup_target "$CODEX_CONFIG"
[ "$DO_CLAUDE" = 1 ] && backup_target "$CLAUDE_CONFIG"
[ "$DO_OPENCODE" = 1 ] && backup_target "$OPENCODE_CONFIG"
trap rollback ERR

KEY_STAGE="$TMPDIR_SETUP/api-key"
printf '%s' "$API_KEY" >"$KEY_STAGE"
chmod 600 "$KEY_STAGE"
mkdir -p "$KEY_DIR"
mv -f "$KEY_STAGE" "$KEY_PATH"
chmod 600 "$KEY_PATH"
unset API_KEY API_KEY_B64

merge_json() {
  _mj_target=$1
  _mj_patch_b64=$2
  _mj_mode=${3:-default}
  _mj_patch="$TMPDIR_SETUP/patch.$$.json"
  _mj_stage="$TMPDIR_SETUP/stage.$$.json"
  decode_file "$_mj_patch_b64" "$_mj_patch"
  if [ "$JSON_TOOL" = python3 ]; then
    python3 - "$_mj_target" "$_mj_patch" "$_mj_stage" "$_mj_mode" <<'PY'
import json, os, sys
target, patch_path, stage, mode = sys.argv[1:]
base = {}
if os.path.exists(target):
    with open(target, encoding="utf-8-sig") as handle:
        base = json.load(handle)
with open(patch_path, encoding="utf-8") as handle:
    patch = json.load(handle)
def merge(left, right, path=()):
    for key, value in right.items():
        child_path = path + (key,)
        if mode == "opencode" and child_path == ("provider", "relayapi", "models"):
            left[key] = value
        elif isinstance(value, dict) and isinstance(left.get(key), dict):
            merge(left[key], value, child_path)
        else:
            left[key] = value
merge(base, patch)
if mode == "opencode":
    disabled = base.get("disabled_providers")
    if isinstance(disabled, list):
        base["disabled_providers"] = [item for item in disabled if item != "relayapi"]
    enabled = base.get("enabled_providers")
    if isinstance(enabled, list) and "relayapi" not in enabled:
        enabled.append("relayapi")
with open(stage, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(base, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
  else
    node - "$_mj_target" "$_mj_patch" "$_mj_stage" "$_mj_mode" <<'JS'
const fs = require("fs");
const [target, patchPath, stage, mode] = process.argv.slice(2);
const base = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {};
const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
function merge(left, right, path = []) {
  for (const [key, value] of Object.entries(right)) {
    const childPath = [...path, key];
    if (mode === "opencode" && childPath.join(".") === "provider.relayapi.models") left[key] = value;
    else if (value && typeof value === "object" && !Array.isArray(value) && left[key] && typeof left[key] === "object" && !Array.isArray(left[key])) merge(left[key], value, childPath);
    else left[key] = value;
  }
}
merge(base, patch);
if (mode === "opencode") {
  if (Array.isArray(base.disabled_providers)) base.disabled_providers = base.disabled_providers.filter((item) => item !== "relayapi");
  if (Array.isArray(base.enabled_providers) && !base.enabled_providers.includes("relayapi")) base.enabled_providers.push("relayapi");
}
fs.writeFileSync(stage, JSON.stringify(base, null, 2) + "\n");
JS
  fi
  chmod 600 "$_mj_stage"
  mv -f "$_mj_stage" "$_mj_target"
}

configure_codex() {
  mkdir -p "$CODEX_HOME_DIR"
  _cc_edits="$TMPDIR_SETUP/codex-edits.json"
  _cc_input="$TMPDIR_SETUP/codex-input.fifo"
  _cc_output="$TMPDIR_SETUP/codex-output.fifo"
  _cc_error="$TMPDIR_SETUP/codex-error.log"
  decode_file "$CODEX_EDITS_B64" "$_cc_edits"
  mkfifo "$_cc_input" "$_cc_output"
  codex app-server --listen stdio:// <"$_cc_input" >"$_cc_output" 2>"$_cc_error" &
  _cc_pid=$!
  exec 3>"$_cc_input"
  exec 4<"$_cc_output"

  codex_read_response() {
    _crr_id=$1
    CODEX_RESPONSE=''
    while IFS= read -r -t 60 _crr_line <&4; do
      if printf '%s' "$_crr_line" | grep -Eq '"id"[[:space:]]*:[[:space:]]*'"$_crr_id"'([,}])'; then
        CODEX_RESPONSE=$_crr_line
        return 0
      fi
    done
    return 1
  }

  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"relayapi-setup","title":"RelayAPI Setup","version":"1"},"capabilities":null}}' >&3
  if ! codex_read_response 1; then
    kill "$_cc_pid" 2>/dev/null || true
    wait "$_cc_pid" 2>/dev/null || true
    fail 'Codex app-server did not complete initialization.'
  fi
  printf '%s\n' '{"jsonrpc":"2.0","method":"initialized"}' >&3
  {
    printf '%s' '{"jsonrpc":"2.0","id":2,"method":"config/batchWrite","params":{"edits":'
    cat "$_cc_edits"
    printf '%s\n' '}}'
  } >&3
  if ! codex_read_response 2; then
    kill "$_cc_pid" 2>/dev/null || true
    wait "$_cc_pid" 2>/dev/null || true
    fail 'Codex app-server did not confirm the configuration write.'
  fi
  exec 3>&-
  exec 4<&-
  kill "$_cc_pid" 2>/dev/null || true
  wait "$_cc_pid" 2>/dev/null || true
  printf '%s' "$CODEX_RESPONSE" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok(Overridden)?"' || {
    sed -n '1,20p' "$_cc_error" >&2
    fail 'Codex did not confirm the configuration write.'
  }
  ok "Codex configured in $CODEX_CONFIG"
}

configure_claude() {
  merge_json "$CLAUDE_CONFIG" "$CLAUDE_PATCH_B64"
  ok "Claude Code configured in $CLAUDE_CONFIG"
}

configure_opencode() {
  merge_json "$OPENCODE_CONFIG" "$OPENCODE_PATCH_B64" opencode
  ok "OpenCode configured in $OPENCODE_CONFIG"
}

[ "$DO_CODEX" = 1 ] && configure_codex
[ "$DO_CLAUDE" = 1 ] && configure_claude
[ "$DO_OPENCODE" = 1 ] && configure_opencode

trap - ERR
if [ "$VERIFY_CONNECTION" = 1 ]; then
  API_KEY=$(cat "$KEY_PATH")
  verify_gateway
  unset API_KEY
fi

ok 'RelayAPI agent setup completed.'
info "Credential: $KEY_PATH (mode 600)"
info 'Existing settings were merged. Timestamped backups were kept beside changed files.'
