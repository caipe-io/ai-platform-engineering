#!/usr/bin/env bash
# Validate the declarative Compose profile path without starting containers.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SETUP_SCRIPT="${REPO_ROOT}/setup-caipe.sh"
SANDBOX="$(mktemp -d /tmp/caipe-compose-profile.XXXXXX)"
FAKE_BIN="${SANDBOX}/bin"
mkdir -p "$FAKE_BIN"

cat > "${FAKE_BIN}/docker" <<'DOCKER_MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == info ]]; then
  exit 0
fi
if [[ "${1:-}" == ps ]]; then
  exit 0
fi
if [[ "${1:-}" == compose ]]; then
  if printf '%s\n' "$@" | grep -q -- '--services'; then
    printf '%s\n' caipe-ui dynamic-agents rag-server mcp-webex mcp-webex-meetings
  fi
  exit 0
fi
exit 0
DOCKER_MOCK
chmod 700 "${FAKE_BIN}/docker"

PROFILE="${SANDBOX}/profile.yaml"
cp "${REPO_ROOT}/deployment/sandbox.example.yaml" "$PROFILE"
sed -i.bak 's/^ports:.*/ports:/' "$PROFILE"

run_plan() {
  PATH="${FAKE_BIN}:${PATH}" \
    CAIPE_MIN_FREE_GB=0 \
    "${SETUP_SCRIPT}" plan --config "$PROFILE" --env-file "${REPO_ROOT}/.env.example" --non-interactive
}

output="$(run_plan)"
grep -q 'Compose deployment plan' <<< "$output"
grep -q 'Compose files: docker-compose.yaml deployment/caipe-sandbox-overlay.yaml' <<< "$output"
grep -q 'mcp-webex-meetings' <<< "$output"

BROKEN_PROFILE="${SANDBOX}/scheduler.yaml"
cp "$PROFILE" "$BROKEN_PROFILE"
sed -i.bak 's/^scheduler:.*/scheduler: true/' "$BROKEN_PROFILE"
if PATH="${FAKE_BIN}:${PATH}" CAIPE_MIN_FREE_GB=0 \
  "${SETUP_SCRIPT}" plan --config "$BROKEN_PROFILE" --env-file "${REPO_ROOT}/.env.example" --non-interactive >/dev/null 2>&1; then
  echo "FAIL: scheduler parity check accepted a missing backend" >&2
  exit 1
fi

echo "PASS: declarative Compose profile and scheduler parity checks"
