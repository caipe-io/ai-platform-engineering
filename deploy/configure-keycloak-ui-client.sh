#!/bin/sh
set -eu

: "${KEYCLOAK_URL:?set KEYCLOAK_URL}"
: "${KEYCLOAK_REALM:?set KEYCLOAK_REALM}"
: "${KEYCLOAK_ADMIN:?set KEYCLOAK_ADMIN}"
: "${KEYCLOAK_ADMIN_PASSWORD:?set KEYCLOAK_ADMIN_PASSWORD}"
: "${KEYCLOAK_UI_CLIENT_ID:?set KEYCLOAK_UI_CLIENT_ID}"
: "${KEYCLOAK_UI_BASE_URL:?set KEYCLOAK_UI_BASE_URL}"

base_url=${KEYCLOAK_UI_BASE_URL%/}
kcadm=/opt/keycloak/bin/kcadm.sh

"${kcadm}" config credentials \
  --server "${KEYCLOAK_URL}" \
  --realm master \
  --user "${KEYCLOAK_ADMIN}" \
  --password "${KEYCLOAK_ADMIN_PASSWORD}" >/dev/null

client_uuid=$("${kcadm}" get clients \
  --target-realm "${KEYCLOAK_REALM}" \
  --query "clientId=${KEYCLOAK_UI_CLIENT_ID}" \
  --fields id \
  --format csv \
  --noquotes | tail -n 1)

if [ -z "${client_uuid}" ]; then
  echo "Keycloak client '${KEYCLOAK_UI_CLIENT_ID}' was not found" >&2
  exit 1
fi

"${kcadm}" update "clients/${client_uuid}" \
  --target-realm "${KEYCLOAK_REALM}" \
  --set "rootUrl=\"${base_url}\"" \
  --set "baseUrl=\"${base_url}\"" \
  --set "redirectUris=[\"${base_url}/*\"]" \
  --set "webOrigins=[\"${base_url}\"]"

echo "Reconciled '${KEYCLOAK_UI_CLIENT_ID}' redirects for ${base_url}"
