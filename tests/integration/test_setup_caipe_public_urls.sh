#!/usr/bin/env bash
# Run locally with: bash tests/integration/test_setup_caipe_public_urls.sh
# Exercise production code in isolated subshells; never run the full installer.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SOURCE="$ROOT/setup-caipe.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
equal() { [[ "$1" == "$2" ]] || fail "expected '$2', got '$1'"; }

grep -E '^_(ui_public_url|idp_public_url|idp_url_overridden)\(\)' "$SOURCE" > "$WORK/helpers.sh"
extract_function() {
  awk -v name="$1" '
    $0 == name "() {" { found=1 }
    found { print }
    found && /^}$/ { complete=1; exit }
    END { if (!complete) exit 1 }
  ' "$SOURCE"
}
extract_function _ui_check_url >> "$WORK/helpers.sh"
extract_function expose_nodeports >> "$WORK/helpers.sh"
bash -n "$WORK/helpers.sh"

# Defaults follow the domain.
(
  source "$WORK/helpers.sh"
  CAIPE_DOMAIN=caipe.example.test CAIPE_UI_URL="" CAIPE_IDP_URL=""
  equal "$(_ui_public_url)" "https://caipe.example.test"
  equal "$(_idp_public_url)" "https://caipe.example.test"
  _idp_url_overridden && fail "IdP URL reported as overridden"
  true
)

# Overrides win and lose a trailing slash.
(
  source "$WORK/helpers.sh"
  CAIPE_DOMAIN=caipe.example.test
  CAIPE_UI_URL=https://ui.example.test/ CAIPE_IDP_URL=https://idp.example.test:8443/
  equal "$(_ui_public_url)" "https://ui.example.test"
  equal "$(_idp_public_url)" "https://idp.example.test:8443"
  _idp_url_overridden || fail "IdP override not detected"
)

# Health checks use the URL that matches how the UI is exposed.
(
  source "$WORK/helpers.sh"
  CAIPE_DOMAIN=caipe.example.test CAIPE_UI_URL=https://ui.example.test UI_PORT=3000
  ENABLE_INGRESS=true CAIPE_EXPOSE=port-forward
  equal "$(_ui_check_url)" "https://caipe.example.test"
  ENABLE_INGRESS=false CAIPE_EXPOSE=nodeport
  equal "$(_ui_check_url)" "https://ui.example.test"
  ENABLE_INGRESS=false CAIPE_EXPOSE=port-forward
  equal "$(_ui_check_url)" "http://localhost:3000"
)

# NodePort services carry the requested ports.
(
  source "$WORK/helpers.sh"
  log() { :; }; step() { :; }
  kubectl() { cat > "$WORK/applied.yaml"; }
  CAIPE_DOMAIN=caipe.example.test CAIPE_EXPOSE=nodeport UI_NODE_PORT=30201 IDP_NODE_PORT=30001
  expose_nodeports
  grep -q 'nodePort: 30201' "$WORK/applied.yaml" || fail "UI NodePort missing"
  grep -q 'nodePort: 30001' "$WORK/applied.yaml" || fail "Keycloak NodePort missing"
  CAIPE_EXPOSE=port-forward
  rm -f "$WORK/applied.yaml"
  expose_nodeports
  [[ ! -e "$WORK/applied.yaml" ]] || fail "NodePorts applied without --expose=nodeport"
)

# Browser-facing auth settings go through the helpers, never the raw domain.
if grep -nE '(KC_HOSTNAME|NEXTAUTH_URL|OIDC_ISSUER|tokenValidation\.issuer|redirectUris|target_origin)[^#]*https://\$\{CAIPE_DOMAIN\}' "$SOURCE"; then
  fail "auth URL built from CAIPE_DOMAIN instead of _ui_public_url/_idp_public_url"
fi

echo "PASS: setup-caipe public URLs and NodePort exposure"
