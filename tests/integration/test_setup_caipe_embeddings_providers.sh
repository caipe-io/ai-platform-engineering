#!/usr/bin/env bash
# -------------------------------------------------------------------
# tests/integration/test_setup_caipe_embeddings_providers.sh
#
# Pin-test for the expanded embeddings provider matrix in setup-caipe.sh.
#
# Before this change, setup-caipe.sh's embeddings menu only offered:
#   openai, azure-openai, litellm, ollama
# And it had no Anthropic-aware guidance (Anthropic doesn't ship a
# native embeddings model; their official recommendation is Voyage AI).
#
# This test pins:
#   * Pin 1 — All 7 EmbeddingsFactory providers are reachable from the
#             interactive menu (one option each, plus Voyage routed via
#             the LiteLLM-compatible code path).
#   * Pin 2 — Anthropic-aware note is rendered when LLM == anthropic-claude.
#   * Pin 3 — Credential collectors exist for the new providers
#             (Cohere, Voyage, AWS Bedrock embeddings, HuggingFace).
#   * Pin 4 — `create_namespace_and_secrets` materialises the new
#             provider env vars into llm-secret (COHERE_API_KEY,
#             VOYAGE_API_KEY → LITELLM_API_KEY, AWS_* for bedrock,
#             HUGGINGFACEHUB_API_TOKEN, EMBEDDINGS_DEVICE,
#             OLLAMA_BASE_URL for in-cluster Ollama embeddings).
#   * Pin 5 — auto-heal no longer clobbers a genuine Azure OpenAI pick
#             (the AZURE_OPENAI_ENDPOINT log-grep is gated on
#             EMBEDDINGS_PROVIDER != azure-openai).
#   * Pin 6 — --help output documents the new env vars and the
#             Voyage AI / Anthropic note.
#   * Pin 7 — The EmbeddingsFactory still supports the same set of
#             providers the menu offers (drift guard against the Python
#             factory adding or removing providers without this test
#             being updated).
#   * Pin 8 — detect_deployed_features (the unattended upgrade path)
#             inherits the *deployed* RAG embeddings provider/model from
#             the live Helm values, instead of resetting them to the
#             openai default, and still honors an explicit caller override.
#
# Exits 0 on success, non-zero with a clear FAIL message otherwise.
#
# Usage:
#   ./tests/integration/test_setup_caipe_embeddings_providers.sh
#
# assisted-by Claude:claude-opus-4-7
# -------------------------------------------------------------------

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SETUP_SCRIPT="${REPO_ROOT}/setup-caipe.sh"
FACTORY_PY="${REPO_ROOT}/ai_platform_engineering/knowledge_bases/rag/common/src/common/embeddings_factory.py"

if [ ! -f "${SETUP_SCRIPT}" ]; then
  echo "FAIL: setup-caipe.sh not found at ${SETUP_SCRIPT}" >&2
  exit 2
fi

PASS=0
FAIL=0

_pass() { echo "[emb-test]   OK: $*"; PASS=$((PASS + 1)); }
_fail() { echo "[emb-test]   FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------
# Pin 1 — All 7 EmbeddingsFactory providers reachable from menu.
# ---------------------------------------------------------------------
echo "[emb-test] Pin 1: all 7 providers + Voyage option exposed in the menu ..."
# The menu lines are rendered with ANSI colour escapes — we look only at the
# (BOLD)N)(NC) prefix + provider label, ignoring the surrounding markup.
expected_menu=(
  '[0-9]).* OpenAI '
  '[0-9]).* Azure OpenAI '
  '[0-9]).* AWS Bedrock '
  '[0-9]).* Cohere '
  '[0-9]).* Voyage AI '
  '[0-9]).* HuggingFace '
  '[0-9]).* Ollama '
  '[0-9]).* LiteLLM Proxy '
)
for pat in "${expected_menu[@]}"; do
  if grep -qE -- "${pat}" "${SETUP_SCRIPT}"; then
    _pass "menu line matches /${pat}/"
  else
    _fail "menu is missing pattern /${pat}/"
  fi
done

# ---------------------------------------------------------------------
# Pin 2 — Anthropic-aware Voyage note is rendered.
# ---------------------------------------------------------------------
echo "[emb-test] Pin 2: Anthropic-aware note appears in choose_features() ..."
if grep -q 'Anthropic does not ship its own embeddings model' "${SETUP_SCRIPT}"; then
  _pass "Anthropic note present"
else
  _fail "Missing Anthropic-aware note (operator running Claude won't know about Voyage)"
fi
if grep -q 'platform.claude.com/docs/en/build-with-claude/embeddings' "${SETUP_SCRIPT}"; then
  _pass "Anthropic docs link cited"
else
  _fail "Missing canonical Anthropic embeddings docs link"
fi

# ---------------------------------------------------------------------
# Pin 3 — Credential collectors exist for new providers.
# ---------------------------------------------------------------------
echo "[emb-test] Pin 3: credential collectors for new providers exist ..."
collectors=(
  _collect_cohere_embeddings_creds
  _collect_voyage_embeddings_creds
  _collect_aws_bedrock_embeddings_creds
  _collect_huggingface_embeddings_creds
)
for fn in "${collectors[@]}"; do
  if grep -qE "^${fn}\(\)" "${SETUP_SCRIPT}"; then
    _pass "collector ${fn}()"
  else
    _fail "missing collector ${fn}()"
  fi
done

# ---------------------------------------------------------------------
# Pin 4 — llm-secret materialisation for new providers.
# ---------------------------------------------------------------------
echo "[emb-test] Pin 4: create_namespace_and_secrets wires new env vars ..."
secret_wirings=(
  '--from-literal=COHERE_API_KEY='
  '--from-literal=HUGGINGFACEHUB_API_TOKEN='
  '--from-literal=EMBEDDINGS_DEVICE='
  '--from-literal=AWS_ACCESS_KEY_ID='
  '--from-literal=OLLAMA_BASE_URL='
)
# Use `--` to stop grep from treating the leading `--` as a flag.
for wire in "${secret_wirings[@]}"; do
  if grep -qF -- "${wire}" "${SETUP_SCRIPT}"; then
    _pass "secret-args wiring '${wire}…'"
  else
    _fail "missing secret-args wiring '${wire}…'"
  fi
done

# Voyage routes through LiteLLM endpoint=https://api.voyageai.com/v1.
if grep -q 'api.voyageai.com/v1' "${SETUP_SCRIPT}"; then
  _pass "Voyage AI endpoint hardcoded (api.voyageai.com/v1)"
else
  _fail "Voyage AI endpoint missing — Voyage option will not reach the right host"
fi

# ---------------------------------------------------------------------
# Pin 5 — auto-heal Azure-clobber bug is fixed.
# ---------------------------------------------------------------------
echo "[emb-test] Pin 5: auto-heal does not clobber genuine Azure embeddings picks ..."
# The fix is a guard `EMBEDDINGS_PROVIDER != azure-openai` BEFORE the
# AZURE_OPENAI_ENDPOINT log-grep. We assert both parts are present and
# colocated (within 5 lines of each other).
if awk '
  /EMBEDDINGS_PROVIDER.*!=.*azure-openai/ { guard = NR }
  /AZURE_OPENAI_ENDPOINT.*azure_endpoint/ {
    if (guard && NR - guard <= 5) { found = 1 }
  }
  END { exit found ? 0 : 1 }
' "${SETUP_SCRIPT}"; then
  _pass "auto-heal guard correctly precedes the log-grep"
else
  _fail "auto-heal still has the unconditional log-grep that would clobber a real Azure pick"
fi

# ---------------------------------------------------------------------
# Pin 6 — --help documents the new env vars.
# ---------------------------------------------------------------------
echo "[emb-test] Pin 6: --help advertises new env vars + Anthropic guidance ..."
help_out=$(bash "${SETUP_SCRIPT}" --help 2>&1 || true)
help_vars=(
  COHERE_API_KEY
  VOYAGE_API_KEY
  HUGGINGFACEHUB_API_TOKEN
  EMBEDDINGS_DEVICE
)
for v in "${help_vars[@]}"; do
  if echo "${help_out}" | grep -qE "^[[:space:]]+${v}\b"; then
    _pass "--help mentions ${v}"
  else
    _fail "--help is missing ${v}"
  fi
done
if echo "${help_out}" | grep -q 'Anthropic does NOT ship a native embeddings model'; then
  _pass "--help calls out the Anthropic-Voyage relationship"
else
  _fail "--help missing the Anthropic-Voyage callout"
fi

# ---------------------------------------------------------------------
# Pin 7 — drift guard: factory still supports the same provider set.
# ---------------------------------------------------------------------
echo "[emb-test] Pin 7: EmbeddingsFactory provider set still matches the menu ..."
if [ -f "${FACTORY_PY}" ]; then
  factory_providers=$(awk '/provider == "/ { match($0, /provider == "[^"]+"/); print substr($0, RSTART+13, RLENGTH-14) }' "${FACTORY_PY}" | sort -u)
  expected_providers=$(printf '%s\n' \
    azure-openai openai aws-bedrock cohere huggingface ollama litellm | sort -u)
  if [ "${factory_providers}" = "${expected_providers}" ]; then
    _pass "EmbeddingsFactory providers == {azure-openai, openai, aws-bedrock, cohere, huggingface, ollama, litellm}"
  else
    _fail "EmbeddingsFactory provider drift — menu may be out of sync with Python factory"
    echo "    Factory says: $(echo "${factory_providers}" | tr '\n' ' ')" >&2
    echo "    Menu expects: $(echo "${expected_providers}" | tr '\n' ' ')" >&2
  fi
else
  echo "[emb-test]   SKIP: ${FACTORY_PY} not found (drift guard cannot run)"
fi

# ---------------------------------------------------------------------
# Pin 8 — non-interactive upgrade inherits the deployed embeddings config.
#
# Regression guard for the bug where a `--non-interactive` re-run reset RAG
# embeddings to the EMBEDDINGS_PROVIDER default (openai) because the
# embeddings-from-cluster read lived only in choose_features' interactive
# branch. The read now lives in detect_deployed_features, which the upgrade
# path always runs.
# ---------------------------------------------------------------------
echo "[emb-test] Pin 8: detect_deployed_features inherits the deployed embeddings provider ..."
detect_body=$(awk '/^detect_deployed_features\(\) \{/{f=1} f{print} f && /^\}/{exit}' "${SETUP_SCRIPT}")
if echo "${detect_body}" | grep -q 'rag-server".env.EMBEDDINGS_PROVIDER'; then
  _pass "detect_deployed_features reads EMBEDDINGS_PROVIDER from the deployed RAG values"
else
  _fail "detect_deployed_features no longer reads the deployed EMBEDDINGS_PROVIDER (non-interactive upgrade would reset RAG embeddings to the openai default)"
fi
if echo "${detect_body}" | grep -q '_EMBEDDINGS_PROVIDER_EXPLICIT'; then
  _pass "detect_deployed_features honors an explicit caller override (_EMBEDDINGS_PROVIDER_EXPLICIT)"
else
  _fail "detect_deployed_features ignores the explicit EMBEDDINGS_PROVIDER override guard"
fi

# ---------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------
echo ""
echo "[emb-test] ${PASS} pass, ${FAIL} fail"
if [ "${FAIL}" -gt 0 ]; then
  echo "[emb-test] FAIL — see messages above" >&2
  exit 1
fi
echo "[emb-test] PASS — all embeddings provider pins green."
exit 0
