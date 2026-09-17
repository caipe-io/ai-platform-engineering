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

# RAG is part of the out-of-box install. Operators can still make a deliberate
# resource-saving choice with --no-rag.
grep -q '^ENABLE_RAG="\${ENABLE_RAG:-true}"$' "$SOURCE" \
  || fail "RAG is not enabled by default"
grep -q -- '--no-rag' "$SOURCE" \
  || fail "installer does not expose an explicit RAG opt-out"
grep -q -- '--no-rag)          ENABLE_RAG=false' "$SOURCE" \
  || fail "--no-rag does not disable RAG"
pass "RAG is enabled by default with an explicit opt-out"

# Milvus' MinIO dependency must use a registry that retains the pinned image;
# a missing image prevents rag-server from starting at all.
grep -q 'rag-stack.milvus.minio.image.repository=quay.io/minio/minio' "$SOURCE" \
  || fail "RAG install does not use the reliable MinIO registry"
pass "RAG MinIO image uses the reliable registry"
grep -q '_discover_gateway_embedding_model' "$SOURCE" \
  || fail "RAG does not discover embedding models from custom gateways"
pass "RAG discovers embedding models from custom gateways"

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
grep -q 'if \[\[ -n "\${CAIPE_DOMAIN:-}" \]\] || ! \$ENABLE_INGRESS; then' "$SOURCE" \
  || fail "post-deploy Keycloak setup does not run for no-ingress installs"
pass "no-ingress uses split browser/server OIDC endpoints"
