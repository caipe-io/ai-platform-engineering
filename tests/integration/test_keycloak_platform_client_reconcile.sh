#!/usr/bin/env bash
# -------------------------------------------------------------------
# tests/integration/test_keycloak_platform_client_reconcile.sh
#
# End-to-end test for the caipe-platform client_secret reconciliation
# added to charts/.../keycloak/scripts/init-idp.sh.
#
# Spins up a throwaway Keycloak 26.3 container (the same image the
# Helm chart pins), imports the realm shipped with the chart, then:
#
#   1. Confirms the realm placeholder "caipe-platform-dev-secret" is
#      in place (matches dev/CI behaviour).
#   2. Runs init-idp.sh with KEYCLOAK_PLATFORM_CLIENT_SECRET unset and
#      asserts the placeholder is unchanged (no-op path).
#   3. Runs init-idp.sh with KEYCLOAK_PLATFORM_CLIENT_SECRET set to a
#      fresh random value and asserts Keycloak now holds that value.
#   4. Runs init-idp.sh a SECOND time with the same value to assert
#      idempotency.
#   5. Mints a client_credentials access token using the new secret to
#      prove the platform client flow still works after rotation.
#   6. Mints a client_credentials access token using the OLD placeholder
#      to prove it is now rejected (invalid_client).
#
# Requires: docker, curl, jq, python3. Uses one host port (default
# 18080, override with KC_PORT=...).
#
# Self-contained: pulls the keycloak-init image to get python3 + curl
# inside the test runner, so no local python install on the runtime
# image is required.
#
# Exit 0 on success, non-zero with a clear FAIL message otherwise.
#
# Usage:
#   ./tests/integration/test_keycloak_platform_client_reconcile.sh
#   KC_PORT=28080 ./tests/integration/test_keycloak_platform_client_reconcile.sh
#   KEEP=1 ./...    # leave the Keycloak container running for inspection
#
# assisted-by Claude:claude-opus-4-7
# -------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS_DIR="${REPO_ROOT}/charts/ai-platform-engineering/charts/keycloak/scripts"
REALM_FILE="${REPO_ROOT}/charts/ai-platform-engineering/charts/keycloak/realm-config.json"

KC_PORT="${KC_PORT:-18080}"
KC_URL="http://localhost:${KC_PORT}"
KC_REALM="caipe"
KC_PLATFORM_CLIENT="caipe-platform"
KC_PLACEHOLDER_SECRET="caipe-platform-dev-secret"
KC_CONTAINER="kc-platform-reconcile-test-$$"
# init image: chart's keycloak-init container provides sh + curl + python3 +
# sed/grep/awk — everything init-idp.sh expects. Tag autoselect logic below
# picks the first one that resolves, with a local build as a last resort.
INIT_IMAGE_CANDIDATES=(
  "${INIT_IMAGE:-}"
  "ghcr.io/cnoe-io/keycloak-init:0.5.1-rc.25"
  "ghcr.io/cnoe-io/keycloak-init:latest"
)
INIT_IMAGE_LOCAL_BUILD="caipe/keycloak-init:local-test"
KC_IMAGE="quay.io/keycloak/keycloak:26.3"

# --- Pretty output -------------------------------------------------
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
step()  { echo; echo "${CYAN}==> $*${RESET}"; }
pass()  { echo "${GREEN}    PASS:${RESET} $*"; }
fail()  { echo "${RED}    FAIL:${RESET} $*"; exit 1; }
info()  { echo "${YELLOW}    info:${RESET} $*"; }

# --- Pre-flight ----------------------------------------------------
command -v docker >/dev/null || { echo "docker is required"; exit 2; }
command -v curl   >/dev/null || { echo "curl is required";   exit 2; }
command -v jq     >/dev/null || { echo "jq is required (brew install jq)"; exit 2; }
[ -f "${REALM_FILE}" ] || { echo "realm-config.json not found at ${REALM_FILE}"; exit 2; }
[ -f "${SCRIPTS_DIR}/init-idp.sh" ] || { echo "init-idp.sh not found at ${SCRIPTS_DIR}"; exit 2; }

# Resolve which keycloak-init image to use. Prefer published tags;
# build locally only as a last resort so the test runs offline.
INIT_IMAGE=""
for img in "${INIT_IMAGE_CANDIDATES[@]}"; do
  [ -z "${img}" ] && continue
  if docker image inspect "${img}" >/dev/null 2>&1; then
    INIT_IMAGE="${img}"
    echo "[init-image] using locally cached ${INIT_IMAGE}"
    break
  fi
  if docker pull "${img}" >/dev/null 2>&1; then
    INIT_IMAGE="${img}"
    echo "[init-image] pulled ${INIT_IMAGE}"
    break
  fi
done

if [ -z "${INIT_IMAGE}" ]; then
  echo "[init-image] no published tag resolved — building locally from build/Dockerfile.keycloak-init"
  if [ ! -f "${REPO_ROOT}/build/Dockerfile.keycloak-init" ]; then
    echo "build/Dockerfile.keycloak-init is missing — cannot fall back to local build"
    exit 2
  fi
  docker build --quiet \
    -t "${INIT_IMAGE_LOCAL_BUILD}" \
    -f "${REPO_ROOT}/build/Dockerfile.keycloak-init" \
    "${REPO_ROOT}" >/dev/null
  INIT_IMAGE="${INIT_IMAGE_LOCAL_BUILD}"
  echo "[init-image] built ${INIT_IMAGE}"
fi

# --- Teardown ------------------------------------------------------
cleanup() {
  local code=$?
  if [ "${KEEP:-0}" = "1" ]; then
    info "KEEP=1 set — leaving ${KC_CONTAINER} running on ${KC_URL}"
    info "  docker rm -f ${KC_CONTAINER}   # to remove later"
  else
    docker rm -f "${KC_CONTAINER}" >/dev/null 2>&1 || true
  fi
  exit "${code}"
}
trap cleanup EXIT INT TERM

# --- 0. Boot Keycloak ----------------------------------------------
step "Booting throwaway Keycloak (${KC_IMAGE}) on ${KC_URL}"

docker rm -f "${KC_CONTAINER}" >/dev/null 2>&1 || true

# Mount realm-config.json INTO /opt/keycloak/data/import so Keycloak
# imports it on first boot. Using -v with absolute path so the mount
# is portable across Docker Desktop on macOS / Linux.
docker run -d --name "${KC_CONTAINER}" \
  -p "${KC_PORT}:8080" \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -v "${REALM_FILE}:/opt/keycloak/data/import/realm-config.json:ro" \
  "${KC_IMAGE}" \
  start-dev --import-realm \
  >/dev/null

info "container: ${KC_CONTAINER}"
info "waiting for realm import..."

# Wait up to 90s for the realm to be reachable
for i in $(seq 1 45); do
  if curl -sf "${KC_URL}/realms/${KC_REALM}" >/dev/null 2>&1; then
    pass "Keycloak ready (took ~$((i*2))s)"
    break
  fi
  if [ "$i" = "45" ]; then
    echo "--- container logs ---"
    docker logs --tail 80 "${KC_CONTAINER}" || true
    fail "Keycloak did not start within 90s"
  fi
  sleep 2
done

# --- Helper: get admin token + caipe-platform UUID -----------------
get_admin_token() {
  curl -sf -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
    -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" \
    | jq -r '.access_token'
}

get_platform_client_secret() {
  local tok="$1"
  local uuid
  uuid=$(curl -sf -H "Authorization: Bearer ${tok}" \
    "${KC_URL}/admin/realms/${KC_REALM}/clients?clientId=${KC_PLATFORM_CLIENT}" \
    | jq -r '.[0].id')
  [ -n "${uuid}" ] && [ "${uuid}" != "null" ] || { echo "client ${KC_PLATFORM_CLIENT} not found"; return 1; }
  curl -sf -H "Authorization: Bearer ${tok}" \
    "${KC_URL}/admin/realms/${KC_REALM}/clients/${uuid}" \
    | jq -r '.secret'
}

# Run init-idp.sh inside a container using the chart's init image,
# mounting our local scripts/ dir so we exercise the patched file.
# `--network host` so the container can reach Keycloak on localhost
# (Docker Desktop on macOS would otherwise need host.docker.internal).
# On macOS, --network host doesn't expose host ports — fall back to
# host.docker.internal which Docker Desktop wires up automatically.
KC_URL_FOR_CONTAINER="${KC_URL}"
case "$(uname -s)" in
  Darwin)
    KC_URL_FOR_CONTAINER="http://host.docker.internal:${KC_PORT}"
    DOCKER_NET_ARGS=()                       # no --network host on macOS
    ;;
  Linux)
    DOCKER_NET_ARGS=(--network host)
    ;;
  *)
    DOCKER_NET_ARGS=()
    ;;
esac

run_init_idp() {
  local platform_secret="$1"
  local extra_env=()
  if [ -n "${platform_secret}" ]; then
    extra_env+=(-e "KEYCLOAK_PLATFORM_CLIENT_SECRET=${platform_secret}")
  fi
  # NB: the init image declares `ENTRYPOINT ["/bin/sh"]` so the CMD here is
  # just the script path (and any flags). Don't prepend `/bin/sh` or
  # `--entrypoint` will get nested-`sh`'d and read its own ELF as a script.
  docker run --rm "${DOCKER_NET_ARGS[@]}" \
    -e "KC_URL=${KC_URL_FOR_CONTAINER}" \
    -e "KC_REALM=${KC_REALM}" \
    -e "KEYCLOAK_ADMIN=admin" \
    -e "KEYCLOAK_ADMIN_PASSWORD=admin" \
    -e "KEYCLOAK_SEED_DEMO_USERS=false" \
    "${extra_env[@]}" \
    -v "${SCRIPTS_DIR}:/scripts:ro" \
    --entrypoint /bin/sh \
    "${INIT_IMAGE}" \
    /scripts/init-idp.sh 2>&1
}

# --- 1. Confirm placeholder is in place ----------------------------
step "Step 1: confirm realm import seeded the dev placeholder"
TOKEN="$(get_admin_token)"
[ -n "${TOKEN}" ] && [ "${TOKEN}" != "null" ] || fail "could not get master admin token"
INITIAL_SECRET="$(get_platform_client_secret "${TOKEN}")"
info "  caipe-platform secret: ${INITIAL_SECRET}"
if [ "${INITIAL_SECRET}" = "${KC_PLACEHOLDER_SECRET}" ]; then
  pass "placeholder '${KC_PLACEHOLDER_SECRET}' is in place"
else
  fail "expected placeholder '${KC_PLACEHOLDER_SECRET}', got '${INITIAL_SECRET}'"
fi

# --- 2. Run init-idp.sh with env UNSET — must be a no-op ----------
step "Step 2: run init-idp.sh with KEYCLOAK_PLATFORM_CLIENT_SECRET unset (no-op path)"
OUTPUT_NOOP="$(run_init_idp "" 2>&1 || true)"
if echo "${OUTPUT_NOOP}" | grep -q "KEYCLOAK_PLATFORM_CLIENT_SECRET not set — leaving caipe-platform client_secret unchanged"; then
  pass "init-idp.sh logged the expected no-op message"
else
  echo "${OUTPUT_NOOP}" | tail -30
  fail "did not find the expected no-op log line"
fi

TOKEN="$(get_admin_token)"
SECRET_AFTER_NOOP="$(get_platform_client_secret "${TOKEN}")"
if [ "${SECRET_AFTER_NOOP}" = "${KC_PLACEHOLDER_SECRET}" ]; then
  pass "Keycloak secret unchanged (still '${KC_PLACEHOLDER_SECRET}')"
else
  fail "secret unexpectedly changed: '${SECRET_AFTER_NOOP}'"
fi

# --- 3. Run init-idp.sh with env SET — must reconcile -------------
step "Step 3: run init-idp.sh with KEYCLOAK_PLATFORM_CLIENT_SECRET set to a new random value"
ROTATED_SECRET="rotated-$(openssl rand -hex 16)"
info "  new secret: ${ROTATED_SECRET}"

OUTPUT_RUN1="$(run_init_idp "${ROTATED_SECRET}" 2>&1 || true)"
if echo "${OUTPUT_RUN1}" | grep -q "Reconciling client_secret on 'caipe-platform' from KEYCLOAK_PLATFORM_CLIENT_SECRET"; then
  pass "init-idp.sh logged 'Reconciling …'"
else
  echo "${OUTPUT_RUN1}" | tail -30
  fail "did not find the expected reconcile log line"
fi
if echo "${OUTPUT_RUN1}" | grep -q "caipe-platform client_secret reconciled"; then
  pass "init-idp.sh logged 'caipe-platform client_secret reconciled.'"
else
  fail "did not find the success log line"
fi

TOKEN="$(get_admin_token)"
SECRET_AFTER_RUN1="$(get_platform_client_secret "${TOKEN}")"
if [ "${SECRET_AFTER_RUN1}" = "${ROTATED_SECRET}" ]; then
  pass "Keycloak now holds the new value"
else
  fail "Keycloak holds '${SECRET_AFTER_RUN1}', expected '${ROTATED_SECRET}'"
fi

# --- 4. Run init-idp.sh again with the SAME value — idempotency ----
step "Step 4: re-run with the same value (idempotency check)"
OUTPUT_RUN2="$(run_init_idp "${ROTATED_SECRET}" 2>&1 || true)"
if echo "${OUTPUT_RUN2}" | grep -q "caipe-platform client_secret reconciled"; then
  pass "second run completed successfully (idempotent)"
else
  echo "${OUTPUT_RUN2}" | tail -30
  fail "second run did not succeed"
fi

TOKEN="$(get_admin_token)"
SECRET_AFTER_RUN2="$(get_platform_client_secret "${TOKEN}")"
if [ "${SECRET_AFTER_RUN2}" = "${ROTATED_SECRET}" ]; then
  pass "secret unchanged after second run"
else
  fail "secret changed unexpectedly: '${SECRET_AFTER_RUN2}'"
fi

# --- 5. Supervisor-style client_credentials with the NEW secret ----
step "Step 5: client_credentials grant with the rotated secret"
NEW_TOKEN_RESP="$(curl -sf -X POST "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  --data-urlencode "client_id=${KC_PLATFORM_CLIENT}" \
  --data-urlencode "client_secret=${ROTATED_SECRET}" 2>/dev/null || echo "{}")"
NEW_TOKEN="$(echo "${NEW_TOKEN_RESP}" | jq -r '.access_token // empty')"
if [ -n "${NEW_TOKEN}" ] && [ "${#NEW_TOKEN}" -gt 100 ]; then
  pass "minted JWT with new secret (length=${#NEW_TOKEN})"
else
  info "response: ${NEW_TOKEN_RESP}"
  fail "could not mint token with new secret"
fi

# --- 6. The OLD placeholder must now be REJECTED -------------------
step "Step 6: client_credentials grant with the OLD placeholder MUST fail"
OLD_TOKEN_RESP="$(curl -s -X POST "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  --data-urlencode "client_id=${KC_PLATFORM_CLIENT}" \
  --data-urlencode "client_secret=${KC_PLACEHOLDER_SECRET}" 2>/dev/null || echo "{}")"
OLD_ERR="$(echo "${OLD_TOKEN_RESP}" | jq -r '.error // empty')"
if [ "${OLD_ERR}" = "invalid_client" ] || [ "${OLD_ERR}" = "unauthorized_client" ]; then
  pass "old placeholder rejected (error=${OLD_ERR})"
elif [ -n "$(echo "${OLD_TOKEN_RESP}" | jq -r '.access_token // empty')" ]; then
  fail "SECURITY REGRESSION: Keycloak still accepts the old placeholder!"
else
  info "response: ${OLD_TOKEN_RESP}"
  fail "unexpected response — expected invalid_client"
fi

# --- Done ----------------------------------------------------------
echo
echo "${GREEN}=============================================${RESET}"
echo "${GREEN}  All 6 steps passed.${RESET}"
echo "${GREEN}  caipe-platform reconcile is working end-to-end.${RESET}"
echo "${GREEN}=============================================${RESET}"
