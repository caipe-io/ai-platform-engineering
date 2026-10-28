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
  local MCP_RESOURCE_URL MCP_RESOURCE_CLIENT_ID MCP_RESOURCE_CLIENTS MCP_RESOURCE_ID
  local MCP_RESOURCE_PAYLOAD MCP_SCOPE_ID MCP_SCOPE_PAYLOAD MCP_SCOPE_NAME
  local MCP_PLATFORM_SCOPE_ID MCP_PLATFORM_SCOPE_PAYLOAD MCP_PROFILE_SCOPE_ID
  local MCP_PLATFORM_CLIENT_IDS MCP_CLIENT_ID MCP_CLIENTS_JSON MCP_CLIENT_UUID MCP_PROFILE_MAPPERS_JSON MCP_MAPPER_IDS MCP_DEFAULT_SCOPES_JSON

  MCP_AUTH="${1:-}"
  MCP_LOG_PREFIX="${TAG:-[init-idp]}"
  MCP_RESOURCE_URL="${MCP_DCR_RESOURCE_URL:-}"
  MCP_RESOURCE_CLIENT_ID="${MCP_DCR_RESOURCE_CLIENT_ID:-caipe-mcp-dcr}"
  MCP_SCOPE_NAME="caipe-mcp-dcr"
  MCP_PLATFORM_CLIENT_IDS="${MCP_DCR_PLATFORM_CLIENT_IDS:-caipe-ui,caipe-cli,caipe-platform,caipe-slack-bot,caipe-webex-bot,caipe-scheduler-runner,caipe-webex-bot-admin,caipe-rag-ingestor}"

  if ! MCP_RESOURCE_URL="${MCP_RESOURCE_URL}" MCP_RESOURCE_CLIENT_ID="${MCP_RESOURCE_CLIENT_ID}" python3 -c '
import os
import re
from urllib.parse import urlsplit

url = urlsplit(os.environ["MCP_RESOURCE_URL"])
client_id = os.environ["MCP_RESOURCE_CLIENT_ID"]
if url.scheme != "https" or not url.hostname or url.username or url.password or not url.path or url.query or url.fragment:
    raise SystemExit(1)
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", client_id):
    raise SystemExit(1)
'; then
    echo "${MCP_LOG_PREFIX} ERROR: invalid MCP resource URL or client ID." >&2
    return 1
  fi

  case "${MCP_RESOURCE_URL}" in
    https://*/*) ;;
    *) echo "${MCP_LOG_PREFIX} ERROR: MCP_DCR_RESOURCE_URL must be a public HTTPS MCP endpoint." >&2; return 1 ;;
  esac

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

  # Resource indicators require a registered resource server. This client
  # cannot log in; it identifies the MCP endpoint named by the resource URL.
  MCP_RESOURCE_CLIENTS=$(curl -sf -H "${MCP_AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/clients?clientId=${MCP_RESOURCE_CLIENT_ID}" 2>/dev/null || echo "[]")
  MCP_RESOURCE_ID=$(MCP_RESOURCE_CLIENTS="${MCP_RESOURCE_CLIENTS}" \
    MCP_RESOURCE_CLIENT_ID="${MCP_RESOURCE_CLIENT_ID}" python3 -c '
import json
import os

clients = json.loads(os.environ["MCP_RESOURCE_CLIENTS"])
print(next((client["id"] for client in clients if client.get("clientId") == os.environ["MCP_RESOURCE_CLIENT_ID"]), ""))
' 2>/dev/null) || return 1
  if [ -z "${MCP_RESOURCE_ID}" ]; then
    MCP_RESOURCE_PAYLOAD=$(MCP_RESOURCE_CLIENT_ID="${MCP_RESOURCE_CLIENT_ID}" \
      MCP_RESOURCE_URL="${MCP_RESOURCE_URL}" python3 -c '
import json
import os

print(json.dumps({
    "clientId": os.environ["MCP_RESOURCE_CLIENT_ID"],
    "name": "CAIPE MCP resource",
    "description": "Resource server for operator-enabled MCP OAuth",
    "enabled": True,
    "publicClient": False,
    "bearerOnly": True,
    "standardFlowEnabled": False,
    "directAccessGrantsEnabled": False,
    "serviceAccountsEnabled": False,
    "attributes": {"resource_url": os.environ["MCP_RESOURCE_URL"]},
}))
' 2>/dev/null) || return 1
    if ! curl -sf -o /dev/null -X POST -H "${MCP_AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/clients" -d "${MCP_RESOURCE_PAYLOAD}"; then
      echo "${MCP_LOG_PREFIX} ERROR: could not create MCP resource client." >&2
      return 1
    fi
  else
    MCP_RESOURCE_PAYLOAD=$(curl -sf -H "${MCP_AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${MCP_RESOURCE_ID}" 2>/dev/null || echo "")
    MCP_RESOURCE_PAYLOAD=$(MCP_RESOURCE_PAYLOAD="${MCP_RESOURCE_PAYLOAD}" \
      MCP_RESOURCE_URL="${MCP_RESOURCE_URL}" python3 -c '
import json
import os

client = json.loads(os.environ["MCP_RESOURCE_PAYLOAD"])
if client.get("description") != "Resource server for operator-enabled MCP OAuth":
    raise SystemExit("MCP resource client ID is already in use")
client.setdefault("attributes", {})["resource_url"] = os.environ["MCP_RESOURCE_URL"]
print(json.dumps(client))
' 2>/dev/null) || return 1
    if ! curl -sf -o /dev/null -X PUT -H "${MCP_AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/clients/${MCP_RESOURCE_ID}" -d "${MCP_RESOURCE_PAYLOAD}"; then
      echo "${MCP_LOG_PREFIX} ERROR: could not update MCP resource URL." >&2
      return 1
    fi
  fi

  MCP_SCOPES_JSON=$(curl -sf -H "${MCP_AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/client-scopes" 2>/dev/null || echo "[]")
  MCP_SCOPE_ID=$(MCP_SCOPES_JSON="${MCP_SCOPES_JSON}" python3 -c '
import json
import os

scopes = json.loads(os.environ["MCP_SCOPES_JSON"])
print(next((scope["id"] for scope in scopes if scope.get("name") == "caipe-mcp-dcr"), ""))
' 2>/dev/null) || return 1
  if [ -z "${MCP_SCOPE_ID}" ]; then
    MCP_SCOPE_PAYLOAD=$(MCP_RESOURCE_CLIENT_ID="${MCP_RESOURCE_CLIENT_ID}" python3 -c '
import json
import os

print(json.dumps({
    "name": "caipe-mcp-dcr",
    "description": "MCP resource audience for dynamically registered clients",
    "protocol": "openid-connect",
    "attributes": {"include.in.token.scope": "true", "display.on.consent.screen": "true"},
    "protocolMappers": [{
        "name": "mcp-resource-audience",
        "protocol": "openid-connect",
        "protocolMapper": "oidc-audience-mapper",
        "consentRequired": False,
        "config": {
            "included.client.audience": os.environ["MCP_RESOURCE_CLIENT_ID"],
            "id.token.claim": "false",
            "access.token.claim": "true",
            "introspection.token.claim": "true",
        },
    }],
}))
' 2>/dev/null) || return 1
    if ! curl -sf -o /dev/null -X POST -H "${MCP_AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/client-scopes" -d "${MCP_SCOPE_PAYLOAD}"; then
      echo "${MCP_LOG_PREFIX} ERROR: could not create MCP client scope." >&2
      return 1
    fi
  else
    MCP_SCOPE_PAYLOAD=$(curl -sf -H "${MCP_AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/client-scopes/${MCP_SCOPE_ID}" 2>/dev/null || echo "")
    MCP_SCOPE_PAYLOAD=$(MCP_SCOPE_PAYLOAD="${MCP_SCOPE_PAYLOAD}" \
      MCP_RESOURCE_CLIENT_ID="${MCP_RESOURCE_CLIENT_ID}" python3 -c '
import json
import os

scope = json.loads(os.environ["MCP_SCOPE_PAYLOAD"])
if scope.get("description") != "MCP resource audience for dynamically registered clients":
    raise SystemExit("MCP client scope name is already in use")
mappers = [mapper for mapper in scope.get("protocolMappers", []) if mapper.get("name") != "mcp-resource-audience"]
mappers.append({
    "name": "mcp-resource-audience",
    "protocol": "openid-connect",
    "protocolMapper": "oidc-audience-mapper",
    "consentRequired": False,
    "config": {
        "included.client.audience": os.environ["MCP_RESOURCE_CLIENT_ID"],
        "id.token.claim": "false",
        "access.token.claim": "true",
        "introspection.token.claim": "true",
    },
})
scope["protocolMappers"] = mappers
print(json.dumps(scope))
' 2>/dev/null) || return 1
    if ! curl -sf -o /dev/null -X PUT -H "${MCP_AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/client-scopes/${MCP_SCOPE_ID}" -d "${MCP_SCOPE_PAYLOAD}"; then
      echo "${MCP_LOG_PREFIX} ERROR: could not update MCP client scope." >&2
      return 1
    fi
  fi

  # The realm-wide profile scope used to add caipe-platform to every token.
  # With DCR enabled, that would let a client omit `resource` and use its token
  # against unrelated platform APIs. Move the mapper to a scope assigned only
  # to the known first-party clients before opening MCP registration.
  MCP_PLATFORM_SCOPE_ID=$(MCP_SCOPES_JSON="${MCP_SCOPES_JSON}" python3 -c '
import json
import os

print(next((scope["id"] for scope in json.loads(os.environ["MCP_SCOPES_JSON"])
    if scope.get("name") == "caipe-platform-api"), ""))
' 2>/dev/null) || return 1
  if [ -z "${MCP_PLATFORM_SCOPE_ID}" ]; then
    MCP_PLATFORM_SCOPE_PAYLOAD='{"name":"caipe-platform-api","description":"First-party CAIPE platform API audience","protocol":"openid-connect","attributes":{"include.in.token.scope":"false","display.on.consent.screen":"false"},"protocolMappers":[{"name":"platform-api-audience","protocol":"openid-connect","protocolMapper":"oidc-audience-mapper","consentRequired":false,"config":{"included.custom.audience":"caipe-platform","id.token.claim":"false","access.token.claim":"true","introspection.token.claim":"true"}}]}'
    if ! curl -sf -o /dev/null -X POST -H "${MCP_AUTH}" -H "Content-Type: application/json" \
      "${KC_URL}/admin/realms/${REALM}/client-scopes" -d "${MCP_PLATFORM_SCOPE_PAYLOAD}"; then
      echo "${MCP_LOG_PREFIX} ERROR: could not create first-party platform audience scope." >&2
      return 1
    fi
    MCP_SCOPES_JSON=$(curl -sf -H "${MCP_AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/client-scopes") || return 1
    MCP_PLATFORM_SCOPE_ID=$(MCP_SCOPES_JSON="${MCP_SCOPES_JSON}" python3 -c '
import json
import os

print(next((scope["id"] for scope in json.loads(os.environ["MCP_SCOPES_JSON"])
    if scope.get("name") == "caipe-platform-api"), ""))
' 2>/dev/null) || return 1
  fi
  MCP_DEFAULT_SCOPES_JSON=$(curl -sf -H "${MCP_AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/default-default-client-scopes") || return 1
  if ! MCP_DEFAULT_SCOPES_JSON="${MCP_DEFAULT_SCOPES_JSON}" MCP_PLATFORM_SCOPE_ID="${MCP_PLATFORM_SCOPE_ID}" python3 -c '
import json
import os

if any(scope.get("id") == os.environ["MCP_PLATFORM_SCOPE_ID"]
        for scope in json.loads(os.environ["MCP_DEFAULT_SCOPES_JSON"])):
    raise SystemExit(1)
'; then
    echo "${MCP_LOG_PREFIX} ERROR: platform audience scope must not be a realm default." >&2
    return 1
  fi
  if [ -z "${MCP_PLATFORM_SCOPE_ID}" ]; then
    echo "${MCP_LOG_PREFIX} ERROR: first-party audience scope was not created." >&2
    return 1
  fi
  MCP_PROFILE_MAPPERS_JSON=$(curl -sf -H "${MCP_AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/client-scopes/${MCP_PLATFORM_SCOPE_ID}/protocol-mappers/models") || return 1
  if ! MCP_PROFILE_MAPPERS_JSON="${MCP_PROFILE_MAPPERS_JSON}" python3 -c '
import json
import os

mappers = json.loads(os.environ["MCP_PROFILE_MAPPERS_JSON"])
if not any(mapper.get("protocolMapper") == "oidc-audience-mapper" and
        mapper.get("config", {}).get("included.custom.audience") == "caipe-platform"
        for mapper in mappers):
    raise SystemExit(1)
'; then
    echo "${MCP_LOG_PREFIX} ERROR: first-party audience scope has no platform mapper." >&2
    return 1
  fi
  for MCP_CLIENT_ID in $(printf '%s' "${MCP_PLATFORM_CLIENT_IDS}" | tr ',' ' '); do
    if ! printf '%s' "${MCP_CLIENT_ID}" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
      echo "${MCP_LOG_PREFIX} ERROR: invalid first-party client ID." >&2
      return 1
    fi
    MCP_CLIENTS_JSON=$(curl -sf -H "${MCP_AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients?clientId=${MCP_CLIENT_ID}") || return 1
    MCP_CLIENT_UUID=$(MCP_CLIENTS_JSON="${MCP_CLIENTS_JSON}" MCP_CLIENT_ID="${MCP_CLIENT_ID}" python3 -c '
import json
import os

print(next((client["id"] for client in json.loads(os.environ["MCP_CLIENTS_JSON"])
    if client.get("clientId") == os.environ["MCP_CLIENT_ID"]), ""))
' 2>/dev/null) || return 1
    if [ -z "${MCP_CLIENT_UUID}" ]; then
      case "${MCP_CLIENT_ID}" in
        caipe-ui|caipe-platform) echo "${MCP_LOG_PREFIX} ERROR: required client ${MCP_CLIENT_ID} is missing." >&2; return 1 ;;
        *) continue ;;
      esac
    fi
    if ! curl -sf -o /dev/null -X PUT -H "${MCP_AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/clients/${MCP_CLIENT_UUID}/default-client-scopes/${MCP_PLATFORM_SCOPE_ID}"; then
      echo "${MCP_LOG_PREFIX} ERROR: could not assign platform audience to ${MCP_CLIENT_ID}." >&2
      return 1
    fi
  done

  MCP_PROFILE_SCOPE_ID=$(MCP_SCOPES_JSON="${MCP_SCOPES_JSON}" python3 -c '
import json
import os

print(next((scope["id"] for scope in json.loads(os.environ["MCP_SCOPES_JSON"])
    if scope.get("name") == "profile"), ""))
' 2>/dev/null) || return 1
  if [ -z "${MCP_PROFILE_SCOPE_ID}" ]; then
    echo "${MCP_LOG_PREFIX} ERROR: profile scope is missing." >&2
    return 1
  fi
  MCP_PROFILE_MAPPERS_JSON=$(curl -sf -H "${MCP_AUTH}" \
    "${KC_URL}/admin/realms/${REALM}/client-scopes/${MCP_PROFILE_SCOPE_ID}/protocol-mappers/models") || return 1
  MCP_MAPPER_IDS=$(MCP_PROFILE_MAPPERS_JSON="${MCP_PROFILE_MAPPERS_JSON}" python3 -c '
import json
import os

for mapper in json.loads(os.environ["MCP_PROFILE_MAPPERS_JSON"]):
    if mapper.get("protocolMapper") == "oidc-audience-mapper" and \
            mapper.get("config", {}).get("included.custom.audience") == "caipe-platform":
        print(mapper["id"])
' 2>/dev/null) || return 1
  for MCP_SCOPE_ID in ${MCP_MAPPER_IDS}; do
    if ! curl -sf -o /dev/null -X DELETE -H "${MCP_AUTH}" \
      "${KC_URL}/admin/realms/${REALM}/client-scopes/${MCP_PROFILE_SCOPE_ID}/protocol-mappers/models/${MCP_SCOPE_ID}"; then
      echo "${MCP_LOG_PREFIX} ERROR: could not remove realm-wide platform audience." >&2
      return 1
    fi
  done
  echo "${MCP_LOG_PREFIX}   Platform audience is restricted to first-party clients."
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
allowed = [scope for scope in allowed if scope != "caipe-platform-api"]
for scope in ("basic", "openid", "profile", "email", "roles", "groups", "org", "offline_access", "caipe-mcp-dcr"):
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
