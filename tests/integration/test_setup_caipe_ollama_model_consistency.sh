#!/usr/bin/env bash
# Verify that the configured Ollama model is restored on reruns and is kept
# separate from the LiteLLM chat alias used by agents.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SETUP_SCRIPT="${REPO_ROOT}/setup-caipe.sh"
OLLAMA_MANIFEST="${REPO_ROOT}/deploy/kind/ollama.yaml"

grep -q '^_OLLAMA_MODEL_EXPLICIT=' "${SETUP_SCRIPT}"
grep -q ' -z "${_OLLAMA_MODEL_EXPLICIT:-}" ' "${SETUP_SCRIPT}"
grep -q -- '--from-literal=OLLAMA_MODEL="${OLLAMA_MODEL}"' "${SETUP_SCRIPT}"
grep -q 'name: OLLAMA_MODEL' "${OLLAMA_MANIFEST}"
grep -q 'key: OLLAMA_MODEL' "${OLLAMA_MANIFEST}"
grep -q 'ollama pull "${OLLAMA_MODEL}"' "${OLLAMA_MANIFEST}"
grep -q 'ollama show "${OLLAMA_MODEL}"' "${OLLAMA_MANIFEST}"

echo "PASS: Ollama model selection is persisted and independent of the LiteLLM alias"
