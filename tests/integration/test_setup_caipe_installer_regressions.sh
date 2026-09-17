#!/usr/bin/env bash
# Regression tests for installer behavior observed during a release-tag install.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SOURCE="$ROOT/setup-caipe.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# Environment-provided model and endpoint values must survive initialization and
# --env-file loading. These are intentionally exact guards because these lines
# run before the interactive credential flow.
grep -q '^OPENAI_ENDPOINT="\${OPENAI_ENDPOINT:-https://api.openai.com/v1}"$' "$SOURCE" \
  || fail "OPENAI_ENDPOINT default overwrites the caller's environment"
grep -q '^OPENAI_MODEL_NAME="\${OPENAI_MODEL_NAME:-gpt-5.2}"$' "$SOURCE" \
  || fail "OPENAI_MODEL_NAME default overwrites the caller's environment"
grep -q '^ANTHROPIC_MODEL_NAME="\${ANTHROPIC_MODEL_NAME:-claude-haiku-4-5-20251001}"$' "$SOURCE" \
  || fail "ANTHROPIC_MODEL_NAME default overwrites the caller's environment"
grep -q 'OPENAI_ENDPOINT OPENAI_MODEL_NAME' "$SOURCE" \
  || fail "--env-file loader does not import endpoint/model overrides"
grep -q '_OPENAI_ENDPOINT_EXPLICIT' "$SOURCE" \
  || fail "--env-file loader cannot distinguish defaults from explicit endpoint values"
grep -q '_OPENAI_MODEL_NAME_EXPLICIT' "$SOURCE" \
  || fail "--env-file loader cannot distinguish defaults from explicit model values"
pass "LLM endpoint and model overrides are preserved"

# Cleanup namespace deletion must be bounded so a stuck finalizer cannot hang
# the teardown command indefinitely.
for namespace in agentgateway-system ingress-nginx metallb-system; do
  grep -q "kubectl delete namespace ${namespace} --timeout=120s" "$SOURCE" \
    || fail "${namespace} cleanup is not bounded"
done
pass "auxiliary namespace cleanup is bounded"

# The no-ingress/SSH path must configure a browser-reachable localhost issuer,
# while server-side discovery stays on the in-cluster Keycloak service.
grep -q -- '--port-forward-mode' "$SOURCE" \
  || fail "port-forward mode is not exposed as an installer option"
grep -q 'PORT_FORWARD_MODE=true' "$SOURCE" \
  || fail "--no-ingress does not select port-forward mode"
grep -q 'caipe-ui.config.OIDC_ISSUER=$(_browser_oidc_issuer)' "$SOURCE" \
  || fail "no-ingress UI issuer is not browser-reachable"
grep -q 'caipe-ui.config.OIDC_DISCOVERY_URL=$(_internal_oidc_issuer)' "$SOURCE" \
  || fail "no-ingress discovery URL is not in-cluster"
grep -q 'OIDC_DISCOVERY_URL: "$(_internal_oidc_issuer)"' "$SOURCE" \
  || fail "dynamic-agents OIDC discovery URL is not in-cluster"
grep -q 'OIDC_ACCEPTED_AUDIENCES: "caipe-platform"' "$SOURCE" \
  || fail "UI does not accept the shared platform token audience"
grep -q 'caipe-ui.config.DYNAMIC_AGENTS_ENABLED=true' "$SOURCE" \
  || fail "dynamic-agents deployment does not enable the UI capability flag"
grep -q 'WORKFLOW_RUNNER_ENABLED="\${WORKFLOW_RUNNER_ENABLED:-true}"' "$SOURCE" \
  || fail "workflow runner is not enabled by default"
grep -q 'caipe-ui.config.WORKFLOW_RUNNER_ENABLED=\${_workflow_runner_enabled}' "$SOURCE" \
  || fail "workflow runner UI flag is not wired from the setup default"
grep -q 'if \[\[ -n "\${CAIPE_DOMAIN:-}" \]\] || ! \$ENABLE_INGRESS; then' "$SOURCE" \
  || fail "post-deploy Keycloak setup does not run for no-ingress installs"
pass "no-ingress uses split browser/server OIDC endpoints"

# RAG MCP must use the authenticated AgentGateway path. Dynamic Agents must
# forward the caller token, otherwise the gateway sends an empty bearer token
# upstream and RAG returns HTTP 401.
grep -q 'AGENT_GATEWAY_URL: "http://caipe-agentgateway:4000"' "$SOURCE" \
  || fail "Dynamic Agents gateway URL is not seeded"
grep -q 'USE_IMPERSONATION_TOKENS: "true"' "$SOURCE" \
  || fail "caller-token forwarding is not enabled for gateway MCP"
grep -q '_kb_endpoint="http://caipe-agentgateway:4000/mcp/knowledge-base"' "$SOURCE" \
  || fail "Knowledge Base seed does not use the AgentGateway route"
grep -q 'kind: "caller_token"' "$SOURCE" \
  || fail "Knowledge Base seed has no caller-token credential source"
pass "RAG Knowledge Base MCP uses authenticated AgentGateway routing"

# No-ingress RAG must validate the browser-issued token while fetching
# discovery/JWKS over the in-cluster Keycloak service.
grep -q 'rag-stack.rag-server.env.OIDC_ISSUER=\${_rag_browser_issuer}' "$SOURCE" \
  || fail "no-ingress RAG issuer is not browser-reachable"
grep -q 'rag-stack.rag-server.env.OIDC_DISCOVERY_URL=\$(_internal_oidc_issuer)' "$SOURCE" \
  || fail "no-ingress RAG discovery is not in-cluster"
pass "no-ingress RAG uses split browser/server OIDC endpoints"

# The released RAG chart consumes ingestor authentication from the shared
# global.rag.ingestorOidc values. The old rag-server.webIngestor path is ignored.
grep -q "rag-stack.milvus.minio.image.repository=quay.io/minio/minio" "$SOURCE" \
  || fail "RAG MinIO image is not pinned to the reachable Quay repository"
grep -q 'global.rag.ingestorOidc.issuer=\${RAG_INGESTOR_OIDC_ISSUER}' "$SOURCE" \
  || fail "RAG ingestor issuer is not wired through shared chart OIDC values"
grep -q 'global.rag.ingestorOidc.clientSecretRef.name=rag-ingestor-secret' "$SOURCE" \
  || fail "RAG ingestor secret is not wired through shared chart OIDC values"
! grep -q 'rag-stack.rag-server.webIngestor' "$SOURCE" \
  || fail "RAG installer still uses ignored legacy webIngestor values"
pass "RAG ingestor uses shared chart OIDC values and reachable MinIO image"

# Ingress-mode UI auth intentionally redirects unauthenticated requests to
# /login; that is a reachable UI, not a failed ingress probe. The localtest.me
# hint must preserve the issuer's port 443 for OAuth callback compatibility.
grep -q 'if \[\[ "\$_ui_code" =~ \^\[23\]\[0-9\]\[0-9\]\$ \]\]; then' "$SOURCE" \
  || fail "ingress validation rejects the expected UI auth redirect"
grep -q 'sudo ssh -N -L 443:<remote-private-ip>:443 <host>' "$SOURCE" \
  || fail "remote localtest.me guidance does not forward the issuer port"
! grep -q 'ssh -N -L 443:127.0.0.1:443' "$SOURCE" \
  || fail "remote localtest.me guidance targets remote loopback instead of ingress"
pass "ingress validation accepts auth redirects and documents compatible SSH forwarding"

# The default static AgentGateway path must not contact the CRD installers.
awk '
  /^_install_agentgateway_crds\(\) \{/ { found=1 }
  found { print }
  found && /^}$/ { exit }
' "$SOURCE" > "$WORK/agentgateway-function.sh"
source "$WORK/agentgateway-function.sh"
log() { :; }
err() { :; }
kubectl() { fail "kubectl was called for static AgentGateway routing: $*"; }
helm() { fail "helm was called for static AgentGateway routing: $*"; }
AGENTGATEWAY_ROUTING_MODE=static
_install_agentgateway_crds
pass "static AgentGateway routing skips CRD installation"

# Explicit Gateway API mode still invokes both installers and propagates a
# failure instead of hiding it behind `tail ... || true`.
kubectl() { [[ "$1" == apply && "$2" == -f ]] || fail "unexpected kubectl call: $*"; }
helm() { [[ "$1" == upgrade && "$2" == -i ]] || fail "unexpected helm call: $*"; }
AGENTGATEWAY_ROUTING_MODE=gateway-api
AGENTGATEWAY_VERSION=v2.2.1
_install_agentgateway_crds
pass "Gateway API mode retains CRD installation"

helm() { return 1; }
if _install_agentgateway_crds; then
  fail "Gateway API CRD failures are swallowed"
fi
pass "Gateway API CRD failures are propagated"
