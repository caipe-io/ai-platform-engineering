#!/bin/sh
# -------------------------------------------------------------------
# deploy/keycloak/init-token-exchange.sh
#
# Configures Keycloak token exchange (RFC 8693) impersonation for CAIPE
# service clients. Runs after realm import to set up fine-grained admin
# permissions that cannot be declared in realm-config.json.
#
# Idempotent — safe to re-run on every container start.
#
# Depends on: sh, curl, grep, sed, python3 (provided by Dockerfile.keycloak-init).
#
# Required env vars:
#   KEYCLOAK_ADMIN / KC_BOOTSTRAP_ADMIN_USERNAME  (default: admin)
#   KEYCLOAK_ADMIN_PASSWORD / KC_BOOTSTRAP_ADMIN_PASSWORD (default: admin)
#
# Optional:
#   KC_REALM           – realm name (default: caipe)
#   KC_BOT_CLIENT_ID   – bot client-id (default: caipe-slack-bot)
#   KC_SSL_REQUIRED    – realm sslRequired (default: none for dev)
# -------------------------------------------------------------------
set -eu

REALM="${KC_REALM:-caipe}"
KC_URL="${KC_URL:-http://localhost:7080}"
BOT_CLIENT_ID="${KC_BOT_CLIENT_ID:-caipe-slack-bot}"
SSL_REQ="${KC_SSL_REQUIRED:-none}"
ADMIN_USER="${KEYCLOAK_ADMIN:-${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}}"
ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin}}"

TAG="[init-token-exchange]"

# --- helper: extract a string field from JSON (no jq needed) ---
json_field() {
  echo "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:.*"\(.*\)"/\1/'
}

# --- helper: extract a JSON array or object (simple, single-line) ---
json_bool() {
  echo "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*[a-z]*" | head -1 | sed "s/.*:[[:space:]]*//"
}

# --- obtain admin token ---
get_admin_token() {
  TOKEN_RESP=$(curl -sf -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
    -d "grant_type=password&client_id=admin-cli&username=${ADMIN_USER}&password=${ADMIN_PASS}") || {
    echo "${TAG} ERROR: could not authenticate to Keycloak" >&2
    return 1
  }
  json_field "${TOKEN_RESP}" "access_token"
}

echo "${TAG} Obtaining admin access token ..."
ACCESS_TOKEN=$(get_admin_token) || exit 1
if [ -z "${ACCESS_TOKEN}" ]; then
  echo "${TAG} ERROR: empty access_token" >&2
  exit 1
fi
AUTH="Authorization: Bearer ${ACCESS_TOKEN}"

attach_policy_to_scope_permission() {
  REALM_MANAGEMENT_ID="$1"
  PERMISSION_ID="$2"
  POLICY_ID="$3"
  LABEL="${4:-scope permission}"

  PERMISSION_JSON=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/clients/${REALM_MANAGEMENT_ID}/authz/resource-server/permission/scope/${PERMISSION_ID}" 2>/dev/null || echo "{}")
  ASSOCIATED_POLICIES_JSON=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/clients/${REALM_MANAGEMENT_ID}/authz/resource-server/permission/scope/${PERMISSION_ID}/associatedPolicies" 2>/dev/null || echo "[]")
  UPDATED_PERMISSION_JSON=$(PERMISSION_JSON="${PERMISSION_JSON}" ASSOCIATED_POLICIES_JSON="${ASSOCIATED_POLICIES_JSON}" POLICY_ID="${POLICY_ID}" python3 -c '
import json
import os

permission = json.loads(os.environ["PERMISSION_JSON"])
associated = json.loads(os.environ.get("ASSOCIATED_POLICIES_JSON") or "[]")
policies = []
for policy_id in permission.get("policies") or []:
    if policy_id not in policies:
        policies.append(policy_id)
for policy in associated:
    policy_id = policy.get("id") if isinstance(policy, dict) else None
    if policy_id and policy_id not in policies:
        policies.append(policy_id)
if os.environ["POLICY_ID"] not in policies:
    policies.append(os.environ["POLICY_ID"])
permission["policies"] = policies
# Force AFFIRMATIVE decision strategy so that adding additional
# per-client policies to a SHARED scope-permission (e.g. the realm-level
# users.impersonate permission, which both caipe-slack-bot and
# caipe-webex-bot attach client policies to) does not cause cross-DENY
# under Keycloak'\''s default UNANIMOUS strategy. Without this, attaching
# the Webex bot policy after the Slack bot policy makes the Slack bot
# fail OBO with "Client not allowed to exchange/impersonate" because
# the Webex policy votes DENY for the Slack bot. See the matching
# helper in charts/.../init-idp.sh for the long-form rationale.
permission["decisionStrategy"] = "AFFIRMATIVE"
print(json.dumps(permission))
' 2>/dev/null)
  if [ -n "${UPDATED_PERMISSION_JSON}" ]; then
    curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/clients/${REALM_MANAGEMENT_ID}/authz/resource-server/permission/scope/${PERMISSION_ID}" \
      -d "${UPDATED_PERMISSION_JSON}" 2>/dev/null && \
      echo "${TAG}   ${LABEL} updated (AFFIRMATIVE)."
  fi
}

# ------------------------------------------------------------------
# 1. Set sslRequired on master + realm
# ------------------------------------------------------------------
echo "${TAG} Setting sslRequired=${SSL_REQ} on master and ${REALM} realms ..."
curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
  "${KC_URL}/admin/realms/master" \
  -d "{\"sslRequired\":\"${SSL_REQ}\"}" 2>/dev/null && \
  echo "${TAG}   master realm sslRequired=${SSL_REQ}" || \
  echo "${TAG}   WARNING: could not update master realm."

curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
  "${KC_URL}/admin/realms/${REALM}" \
  -d "{\"sslRequired\":\"${SSL_REQ}\"}" 2>/dev/null && \
  echo "${TAG}   ${REALM} realm sslRequired=${SSL_REQ}" || \
  echo "${TAG}   WARNING: could not update ${REALM} realm."

# ------------------------------------------------------------------
# 2. Configure user profile: unmanagedAttributePolicy + slack_user_id
# ------------------------------------------------------------------
echo "${TAG} Configuring user profile ..."
PROFILE=$(curl -sf -H "${AUTH}" "${KC_URL}/admin/realms/${REALM}/users/profile" 2>/dev/null || echo "{}")

# Check if slack_user_id is already declared
if echo "${PROFILE}" | grep -q '"slack_user_id"'; then
  echo "${TAG}   slack_user_id already declared in user profile."
else
  echo "${TAG}   Adding slack_user_id to user profile ..."
  # Use sed to inject the attribute and set unmanagedAttributePolicy
  # We rebuild the profile JSON to add slack_user_id and set the policy
  # NB: capture group must be explicitly closed with `\)` for busybox sed
  # (alpine/curl). GNU sed auto-closes at the end of the pattern; busybox
  # does not, and aborts with "bad regex: Missing ')'". Closing the group
  # right after `\[` matches the same text and works in both GNU + busybox.
  UPDATED_PROFILE=$(echo "${PROFILE}" | sed 's/\("attributes"[[:space:]]*:[[:space:]]*\[\)/\1{"name":"slack_user_id","displayName":"Slack User ID","validations":{},"annotations":{},"permissions":{"view":["admin"],"edit":["admin"]},"multivalued":false},/')

  # Set unmanagedAttributePolicy
  if echo "${UPDATED_PROFILE}" | grep -q '"unmanagedAttributePolicy"'; then
    UPDATED_PROFILE=$(echo "${UPDATED_PROFILE}" | sed 's/"unmanagedAttributePolicy"[[:space:]]*:[[:space:]]*"[^"]*"/"unmanagedAttributePolicy":"ADMIN_EDIT"/')
  else
    # Append before closing brace
    UPDATED_PROFILE=$(echo "${UPDATED_PROFILE}" | sed 's/}$/,"unmanagedAttributePolicy":"ADMIN_EDIT"}/')
  fi

  curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
    "${KC_URL}/admin/realms/${REALM}/users/profile" \
    -d "${UPDATED_PROFILE}" 2>/dev/null && \
    echo "${TAG}   User profile updated (slack_user_id + ADMIN_EDIT)." || \
    echo "${TAG}   WARNING: could not update user profile."
  PROFILE=$(curl -sf -H "${AUTH}" "${KC_URL}/admin/realms/${REALM}/users/profile" 2>/dev/null || echo "{}")
fi

if echo "${PROFILE}" | grep -q '"webex_user_id"'; then
  echo "${TAG}   webex_user_id already declared in user profile."
else
  echo "${TAG}   Adding webex_user_id to user profile ..."
  UPDATED_PROFILE=$(echo "${PROFILE}" | sed 's/\("attributes"[[:space:]]*:[[:space:]]*\[\)/\1{"name":"webex_user_id","displayName":"Webex User ID","validations":{},"annotations":{},"permissions":{"view":["admin"],"edit":["admin"]},"multivalued":false},/')
  if echo "${UPDATED_PROFILE}" | grep -q '"unmanagedAttributePolicy"'; then
    UPDATED_PROFILE=$(echo "${UPDATED_PROFILE}" | sed 's/"unmanagedAttributePolicy"[[:space:]]*:[[:space:]]*"[^"]*"/"unmanagedAttributePolicy":"ADMIN_EDIT"/')
  else
    UPDATED_PROFILE=$(echo "${UPDATED_PROFILE}" | sed 's/}$/,"unmanagedAttributePolicy":"ADMIN_EDIT"}/')
  fi
  curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
    "${KC_URL}/admin/realms/${REALM}/users/profile" \
    -d "${UPDATED_PROFILE}" 2>/dev/null && \
    echo "${TAG}   User profile updated (webex_user_id + ADMIN_EDIT)." || \
    echo "${TAG}   WARNING: could not update user profile for webex_user_id."
fi

# Also ensure unmanagedAttributePolicy is set even if slack_user_id was already there
if ! echo "${PROFILE}" | grep -q '"ADMIN_EDIT"'; then
  UPDATED_PROFILE=$(curl -sf -H "${AUTH}" "${KC_URL}/admin/realms/${REALM}/users/profile" 2>/dev/null || echo "{}")
  if echo "${UPDATED_PROFILE}" | grep -q '"unmanagedAttributePolicy"'; then
    UPDATED_PROFILE=$(echo "${UPDATED_PROFILE}" | sed 's/"unmanagedAttributePolicy"[[:space:]]*:[[:space:]]*"[^"]*"/"unmanagedAttributePolicy":"ADMIN_EDIT"/')
  else
    UPDATED_PROFILE=$(echo "${UPDATED_PROFILE}" | sed 's/}$/,"unmanagedAttributePolicy":"ADMIN_EDIT"}/')
  fi
  curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
    "${KC_URL}/admin/realms/${REALM}/users/profile" \
    -d "${UPDATED_PROFILE}" 2>/dev/null && \
    echo "${TAG}   unmanagedAttributePolicy set to ADMIN_EDIT." || true
fi

# ------------------------------------------------------------------
# 3. Find bot client internal ID
# ------------------------------------------------------------------
echo "${TAG} Looking up client '${BOT_CLIENT_ID}' ..."
CLIENTS_RESP=$(curl -sf -H "${AUTH}" \
  "${KC_URL}/admin/realms/${REALM}/clients?clientId=${BOT_CLIENT_ID}" 2>/dev/null || echo "[]")

BOT_INTERNAL_ID=$(json_field "${CLIENTS_RESP}" "id")
if [ -z "${BOT_INTERNAL_ID}" ]; then
  echo "${TAG} ERROR: client '${BOT_CLIENT_ID}' not found in realm '${REALM}'" >&2
  exit 1
fi
echo "${TAG}   Client internal ID: ${BOT_INTERNAL_ID}"

# ------------------------------------------------------------------
# 4. Ensure fullScopeAllowed = true
# ------------------------------------------------------------------
echo "${TAG} Ensuring fullScopeAllowed=true on '${BOT_CLIENT_ID}' ..."
FULL_SCOPE=$(json_bool "${CLIENTS_RESP}" "fullScopeAllowed")
if [ "${FULL_SCOPE}" = "true" ]; then
  echo "${TAG}   Already true."
else
  curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
    "${KC_URL}/admin/realms/${REALM}/clients/${BOT_INTERNAL_ID}" \
    -d "{\"clientId\":\"${BOT_CLIENT_ID}\",\"fullScopeAllowed\":true}" 2>/dev/null && \
    echo "${TAG}   Set fullScopeAllowed=true." || \
    echo "${TAG}   WARNING: could not set fullScopeAllowed."
fi

# ------------------------------------------------------------------
# 4b. (Optional) Reconcile client_secret to the value supplied by the
#     orchestration layer (Helm chart Secret / ESO ExternalSecret).
#
# Set when KC_BOT_CLIENT_SECRET env var is non-empty. Skipped silently
# in dev/local scenarios where the secret is left to whatever Keycloak
# auto-generated on realm import (current behavior is preserved).
#
# The Admin API accepts the secret as a regular client field on PUT.
# Idempotent — re-applying the same value is a no-op as far as Keycloak
# is concerned (it just overwrites the same string). Keycloak does NOT
# return the current value via GET, so we cannot conditionally skip;
# we always PUT when the env is supplied.
#
# Security: we deliberately do not log the secret. Only success/failure.
# ------------------------------------------------------------------
if [ -n "${KC_BOT_CLIENT_SECRET:-}" ]; then
  echo "${TAG} Reconciling client_secret on '${BOT_CLIENT_ID}' from KC_BOT_CLIENT_SECRET ..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
    "${KC_URL}/admin/realms/${REALM}/clients/${BOT_INTERNAL_ID}" \
    -d "{\"clientId\":\"${BOT_CLIENT_ID}\",\"secret\":\"${KC_BOT_CLIENT_SECRET}\"}" 2>/dev/null || echo "000")
  if [ "${HTTP_CODE}" = "204" ] || [ "${HTTP_CODE}" = "200" ]; then
    echo "${TAG}   client_secret reconciled (HTTP ${HTTP_CODE})."
  else
    echo "${TAG}   ERROR: failed to set client_secret (HTTP ${HTTP_CODE})." >&2
    exit 1
  fi
else
  echo "${TAG} KC_BOT_CLIENT_SECRET not set — leaving Keycloak-managed client_secret unchanged."
fi

WEBEX_BOT_CLIENT_ID="${KC_WEBEX_BOT_CLIENT_ID:-}"
if [ -n "${KC_WEBEX_BOT_CLIENT_SECRET:-}" ] && [ -n "${WEBEX_BOT_CLIENT_ID}" ]; then
  echo "${TAG} Reconciling client_secret on '${WEBEX_BOT_CLIENT_ID}' from KC_WEBEX_BOT_CLIENT_SECRET ..."
  WEBEX_CLIENTS_RESP=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/clients?clientId=${WEBEX_BOT_CLIENT_ID}" 2>/dev/null || echo "[]")
  WEBEX_INTERNAL_ID=$(json_field "${WEBEX_CLIENTS_RESP}" "id")
  if [ -z "${WEBEX_INTERNAL_ID}" ]; then
    echo "${TAG}   WARNING: client '${WEBEX_BOT_CLIENT_ID}' not found — skipping Webex secret reconciliation." >&2
  else
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/clients/${WEBEX_INTERNAL_ID}" \
      -d "{\"clientId\":\"${WEBEX_BOT_CLIENT_ID}\",\"secret\":\"${KC_WEBEX_BOT_CLIENT_SECRET}\"}" 2>/dev/null || echo "000")
    if [ "${HTTP_CODE}" = "204" ] || [ "${HTTP_CODE}" = "200" ]; then
      echo "${TAG}   Webex client_secret reconciled (HTTP ${HTTP_CODE})."
    else
      echo "${TAG}   ERROR: failed to set Webex client_secret (HTTP ${HTTP_CODE})." >&2
      exit 1
    fi
  fi
else
  echo "${TAG} KC_WEBEX_BOT_CLIENT_SECRET not set — leaving Webex client_secret unchanged."
fi

# Reconcile the scheduler-runner client secret.
# This client is used by the BFF to mint schedule-owner bearers via
# requested_subject impersonation; the BFF authenticates with
# KEYCLOAK_SCHEDULER_CLIENT_SECRET, so Keycloak's stored secret must match.
SCHEDULER_CLIENT_ID="${KC_SCHEDULER_CLIENT_ID:-}"
if [ -n "${SCHEDULER_CLIENT_ID}" ]; then
  SCHEDULER_CLIENTS_RESP=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/clients?clientId=${SCHEDULER_CLIENT_ID}" 2>/dev/null || echo "[]")
  SCHEDULER_INTERNAL_ID=$(json_field "${SCHEDULER_CLIENTS_RESP}" "id")

  # Realm import only creates clients when the realm is first created. Helm
  # upgrades therefore need to create this newly introduced client explicitly.
  if [ -z "${SCHEDULER_INTERNAL_ID}" ]; then
    if [ -z "${KC_SCHEDULER_CLIENT_SECRET:-}" ]; then
      echo "${TAG}   ERROR: client '${SCHEDULER_CLIENT_ID}' is missing and KC_SCHEDULER_CLIENT_SECRET is unset." >&2
      exit 1
    fi
    echo "${TAG} Creating missing scheduler-runner client '${SCHEDULER_CLIENT_ID}' ..."
    SCHEDULER_CLIENT_JSON=$(SCHEDULER_CLIENT_ID="${SCHEDULER_CLIENT_ID}" \
      SCHEDULER_CLIENT_SECRET="${KC_SCHEDULER_CLIENT_SECRET}" python3 -c '
import json
import os

print(json.dumps({
    "clientId": os.environ["SCHEDULER_CLIENT_ID"],
    "name": "CAIPE Scheduler Runner",
    "description": "Confidential client scoped to scheduled-run owner impersonation.",
    "enabled": True,
    "publicClient": False,
    "bearerOnly": False,
    "standardFlowEnabled": False,
    "directAccessGrantsEnabled": False,
    "serviceAccountsEnabled": True,
    "authorizationServicesEnabled": False,
    "protocol": "openid-connect",
    "fullScopeAllowed": True,
    "defaultClientScopes": ["profile", "email", "roles", "groups", "org"],
    "attributes": {"oidc.token.exchange.enabled": "true"},
    "secret": os.environ["SCHEDULER_CLIENT_SECRET"],
}))
')
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST -H "${AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/clients" \
      -d "${SCHEDULER_CLIENT_JSON}" 2>/dev/null || echo "000")
    if [ "${HTTP_CODE}" != "201" ] && [ "${HTTP_CODE}" != "409" ]; then
      echo "${TAG}   ERROR: failed to create scheduler-runner client (HTTP ${HTTP_CODE})." >&2
      exit 1
    fi
    SCHEDULER_CLIENTS_RESP=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients?clientId=${SCHEDULER_CLIENT_ID}" 2>/dev/null || echo "[]")
    SCHEDULER_INTERNAL_ID=$(json_field "${SCHEDULER_CLIENTS_RESP}" "id")
    if [ -z "${SCHEDULER_INTERNAL_ID}" ]; then
      echo "${TAG}   ERROR: scheduler-runner client has no internal ID after create." >&2
      exit 1
    fi
  fi

  if [ -n "${KC_SCHEDULER_CLIENT_SECRET:-}" ]; then
    echo "${TAG} Reconciling client_secret on '${SCHEDULER_CLIENT_ID}' from KC_SCHEDULER_CLIENT_SECRET ..."
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/clients/${SCHEDULER_INTERNAL_ID}" \
      -d "{\"clientId\":\"${SCHEDULER_CLIENT_ID}\",\"secret\":\"${KC_SCHEDULER_CLIENT_SECRET}\"}" 2>/dev/null || echo "000")
    if [ "${HTTP_CODE}" = "204" ] || [ "${HTTP_CODE}" = "200" ]; then
      echo "${TAG}   scheduler-runner client_secret reconciled (HTTP ${HTTP_CODE})."
    else
      echo "${TAG}   ERROR: failed to set scheduler-runner client_secret (HTTP ${HTTP_CODE})." >&2
      exit 1
    fi
  else
    echo "${TAG} KC_SCHEDULER_CLIENT_SECRET not set; leaving scheduler-runner client_secret unchanged."
  fi
else
  echo "${TAG} KC_SCHEDULER_CLIENT_ID not set; skipping scheduler-runner reconciliation."
fi

# ------------------------------------------------------------------
# 5. Get service account users + assign impersonation role
# ------------------------------------------------------------------
# Find realm-management client
RM_RESP=$(curl -sf -H "${AUTH}" \
  "${KC_URL}/admin/realms/${REALM}/clients?clientId=realm-management" 2>/dev/null || echo "[]")
RM_CLIENT_ID=$(json_field "${RM_RESP}" "id")

ensure_service_account_impersonation_role() {
  CLIENT_ID="$1"
  CLIENT_INTERNAL_ID="$2"
  SEED_OPENFGA_GRANTS="${3:-true}"

  if [ -z "${CLIENT_ID}" ]; then
    return 0
  fi
  if [ -z "${CLIENT_INTERNAL_ID}" ]; then
    echo "${TAG} WARNING: client '${CLIENT_ID}' not found — skipping impersonation role."
    return 0
  fi
  if [ -z "${RM_CLIENT_ID}" ]; then
    echo "${TAG} WARNING: realm-management client not found — skipping impersonation role for '${CLIENT_ID}'."
    return 0
  fi

  echo "${TAG} Looking up service account for '${CLIENT_ID}' ..."
  SA_RESP=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/clients/${CLIENT_INTERNAL_ID}/service-account-user" 2>/dev/null || echo "{}")
  SA_USER_ID=$(json_field "${SA_RESP}" "id")

  if [ -z "${SA_USER_ID}" ]; then
    echo "${TAG} ERROR: service account not found for '${CLIENT_ID}'" >&2
    exit 1
  fi
  echo "${TAG}   Service account user ID: ${SA_USER_ID}"

  if [ "${SEED_OPENFGA_GRANTS}" = "true" ]; then
    # Stash bot service-account ids for the OpenFGA seed section below.
    BOT_SA_USER_IDS="${BOT_SA_USER_IDS:-}${BOT_SA_USER_IDS:+
}${SA_USER_ID}|${CLIENT_ID}"
  fi

  SA_CLIENT_ROLES=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/users/${SA_USER_ID}/role-mappings/clients/${RM_CLIENT_ID}" 2>/dev/null || echo "[]")

  if echo "${SA_CLIENT_ROLES}" | grep -q '"impersonation"'; then
    echo "${TAG}   impersonation role already assigned."
  else
    echo "${TAG}   Assigning impersonation role ..."
    IMP_ROLE_RESP=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/roles/impersonation" 2>/dev/null || echo "{}")
    IMP_ROLE_ID=$(json_field "${IMP_ROLE_RESP}" "id")

    if [ -n "${IMP_ROLE_ID}" ]; then
      curl -sf -X POST -H "${AUTH}" -H "Content-Type: application/json" \
        "${KC_URL}/admin/realms/${REALM}/users/${SA_USER_ID}/role-mappings/clients/${RM_CLIENT_ID}" \
        -d "[{\"id\":\"${IMP_ROLE_ID}\",\"name\":\"impersonation\"}]" && \
        echo "${TAG}   impersonation role assigned." || \
        echo "${TAG}   WARNING: could not assign impersonation role."
    else
      echo "${TAG}   WARNING: impersonation role not found in realm-management."
    fi
  fi
}

ensure_service_account_impersonation_role "${BOT_CLIENT_ID}" "${BOT_INTERNAL_ID}"

if [ -n "${WEBEX_BOT_CLIENT_ID}" ]; then
  if [ -z "${WEBEX_INTERNAL_ID:-}" ]; then
    WEBEX_CLIENTS_RESP=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients?clientId=${WEBEX_BOT_CLIENT_ID}" 2>/dev/null || echo "[]")
    WEBEX_INTERNAL_ID=$(json_field "${WEBEX_CLIENTS_RESP}" "id")
  fi
  ensure_service_account_impersonation_role "${WEBEX_BOT_CLIENT_ID}" "${WEBEX_INTERNAL_ID}"
fi

if [ -n "${SCHEDULER_CLIENT_ID}" ]; then
  if [ -z "${SCHEDULER_INTERNAL_ID:-}" ]; then
    SCHEDULER_CLIENTS_RESP=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients?clientId=${SCHEDULER_CLIENT_ID}" 2>/dev/null || echo "[]")
    SCHEDULER_INTERNAL_ID=$(json_field "${SCHEDULER_CLIENTS_RESP}" "id")
  fi
  ensure_service_account_impersonation_role "${SCHEDULER_CLIENT_ID}" "${SCHEDULER_INTERNAL_ID}" "false"
fi

# ------------------------------------------------------------------
# 6. Enable management permissions on the bot client
# ------------------------------------------------------------------
echo "${TAG} Enabling management permissions on '${BOT_CLIENT_ID}' ..."

# Refresh token (previous operations may have taken time)
ACCESS_TOKEN=$(get_admin_token) || exit 1
AUTH="Authorization: Bearer ${ACCESS_TOKEN}"

MGMT_PERMS=$(curl -sf -H "${AUTH}" \
  "${KC_URL}/admin/realms/${REALM}/clients/${BOT_INTERNAL_ID}/management/permissions" 2>/dev/null || echo '{"enabled":false}')

MGMT_ENABLED=$(json_bool "${MGMT_PERMS}" "enabled")
if [ "${MGMT_ENABLED}" = "true" ]; then
  echo "${TAG}   Management permissions already enabled."
  # Re-fetch to get permission IDs
  MGMT_PERMS=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/clients/${BOT_INTERNAL_ID}/management/permissions" 2>/dev/null || echo '{}')
else
  MGMT_PERMS=$(curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
    "${KC_URL}/admin/realms/${REALM}/clients/${BOT_INTERNAL_ID}/management/permissions" \
    -d '{"enabled":true}' 2>/dev/null || echo '{}')
  echo "${TAG}   Management permissions enabled."
fi

# Extract token-exchange permission ID
TOKEN_EXCHANGE_PERM_ID=$(echo "${MGMT_PERMS}" | grep -o '"token-exchange" *: *"[^"]*"' | sed 's/.*"\([^"]*\)"/\1/' | head -1)
echo "${TAG}   token-exchange permission ID: ${TOKEN_EXCHANGE_PERM_ID:-NOT_FOUND}"

# ------------------------------------------------------------------
# 7. Create client policy for the bot (idempotent)
# ------------------------------------------------------------------
if [ -z "${RM_CLIENT_ID}" ]; then
  echo "${TAG} WARNING: skipping policy setup — realm-management not found."
else
  echo "${TAG} Ensuring client policy for '${BOT_CLIENT_ID}' ..."
  POLICY_NAME="caipe-slack-bot-token-exchange-policy"

  # Check if policy already exists
  EXISTING_POLICIES=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/authz/resource-server/policy?name=${POLICY_NAME}&max=1" 2>/dev/null || echo "[]")

  if echo "${EXISTING_POLICIES}" | grep -q "\"${POLICY_NAME}\""; then
    echo "${TAG}   Policy '${POLICY_NAME}' already exists."
    POLICY_ID=$(json_field "${EXISTING_POLICIES}" "id")
  else
    echo "${TAG}   Creating policy '${POLICY_NAME}' ..."
    POLICY_RESP=$(curl -sf -X POST -H "${AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/authz/resource-server/policy/client" \
      -d "{\"name\":\"${POLICY_NAME}\",\"description\":\"Allow ${BOT_CLIENT_ID} to perform token exchange\",\"logic\":\"POSITIVE\",\"clients\":[\"${BOT_INTERNAL_ID}\"]}" 2>/dev/null || echo '{}')
    POLICY_ID=$(json_field "${POLICY_RESP}" "id")
    if [ -n "${POLICY_ID}" ]; then
      echo "${TAG}   Policy created: ${POLICY_ID}"
    else
      echo "${TAG}   WARNING: could not create policy."
    fi
  fi

  # ------------------------------------------------------------------
  # 8. Associate policy with token-exchange permission
  # ------------------------------------------------------------------
  if [ -n "${TOKEN_EXCHANGE_PERM_ID}" ] && [ -n "${POLICY_ID}" ]; then
    echo "${TAG} Associating policy with token-exchange permission ..."

    # Get permission details (resources + scopes)
    PERM_RESOURCES=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/authz/resource-server/permission/scope/${TOKEN_EXCHANGE_PERM_ID}/resources" 2>/dev/null || echo "[]")
    RESOURCE_ID=$(json_field "${PERM_RESOURCES}" "_id")

    PERM_SCOPES=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/authz/resource-server/permission/scope/${TOKEN_EXCHANGE_PERM_ID}/scopes" 2>/dev/null || echo "[]")
    SCOPE_ID=$(json_field "${PERM_SCOPES}" "id")

    PERM_NAME="token-exchange.permission.client.${BOT_INTERNAL_ID}"

    attach_policy_to_scope_permission "${RM_CLIENT_ID}" "${TOKEN_EXCHANGE_PERM_ID}" "${POLICY_ID}" "token-exchange permission" || \
      echo "${TAG}   WARNING: could not update token-exchange permission ${PERM_NAME}."
  fi

  # ------------------------------------------------------------------
  # 9. Enable user management permissions + associate impersonate
  # ------------------------------------------------------------------
  echo "${TAG} Enabling user management permissions ..."

  USER_MGMT=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/users-management-permissions" 2>/dev/null || echo '{"enabled":false}')
  USER_MGMT_ENABLED=$(json_bool "${USER_MGMT}" "enabled")

  if [ "${USER_MGMT_ENABLED}" = "true" ]; then
    echo "${TAG}   User management permissions already enabled."
    USER_MGMT=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/users-management-permissions" 2>/dev/null || echo '{}')
  else
    USER_MGMT=$(curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/users-management-permissions" \
      -d '{"enabled":true}' 2>/dev/null || echo '{}')
    echo "${TAG}   User management permissions enabled."
  fi

  # Extract impersonate permission ID
  IMPERSONATE_PERM_ID=$(echo "${USER_MGMT}" | grep -o '"impersonate" *: *"[^"]*"' | sed 's/.*"\([^"]*\)"/\1/' | head -1)

  if [ -n "${IMPERSONATE_PERM_ID}" ] && [ -n "${POLICY_ID}" ]; then
    echo "${TAG} Associating policy with impersonate permission ..."

    IMP_RESOURCES=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/authz/resource-server/permission/scope/${IMPERSONATE_PERM_ID}/resources" 2>/dev/null || echo "[]")
    IMP_RESOURCE_ID=$(json_field "${IMP_RESOURCES}" "_id")

    IMP_SCOPES=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/authz/resource-server/permission/scope/${IMPERSONATE_PERM_ID}/scopes" 2>/dev/null || echo "[]")
    IMP_SCOPE_ID=$(json_field "${IMP_SCOPES}" "id")

    attach_policy_to_scope_permission "${RM_CLIENT_ID}" "${IMPERSONATE_PERM_ID}" "${POLICY_ID}" "impersonate permission" || \
      echo "${TAG}   WARNING: could not update impersonate permission."
  fi

  # The scheduler performs requested_subject token exchange on behalf of a
  # schedule owner. Authorize its client policy on all three Keycloak gates:
  # its own token-exchange permission, users.impersonate, and (in section 8b)
  # the target audience's token-exchange permission.
  if [ -n "${SCHEDULER_INTERNAL_ID:-}" ]; then
    echo "${TAG} Enabling management permissions on '${SCHEDULER_CLIENT_ID}' ..."
    SCHEDULER_MGMT=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${SCHEDULER_INTERNAL_ID}/management/permissions" 2>/dev/null || echo '{"enabled":false}')
    if [ "$(json_bool "${SCHEDULER_MGMT}" "enabled")" != "true" ]; then
      curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
        "${KC_URL}/admin/realms/${REALM}/clients/${SCHEDULER_INTERNAL_ID}/management/permissions" \
        -d '{"enabled":true}' >/dev/null 2>&1 || {
          echo "${TAG}   ERROR: could not enable scheduler management permissions." >&2
          exit 1
        }
    fi
    SCHEDULER_MGMT=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${SCHEDULER_INTERNAL_ID}/management/permissions" 2>/dev/null || echo '{}')
    SCHEDULER_TOKEN_EXCHANGE_PERM_ID=$(echo "${SCHEDULER_MGMT}" | grep -o '"token-exchange" *: *"[^"]*"' | sed 's/.*"\([^"]*\)"/\1/' | head -1)
    if [ -z "${SCHEDULER_TOKEN_EXCHANGE_PERM_ID}" ] || [ -z "${IMPERSONATE_PERM_ID}" ]; then
      echo "${TAG}   ERROR: scheduler token-exchange or users.impersonate permission is unavailable." >&2
      exit 1
    fi

    SCHEDULER_POLICY_NAME="caipe-scheduler-runner-token-exchange-policy"
    SCHEDULER_POLICIES=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/authz/resource-server/policy?name=${SCHEDULER_POLICY_NAME}&max=1" 2>/dev/null || echo '[]')
    SCHEDULER_POLICY_ID=$(json_field "${SCHEDULER_POLICIES}" "id")
    if [ -z "${SCHEDULER_POLICY_ID}" ]; then
      SCHEDULER_POLICY_RESP=$(curl -sf -X POST -H "${AUTH}" -H "Content-Type: application/json" \
        "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/authz/resource-server/policy/client" \
        -d "{\"name\":\"${SCHEDULER_POLICY_NAME}\",\"description\":\"Allow ${SCHEDULER_CLIENT_ID} to perform owner OBO token exchange\",\"logic\":\"POSITIVE\",\"clients\":[\"${SCHEDULER_INTERNAL_ID}\"]}" 2>/dev/null || echo '{}')
      SCHEDULER_POLICY_ID=$(json_field "${SCHEDULER_POLICY_RESP}" "id")
    fi
    if [ -z "${SCHEDULER_POLICY_ID}" ]; then
      echo "${TAG}   ERROR: could not resolve or create scheduler token-exchange policy." >&2
      exit 1
    fi

    attach_policy_to_scope_permission "${RM_CLIENT_ID}" "${SCHEDULER_TOKEN_EXCHANGE_PERM_ID}" "${SCHEDULER_POLICY_ID}" "scheduler token-exchange permission" || {
      echo "${TAG}   ERROR: could not authorize scheduler token exchange." >&2
      exit 1
    }
    attach_policy_to_scope_permission "${RM_CLIENT_ID}" "${IMPERSONATE_PERM_ID}" "${SCHEDULER_POLICY_ID}" "scheduler users.impersonate permission" || {
      echo "${TAG}   ERROR: could not authorize scheduler owner impersonation." >&2
      exit 1
    }
  fi
fi

# ------------------------------------------------------------------
# 8b. OBO target token-exchange permission on the audience client
#     (caipe-platform by default)
#
# Bots perform On-Behalf-Of (RFC 8693) token-exchange whose *target
# audience* is the CAIPE UI BFF resource server (caipe-platform). Keycloak
# gates that exchange with the token-exchange scope-permission on the
# AUDIENCE client, so BOTH bot client policies must be attached there — not
# just on each bot's own client permission (handled above).
#
# This reconciliation previously lived only in init-idp.sh, which the chart
# runs exclusively when an upstream IdP broker is configured (idp.enabled=
# true). For the default in-chart / local-Keycloak install that job never
# renders, leaving the caipe-platform token-exchange perm with no bot
# policies and Keycloak's default UNANIMOUS strategy — which fails the bot
# OBO health invariants on a brand-new install. Reconciling it here, in the
# job that always runs on tokenExchange.enabled, makes a fresh install pass
# without depending on the upstream-IdP path. Idempotent; safe to re-run and
# safe to no-op when the audience/bot clients are absent.
# ------------------------------------------------------------------
OBO_AUDIENCE_CLIENT_ID="${CAIPE_PLATFORM_AUDIENCE:-caipe-platform}"
if [ -n "${RM_CLIENT_ID:-}" ]; then
  echo "${TAG} Reconciling OBO target token-exchange perm on '${OBO_AUDIENCE_CLIENT_ID}' ..."
  OBO_AUD_RESP=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/clients?clientId=${OBO_AUDIENCE_CLIENT_ID}" 2>/dev/null || echo "[]")
  OBO_AUD_INTERNAL_ID=$(json_field "${OBO_AUD_RESP}" "id")
  if [ -z "${OBO_AUD_INTERNAL_ID}" ]; then
    echo "${TAG}   '${OBO_AUDIENCE_CLIENT_ID}' client not found — skipping OBO target perm."
  else
    # Enable management permissions on the audience client (idempotent;
    # creates the token-exchange scope-permission if absent).
    OBO_MGMT=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${OBO_AUD_INTERNAL_ID}/management/permissions" 2>/dev/null || echo '{"enabled":false}')
    if [ "$(json_bool "${OBO_MGMT}" "enabled")" != "true" ]; then
      OBO_MGMT=$(curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
        "${KC_URL}/admin/realms/${REALM}/clients/${OBO_AUD_INTERNAL_ID}/management/permissions" \
        -d '{"enabled":true}' 2>/dev/null || echo '{}')
      echo "${TAG}   Management permissions enabled on '${OBO_AUDIENCE_CLIENT_ID}'."
    fi
    OBO_TE_PERM_ID=$(echo "${OBO_MGMT}" | grep -o '"token-exchange" *: *"[^"]*"' | sed 's/.*"\([^"]*\)"/\1/' | head -1)
    if [ -z "${OBO_TE_PERM_ID}" ]; then
      echo "${TAG}   WARNING: no token-exchange permission on '${OBO_AUDIENCE_CLIENT_ID}' — skipping."
    else
      # find-or-create a POSITIVE client policy for a bot, then attach it to
      # the audience token-exchange perm. attach_policy_to_scope_permission
      # forces AFFIRMATIVE so multiple bot policies on the SHARED perm don't
      # cross-DENY under the default UNANIMOUS strategy.
      _attach_bot_to_obo_target() {
        _pname="$1"; _bot_internal="$2"; _bot_label="$3"
        [ -n "${_bot_internal}" ] || return 0
        _existing=$(curl -sf -H "${AUTH}" \
          "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/authz/resource-server/policy?name=${_pname}&max=1" 2>/dev/null || echo "[]")
        if echo "${_existing}" | grep -q "\"${_pname}\""; then
          _pid=$(json_field "${_existing}" "id")
        else
          _presp=$(curl -sf -X POST -H "${AUTH}" -H "Content-Type: application/json" \
            "${KC_URL}/admin/realms/${REALM}/clients/${RM_CLIENT_ID}/authz/resource-server/policy/client" \
            -d "{\"name\":\"${_pname}\",\"description\":\"Allow ${_bot_label} OBO token exchange to ${OBO_AUDIENCE_CLIENT_ID}\",\"logic\":\"POSITIVE\",\"clients\":[\"${_bot_internal}\"]}" 2>/dev/null || echo '{}')
          _pid=$(json_field "${_presp}" "id")
        fi
        if [ -n "${_pid}" ]; then
          attach_policy_to_scope_permission "${RM_CLIENT_ID}" "${OBO_TE_PERM_ID}" "${_pid}" "${OBO_AUDIENCE_CLIENT_ID} token-exchange perm (${_bot_label})" || \
            echo "${TAG}   WARNING: could not attach ${_bot_label} policy to OBO target perm."
        else
          echo "${TAG}   WARNING: could not resolve/create policy '${_pname}'."
        fi
      }
      _attach_bot_to_obo_target "caipe-slack-bot-token-exchange-policy" "${BOT_INTERNAL_ID:-}" "caipe-slack-bot"
      _attach_bot_to_obo_target "caipe-webex-bot-token-exchange-policy" "${WEBEX_INTERNAL_ID:-}" "caipe-webex-bot"
      _attach_bot_to_obo_target "caipe-scheduler-runner-token-exchange-policy" "${SCHEDULER_INTERNAL_ID:-}" "caipe-scheduler-runner"
    fi
  fi
fi

# ------------------------------------------------------------------
# Phase 3 of spec 2026-05-24-derive-team-from-channel removed the
# team-personal client scope, the `active_team=__personal__` hardcoded
# claim mapper, and the optional-scope binding on the bot client. The
# `active_team` mechanism never shipped to production, so we do not
# need an idempotent cleanup branch here — operators starting from
# scratch get a clean realm, and any realm that was provisioned by an
# older version of this script can drop the scope manually if needed.
# ------------------------------------------------------------------

# ------------------------------------------------------------------
# 9. Seed the bot service accounts' OpenFGA grants
# ------------------------------------------------------------------
# The Slack and Webex bots call first-party BFF endpoints with their own
# client-credentials (service-account) tokens — not user OBO tokens — for
# service-to-service reads that have no user in context. The BFF graphs
# such callers as `service_account:<bot-sub>` (see ui/src/lib/rbac/
# resource-authz.ts `subjectFromSession`) and gates each endpoint with an
# OpenFGA check. Nothing else grants the bots' service accounts those
# relations, so we seed them here where each bot's SA user id is known.
#
# Grants applied to every bot SA:
#   - reader system_config:platform_settings — read platform-wide settings
#     (default agent, VictorOps agent) via `GET /api/admin/platform-config`.
#   - writer admin_surface:user_provisioning — JIT create-or-resolve a
#     federated shell user via `POST /api/admin/users/provision-shell`
#     (issue #1781), so a bot can provision a Keycloak account on first DM.
#   - reader admin_surface:user_directory — exact user lookups (by attribute,
#     email, or id) via `GET /api/admin/users/resolve`.
#   - writer admin_surface:user_directory — merge a user attribute via
#     `PATCH /api/admin/users/{id}/attributes`.
#     The user_directory grants (read = lookups, write = attribute merge) let
#     the bot reach Keycloak entirely through the BFF, replacing its former
#     direct Keycloak Admin credentials (spec
#     2026-06-09-slack-bot-remove-direct-keycloak-admin).
# Add rows to SA_GRANTS as the bots take on more service-to-service calls —
# each grant is applied to all bots in BOT_SA_USER_IDS, so the Webex bot gets
# parity automatically.
#
# Idempotent (check-then-write). Best-effort: a missing store / unreachable
# OpenFGA logs a warning and returns 0 so it never blocks token exchange —
# the bots degrade to their env/YAML defaults until the grant lands.

# Newline-separated "<relation> <object>" pairs to grant each bot's service
# account (the seeding loop splits on newlines).
SA_GRANTS="reader system_config:platform_settings
writer admin_surface:user_provisioning
reader admin_surface:user_directory
writer admin_surface:user_directory"

# resolve_openfga_store_id <openfga_base_url> <store_name> -> echoes store id
resolve_openfga_store_id() {
  _ofga="$1"
  _store_name="$2"
  _i=0
  while [ "${_i}" -lt 30 ]; do
    if curl -sf "${_ofga}/stores" >/dev/null 2>&1; then
      break
    fi
    _i=$((_i + 1))
    echo "${TAG}   waiting for OpenFGA (${_i}/30) ..." >&2
    sleep 2
  done
  _stores_json=$(curl -sf "${_ofga}/stores" 2>/dev/null || echo "")
  [ -z "${_stores_json}" ] && return 0
  STORES_JSON="${_stores_json}" STORE_NAME="${_store_name}" python3 -c '
import json, os, sys
stores = json.loads(os.environ["STORES_JSON"]).get("stores", [])
sys.stdout.write(next((s["id"] for s in stores if s.get("name") == os.environ["STORE_NAME"]), ""))
' 2>/dev/null
}

# write_openfga_grant <openfga_base_url> <store_id> <user> <relation> <object>
write_openfga_grant() {
  _ofga="$1"; _store_id="$2"; _user="$3"; _relation="$4"; _object="$5"
  _tuple="{\"user\":\"${_user}\",\"relation\":\"${_relation}\",\"object\":\"${_object}\"}"

  _check=$(curl -sf -X POST "${_ofga}/stores/${_store_id}/check" \
    -H "Content-Type: application/json" \
    -d "{\"tuple_key\":${_tuple}}" 2>/dev/null || echo "")
  if echo "${_check}" | grep -q '"allowed"[[:space:]]*:[[:space:]]*true'; then
    echo "${TAG}   ${_user} ${_relation} ${_object} — already present."
    return 0
  fi

  _code=$(curl -s -o /tmp/_ofga_write.$$ -w "%{http_code}" \
    -X POST "${_ofga}/stores/${_store_id}/write" \
    -H "Content-Type: application/json" \
    -d "{\"writes\":{\"tuple_keys\":[${_tuple}]}}" 2>/dev/null || echo "000")
  _body=$(cat /tmp/_ofga_write.$$ 2>/dev/null || echo "")
  rm -f /tmp/_ofga_write.$$
  if [ "${_code}" = "200" ] || [ "${_code}" = "201" ]; then
    echo "${TAG}   ${_user} ${_relation} ${_object} — written."
  elif echo "${_body}" | grep -q "already exists"; then
    echo "${TAG}   ${_user} ${_relation} ${_object} — already present (write race)."
  else
    echo "${TAG}   WARNING: failed to write ${_user} ${_relation} ${_object} (HTTP ${_code}): ${_body}" >&2
  fi
}

seed_openfga_service_account_grants() {
  OFGA="${OPENFGA_HTTP:-http://openfga:8080}"
  OFGA="${OFGA%/}"
  OFGA_STORE_NAME="${OPENFGA_STORE_NAME:-caipe-openfga}"

  if [ -z "${BOT_SA_USER_IDS:-}" ]; then
    echo "${TAG} WARNING: no bot service-account user ids resolved — skipping OpenFGA grants." >&2
    return 0
  fi

  echo "${TAG} Seeding OpenFGA service-account grants at ${OFGA} ..."
  STORE_ID=$(resolve_openfga_store_id "${OFGA}" "${OFGA_STORE_NAME}")
  if [ -z "${STORE_ID}" ]; then
    echo "${TAG}   WARNING: OpenFGA store '${OFGA_STORE_NAME}' unavailable at ${OFGA} — skipping grants (bots fall back to env)." >&2
    return 0
  fi

  # Outer loop: each bot's service account ("<sa_user_id>|<clientId>").
  # Inner loop: each "<relation> <object>" grant, applied to that SA.
  echo "${BOT_SA_USER_IDS}" | while IFS= read -r sa_row; do
    [ -z "${sa_row}" ] && continue
    sa_id="${sa_row%%|*}"
    client_id="${sa_row##*|}"
    [ -z "${sa_id}" ] && continue
    ofga_user="service_account:${sa_id}"
    echo "${TAG}   ${client_id} -> ${ofga_user}"
    echo "${SA_GRANTS}" | while IFS= read -r grant; do
      [ -z "${grant}" ] && continue
      relation="${grant%% *}"
      object="${grant##* }"
      write_openfga_grant "${OFGA}" "${STORE_ID}" "${ofga_user}" "${relation}" "${object}"
    done
  done
}

seed_openfga_service_account_grants

# -------------------------------------------------------------------
# Reconcile the public CLI client (caipe-cli / forge-cli).
#
# Background: the CLI client is a public authorization-code + PKCE
# client that lets local developer CLIs (e.g. `dev-login`) mint a
# real-user JWT with aud=caipe-platform. It ships in realm-config.json,
# but Keycloak's `--import-realm` only imports on FIRST boot. On any
# deployment with a persistent database (database.enabled=true), the
# realm already exists on upgrade, so a newly-added client in
# realm-config.json is NEVER created — login fails with "Client not
# found".
#
# init-idp.sh has an identical reconcile, but that script runs only when
# idp.enabled=true (default false). This copy lives on the always-on
# init-token-exchange job (tokenExchange.enabled, default true) so the
# CLI client is also reconciled on a fresh in-chart / local-Keycloak
# install with no upstream IdP broker — the same dual-copy pattern the
# OBO reconcile uses. Both paths are idempotent.
#
# The clientId, redirect URIs, web origins, and access-token lifespan
# are configurable so downstream realms can rename the client
# (e.g. forge-cli) and tune callbacks/session length. Defaults mirror
# the caipe-cli definition in realm-config.json.
#
# assisted-by Claude:claude-opus-4-8
# -------------------------------------------------------------------
_reconcile_cli_client() {
  CLI_CLIENT_ID="${KEYCLOAK_CLI_CLIENT_ID:-caipe-cli}"
  # Space- or comma-separated lists; defaults match realm-config.json.
  CLI_REDIRECT_URIS="${KEYCLOAK_CLI_REDIRECT_URIS:-http://localhost:8085 http://localhost:8085/* http://127.0.0.1:8085 http://127.0.0.1:8085/*}"
  CLI_WEB_ORIGINS="${KEYCLOAK_CLI_WEB_ORIGINS:-http://localhost:8085 http://127.0.0.1:8085}"
  CLI_ACCESS_TOKEN_LIFESPAN="${KEYCLOAK_CLI_ACCESS_TOKEN_LIFESPAN:-28800}"

  echo "${TAG} Reconciling public CLI client '${CLI_CLIENT_ID}' (authorization-code + PKCE) ..."

  # Build the desired client representation. Keycloak binds the
  # defaultClientScopes/optionalClientScopes name arrays only on CREATE
  # (RepresentationToModel.createClient); updateClient does not re-bind
  # scopes. That is safe here because caipe-cli's default scopes match
  # the realm's defaultDefaultClientScopes, so an existing client keeps
  # the right scopes without a separate scope-binding call.
  DESIRED_JSON=$(CLI_CLIENT_ID="${CLI_CLIENT_ID}" \
    CLI_REDIRECT_URIS="${CLI_REDIRECT_URIS}" \
    CLI_WEB_ORIGINS="${CLI_WEB_ORIGINS}" \
    CLI_ACCESS_TOKEN_LIFESPAN="${CLI_ACCESS_TOKEN_LIFESPAN}" \
    python3 -c '
import json
import os


def split(value):
    return [item for item in value.replace(",", " ").split() if item]


client = {
    "clientId": os.environ["CLI_CLIENT_ID"],
    "name": "CAIPE CLI",
    "description": (
        "Public OIDC client for local developer CLIs (authorization-code + "
        "PKCE). Mints a real-user JWT with aud=caipe-platform accepted by "
        "Dynamic Agents, AgentGateway, and MCP servers. No client secret; "
        "PKCE S256 required."
    ),
    "enabled": True,
    "publicClient": True,
    "standardFlowEnabled": True,
    "directAccessGrantsEnabled": False,
    "serviceAccountsEnabled": False,
    "authorizationServicesEnabled": False,
    "redirectUris": split(os.environ["CLI_REDIRECT_URIS"]),
    "webOrigins": split(os.environ["CLI_WEB_ORIGINS"]),
    "protocol": "openid-connect",
    "fullScopeAllowed": True,
    "attributes": {
        "pkce.code.challenge.method": "S256",
        "access.token.lifespan": str(int(os.environ["CLI_ACCESS_TOKEN_LIFESPAN"])),
    },
    "defaultClientScopes": ["profile", "email", "roles", "groups", "org"],
    "optionalClientScopes": ["offline_access"],
}
print(json.dumps(client))
' 2>/dev/null)

  if [ -z "${DESIRED_JSON}" ]; then
    echo "${TAG}   WARNING: failed to render CLI client JSON (python3 required) — skipping."
    return 0
  fi

  CLI_CLIENT_UUID=$(curl -sf -H "${AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/clients?clientId=${CLI_CLIENT_ID}" 2>/dev/null \
    | grep -o '"id" *: *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"/\1/')

  if [ -z "${CLI_CLIENT_UUID}" ]; then
    echo "${TAG}   Client '${CLI_CLIENT_ID}' not found — creating ..."
    curl -sf -X POST -H "${AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/clients" \
      -d "${DESIRED_JSON}" \
      && echo "${TAG}   Created CLI client '${CLI_CLIENT_ID}'." \
      || echo "${TAG}   WARNING: failed to create CLI client '${CLI_CLIENT_ID}'."
  else
    # Merge desired fields onto the existing representation so we keep
    # the Keycloak-assigned id and any fields we do not manage, then PUT.
    EXISTING_JSON=$(curl -sf -H "${AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${CLI_CLIENT_UUID}" 2>/dev/null || echo "")
    if [ -z "${EXISTING_JSON}" ]; then
      echo "${TAG}   WARNING: could not fetch existing CLI client — skipping update."
      return 0
    fi
    MERGED_JSON=$(EXISTING_JSON="${EXISTING_JSON}" DESIRED_JSON="${DESIRED_JSON}" python3 -c '
import json
import os

existing = json.loads(os.environ["EXISTING_JSON"])
desired = json.loads(os.environ["DESIRED_JSON"])
# Preserve Keycloak-managed identity; merge attributes rather than replace.
attributes = existing.get("attributes") or {}
attributes.update(desired.pop("attributes", {}))
existing.update(desired)
existing["attributes"] = attributes
print(json.dumps(existing))
' 2>/dev/null)
    if [ -z "${MERGED_JSON}" ]; then
      echo "${TAG}   WARNING: failed to merge CLI client JSON — skipping update."
      return 0
    fi
    curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/clients/${CLI_CLIENT_UUID}" \
      -d "${MERGED_JSON}" \
      && echo "${TAG}   Updated CLI client '${CLI_CLIENT_ID}' (public/PKCE/redirects/lifespan reconciled)." \
      || echo "${TAG}   WARNING: failed to update CLI client '${CLI_CLIENT_ID}'."
  fi
}

_reconcile_cli_client

# -------------------------------------------------------------------
# Strict client-secret mode guard (token-exchange scope: caipe-slack-bot
# + caipe-webex-bot).
#
# When KEYCLOAK_STRICT_CLIENT_SECRETS=true, attempt a client_credentials
# token grant against the dev placeholder secrets for the two bot
# clients reconciled by THIS script. If Keycloak still accepts either —
# for example because tokenExchange.secretRef / webexTokenExchange.secretRef
# is unset — log a loud ERROR and exit non-zero so the Helm install
# fails fast.
#
# init-idp.sh has its own copy of this guard scoped to caipe-ui +
# caipe-platform. Together they cover all four dev placeholders.
# -------------------------------------------------------------------
_assert_dev_placeholders_rejected() {
  if [ "${KEYCLOAK_STRICT_CLIENT_SECRETS:-false}" != "true" ]; then
    return 0
  fi

  echo "${TAG} Strict mode: verifying caipe-slack-bot + caipe-webex-bot + caipe-scheduler-runner reject their dev placeholders ..."

  KC_TOKEN_URL="${KC_URL}/realms/${REALM}/protocol/openid-connect/token"
  violations=0

  # Pairs: "<clientId>|<dev-placeholder-secret>"
  pairs="caipe-slack-bot|caipe-slack-bot-dev-secret
caipe-webex-bot|caipe-webex-bot-dev-secret"
  if [ -n "${SCHEDULER_CLIENT_ID:-}" ]; then
    pairs="${pairs}
caipe-scheduler-runner|caipe-scheduler-runner-dev-secret"
  fi

  IFS_OLD="${IFS}"
  IFS='
'
  for pair in ${pairs}; do
    cid="${pair%%|*}"
    placeholder="${pair##*|}"
    HTTP_CODE=$(curl -sS -o /tmp/_strict_te_body.$$ -w "%{http_code}" \
      -X POST "${KC_TOKEN_URL}" \
      -d "grant_type=client_credentials&client_id=${cid}&client_secret=${placeholder}" 2>/dev/null || echo "000")
    BODY=$(cat /tmp/_strict_te_body.$$ 2>/dev/null || echo "")
    rm -f /tmp/_strict_te_body.$$
    if [ "${HTTP_CODE}" = "200" ] && echo "${BODY}" | grep -q '"access_token"'; then
      echo "${TAG}   ERROR: Keycloak still accepts the dev placeholder client_secret for '${cid}'." >&2
      echo "${TAG}          Set the matching tokenExchange.secretRef / webexTokenExchange.secretRef and retry." >&2
      violations=$((violations + 1))
    else
      echo "${TAG}   OK: '${cid}' rejects its dev placeholder (HTTP ${HTTP_CODE})."
    fi
  done
  IFS="${IFS_OLD}"

  if [ "${violations}" -gt 0 ]; then
    echo "${TAG} Strict mode FAILED: ${violations} bot client(s) still accept dev placeholder secrets." >&2
    echo "${TAG} See https://github.com/caipe-io/ai-platform-engineering/blob/main/docs/docs/security/rbac/secrets-bootstrap.md#production-hardening" >&2
    return 1
  fi

  echo "${TAG} Strict mode passed: caipe-slack-bot + caipe-webex-bot reject their dev placeholders."
  return 0
}

if ! _assert_dev_placeholders_rejected; then
  exit 1
fi

echo "${TAG} Done — token exchange configured for '${BOT_CLIENT_ID}'."
