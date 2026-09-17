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

# Docker Compose uses a published all-in-one image set. Do not rewrite it to
# the latest Helm release, because component images and chart releases can
# publish on different cadences. Autonomous Agents also has its own image
# repository/tag, while local helper images must be built from this checkout.
grep -q '^IMAGE_TAG=0\.5\.66$' "$ROOT/.env.example" \
  || fail "Compose defaults do not pin the published all-in-one image set"
grep -q 'COMPOSE_PROFILES=.*autonomous-agents' "$ROOT/.env.example" \
  || fail "Compose defaults omit the autonomous-agents profile"
grep -q 'AUTONOMOUS_AGENTS_IMAGE_TAG=1\.1\.0' "$ROOT/.env.example" \
  || fail "Compose does not pin the autonomous-agents image independently"
grep -q 'ghcr.io/caipe-io/caipe-autonomous-agents:\${AUTONOMOUS_AGENTS_IMAGE_TAG:-1\.1\.0}' "$ROOT/docker-compose.yaml" \
  || fail "Compose uses the wrong autonomous-agents image repository"
grep -q 'image: quay.io/minio/minio:RELEASE\.2024-05-28T17-19-04Z' "$ROOT/docker-compose.yaml" \
  || fail "Compose RAG MinIO image uses the unreliable registry"
grep -q 'up --build -d' "$SOURCE" \
  || fail "Compose setup does not build local helper images"
grep -q 'EMBEDDINGS_PROVIDER=\${EMBEDDINGS_PROVIDER:-openai}' "$ROOT/docker-compose.yaml" \
  || fail "Compose does not pass the RAG embeddings provider"
grep -q 'LITELLM_API_BASE=\${LITELLM_API_BASE:-' "$ROOT/docker-compose.yaml" \
  || fail "Compose does not pass LiteLLM embedding connectivity"
grep -q 'AGENTIC_APPS_INSTALL_ENABLED=\${AGENTIC_APPS_INSTALL_ENABLED:-true}' "$ROOT/docker-compose.yaml" \
  || fail "Compose does not enable the External Apps catalog"
grep -q 'AGENTIC_APPS_CONFIG_PATH=/app/config/agentic-apps.yaml' "$ROOT/docker-compose.yaml" \
  || fail "Compose does not configure the External Apps catalog path"
grep -q 'AGENTIC_APP_TOKEN_SECRET=\${AGENTIC_APP_TOKEN_SECRET:-' "$ROOT/docker-compose.yaml" \
  || fail "Compose does not provision the External Apps token secret"
grep -q 'AGENTIC_APPS_CONFIG_FILE=./config/agentic-apps.yaml' "$ROOT/.env.example" \
  || fail "Compose does not provide an External Apps catalog file"
[[ -f "$ROOT/config/agentic-apps.yaml" ]] \
  || fail "Compose External Apps catalog file is missing"
grep -q '^  packages: \[\]$' "$ROOT/config/agentic-apps.yaml" \
  || fail "Compose External Apps catalog is not a valid empty catalog"
pass "Compose defaults are pinned, full-featured, and gateway-compatible"

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
