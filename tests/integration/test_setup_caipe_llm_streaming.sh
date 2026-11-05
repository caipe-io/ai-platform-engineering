#!/usr/bin/env bash
# Exercise installer functions with Helm stubs; never contact a cluster.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SOURCE="$ROOT/setup-caipe.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
extract_function() {
  awk -v name="$1" '
    $0 == name "() {" { found=1 }
    found { print }
    found && /^}$/ { complete=1; exit }
    END { if (!complete) exit 1 }
  ' "$SOURCE"
}
extract_function _resolve_llm_streaming > "$WORK/helpers.sh"
extract_function _env_get >> "$WORK/helpers.sh"
# Exercise the installer's actual --env-file preload and precedence rules.
awk '
  /local _llm_vars=\(/ { found=1 }
  found { print }
  found && /^    done$/ { complete=1; exit }
  END { if (!complete) exit 1 }
' "$SOURCE" > "$WORK/load-env.sh"
# The preload block is followed by more installer code, not a standalone command.
printf '\ntrue\n' >> "$WORK/load-env.sh"

source "$WORK/helpers.sh"
err() { echo "$*" >&2; }

check_resolution() (
  local label="$1" explicit="$2" release="$3" values="$4" expected="$5"
  unset LLM_STREAMING
  [[ "$explicit" == unset ]] || export LLM_STREAMING="$explicit"
  helm() {
    case "$1" in
      status) [[ "$release" == present ]] ;;
      get) printf '%s' "$values" ;;
      *) fail "unexpected Helm command: $*" ;;
    esac
  }
  local actual
  actual=$(_resolve_llm_streaming)
  [[ "$actual" == "$expected" ]] || fail "$label: expected $expected, got $actual"
)

check_resolution fresh unset absent '{}' true
check_resolution upgrade-without-setting unset present '{}' true
check_resolution retain-false-string unset present '{"dynamic-agents":{"config":{"LLM_STREAMING":"false"}}}' false
check_resolution retain-false-boolean unset present '{"dynamic-agents":{"config":{"LLM_STREAMING":false}}}' false
check_resolution retain-true unset present '{"dynamic-agents":{"config":{"LLM_STREAMING":"true"}}}' true
check_resolution explicit-enable true present '{"dynamic-agents":{"config":{"LLM_STREAMING":"false"}}}' true
check_resolution explicit-disable false present '{"dynamic-agents":{"config":{"LLM_STREAMING":"true"}}}' false

(
  # An explicit value needs no deployed values, including on a fresh install.
  export LLM_STREAMING=false
  helm() { fail "explicit setting should not query Helm"; }
  [[ "$(_resolve_llm_streaming)" == false ]] || fail "explicit setting lost"
)

(
  unset LLM_STREAMING
  ENV_FILE="$WORK/override.env"
  printf 'LLM_STREAMING="false"\n' > "$ENV_FILE"
  load_env() { source "$WORK/load-env.sh"; return 0; }
  load_env
  [[ "$(_resolve_llm_streaming)" == false ]] || fail "env-file override lost"
  export LLM_STREAMING=true
  load_env
  [[ "$(_resolve_llm_streaming)" == true ]] || fail "env-file replaced explicit environment"
)

for failure in helm malformed-json; do
  (
    unset LLM_STREAMING
    helm() {
      [[ "$1" == status ]] && return 0
      [[ "$failure" == malformed-json ]] && { printf 'invalid-json'; return 0; }
      return 1
    }
    if _resolve_llm_streaming > "$WORK/output" 2> "$WORK/error"; then
      fail "$failure: unreadable deployed values must stop the upgrade"
    fi
    [[ ! -s "$WORK/output" ]] || fail "$failure: emitted a replacement value"
  )
done

echo "PASS: setup-caipe streaming defaults, upgrade retention, and explicit overrides"
