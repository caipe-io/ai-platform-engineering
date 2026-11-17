#!/bin/sh
# Reconcile the Keycloak realm user-profile schema on every install and upgrade.
# This script is intentionally independent of upstream IdP and token-exchange
# configuration so persistent realms receive newly introduced custom attributes.
set -eu

REALM="${KC_REALM:-caipe}"
KC_URL="${KC_URL:-http://localhost:7080}"
ADMIN_USER="${KEYCLOAK_ADMIN:-${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}}"
ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin}}"
DESIRED_ATTRIBUTES='[{"name":"caipe_secondary_oidc_identity_key","permissions":{"view":["admin"],"edit":["admin"]}},{"name":"caipe_secondary_oidc_provider_id","permissions":{"view":["admin"],"edit":["admin"]}},{"name":"caipe_secondary_oidc_issuer","permissions":{"view":["admin"],"edit":["admin"]}},{"name":"caipe_secondary_oidc_sub","permissions":{"view":["admin"],"edit":["admin"]}},{"name":"caipe_secondary_oidc_email","permissions":{"view":["admin"],"edit":["admin"]}},{"name":"caipe_secondary_oidc_linked_at","permissions":{"view":["admin"],"edit":["admin"]}}]'
TAG="[secondary-auth-profile]"
CUSTOM_ATTRIBUTES="${KEYCLOAK_USER_PROFILE_ATTRIBUTES_JSON:-[]}"

json_field() {
  echo "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:.*"\(.*\)"/\1/'
}

echo "${TAG} Obtaining Keycloak admin token ..."
TOKEN_RESPONSE=$(curl -sf --retry 30 --retry-connrefused --retry-delay 2 \
  -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=${ADMIN_USER}" \
  --data-urlencode "password=${ADMIN_PASS}") || {
  echo "${TAG} ERROR: could not authenticate to Keycloak" >&2
  exit 1
}
ACCESS_TOKEN=$(json_field "${TOKEN_RESPONSE}" "access_token")
if [ -z "${ACCESS_TOKEN}" ]; then
  echo "${TAG} ERROR: Keycloak returned an empty admin access token" >&2
  exit 1
fi
AUTH="Authorization: Bearer ${ACCESS_TOKEN}"

echo "${TAG} Fetching realm user profile ..."
PROFILE=$(curl -sf -H "${AUTH}" \
  "${KC_URL}/admin/realms/${REALM}/users/profile") || {
  echo "${TAG} ERROR: could not fetch the ${REALM} realm user profile" >&2
  exit 1
}

UPDATED_PROFILE=$(DESIRED_ATTRIBUTES="${DESIRED_ATTRIBUTES}" \
  CUSTOM_ATTRIBUTES="${CUSTOM_ATTRIBUTES}" \
  python3 -c '
import json
import os
import sys

profile = json.load(sys.stdin)
desired = json.loads(os.environ["DESIRED_ATTRIBUTES"])
custom = json.loads(os.environ["CUSTOM_ATTRIBUTES"])
if not isinstance(profile, dict) or not isinstance(custom, list):
    raise ValueError("user profile must be an object and custom attributes an array")

attributes = profile.setdefault("attributes", [])
if not isinstance(attributes, list):
    raise ValueError("user profile attributes must be a JSON array")
existing = {
    attribute.get("name"): attribute
    for attribute in attributes
    if isinstance(attribute, dict) and isinstance(attribute.get("name"), str)
}

# Apply protected permissions last so custom configuration cannot weaken the
# admin-only secondary identity binding attributes.
for configured in custom + desired:
    if not isinstance(configured, dict) or not isinstance(configured.get("name"), str):
        raise ValueError("each desired user-profile attribute must have a name")
    name = configured["name"]
    if not name:
        raise ValueError("user-profile attribute names cannot be empty")
    attribute = existing.get(name)
    if attribute is None:
        attribute = {
            "name": name,
            "validations": {},
            "annotations": {},
            "multivalued": False,
        }
        attributes.append(attribute)
        existing[name] = attribute
    for field in ("displayName", "validations", "annotations", "permissions", "multivalued"):
        if field in configured:
            attribute[field] = configured[field]

json.dump(profile, sys.stdout, separators=(",", ":"))
' <<EOF
${PROFILE}
EOF
) || {
  echo "${TAG} ERROR: could not render the desired user-profile schema" >&2
  exit 1
}

curl -sf -X PUT -H "${AUTH}" -H "Content-Type: application/json" \
  "${KC_URL}/admin/realms/${REALM}/users/profile" \
  -d "${UPDATED_PROFILE}" >/dev/null || {
  echo "${TAG} ERROR: could not update the ${REALM} realm user profile" >&2
  exit 1
}

echo "${TAG} Secondary auth attributes protected successfully."
