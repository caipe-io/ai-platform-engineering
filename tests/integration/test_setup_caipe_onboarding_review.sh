#!/usr/bin/env bash
# Exercise installer decisions without accessing a cluster or provider.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
python - "$ROOT/setup-caipe.sh" "$WORK/helpers.sh" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
names = ['_browser_ui_url', '_browser_oidc_issuer', 'choose_features', 'detect_deployed_features', 'update_keycloak_client_urls', 'provision_caipe_ui_audience_mapper']
parts = [re.search(r'^' + re.escape(name) + r'\(\) \{\n.*?^\}', s, re.M | re.S)[0] for name in names]
parts += re.findall(r'^_(?:ui_public_url|idp_public_url)\(\).*$', s, re.M)
a = s.index('  # Match the issuer Keycloak advertises')
b = s.index('  local kcadm_user', a)
parts.append('ingestor_issuer() {\n' + s[a:b] + '\nprintf "%s" "$issuer"\n}')
a = s.index('  if $ENABLE_RBAC_RUNTIME && ! $ENABLE_INGRESS')
b = s.index('    if _local_admin_active;', a)
parts.append('no_ingress_values() {\nlocal helm_args=()\n' + s[a:b] + '\nfi\nprintf "%s\\n" "${helm_args[@]}"\n}')
a = s.index('    if [[ -z "$da_oidc_issuer" ]] && $ENABLE_INGRESS')
b = s.index('    if [[ -z "$da_oidc_client_id"', a)
parts.append('dynamic_issuer() {\nlocal da_oidc_issuer=""\n' + s[a:b] + '\nprintf "%s" "$da_oidc_issuer"\n}')
open(sys.argv[2], 'w').write('\n'.join(parts))
PY
(
  source "$WORK/helpers.sh"
  ENABLE_INGRESS=false CAIPE_DOMAIN=saved.example.test CAIPE_UI_URL= CAIPE_IDP_URL= UI_PORT=3000 KEYCLOAK_PORT=7080
  [[ "$(_browser_ui_url)" == http://localhost:3000 ]]
  [[ "$(ingestor_issuer)" == http://localhost:7080/realms/caipe ]]
  ENABLE_RBAC_RUNTIME=true _ui_env_oidc_issuer=
  _upstream_idp_configured() { return 1; }
  [[ "$(dynamic_issuer)" == http://localhost:7080/realms/caipe ]]
  _internal_oidc_issuer() { echo http://example-keycloak:8080/realms/caipe; }
  no_ingress_values > "$WORK/values"
  grep -q 'rag-stack.rag-server.env.OIDC_ISSUER=http://localhost:7080/realms/caipe' "$WORK/values"
  # Verify both no-domain guards reach the actual authentication path.
  CAIPE_DOMAIN=
  called=false
  _kcadm_get_token() { called=true; echo token; }
  # These helpers read a secret before starting any forwarding or HTTP calls.
  kubectl() { echo reached >> "$WORK/commands"; return 1; }
  log() { :; }; warn() { :; }
  KEYCLOAK_ADMIN_PASSWORD=
  update_keycloak_client_urls || true
  [[ -s "$WORK/commands" ]]
  rm "$WORK/commands"
  provision_caipe_ui_audience_mapper || true
  [[ -s "$WORK/commands" ]]
)
(
  set +u
  source "$WORK/helpers.sh"
  _RAG_FORCED=off ENABLE_RAG=false DATABASE_PROVIDER=mongodb CAIPE_CHART_VERSION=example
  helm() { return 1; }
  kubectl() { [[ "$*" == 'get svc rag-server -n caipe' ]]; }
  log() { :; }
  detect_deployed_features
  [[ "$ENABLE_RAG" == false ]]
)
(
  set +u
  source "$WORK/helpers.sh"
  NON_INTERACTIVE=true ENABLE_RAG=true ENABLE_GRAPH_RAG=false ENABLE_TRACING=false ENABLE_METALLB=false ENABLE_INGRESS=false
  LLM_PROVIDER=openai EMBEDDINGS_PROVIDER=openai DATABASE_PROVIDER=mongodb
  step() { :; }; log() { :; }; _choose_database_provider() { :; }; _database_service_name() { echo example; }
  _discover_gateway_embedding_model() { echo discovered > "$WORK/discovery"; }
  choose_features
  [[ -s "$WORK/discovery" ]]
)
echo 'PASS: saved-domain no-ingress values, RAG opt-out, and unattended model discovery'
