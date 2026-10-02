#!/bin/sh
# Shared, idempotent Keycloak reconciliation for generic remote MCP clients.
# Sourced by both init-idp.sh and init-token-exchange.sh. The caller provides
# REALM and KC_URL; an existing Authorization header may be passed as $1.

# -------------------------------------------------------------------
# Reconcile the OAuth client-registration pieces required by generic
# remote MCP clients.
#
# Keycloak's OIDC DCR provider assigns its internal `basic` client scope
# to every dynamically registered client. CAIPE's hand-authored realm did
# not contain that scope, and persisted realms can retain an anonymous
# Allowed Client Scopes policy that does not allow the MCP scope set. The
# result is a discovery endpoint that advertises DCR but rejects a client
# that only knows the MCP server URL.
#
# Keep existing operator-approved scopes and add the minimum CAIPE/MCP set.
# This is idempotent and covers upgrades where --import-realm is skipped.
# -------------------------------------------------------------------
_reconcile_mcp_dynamic_client_registration() {
  local MCP_LOG_PREFIX MCP_AUTH MCP_ADMIN_USER MCP_ADMIN_PASS MCP_ADMIN_TOKEN
  local MCP_REALM_JSON MCP_REALM_ID MCP_SCOPES_JSON MCP_BASIC_SCOPE_ID MCP_BASIC_SCOPE_JSON
  local MCP_POLICY_TYPE MCP_COMPONENTS_JSON MCP_POLICY_JSON MCP_POLICY_ID
  local MCP_POLICY_URL MCP_POLICY_METHOD MCP_PROFILES_JSON MCP_UPDATED_PROFILES_JSON
  local MCP_POLICIES_JSON MCP_UPDATED_POLICIES_JSON

  MCP_AUTH="${1:-}"
  MCP_LOG_PREFIX="${TAG:-[init-idp]}"

  echo "${MCP_LOG_PREFIX} Reconciling generic MCP dynamic client registration ..."
  if [ -z "${MCP_AUTH}" ]; then
    MCP_ADMIN_USER="${KEYCLOAK_ADMIN:-admin}"
    MCP_ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
    MCP_ADMIN_TOKEN=$(curl -sf -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
      -d "grant_type=password&client_id=admin-cli&username=${MCP_ADMIN_USER}&password=${MCP_ADMIN_PASS}" 2>/dev/null \
      | grep -o '"access_token" *: *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    if [ -z "${MCP_ADMIN_TOKEN}" ]; then
      echo "${MCP_LOG_PREFIX}   ERROR: could not acquire admin token for MCP DCR reconcile." >&2
      return 1
    fi
    MCP_AUTH="Authorization: Bearer ${MCP_ADMIN_TOKEN}"
  fi

  MCP_REALM_JSON=$(curl -sf -H "${MCP_AUTH}" \
    "${KC_URL}/admin/realms/${REALM}" 2>/dev/null || echo "")
  MCP_REALM_ID=$(MCP_REALM_JSON="${MCP_REALM_JSON}" python3 -c '
import json
import os

try:
    print(json.loads(os.environ["MCP_REALM_JSON"])["id"])
except (KeyError, TypeError, json.JSONDecodeError):
    pass
' 2>/dev/null)
  if [ -z "${MCP_REALM_ID}" ]; then
    echo "${MCP_LOG_PREFIX}   ERROR: could not resolve realm id for '${REALM}'." >&2
    return 1
  fi

  MCP_SCOPES_JSON=$(curl -sf -H "${MCP_AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/client-scopes" 2>/dev/null || echo "[]")
  MCP_BASIC_SCOPE_ID=$(MCP_SCOPES_JSON="${MCP_SCOPES_JSON}" python3 -c '
import json
import os

try:
    scopes = json.loads(os.environ["MCP_SCOPES_JSON"])
    print(next((scope.get("id", "") for scope in scopes if scope.get("name") == "basic"), ""))
except (TypeError, json.JSONDecodeError):
    pass
' 2>/dev/null)

  if [ -z "${MCP_BASIC_SCOPE_ID}" ]; then
    echo "${MCP_LOG_PREFIX}   Creating Keycloak's required 'basic' client scope ..."
    MCP_BASIC_SCOPE_JSON='{"name":"basic","description":"OpenID Connect scope for all basic token claims","protocol":"openid-connect","attributes":{"include.in.token.scope":"false","display.on.consent.screen":"false"},"protocolMappers":[{"name":"auth_time","protocol":"openid-connect","protocolMapper":"oidc-usersessionmodel-note-mapper","consentRequired":false,"config":{"user.session.note":"AUTH_TIME","id.token.claim":"true","introspection.token.claim":"true","access.token.claim":"true","claim.name":"auth_time","jsonType.label":"long"}},{"name":"sub","protocol":"openid-connect","protocolMapper":"oidc-sub-mapper","consentRequired":false,"config":{"introspection.token.claim":"true","access.token.claim":"true"}}]}'
    if ! curl -sf -o /dev/null -X POST -H "${MCP_AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/client-scopes" -d "${MCP_BASIC_SCOPE_JSON}"; then
      echo "${MCP_LOG_PREFIX}   ERROR: failed to create the 'basic' client scope." >&2
      return 1
    fi
  else
    echo "${MCP_LOG_PREFIX}   Client scope 'basic' already exists."
  fi

  MCP_POLICY_TYPE="org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy"
  MCP_COMPONENTS_JSON=$(curl -sf -H "${MCP_AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/components?parent=${MCP_REALM_ID}&type=${MCP_POLICY_TYPE}" \
    2>/dev/null || echo "")
  if [ -z "${MCP_COMPONENTS_JSON}" ]; then
    echo "${MCP_LOG_PREFIX}   ERROR: could not read Keycloak client-registration policies." >&2
    return 1
  fi

  MCP_POLICY_JSON=$(MCP_COMPONENTS_JSON="${MCP_COMPONENTS_JSON}" \
    MCP_REALM_ID="${MCP_REALM_ID}" MCP_POLICY_TYPE="${MCP_POLICY_TYPE}" python3 -c '
import json
import os

components = json.loads(os.environ["MCP_COMPONENTS_JSON"])
policy = next(
    (
        item
        for item in components
        if item.get("providerId") == "allowed-client-templates"
        and item.get("subType") == "anonymous"
    ),
    {},
)
policy.update(
    {
        "name": "Allowed Client Scopes",
        "providerId": "allowed-client-templates",
        "providerType": os.environ["MCP_POLICY_TYPE"],
        "parentId": os.environ["MCP_REALM_ID"],
        "subType": "anonymous",
    }
)
config = policy.get("config") or {}
allowed = list(config.get("allowed-client-scopes") or [])
for scope in ("basic", "openid", "profile", "email", "roles", "groups", "org", "offline_access"):
    if scope not in allowed:
        allowed.append(scope)
config["allow-default-scopes"] = ["true"]
config["allowed-client-scopes"] = allowed
policy["config"] = config
print(json.dumps(policy))
' 2>/dev/null)
  if [ -z "${MCP_POLICY_JSON}" ]; then
    echo "${MCP_LOG_PREFIX}   ERROR: failed to render the MCP DCR scope policy." >&2
    return 1
  fi

  MCP_POLICY_ID=$(MCP_POLICY_JSON="${MCP_POLICY_JSON}" python3 -c '
import json
import os

print(json.loads(os.environ["MCP_POLICY_JSON"]).get("id", ""))
' 2>/dev/null)
  if [ -n "${MCP_POLICY_ID}" ]; then
    MCP_POLICY_URL="${KC_URL}/admin/realms/${REALM}/components/${MCP_POLICY_ID}"
    MCP_POLICY_METHOD="PUT"
  else
    MCP_POLICY_URL="${KC_URL}/admin/realms/${REALM}/components"
    MCP_POLICY_METHOD="POST"
  fi

  if curl -sf -o /dev/null -X "${MCP_POLICY_METHOD}" -H "${MCP_AUTH}" \
    -H "Content-Type: application/json" "${MCP_POLICY_URL}" -d "${MCP_POLICY_JSON}"; then
    echo "${MCP_LOG_PREFIX}   Anonymous DCR allows the advertised MCP scope set."
  else
    echo "${MCP_LOG_PREFIX}   ERROR: failed to reconcile the MCP DCR scope policy." >&2
    return 1
  fi
  MCP_PROFILES_JSON=$(curl -sf -H "${MCP_AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/client-policies/profiles" 2>/dev/null || echo "")
  MCP_UPDATED_PROFILES_JSON=$(MCP_PROFILES_JSON="${MCP_PROFILES_JSON}" python3 -c '
import json
import os

document = json.loads(os.environ["MCP_PROFILES_JSON"])
profiles = list(document.get("profiles") or [])
desired = {
    "name": "mcp-public-pkce",
    "description": "Require PKCE S256 for anonymously registered public MCP clients",
    "executors": [
        {
            "executor": "pkce-enforcer",
            "configuration": {"auto-configure": True},
        }
    ],
}
profiles = [profile for profile in profiles if profile.get("name") != desired["name"]]
profiles.append(desired)
print(json.dumps({"profiles": profiles}))
' 2>/dev/null)
  if [ -z "${MCP_UPDATED_PROFILES_JSON}" ] || ! curl -sf -o /dev/null -X PUT \
    -H "${MCP_AUTH}" -H "Content-Type: application/json" \
    "${KC_URL}/admin/realms/${REALM}/client-policies/profiles" \
    -d "${MCP_UPDATED_PROFILES_JSON}"; then
    echo "${MCP_LOG_PREFIX}   ERROR: failed to reconcile the MCP public-PKCE profile." >&2
    return 1
  fi

  MCP_POLICIES_JSON=$(curl -sf -H "${MCP_AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/client-policies/policies" 2>/dev/null || echo "")
  MCP_UPDATED_POLICIES_JSON=$(MCP_POLICIES_JSON="${MCP_POLICIES_JSON}" python3 -c '
import json
import os

document = json.loads(os.environ["MCP_POLICIES_JSON"])
policies = list(document.get("policies") or [])
desired = {
    "name": "mcp-public-dcr-pkce",
    "description": "Apply PKCE S256 to anonymous OIDC registrations for public MCP clients",
    "enabled": True,
    "conditions": [
        {
            "condition": "client-updater-context",
            "configuration": {"update-client-source": ["ByAnonymous"]},
        },
        {
            "condition": "client-type",
            "configuration": {"protocol": "openid-connect"},
        },
        {
            "condition": "client-access-type",
            "configuration": {"type": ["public"]},
        },
    ],
    "profiles": ["mcp-public-pkce"],
}
policies = [policy for policy in policies if policy.get("name") != desired["name"]]
policies.append(desired)
print(json.dumps({"policies": policies}))
' 2>/dev/null)
  if [ -z "${MCP_UPDATED_POLICIES_JSON}" ] || ! curl -sf -o /dev/null -X PUT \
    -H "${MCP_AUTH}" -H "Content-Type: application/json" \
    "${KC_URL}/admin/realms/${REALM}/client-policies/policies" \
    -d "${MCP_UPDATED_POLICIES_JSON}"; then
    echo "${MCP_LOG_PREFIX}   ERROR: failed to reconcile the MCP public-PKCE policy." >&2
    return 1
  fi
  echo "${MCP_LOG_PREFIX}   Anonymous public MCP clients require PKCE S256."
}
