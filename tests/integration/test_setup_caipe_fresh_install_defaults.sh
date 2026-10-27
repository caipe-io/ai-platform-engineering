#!/usr/bin/env bash
# Run locally with: bash tests/integration/test_setup_caipe_fresh_install_defaults.sh
# Exercise production code in isolated subshells; never run the full installer.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SOURCE="$ROOT/setup-caipe.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
contains() { grep -Fq -- "$2" "$1" || fail "missing in $(basename "$1"): $2"; }

# Top-level functions end with an unindented brace. Fail if extraction breaks.
extract_function() {
  awk -v name="$1" '
    $0 == name "() {" { found=1 }
    found { print }
    found && /^}$/ { complete=1; exit }
    END { if (!complete) exit 1 }
  ' "$SOURCE"
}

# Shared Postgres resource defaults honour the environment.
grep -E '^SHARED_PG_[A-Z_]+=' "$SOURCE" > "$WORK/defaults.sh"
(
  unset SHARED_PG_MEMORY_LIMIT
  source "$WORK/defaults.sh"
  [[ "${SHARED_PG_MEMORY_LIMIT:-}" == "1Gi" ]] || fail "default SHARED_PG_MEMORY_LIMIT: ${SHARED_PG_MEMORY_LIMIT:-unset}"
)
(
  export SHARED_PG_MEMORY_LIMIT=2Gi
  source "$WORK/defaults.sh"
  [[ "$SHARED_PG_MEMORY_LIMIT" == "2Gi" ]] || fail "SHARED_PG_MEMORY_LIMIT override ignored"
)

# Shared Postgres install: explicit resources and a BusyBox-compatible mktemp template.
extract_function deploy_shared_postgres > "$WORK/functions.sh"
bash -n "$WORK/functions.sh"
(
  source "$WORK/defaults.sh"
  source "$WORK/functions.sh"
  SHARED_PG_SERVICE=caipe-postgres ENABLE_LITELLM_DB=false SHARED_PG_ADMIN_PASSWORD=x
  KEYCLOAK_DB_PASSWORD=x OPENFGA_DB_PASSWORD=x LITELLM_DB_PASSWORD=x
  log() { :; }; warn() { :; }; err() { :; }; step() { :; }
  _resolve_shared_postgres_passwords() { :; }
  kubectl() { case "$1" in get) return 1 ;; apply) cat >/dev/null ;; esac; }
  helm() { [[ "$1" == upgrade ]] && printf '%s\n' "$@" > "$WORK/helm-args"; return 0; }
  mktemp() { echo "$*" > "$WORK/mktemp-args"; command mktemp "$WORK/initdb-XXXXXX"; }
  # The first wait after the install marks the end of what this test covers.
  sleep() { exit 0; }
  deploy_shared_postgres
)
contains "$WORK/helm-args" "primary.resources.requests.memory=256Mi"
contains "$WORK/helm-args" "primary.resources.limits.memory=1Gi"
contains "$WORK/helm-args" "primary.resources.limits.cpu=1"
[[ "$(cat "$WORK/mktemp-args")" == *XXXXXX ]] || fail "mktemp template must end in XXXXXX: $(cat "$WORK/mktemp-args")"

# The UI hides Knowledge Bases when the RAG stack is not installed.
contains "$SOURCE" '--set caipe-ui.config.RAG_ENABLED=false'

echo "PASS: setup-caipe fresh-install defaults"
