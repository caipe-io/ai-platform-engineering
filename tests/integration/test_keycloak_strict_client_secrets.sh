#!/usr/bin/env bash
# -------------------------------------------------------------------
# tests/integration/test_keycloak_strict_client_secrets.sh
#
# End-to-end test for the strict client-secret mode added to
# init-idp.sh and init-token-exchange.sh
# (keycloak.strictClientSecrets=true in the Helm chart).
#
# Spins up a throwaway Keycloak 26.3 container (same image the Helm
# chart pins), imports the realm shipped with the chart, then:
#
#   1. Sanity-check that all FOUR dev placeholder client_secrets
#      (caipe-ui-dev-secret, caipe-platform-dev-secret,
#      caipe-slack-bot-dev-secret, caipe-webex-bot-dev-secret) are
#      accepted by Keycloak immediately after first-boot import.
#
#   2. Run init-idp.sh with KEYCLOAK_STRICT_CLIENT_SECRETS=true and
#      WITHOUT any reconcile env vars set. The strict guard MUST
#      reject the placeholders for caipe-ui + caipe-platform and the
#      script MUST exit non-zero.
#
#   3. Rotate the caipe-ui + caipe-platform secrets via init-idp.sh
#      and re-run with strict mode on. The guard MUST now PASS for
#      those two clients (the script logs a green line for each).
#
#   4. Reconcile the two bot client_secrets directly via the admin
#      API (avoids the full init-token-exchange.sh dependency tree)
#      and confirm the strict guard logic accepts the realm when ALL
#      four placeholders are rejected. We do this by running the
#      init-idp guard a third time — it should now report "Strict
#      mode passed".
#
#   5. **Caipe-platform Admin REST runtime contract (May 2026).** After
#      the rotation in Step 3, mint a `client_credentials` token using
#      the rotated `caipe-platform` secret and call the real Keycloak
#      Admin REST endpoints the BFF uses (`GET /users`, `GET /clients`,
#      `POST /users`). Assert 200 / 201 — proving the realm config still
#      binds the required realm-management user/client/authz roles to
#      `service-account-caipe-platform`. Also audits the realm-side
#      role mappings as belt-and-braces (Keycloak resolves these
#      server-side at the Admin API gate; they're NOT embedded in the
#      JWT payload, so we have to call the API to know they work).
#
# Note: a "chart-render integration" sub-step that asserts the caipe-ui
# Deployment reads KEYCLOAK_ADMIN_CLIENT_SECRET from the SAME K8s Secret
# this PR creates lives in the dependent caipe-ui hardening PR, where
# the umbrella `values.yaml` actually wires `caipe-ui.keycloakAdminClient`.
# Pinning it here would create a cross-PR dependency that fails on the
# `release/0.5-1-split-pr-5-keycloak-hardening` base branch.
#
# Step 4 deliberately stops short of running init-token-exchange.sh
# end-to-end: that script depends on a fully-configured realm with
# the realm-management client and pre-built scope permissions, which
# is the same scope already covered by the chart-level integration
# tests. Here we focus on the strict guard logic itself.
#
# Requires: docker, curl, jq, openssl, python3. Uses one host port
# (default 19080, override with KC_PORT=...).
#
# Exit 0 on success, non-zero with a clear FAIL message otherwise.
#
# Usage:
#   ./tests/integration/test_keycloak_strict_client_secrets.sh
#   KC_PORT=29080 ./tests/integration/test_keycloak_strict_client_secrets.sh
#   KEEP=1 ./...    # leave the Keycloak container running for inspection
#
# assisted-by Claude:claude-opus-4-7
# -------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS_DIR="${REPO_ROOT}/charts/ai-platform-engineering/charts/keycloak/scripts"
REALM_FILE="${REPO_ROOT}/charts/ai-platform-engineering/charts/keycloak/realm-config.json"

KC_PORT="${KC_PORT:-19080}"
KC_URL="http://localhost:${KC_PORT}"
KC_REALM="caipe"
KC_CONTAINER="kc-strict-secret-test-$$"

INIT_IMAGE_CANDIDATES=(
  "${INIT_IMAGE:-}"
  "ghcr.io/cnoe-io/keycloak-init:0.5.1-rc.25"
  "ghcr.io/cnoe-io/keycloak-init:latest"
)
INIT_IMAGE_LOCAL_BUILD="caipe/keycloak-init:local-test"
KC_IMAGE="quay.io/keycloak/keycloak:26.3"

# clientId|placeholder pairs we care about
DEV_PAIRS=(
  "caipe-ui|caipe-ui-dev-secret"
  "caipe-platform|caipe-platform-dev-secret"
  "caipe-slack-bot|caipe-slack-bot-dev-secret"
  "caipe-webex-bot|caipe-webex-bot-dev-secret"
)

# --- Pretty output -------------------------------------------------
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
step()  { echo; echo "${CYAN}==> $*${RESET}"; }
pass()  { echo "${GREEN}    PASS:${RESET} $*"; }
fail()  { echo "${RED}    FAIL:${RESET} $*"; exit 1; }
info()  { echo "${YELLOW}    info:${RESET} $*"; }

# --- Pre-flight ----------------------------------------------------
command -v docker  >/dev/null || { echo "docker is required";  exit 2; }
command -v curl    >/dev/null || { echo "curl is required";    exit 2; }
command -v jq      >/dev/null || { echo "jq is required (brew install jq)"; exit 2; }
command -v openssl >/dev/null || { echo "openssl is required"; exit 2; }
# python3 powers Step 5's YAML/JWT parsing. It's already an indirect
# prereq via init-idp.sh's _reconcile_caipe_platform_client_secret,
# so the pre-flight just makes the failure mode loud if absent.
command -v python3 >/dev/null || { echo "python3 is required (Step 5 chart-render parser)"; exit 2; }
[ -f "${REALM_FILE}" ] || { echo "realm-config.json not found at ${REALM_FILE}"; exit 2; }
[ -f "${SCRIPTS_DIR}/init-idp.sh" ] || { echo "init-idp.sh not found at ${SCRIPTS_DIR}"; exit 2; }

# Resolve which keycloak-init image to use
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

# --- Helpers -------------------------------------------------------
get_admin_token() {
  curl -sf -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
    -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" \
    | jq -r '.access_token'
}

# Returns 0 if Keycloak ACCEPTS the (clientId, secret) pair via
# client_credentials. Returns 1 otherwise.
accepts_credentials() {
  local cid="$1" sec="$2"
  local resp
  resp=$(curl -s -X POST "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
    -d "grant_type=client_credentials" \
    --data-urlencode "client_id=${cid}" \
    --data-urlencode "client_secret=${sec}" 2>/dev/null || echo "{}")
  [ -n "$(echo "${resp}" | jq -r '.access_token // empty')" ]
}

# Rotate a client's secret directly via the admin API. We deliberately
# DON'T use init-idp.sh for the bot clients here, since init-idp.sh
# only knows how to reconcile caipe-ui + caipe-platform.
rotate_client_secret() {
  local cid="$1" new_secret="$2" tok="$3"
  local uuid
  uuid=$(curl -sf -H "Authorization: Bearer ${tok}" \
    "${KC_URL}/admin/realms/${KC_REALM}/clients?clientId=${cid}" \
    | jq -r '.[0].id')
  [ -n "${uuid}" ] && [ "${uuid}" != "null" ] || { echo "client ${cid} not found"; return 1; }
  curl -sf -X PUT \
    -H "Authorization: Bearer ${tok}" \
    -H "Content-Type: application/json" \
    -d "{\"clientId\":\"${cid}\",\"secret\":\"${new_secret}\"}" \
    "${KC_URL}/admin/realms/${KC_REALM}/clients/${uuid}" >/dev/null
}

# Run init-idp.sh inside the chart's init container image.
# On macOS, --network host is a no-op for port publishing so we have
# to rebrand KC_URL to host.docker.internal.
KC_URL_FOR_CONTAINER="${KC_URL}"
case "$(uname -s)" in
  Darwin)
    KC_URL_FOR_CONTAINER="http://host.docker.internal:${KC_PORT}"
    DOCKER_NET_ARGS=()
    ;;
  Linux)
    DOCKER_NET_ARGS=(--network host)
    ;;
  *)
    DOCKER_NET_ARGS=()
    ;;
esac

run_init_idp() {
  local platform_secret="$1" ui_secret="$2" strict="$3"
  local extra_env=()
  [ -n "${platform_secret}" ] && extra_env+=(-e "KEYCLOAK_PLATFORM_CLIENT_SECRET=${platform_secret}")
  [ -n "${ui_secret}" ]       && extra_env+=(-e "KEYCLOAK_UI_CLIENT_SECRET=${ui_secret}")
  [ "${strict}" = "1" ]       && extra_env+=(-e "KEYCLOAK_STRICT_CLIENT_SECRETS=true")
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

# --- 1. Sanity check: all four placeholders accepted at first boot -
step "Step 1: confirm realm import accepts all four dev placeholder secrets"
for pair in "${DEV_PAIRS[@]}"; do
  cid="${pair%%|*}"
  ph="${pair##*|}"
  if accepts_credentials "${cid}" "${ph}"; then
    pass "Keycloak accepts ${cid} with '${ph}'"
  else
    fail "expected Keycloak to accept ${cid}|${ph} at first boot"
  fi
done

# --- 2. Strict mode without reconcile env vars MUST fail -----------
step "Step 2: run init-idp.sh with KEYCLOAK_STRICT_CLIENT_SECRETS=true and no rotation env vars"
# We intentionally allow this to exit non-zero so we can grep the output.
OUTPUT_STRICT_NOOP="$(run_init_idp "" "" "1" 2>&1 || true)"
if echo "${OUTPUT_STRICT_NOOP}" | grep -q "Strict mode FAILED"; then
  pass "init-idp.sh failed loudly in strict mode (as expected)"
else
  echo "${OUTPUT_STRICT_NOOP}" | tail -40
  fail "expected 'Strict mode FAILED' log line"
fi
if echo "${OUTPUT_STRICT_NOOP}" | grep -q "Keycloak still accepts the dev placeholder client_secret for 'caipe-ui'"; then
  pass "caipe-ui violation surfaced"
else
  fail "did not find caipe-ui violation log line"
fi
if echo "${OUTPUT_STRICT_NOOP}" | grep -q "Keycloak still accepts the dev placeholder client_secret for 'caipe-platform'"; then
  pass "caipe-platform violation surfaced"
else
  fail "did not find caipe-platform violation log line"
fi

# Step 2 only runs init-idp.sh, which is scoped to ui + platform.
# A strict-mode failure inside the script returns rc 1 to the trap,
# but the docker run is wrapped in `|| true` above so we can inspect
# the log. Belt-and-braces: confirm Keycloak still accepts the
# placeholders.
TOKEN="$(get_admin_token)"
for pair in "${DEV_PAIRS[@]}"; do
  cid="${pair%%|*}"
  ph="${pair##*|}"
  if accepts_credentials "${cid}" "${ph}"; then
    info "Keycloak still accepts ${cid}|${ph} (as expected — script aborted before rotation)"
  else
    fail "${cid}|${ph} unexpectedly rejected — script may have rotated despite strict failure"
  fi
done

# --- 3. Rotate caipe-ui + caipe-platform via init-idp.sh in strict mode -
step "Step 3: rotate caipe-ui + caipe-platform via init-idp.sh in strict mode"
ROTATED_PLATFORM="rotated-platform-$(openssl rand -hex 12)"
ROTATED_UI="rotated-ui-$(openssl rand -hex 12)"
info "  new caipe-ui secret:       ${ROTATED_UI}"
info "  new caipe-platform secret: ${ROTATED_PLATFORM}"

OUTPUT_STRICT_OK="$(run_init_idp "${ROTATED_PLATFORM}" "${ROTATED_UI}" "1" 2>&1 || true)"
# Even though strict mode is on, init-idp.sh covers only ui + platform.
# The bots still hold their placeholders, so the strict guard inside
# init-idp.sh should PASS (its scope is just ui + platform) AND the
# script should exit zero overall.
if echo "${OUTPUT_STRICT_OK}" | grep -q "Strict mode passed: caipe-ui + caipe-platform reject their dev placeholders"; then
  pass "init-idp.sh strict guard passed for ui + platform"
else
  echo "${OUTPUT_STRICT_OK}" | tail -40
  fail "did not find 'Strict mode passed' log line"
fi

# Confirm rotation actually happened
if accepts_credentials "caipe-ui" "${ROTATED_UI}"; then
  pass "caipe-ui now accepts the rotated secret"
else
  fail "caipe-ui does NOT accept the rotated secret"
fi
if accepts_credentials "caipe-platform" "${ROTATED_PLATFORM}"; then
  pass "caipe-platform now accepts the rotated secret"
else
  fail "caipe-platform does NOT accept the rotated secret"
fi

# --- 4. Manually rotate the two bot secrets, then re-run init-idp strict -
# This simulates what init-token-exchange.sh would do in a real install:
# rotate caipe-slack-bot + caipe-webex-bot via the admin API. We don't
# run init-token-exchange.sh here (its happy path requires the
# realm-management client + scope permissions which the test realm
# doesn't expose by default).
step "Step 4: rotate the two bot client_secrets via the admin API, then re-run init-idp strict"
ROTATED_SLACK_BOT="rotated-slack-$(openssl rand -hex 12)"
ROTATED_WEBEX_BOT="rotated-webex-$(openssl rand -hex 12)"
TOKEN="$(get_admin_token)"
rotate_client_secret "caipe-slack-bot" "${ROTATED_SLACK_BOT}" "${TOKEN}"
rotate_client_secret "caipe-webex-bot" "${ROTATED_WEBEX_BOT}" "${TOKEN}"
pass "manually rotated caipe-slack-bot + caipe-webex-bot"

# Run init-idp again (still scoped to ui + platform). Its guard should
# still pass because ui + platform are also rotated.
OUTPUT_STRICT_OK2="$(run_init_idp "${ROTATED_PLATFORM}" "${ROTATED_UI}" "1" 2>&1 || true)"
if echo "${OUTPUT_STRICT_OK2}" | grep -q "Strict mode passed"; then
  pass "init-idp.sh strict guard still PASSES after bot rotation"
else
  echo "${OUTPUT_STRICT_OK2}" | tail -40
  fail "init-idp.sh strict guard regressed after bot rotation"
fi

# Finally, manually verify ALL FOUR placeholders are now rejected.
# This is the end-state the production hardening guarantees.
step "End-state: confirm all four dev placeholders are rejected"
for pair in "${DEV_PAIRS[@]}"; do
  cid="${pair%%|*}"
  ph="${pair##*|}"
  if accepts_credentials "${cid}" "${ph}"; then
    fail "SECURITY REGRESSION: Keycloak still accepts the placeholder for '${cid}'!"
  else
    pass "'${cid}' rejects its dev placeholder"
  fi
done

# --- 5. End-to-end: prove a real Keycloak Admin REST call (the exact
# API surface the BFF's `fetchFreshAdminToken` users) succeeds with the
# token minted from the rotated caipe-platform secret.
#
# Important nuance discovered while building this test: Keycloak does
# NOT embed `resource_access.realm-management.roles` in a
# client_credentials access token by default — the realm-management
# roles are resolved SERVER-SIDE at the Admin API gate against the
# calling service-account's role mappings. A JWT-payload-only assertion
# (e.g. `jq '.resource_access["realm-management"].roles'`) would
# therefore be a false-negative even on a perfectly-working install.
#
# So instead of introspecting the token, we make the actual Admin REST
# calls the BFF makes. This is the runtime contract: "the rotated
# secret + the env-var names the BFF reads + the realm's
# service-account role mappings together let the BFF do
# user and client/admin-authz role set needed by the BFF migration."
step "Step 5: caipe-platform token actually works for the Admin REST endpoints the BFF calls"
BFF_TOKEN_RESP="$(curl -s -X POST "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  --data-urlencode "client_id=caipe-platform" \
  --data-urlencode "client_secret=${ROTATED_PLATFORM}" || echo '{}')"
BFF_TOKEN="$(echo "${BFF_TOKEN_RESP}" | jq -r '.access_token // empty')"
if [ -z "${BFF_TOKEN}" ]; then
  echo "${BFF_TOKEN_RESP}"
  fail "could not mint client_credentials token against caipe-platform (rotated secret)"
fi
pass "client_credentials grant succeeded with the rotated caipe-platform secret"

# Sanity: token's `azp` is caipe-platform. This is the only token claim
# that's worth asserting — `resource_access` is intentionally absent
# (see the docstring above).
BFF_TOKEN_PAYLOAD="$(echo "${BFF_TOKEN}" | cut -d. -f2)"
BFF_TOKEN_JSON="$(python3 - "${BFF_TOKEN_PAYLOAD}" <<'PY'
import base64, json, sys
payload = sys.argv[1]
payload += "=" * (-len(payload) % 4)
decoded = base64.urlsafe_b64decode(payload).decode("utf-8")
sys.stdout.write(decoded)
PY
)"
BFF_AZP="$(echo "${BFF_TOKEN_JSON}" | jq -r '.azp // empty')"
BFF_AUD="$(echo "${BFF_TOKEN_JSON}" | jq -r '.aud // empty | if type=="array" then join(",") else . end')"
info "  azp: ${BFF_AZP}"
info "  aud: ${BFF_AUD}"
if [ "${BFF_AZP}" != "caipe-platform" ]; then
  fail "expected azp=caipe-platform, got '${BFF_AZP}'"
fi
pass "token azp matches the BFF's KEYCLOAK_ADMIN_CLIENT_ID (caipe-platform)"

# (i) view-users — listing realm users is the most common BFF Admin
# REST call (the Users tab). 200 OK proves the role binds correctly.
USERS_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${BFF_TOKEN}" \
  "${KC_URL}/admin/realms/${KC_REALM}/users?max=1")"
if [ "${USERS_STATUS}" = "200" ]; then
  pass "BFF can call GET /admin/realms/${KC_REALM}/users (HTTP 200 — view-users + query-users active)"
else
  fail "BFF GET /users returned HTTP ${USERS_STATUS} — expected 200; realm-management/view-users not bound to service-account-caipe-platform"
fi

# (ii) query/view clients — this is the exact Keycloak Admin REST lookup
# used by the BFF Keycloak RBAC migration before it repairs bot OBO
# permissions. A role-filtered token can return HTTP 200 with [] even when
# the client exists, so assert the body too.
CLIENTS_BODY="$(curl -sf \
  -H "Authorization: Bearer ${BFF_TOKEN}" \
  "${KC_URL}/admin/realms/${KC_REALM}/clients?clientId=caipe-slack-bot")"
CLIENTS_COUNT="$(echo "${CLIENTS_BODY}" | jq 'length')"
if [ "${CLIENTS_COUNT}" = "1" ]; then
  pass "BFF can call GET /admin/realms/${KC_REALM}/clients?clientId=caipe-slack-bot (query/view-clients active)"
else
  echo "${CLIENTS_BODY}"
  fail "BFF client lookup returned ${CLIENTS_COUNT} row(s) — expected 1; realm-management query/view-clients not bound to service-account-caipe-platform"
fi

# (iii) manage-users — POST a throwaway user (the role required for
# creating users in the Admin UI). 201 Created proves the role binds
# end-to-end. We don't bother deleting it: the Keycloak container is
# torn down at the next `docker rm -f` (and `KEEP=1` is for inspection,
# where the probe user is harmless).
PROBE_USER="r1-int-probe-$(openssl rand -hex 6)"
CREATE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST -H "Authorization: Bearer ${BFF_TOKEN}" -H "Content-Type: application/json" \
  -d "{\"username\":\"${PROBE_USER}\",\"enabled\":true}" \
  "${KC_URL}/admin/realms/${KC_REALM}/users")"
if [ "${CREATE_STATUS}" = "201" ]; then
  pass "BFF can call POST /admin/realms/${KC_REALM}/users (HTTP 201 — manage-users active; probe user '${PROBE_USER}')"
else
  fail "BFF POST /users returned HTTP ${CREATE_STATUS} — expected 201; realm-management/manage-users not bound to service-account-caipe-platform"
fi

# Belt-and-braces: verify the realm-side role bindings still exist
# even though we just proved them by call. This guards against the
# case where Keycloak's default behaviour ever changes (e.g. it
# starts looking at the JWT payload again instead of resolving
# server-side): the realm config MUST keep these mappings.
SA_UID="$(curl -sf -H "Authorization: Bearer $(get_admin_token)" \
  "${KC_URL}/admin/realms/${KC_REALM}/users?username=service-account-caipe-platform&exact=true" \
  | jq -r '.[0].id // empty')"
RM_UID="$(curl -sf -H "Authorization: Bearer $(get_admin_token)" \
  "${KC_URL}/admin/realms/${KC_REALM}/clients?clientId=realm-management" \
  | jq -r '.[0].id // empty')"
if [ -z "${SA_UID}" ] || [ -z "${RM_UID}" ]; then
  fail "could not locate service-account-caipe-platform or realm-management for role audit"
fi
SA_RM_ROLES="$(curl -sf -H "Authorization: Bearer $(get_admin_token)" \
  "${KC_URL}/admin/realms/${KC_REALM}/users/${SA_UID}/role-mappings/clients/${RM_UID}" \
  | jq -r '[.[] | .name] | join(",")')"
info "  service-account-caipe-platform realm-management roles: ${SA_RM_ROLES:-<none>}"
for role in view-users query-users manage-users query-clients view-clients manage-clients view-authorization manage-authorization; do
  if echo "${SA_RM_ROLES}" | tr ',' '\n' | grep -qx "${role}"; then
    pass "realm config still binds realm-management:${role} to service-account-caipe-platform"
  else
    fail "service-account-caipe-platform is MISSING realm-management:${role} — realm-config.json regressed"
  fi
done

# --- Done ----------------------------------------------------------
echo
echo "${GREEN}=============================================${RESET}"
echo "${GREEN}  All strict-mode steps passed.${RESET}"
echo "${GREEN}  Four-client placeholder hardening works end-to-end.${RESET}"
echo "${GREEN}=============================================${RESET}"
