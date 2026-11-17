#!/usr/bin/env bash
# Exercise installer decisions without accessing a cluster or provider.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
python - "$ROOT/setup-caipe.sh" "$WORK/helpers.sh" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
names = ['_browser_ui_url', '_browser_oidc_issuer', '_internal_oidc_issuer', '_discover_gateway_embedding_model', 'choose_features', 'detect_deployed_features', 'update_keycloak_client_urls', 'provision_caipe_ui_audience_mapper']
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
a = s.index('  kubectl create secret generic rag-ingestor-secret')
b = s.index('  log "RAG ingestor client: credentials stored', a)
parts.append('ingestor_secret() {\nlocal issuer="$(_browser_oidc_issuer)" client_id=example-ingestor client_secret=example-secret\n' + s[a:b] + '\n}')
a = s.index('    if [[ "${RAG_INGESTOR_SECRET_READY:-false}" == "true" ]]; then')
b = s.index('      log "RAG web-ingestor: Keycloak OIDC credentials wired', a)
parts.append('ingestor_values() {\nlocal helm_args=()\n' + s[a:b] + '\nfi\nprintf "%s\\n" "${helm_args[@]}"\n}')
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
  grep -q 'rag-stack.rag-server.env.OIDC_DISCOVERY_URL=http://example-keycloak:8080/realms/caipe' "$WORK/values"
  grep -q 'rag-stack.rag-server.env.OIDC_JWKS_URL=http://example-keycloak:8080/realms/caipe/protocol/openid-connect/certs' "$WORK/values"
  kubectl() {
    if [[ "$1" == create ]]; then printf '%s\n' "$@" > "$WORK/secret-args"; else cat >/dev/null; fi
  }
  log() { :; }
  ingestor_secret
  grep -q -- '--from-literal=INGESTOR_OIDC_ISSUER=http://localhost:7080/realms/caipe' "$WORK/secret-args"
  grep -q -- '--from-literal=INGESTOR_OIDC_DISCOVERY_URL=http://example-keycloak:8080/realms/caipe/.well-known/openid-configuration$' "$WORK/secret-args"
  RAG_INGESTOR_SECRET_READY=true RAG_INGESTOR_OIDC_ISSUER="$(_browser_oidc_issuer)" RAG_INGESTOR_OIDC_CLIENT_ID=example-ingestor
  ingestor_values > "$WORK/ingestor-values"
  grep -q 'rag-stack.rag-server.env.INGESTOR_OIDC_DISCOVERY_URL=http://example-keycloak:8080/realms/caipe' "$WORK/ingestor-values"
  grep -q 'rag-stack.rag-server.env.INGESTOR_OIDC_JWKS_URL=http://example-keycloak:8080/realms/caipe/protocol/openid-connect/certs' "$WORK/ingestor-values"
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
(
  set +u
  source "$WORK/helpers.sh"
  log() { :; }
  EMBEDDINGS_PROVIDER=openai EMBEDDINGS_MODEL=embedding-v2 OPENAI_API_KEY=example-key OPENAI_ENDPOINT=https://gateway.example.test/v1
  curl() { printf '{"data":[{"id":"embedding-v1"},{"id":"embedding-v2"}]}'; }
  ENABLE_RAG=true DATABASE_PROVIDER=mongodb CAIPE_CHART_VERSION=example _RAG_FORCED=on
  SELECTED_AGENTS=(example) HELM_AGENT_ARGS=(example)
  helm() {
    [[ "$1 $2" == "get values" ]] || return 1
    printf '{"rag-stack":{"rag-server":{"env":{"EMBEDDINGS_PROVIDER":"openai","EMBEDDINGS_MODEL":"embedding-v2"}}}}'
  }
  kubectl() { return 1; }
  EMBEDDINGS_MODEL=text-embedding-3-large
  detect_deployed_features
  _discover_gateway_embedding_model
  [[ "$EMBEDDINGS_MODEL" == embedding-v2 ]]
  _EMBEDDINGS_MODEL_DEPLOYED= _EMBEDDINGS_MODEL_EXPLICIT=set EMBEDDINGS_MODEL=explicit-embedding
  _discover_gateway_embedding_model
  [[ "$EMBEDDINGS_MODEL" == explicit-embedding ]]
  _EMBEDDINGS_MODEL_EXPLICIT= EMBEDDINGS_MODEL=text-embedding-3-large
  _discover_gateway_embedding_model
  [[ "$EMBEDDINGS_MODEL" == embedding-v1 ]]
)
echo 'PASS: no-ingress discovery/JWKS and ingestor secret, RAG opt-out, and embedding discovery preservation'
