#!/usr/bin/env bash
set -euo pipefail

# ─── Future work ─────────────────────────────────────────────────────────────
# TODO(ansible): Replace or complement this script with an Ansible playbook.
#   Roles: kind_cluster, metallb, nginx_ingress, caipe_secrets, caipe_helm,
#   caipe_mongodb. Benefits: idempotency, inventory-driven multi-env deploys
#   (demo/devnet/prod from one playbook), Ansible Vault for secrets, CI/CD.
#   Tracking: https://github.com/caipe-io/ai-platform-engineering/issues/1115
# ─────────────────────────────────────────────────────────────────────────────

# ─── Defaults ────────────────────────────────────────────────────────────────
CAIPE_CHART_VERSION="${CAIPE_CHART_VERSION:-}"
CAIPE_OCI_REPO="oci://ghcr.io/cnoe-io/charts/ai-platform-engineering"
LANGFUSE_PORT=3100
DYNAMIC_AGENTS_PORT=8001
UI_PORT=3000
RAG_SERVER_PORT=9446

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ─── State ───────────────────────────────────────────────────────────────────
CLUSTER_NAME=""
ENABLE_RAG=false
ENABLE_TRACING=false
# Dynamic-agent runtime persistence is backed by MongoDB in the baseline stack.
# The persistence flags are accepted below for CLI compatibility.
ENABLE_PERSISTENCE="${ENABLE_PERSISTENCE:-true}"
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
OPENAI_ENDPOINT="https://api.openai.com/v1"
OPENAI_MODEL_NAME="gpt-5.2"
LITELLM_ENDPOINT="${LITELLM_ENDPOINT:-}"
LITELLM_API_KEY="${LITELLM_API_KEY:-}"
LITELLM_MODEL_NAME="${LITELLM_MODEL_NAME:-gpt-oss-20B}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_MODEL_NAME="claude-haiku-4-5-20251001"
AWS_BEDROCK_MODEL_ID="${AWS_BEDROCK_MODEL_ID:-global.anthropic.claude-haiku-4-5-20251001-v1:0}"
AWS_BEDROCK_PROVIDER="${AWS_BEDROCK_PROVIDER:-anthropic}"
AWS_REGION="${AWS_REGION:-us-east-2}"
AWS_PROFILE="${AWS_PROFILE:-}"
AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"
AWS_BEDROCK_ENABLE_PROMPT_CACHE="${AWS_BEDROCK_ENABLE_PROMPT_CACHE:-}"
LLM_PROVIDER="${LLM_PROVIDER:-}"  # filled by cluster detection or user prompt; default applied per-use
# Capture whether the caller set these explicitly (env/CLI) BEFORE the defaults
# below collapse them to a non-empty value. The upgrade path
# (detect_deployed_features) uses these flags to decide whether to inherit the
# *deployed* RAG embeddings provider/model — mirroring LLM_PROVIDER, which is
# empty by default and inherited from llm-secret.
_EMBEDDINGS_MODEL_EXPLICIT="${EMBEDDINGS_MODEL:+set}"
EMBEDDINGS_MODEL="${EMBEDDINGS_MODEL:-text-embedding-3-large}"
_EMBEDDINGS_PROVIDER_EXPLICIT="${EMBEDDINGS_PROVIDER:+set}"
EMBEDDINGS_PROVIDER="${EMBEDDINGS_PROVIDER:-openai}"
# Provider-specific embeddings credentials (only the active provider's vars are required).
# These mirror the env vars the RAG server's EmbeddingsFactory reads at runtime.
# See ai_platform_engineering/knowledge_bases/rag/common/src/common/embeddings_factory.py
COHERE_API_KEY="${COHERE_API_KEY:-}"
VOYAGE_API_KEY="${VOYAGE_API_KEY:-}"
HUGGINGFACEHUB_API_TOKEN="${HUGGINGFACEHUB_API_TOKEN:-}"
EMBEDDINGS_DEVICE="${EMBEDDINGS_DEVICE:-cpu}"
# Explicit embedding vector dimensions override — passed to rag-server as
# EMBEDDINGS_DIMENSIONS so Milvus collection creation and query-time validation
# always use the correct size, even for models not in EmbeddingsFactory's built-in map.
EMBEDDINGS_DIMENSIONS="${EMBEDDINGS_DIMENSIONS:-}"
# Source hint for the embeddings menu: distinguishes "voyage" and
# "custom-litellm" (both materialise EMBEDDINGS_PROVIDER=litellm internally
# but route through different model menus and credential prompts).
EMBEDDINGS_PROVIDER_SOURCE="${EMBEDDINGS_PROVIDER_SOURCE:-}"
# AWS embeddings reuse the LLM-side AWS creds (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION).
ENABLE_GRAPH_RAG=false
ENABLE_VLLM="${ENABLE_VLLM:-false}"
ENABLE_OLLAMA="${ENABLE_OLLAMA:-false}"
# AgentGateway: default ON. Federates MCP servers behind a single endpoint
# and is the data path RBAC runtime depends on. Set ENABLE_AGENTGATEWAY=false
# or pass --no-agentgateway to skip (also disables RBAC runtime).
ENABLE_AGENTGATEWAY="${ENABLE_AGENTGATEWAY:-true}"
# RBAC runtime: default ON. Installs in-chart Keycloak + OpenFGA + ext_authz
# bridge + standalone AgentGateway proxy (the 0.5.0 RBAC stack). Implies
# ENABLE_AGENTGATEWAY=true. Set ENABLE_RBAC_RUNTIME=false or pass
# --no-rbac-runtime to skip.
ENABLE_RBAC_RUNTIME="${ENABLE_RBAC_RUNTIME:-true}"
# Keycloak bootstrap admin password (master realm). The keycloak subchart
# requires an explicit value — generated admin passwords are disabled because
# Keycloak persists the bootstrap admin in its database. Resolved/persisted by
# _resolve_keycloak_admin_password (idempotent, mirrors the MongoDB pattern).
KEYCLOAK_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-}"
# GitHub social login (Keycloak "github" broker). Lets anyone with a GitHub
# account sign in alongside local Keycloak users. Empty = ask interactively
# when a public domain + RBAC runtime are in play; set to true/false to force.
# Requires a DEDICATED GitHub OAuth App whose Authorization callback URL is
# https://<domain>/realms/caipe/broker/github/endpoint — do NOT reuse the
# GITHUB_CLIENT_* connector credentials (different callback/purpose).
ENABLE_GITHUB_SOCIAL="${ENABLE_GITHUB_SOCIAL:-}"
GITHUB_SOCIAL_CLIENT_ID="${GITHUB_SOCIAL_CLIENT_ID:-}"
GITHUB_SOCIAL_CLIENT_SECRET="${GITHUB_SOCIAL_CLIENT_SECRET:-}"
# Local Keycloak admin login (no upstream IdP / no Cisco SSO). The default
# in-chart Keycloak install ships no human users, so without this nobody could
# sign in unless an upstream IdP (Duo/Okta) was brokered. When the RBAC runtime
# is on with a DNS domain and no upstream IdP is configured, we create a single
# realm user with a password and grant it org-admin (BOOTSTRAP_ADMIN_EMAILS) so
# RBAC/auth can be exercised end-to-end with zero external identity setup.
# Disable with --no-local-admin. The password is generated and persisted in the
# caipe-local-admin Secret (idempotent re-runs) unless LOCAL_ADMIN_PASSWORD is set.
ENABLE_LOCAL_ADMIN="${ENABLE_LOCAL_ADMIN:-true}"
LOCAL_ADMIN_EMAIL="${LOCAL_ADMIN_EMAIL:-admin@caipe.local}"
LOCAL_ADMIN_PASSWORD="${LOCAL_ADMIN_PASSWORD:-}"
# Second local realm user that is NOT in BOOTSTRAP_ADMIN_EMAILS, so it logs in as
# a plain (non-org-admin) user. Lets operators test both RBAC paths — admin
# surfaces vs a standard chat user denied the admin UI — out of the box. Disable
# with --no-local-user. Password generated + persisted in the caipe-local-user
# Secret (idempotent) unless LOCAL_USER_PASSWORD is set. Only provisioned when the
# local admin is (same _local_admin_active gate).
ENABLE_LOCAL_USER="${ENABLE_LOCAL_USER:-true}"
LOCAL_USER_EMAIL="${LOCAL_USER_EMAIL:-user@caipe.local}"
LOCAL_USER_PASSWORD="${LOCAL_USER_PASSWORD:-}"
# Shared Postgres: default ON. Deploys a single bitnami/postgresql instance that
# backs Keycloak and OpenFGA (and optionally LiteLLM) with persistent databases,
# replacing Keycloak's embedded H2 and OpenFGA's in-memory store (both of which
# lose all state on pod restart). Only deployed when something actually needs it
# (RBAC runtime, or --litellm-db). Set ENABLE_SHARED_POSTGRES=false or pass
# --no-shared-postgres to fall back to the old ephemeral H2/in-memory stores.
ENABLE_SHARED_POSTGRES="${ENABLE_SHARED_POSTGRES:-true}"
SHARED_PG_SERVICE="caipe-postgres"
SHARED_PG_ADMIN_PASSWORD=""
KEYCLOAK_DB_PASSWORD=""
OPENFGA_DB_PASSWORD=""
LITELLM_DB_PASSWORD=""
# LiteLLM unified front: route all chat + embeddings credentials through a single
# in-cluster LiteLLM proxy (OpenAI-compatible). Set via --litellm.
LLM_VIA_LITELLM="${LLM_VIA_LITELLM:-false}"
# Persist LiteLLM virtual keys / spend tracking in the shared Postgres (opt-in).
ENABLE_LITELLM_DB="${ENABLE_LITELLM_DB:-false}"
# Captured at finalize time so the proxy's model_list can be built from the real
# provider while agents/RAG are repointed at the proxy (the working
# LLM_PROVIDER/EMBEDDINGS_PROVIDER get rewritten to openai/litellm).
LITELLM_CHAT_SOURCE=""
LITELLM_EMBED_SOURCE=""
LITELLM_EMBED_MODEL_REAL=""
LITELLM_ROUTE_EMBEDDINGS=false
# Downstream key agents/RAG present to the proxy. The proxy is in-cluster and not
# internet-exposed; this is a routing token, not an upstream provider secret.
LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-caipe-litellm}"
VLLM_MODEL="${VLLM_MODEL:-openai/gpt-oss-20b}"
VLLM_GPU_COUNT="${VLLM_GPU_COUNT:-1}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:0.6b}"
OLLAMA_PORT=11434
# Base URL the RAG server uses for Ollama embeddings. The EmbeddingsFactory
# default (http://localhost:11434) is the pod's own loopback and cannot reach
# Ollama, so on a k8s/kind deploy this must point at an in-cluster Ollama
# (see deploy/kind/ollama.yaml). Resolved per-use in create_namespace_and_secrets.
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-}"
HF_TOKEN="${HF_TOKEN:-}"
AGENTGATEWAY_VERSION="${AGENTGATEWAY_VERSION:-v2.2.1}"
AGENTGATEWAY_PORT=8080
KEYCLOAK_PORT=7080
OPENFGA_PORT=18080
INJECT_CORPORATE_CA=false
CA_SSL_FIX_PROMPTED=false
RAG_INGESTOR_SECRET_READY=false
RAG_INGESTOR_OIDC_ISSUER=""
RAG_INGESTOR_OIDC_CLIENT_ID=""
LANGFUSE_PUBLIC_KEY=""
LANGFUSE_SECRET_KEY=""
PF_PIDS=()
AUTO_YES=false
NON_INTERACTIVE=false
CREATE_CLUSTER=false
FORCE_UPGRADE=false
INGEST_URLS=()
# MetalLB: default ON. Required for real LoadBalancer IPs on kind clusters
# and is a prerequisite for ingress. Set ENABLE_METALLB=false or pass
# --no-metallb to skip (also disables ingress).
ENABLE_METALLB="${ENABLE_METALLB:-true}"
# Ingress: default ON. Exposes the UI via https://<domain> through
# nginx-ingress. If no domain is provided (env var, CLI flag, or interactive
# prompt), falls back to the CAIPE_DOMAIN_DEFAULT below. Set
# ENABLE_INGRESS=false or pass --no-ingress to skip.
ENABLE_INGRESS="${ENABLE_INGRESS:-true}"
# Default ingress hostname used when ingress is enabled but no domain is
# supplied. *.local.me resolves to 127.0.0.1 via public DNS, so this works
# out-of-the-box on any laptop without /etc/hosts edits.
CAIPE_DOMAIN_DEFAULT="${CAIPE_DOMAIN_DEFAULT:-caipe.local.me}"
CAIPE_DOMAIN=""
TLS_CERT_FILE=""
TLS_KEY_FILE=""
ENV_FILE=""
UI_ENV_FILE=""
COMPOSE_ENV_FILE=""
COMPOSE_PROFILES_DEFAULT="mcp-servers,caipe-ui-prod,rbac,dynamic-agents,rag,caipe-mongodb,web_ingestor"
USE_DOCKER_COMPOSE=false
# Chat-bot surfaces (the slack-bot / webex-bot deployments — distinct from the
# slack/webex MCP agents). Default OFF; enabled via --slack-bot / --webex-bot,
# the ENABLE_SLACK_BOT / ENABLE_WEBEX_BOT env vars, or (for parity with
# docker-compose.dev.yaml + .env) when the env-file sets ENABLE_SLACK /
# ENABLE_WEBEX. They wire the slack-bot/webex-bot subcharts onto an existing
# Keycloak + OpenFGA + MongoDB stack.
ENABLE_SLACK_BOT="${ENABLE_SLACK_BOT:-false}"
ENABLE_WEBEX_BOT="${ENABLE_WEBEX_BOT:-false}"
# Set to "on"/"off" by --slack-bot / --no-slack-bot (and webex equivalents) so an
# explicit CLI choice wins over the env-file auto-enable. Empty = no CLI flag given.
_SLACK_BOT_FORCED=""
_WEBEX_BOT_FORCED=""
# Agents selected interactively or via CAIPE_SELECTED_AGENTS; empty means all
# defaults are used (non-interactive path).
SELECTED_AGENTS=()
CAIPE_SELECTED_AGENTS="${CAIPE_SELECTED_AGENTS:-}"
if [[ -n "$CAIPE_SELECTED_AGENTS" ]]; then
  IFS=',' read -ra _selected_agents_from_env <<< "$CAIPE_SELECTED_AGENTS"
  for _agent in "${_selected_agents_from_env[@]}"; do
    _agent="${_agent#"${_agent%%[![:space:]]*}"}"
    _agent="${_agent%"${_agent##*[![:space:]]}"}"
    [[ -n "$_agent" ]] && SELECTED_AGENTS+=("$_agent")
  done
  unset _selected_agents_from_env _agent
fi

# When run via "curl | bash", stdin is the script content — bash reads it
# line-by-line. We CANNOT redirect stdin (exec < /dev/tty) because that
# would stop bash from reading the rest of the script.  Instead, open
# /dev/tty on fd 3 and redirect all interactive `read` calls to <&3.
for _arg in "$@"; do
  case "$_arg" in
    --non-interactive) NON_INTERACTIVE=true ;;
  esac
done
unset _arg

_tty_fd_opened=false
{ exec 3</dev/tty; _tty_fd_opened=true; } 2>/dev/null || true
if ! $_tty_fd_opened; then
  if $NON_INTERACTIVE; then
    exec 3</dev/null
  elif [[ -t 0 ]]; then
    exec 3<&0
  else
    echo "ERROR: no terminal available for interactive prompts." >&2
    echo "  Run with --non-interactive or use: bash -c \"\$(curl -fsSL URL)\"" >&2
    exit 1
  fi
fi

cleanup_on_exit() {
  # Kill tracked PIDs
  if ((${#PF_PIDS[@]} > 0)); then
    for pid in "${PF_PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
  fi
  # Fallback: kill any kubectl port-forward processes started for our services
  pkill -f "kubectl port-forward.*caipe-dynamic-agents.*${DYNAMIC_AGENTS_PORT:-8001}:8001" 2>/dev/null || true
  pkill -f "kubectl port-forward.*caipe-caipe-ui.*${UI_PORT:-3000}:3000" 2>/dev/null || true
  pkill -f "kubectl port-forward.*langfuse-web.*${LANGFUSE_PORT:-3100}:3000" 2>/dev/null || true
  pkill -f "kubectl port-forward.*caipe-keycloak.*${KEYCLOAK_PORT:-7080}:8080" 2>/dev/null || true
  pkill -f "kubectl port-forward.*caipe-openfga.*${OPENFGA_PORT:-18080}:8080" 2>/dev/null || true
  pkill -f "kubectl port-forward.*caipe-agentgateway.*${AGENTGATEWAY_PORT:-8080}:4000" 2>/dev/null || true
  rm -f /tmp/langfuse-cookies /tmp/caipe-validation-*.log
  exec 3<&- 2>/dev/null || true
}
trap cleanup_on_exit EXIT
trap 'cleanup_on_exit; exit 130' INT
trap 'cleanup_on_exit; exit 143' TERM

# ─── Helpers ─────────────────────────────────────────────────────────────────
log()     { echo -e "${GREEN}  ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}  !${NC} $*"; }
err()     { echo -e "${RED}  ✗${NC} $*" >&2; }
step()    { echo -e "\n${CYAN}${BOLD}━━━ $* ━━━${NC}"; }
header()  { echo -e "\n${BLUE}${BOLD}$*${NC}"; }
prompt()  { echo -en "${BOLD}  ▸ $*${NC}"; }

# Interactive read wrapper — reads from /dev/tty (fd 3) so that
# "curl | bash" keeps reading the script from stdin while prompts
# go to the terminal.  Passes all arguments through to `read`.
tty_read() { read "$@" <&3; }

# Returns 0 (true) when the user wants to go back — accepts "b", "back", "0"
_is_back() { local _v; _v="$(echo "$1" | tr '[:upper:]' '[:lower:]')"; [[ "$_v" == "b" || "$_v" == "back" || "$1" == "0" ]]; }

ask_yn() {
  local question="$1" default="${2:-y}"
  if $AUTO_YES; then return 0; fi
  local yn_hint
  if [[ "$default" == "y" ]]; then yn_hint="${CYAN}[Y/n]${NC}${BOLD}"; else yn_hint="${CYAN}[y/N]${NC}${BOLD}"; fi
  prompt "$question $yn_hint "
  tty_read -r answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

wait_for_pods() {
  local ns="$1" timeout="${2:-300}" exclude_pattern="${3:-}" interval=5 elapsed=0
  local show_interval=10 next_show=10
  # Once the cluster has "settled" (every not-ready pod is CrashLoopBackOff/Error,
  # i.e. nothing is still converging) we stop waiting and return 0 instead of
  # burning the full timeout. This is the common case for a credential-less
  # default install where optional agents (argocd/slack/splunk/…) CrashLoop
  # without secrets — the platform itself is healthy and post-deploy must still
  # run. Grace period avoids declaring "settled" during normal startup flapping.
  local settle_grace=120
  local log_check_after=20 log_check_interval=15 next_log_check=0
  local exclude_awk=""
  local prev_lines=0
  [[ -n "$exclude_pattern" ]] && exclude_awk="/$exclude_pattern/ {next} "

  # Helper: clear the in-place table and reset prev_lines
  _wfp_clear_table() {
    if [[ $prev_lines -gt 0 ]]; then
      printf '\033[%dA' "$prev_lines"
      for (( _cl=0; _cl<prev_lines; _cl++ )); do printf '\033[K\n'; done
      printf '\033[%dA' "$prev_lines"
      prev_lines=0
    fi
  }

  while [[ $elapsed -lt $timeout ]]; do
    local total ready stuck transient
    # Completed/Succeeded job pods (e.g. Keycloak init hooks) are finished work,
    # not long-running workloads — exclude them so they don't inflate the total
    # and make readiness unreachable.
    total=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null \
      | awk "${exclude_awk}"'$3!="Terminating" && $3!="Completed" && $3!="Succeeded" {print}' | wc -l | tr -d ' ')
    ready=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null \
      | awk "${exclude_awk}"'$3=="Running" && $2~"^[0-9]+/[0-9]+$" {split($2,a,"/"); if(a[1]==a[2]) print}' \
      | wc -l | tr -d ' ')
    if [[ "$total" -gt 0 && "$total" -eq "$ready" ]]; then
      _wfp_clear_table
      log "All $total pods in ${ns} are running"
      return 0
    fi
    # Settled? Every not-ready pod is CrashLoopBackOff/Error (nothing converging).
    stuck=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null \
      | awk "${exclude_awk}"'$3=="CrashLoopBackOff" || $3=="Error" {print}' | wc -l | tr -d ' ')
    transient=$(( total - ready - stuck ))
    if [[ "$total" -gt 0 && $elapsed -ge $settle_grace && "$transient" -le 0 && "$stuck" -gt 0 ]]; then
      _wfp_clear_table
      warn "${ready}/${total} pods ready in ${ns}; ${stuck} stuck (CrashLoopBackOff/Error) — continuing"
      warn "Stuck pods usually lack agent credentials; the core platform is up. Add creds via --env-file to enable them."
      return 0
    fi

    if [[ $elapsed -ge $next_show ]]; then
      # Move cursor up to overwrite previous table
      if [[ $prev_lines -gt 0 ]]; then
        printf '\033[%dA' "$prev_lines"
      fi

      local -a table_lines=()
      table_lines+=("$(printf "${DIM}  Waiting for pods in %-10s  %d/%d ready  (%ds)${NC}" "$ns" "$ready" "$total" "$elapsed")")
      table_lines+=("$(printf "  ${DIM}── Pod status in ${ns} ──${NC}")")
      while IFS= read -r line; do
        table_lines+=("$line")
      done < <(kubectl get pods -n "$ns" --no-headers 2>/dev/null \
        | awk -v g="${GREEN}" -v r="${RED}" -v y="${YELLOW}" -v nc="${NC}" \
          '{
            status=$3; name=$1; ready=$2
            if (status=="Running" && ready~"^[0-9]+/[0-9]+$") {
              split(ready,a,"/"); if(a[1]==a[2]) c=g; else c=y
            } else if (status=="Error" || status=="CrashLoopBackOff" || status=="Terminating") c=r
            else c=y
            printf "    %s%-44s %-6s %s%s\n", c, name, ready, status, nc
          }')
      table_lines+=("")

      for tl in "${table_lines[@]}"; do
        printf '\033[K%s\n' "$tl"
      done

      prev_lines=${#table_lines[@]}
      next_show=$((elapsed + show_interval))
    else
      printf "\r\033[K${DIM}  Waiting for pods in %-10s  %d/%d ready  (%ds)${NC}" "$ns" "$ready" "$total" "$elapsed"
    fi

    # Periodically check unhealthy pod logs for actionable errors
    if [[ $elapsed -ge $log_check_after && $elapsed -ge $next_log_check ]]; then
      next_log_check=$((elapsed + log_check_interval))

      # All non-ready pods (crashed, errored, or running with partial readiness)
      local unhealthy_pods
      unhealthy_pods=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null \
        | awk '$3=="CrashLoopBackOff" || $3=="Error" {print $1}
               $3=="Running" && $2~"^[0-9]+/[0-9]+$" {split($2,a,"/"); if(a[1]<a[2]) print $1}')

      for pod in $unhealthy_pods; do
        local pod_logs
        pod_logs=$(kubectl logs "$pod" -n "$ns" --all-containers --tail=200 2>/dev/null || true)
        [[ -z "$pod_logs" ]] && continue

        # SSL certificate errors → offer corporate CA
        if ! $INJECT_CORPORATE_CA && ! $CA_SSL_FIX_PROMPTED \
           && echo "$pod_logs" | grep -q "CERTIFICATE_VERIFY_FAILED\|SSLCertVerificationError"; then
          _wfp_clear_table
          _auto_heal_offer_corporate_ca "$pod (in ${ns})"
          if $INJECT_CORPORATE_CA; then
            log "[auto-heal] Corporate CA patched; pods will restart"
            sleep 5
          fi
          break
        fi
      done
    fi

    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  _wfp_clear_table
  echo ""
  err "Timeout waiting for pods in ${ns} after ${timeout}s"
  kubectl get pods -n "$ns"
  return 1
}

kill_port_on() {
  local port="$1"
  local pid
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
}

# ─── Interactive Setup ───────────────────────────────────────────────────────
_install_kubectl_linux() {
  log "Installing kubectl..."
  local ver
  ver=$(curl -sL https://dl.k8s.io/release/stable.txt)
  curl -sLo /tmp/kubectl "https://dl.k8s.io/release/${ver}/bin/linux/amd64/kubectl"
  chmod +x /tmp/kubectl
  sudo mv /tmp/kubectl /usr/local/bin/kubectl || mv /tmp/kubectl "$HOME/.local/bin/kubectl"
  log "kubectl ${ver} installed"
}

_install_helm_linux() {
  log "Installing helm..."
  curl -sfL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash &>/dev/null
  log "helm installed"
}

_install_openssl_linux() {
  log "Installing openssl..."
  local os_id
  os_id=$(. /etc/os-release && echo "$ID")
  case "$os_id" in
    ubuntu|debian)
      sudo apt-get update -qq
      sudo apt-get install -y openssl &>/dev/null ;;
    fedora|rhel|centos|rocky|almalinux)
      sudo dnf install -y openssl &>/dev/null ;;
    *)
      err "Cannot auto-install openssl on distro '${os_id}' — install it manually and re-run"
      exit 1 ;;
  esac
  log "openssl installed"
}

_install_curl_linux() {
  log "Installing curl..."
  local os_id
  os_id=$(. /etc/os-release && echo "$ID")
  case "$os_id" in
    ubuntu|debian)
      sudo apt-get update -qq
      sudo apt-get install -y curl &>/dev/null ;;
    fedora|rhel|centos|rocky|almalinux)
      sudo dnf install -y curl &>/dev/null ;;
    *)
      err "Cannot auto-install curl on distro '${os_id}' — install it manually and re-run"
      exit 1 ;;
  esac
  log "curl installed"
}

_install_jq_linux() {
  log "Installing jq..."
  local os_id
  os_id=$(. /etc/os-release && echo "$ID")
  case "$os_id" in
    ubuntu|debian)
      sudo apt-get update -qq
      sudo apt-get install -y jq &>/dev/null
      ;;
    fedora|rhel|centos|rocky|almalinux)
      sudo dnf install -y jq &>/dev/null
      ;;
    *)
      local ver
      ver=$(curl -sL https://api.github.com/repos/jqlang/jq/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4)
      curl -sLo /tmp/jq "https://github.com/jqlang/jq/releases/download/${ver}/jq-linux-amd64"
      chmod +x /tmp/jq
      sudo mv /tmp/jq /usr/local/bin/jq || mv /tmp/jq "$HOME/.local/bin/jq"
      ;;
  esac
  log "jq installed"
}

_install_kind_linux() {
  log "Installing kind..."
  local ver
  ver=$(curl -sL https://api.github.com/repos/kubernetes-sigs/kind/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4)
  curl -sLo /tmp/kind "https://kind.sigs.k8s.io/dl/${ver}/kind-linux-amd64"
  chmod +x /tmp/kind
  sudo mv /tmp/kind /usr/local/bin/kind || mv /tmp/kind "$HOME/.local/bin/kind"
  log "kind ${ver} installed"
}

_install_kind_macos() {
  log "Installing kind..."
  if command -v brew &>/dev/null; then
    brew install kind
  else
    local ver
    ver=$(curl -sL https://api.github.com/repos/kubernetes-sigs/kind/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4)
    curl -sLo /tmp/kind "https://kind.sigs.k8s.io/dl/${ver}/kind-darwin-arm64"
    chmod +x /tmp/kind
    sudo mv /tmp/kind /usr/local/bin/kind || mv /tmp/kind "$HOME/.local/bin/kind"
    log "kind ${ver} installed"
  fi
}


_install_docker_linux() {
  log "Installing Docker..."
  local os_id
  os_id=$(. /etc/os-release && echo "$ID")
  case "$os_id" in
    ubuntu|debian)
      sudo apt-get update -qq
      sudo apt-get install -y ca-certificates curl gnupg &>/dev/null
      sudo install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/${os_id}/gpg" \
        | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      sudo chmod a+r /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${os_id} \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
      sudo apt-get update -qq
      sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin &>/dev/null
      sudo systemctl enable --now docker
      sudo usermod -aG docker "$USER"
      log "Docker installed — run 'newgrp docker' or re-login to use without sudo"
      ;;
    fedora|rhel|centos|rocky|almalinux)
      sudo dnf -y install dnf-plugins-core &>/dev/null
      sudo dnf config-manager --add-repo \
        https://download.docker.com/linux/fedora/docker-ce.repo &>/dev/null
      sudo dnf install -y docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin &>/dev/null
      sudo systemctl enable --now docker
      sudo usermod -aG docker "$USER"
      log "Docker installed — run 'newgrp docker' or re-login to use without sudo"
      ;;
    *)
      err "Unsupported Linux distro '${os_id}' for automatic Docker installation."
      err "Install Docker manually: https://docs.docker.com/engine/install/"
      exit 1
      ;;
  esac
}

_install_docker_macos() {
  log "Installing Docker..."
  # Docker.app already present but not started (e.g. after upgrade or first boot)
  if [[ -d "/Applications/Docker.app" ]]; then
    warn "Docker Desktop is installed but not running — start it, wait for the whale icon to appear, then re-run this script"
    open -a Docker 2>/dev/null || true
    exit 0
  fi
  if command -v brew &>/dev/null; then
    brew install --cask docker
    log "Docker Desktop installed — open the Docker app to complete setup, then re-run this script"
    exit 0
  else
    err "Homebrew not found. Install Docker Desktop manually: https://docs.docker.com/desktop/mac/install/"
    exit 1
  fi
}

_check_kubeconfig() {
  local cfg="$HOME/.kube/config"
  mkdir -p "$HOME/.kube"

  if [[ -L "$cfg" ]]; then
    local target
    target="$(readlink -f "$cfg" 2>/dev/null || readlink "$cfg")"
    warn "~/.kube/config is a symlink → ${target}"

    # Known EKS/kubelet placeholder paths that are not real cluster configs
    if [[ "$target" == *kubelet* || "$target" == *eks* || "$target" == /var/lib/* ]]; then
      warn "This looks like an EKS node kubelet config, not a user kubeconfig."
      warn "kind requires a writable ~/.kube/config and will fail otherwise."
      if ask_yn "Replace the symlink with a writable kubeconfig file?" "y"; then
        rm -f "$cfg"
        install -m 600 /dev/null "$cfg"
        log "~/.kube/config replaced with a writable file"
      else
        warn "Skipped — kind cluster creation may fail."
        warn "To fix manually: rm ~/.kube/config && install -m 600 /dev/null ~/.kube/config"
      fi
    else
      warn "Unexpected kubeconfig symlink. kind may fail to write cluster credentials."
      warn "To fix manually: rm ~/.kube/config && install -m 600 /dev/null ~/.kube/config"
    fi
  elif [[ -f "$cfg" && ! -w "$cfg" ]]; then
    warn "~/.kube/config exists but is not writable (owner: $(stat -c '%U' "$cfg" 2>/dev/null || stat -f '%Su' "$cfg"))"
    warn "To fix manually: sudo chown \$USER ~/.kube/config"
  fi
}

_check_docker_access() {
  # Docker binary present but socket not accessible without sudo
  if command -v docker &>/dev/null && ! docker info &>/dev/null 2>&1; then
    if sudo docker info &>/dev/null 2>&1; then
      warn "Docker is running but your user (${USER}) cannot reach the socket."
      if ! groups | grep -qw docker; then
        if ask_yn "Add ${USER} to the 'docker' group so kind can use Docker?" "y"; then
          sudo usermod -aG docker "$USER"
          warn "Done — open a new terminal (or run 'newgrp docker'), then re-run this script."
        else
          warn "Skipped — you can run the script with 'sudo' or add yourself manually:"
          warn "  sudo usermod -aG docker \$USER && newgrp docker"
        fi
      else
        warn "You are in the 'docker' group but this shell session predates the change."
        warn "Open a new terminal (or run 'newgrp docker'), then re-run this script."
      fi
      exit 0
    fi
  fi
}

check_prerequisites() {
  step "Checking prerequisites"

  # Kubeconfig sanity — must run before any kubectl calls
  _check_kubeconfig

  local missing=()
  for cmd in kubectl helm openssl curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    if [[ "$(uname -s)" == "Linux" ]]; then
      # Determine which missing tools need sudo vs can be installed as current user
      local needs_sudo=()
      local no_sudo=()
      for tool in "${missing[@]}"; do
        case "$tool" in
          kubectl|helm) no_sudo+=("$tool") ;;
          *)            needs_sudo+=("$tool") ;;
        esac
      done

      # If any tools need sudo, check whether sudo is usable and user consents
      if [[ ${#needs_sudo[@]} -gt 0 ]]; then
        local sudo_ok=false
        if sudo -n true 2>/dev/null; then
          sudo_ok=true
        elif ask_yn "Installing ${needs_sudo[*]} requires sudo. Allow this script to run sudo?" "y"; then
          sudo_ok=true
        fi

        if [[ "$sudo_ok" == false ]]; then
          warn "Cannot install ${needs_sudo[*]} without sudo."
          warn "Please run the following command(s) on your machine first, then re-run this script:"
          warn ""
          local os_id
          os_id=$(. /etc/os-release 2>/dev/null && echo "$ID" || echo "unknown")
          case "$os_id" in
            ubuntu|debian)
              warn "  sudo apt-get update && sudo apt-get install -y ${needs_sudo[*]}" ;;
            fedora|rhel|centos|rocky|almalinux)
              warn "  sudo dnf install -y ${needs_sudo[*]}" ;;
            *)
              warn "  Install: ${needs_sudo[*]}  (use your distro's package manager)"
              warn "  e.g. for jq: sudo apt-get install -y jq  OR  sudo dnf install -y jq" ;;
          esac
          warn ""
          warn "Then re-run:"
          warn "  bash <(curl -fsSL https://raw.githubusercontent.com/caipe-io/ai-platform-engineering/main/setup-caipe.sh)"
          exit 1
        fi
      fi

      log "Auto-installing missing tools on Linux: ${missing[*]}"
      mkdir -p "$HOME/.local/bin"
      export PATH="$HOME/.local/bin:$PATH"
      for tool in "${missing[@]}"; do
        case "$tool" in
          kubectl) _install_kubectl_linux ;;
          helm)    _install_helm_linux ;;
          jq)      _install_jq_linux ;;
          openssl) _install_openssl_linux ;;
          curl)    _install_curl_linux ;;
          *)
            err "Missing required tool '${tool}' — install it and re-run"
            exit 1
            ;;
        esac
      done
    else
      err "Missing required tools: ${missing[*]}"
      err "Install them and re-run this script."
      exit 1
    fi
  fi

  # Docker is required by kind — detect and auto-install before any cluster work
  # On macOS, Docker Desktop installs to /usr/local/bin/docker which may not be in PATH
  # when invoked via SSH or a minimal shell; add it if present.
  if [[ "$(uname -s)" == "Darwin" && -x "/usr/local/bin/docker" && ! "$(command -v docker 2>/dev/null)" ]]; then
    export PATH="/usr/local/bin:$PATH"
  fi
  if ! command -v docker &>/dev/null; then
    warn "Docker is not installed — it is required to run kind clusters."
    local os
    os="$(uname -s)"
    if [[ "$os" == "Linux" || "$os" == "Darwin" ]]; then
      if ask_yn "Install Docker now?" "y"; then
        step "Installing Docker"
        if [[ "$os" == "Linux" ]]; then
          _install_docker_linux
        else
          _install_docker_macos
        fi
      else
        err "Docker is required. Install it from https://docs.docker.com/engine/install/ and re-run."
        exit 1
      fi
    else
      err "Docker is required but not installed. Install it from https://docs.docker.com/engine/install/ and re-run."
      exit 1
    fi
  fi

  # Docker installed — verify the current user can reach the socket
  _check_docker_access

  if ! command -v kind &>/dev/null; then
    if [[ "$(uname -s)" == "Linux" ]]; then
      _install_kind_linux
    elif [[ "$(uname -s)" == "Darwin" ]]; then
      _install_kind_macos
    else
      warn "kind not found — install it manually: https://kind.sigs.k8s.io/docs/user/quick-start/"
    fi
  fi

  # k9s — optional but strongly recommended; auto-install if missing
  if ! command -v k9s &>/dev/null; then
    if [[ "$(uname -s)" == "Linux" ]]; then
      local _k9s_sudo_ok=false
      if sudo -n true 2>/dev/null; then
        _k9s_sudo_ok=true
      elif ask_yn "Installing k9s (Kubernetes TUI) requires sudo. Allow?" "y"; then
        _k9s_sudo_ok=true
      fi
      if [[ "$_k9s_sudo_ok" == true ]]; then
        log "Installing k9s (Kubernetes TUI)..."
        local _k9s_url
        _k9s_url=$(curl -s https://api.github.com/repos/derailed/k9s/releases/latest \
          | grep "browser_download_url" | grep "Linux_amd64.tar.gz" | head -1 | cut -d'"' -f4)
        if [[ -n "$_k9s_url" ]]; then
          curl -sL "$_k9s_url" | sudo tar xz -C /usr/local/bin k9s 2>/dev/null \
            && log "k9s installed: $(k9s version --short 2>/dev/null || true)" \
            || warn "k9s install failed — you can install it manually from https://k9scli.io"
        else
          warn "Could not fetch k9s release URL — skipping k9s install"
        fi
      else
        warn "Skipping k9s install — run manually: https://k9scli.io/topics/install/"
      fi
    elif [[ "$(uname -s)" == "Darwin" ]]; then
      if command -v brew &>/dev/null; then
        brew install derailed/k9s/k9s &>/dev/null && log "k9s installed via Homebrew" || true
      else
        warn "k9s not found — install it with: brew install derailed/k9s/k9s"
      fi
    fi
  fi

  log "Prerequisites checked (docker, kubectl, helm, kind, openssl, curl, jq, k9s)"
}

choose_cluster() {
  step "Kubernetes cluster"

  local current_ctx
  current_ctx=$(kubectl config current-context 2>/dev/null || echo "")

  if $NON_INTERACTIVE; then
    if [[ -z "$current_ctx" ]]; then
      if $CREATE_CLUSTER; then
        if ! command -v kind &>/dev/null; then
          err "kind is required with --create-cluster but not found"
          exit 1
        fi
        CLUSTER_NAME="${KIND_CLUSTER_NAME:-caipe}"
        log "No kubectl context — creating Kind cluster '${CLUSTER_NAME}'..."
        kind create cluster --name "$CLUSTER_NAME" </dev/null
        kubectl config use-context "kind-${CLUSTER_NAME}" 2>/dev/null || true
        log "Context set to kind-${CLUSTER_NAME}"
      else
        err "No current kubectl context. Pass --create-cluster to auto-create a Kind cluster."
        exit 1
      fi
    else
      CLUSTER_NAME="$current_ctx"
      log "Using current context '${current_ctx}'"
    fi
    if ! kubectl cluster-info &>/dev/null; then
      err "Cannot reach the Kubernetes cluster. Check your configuration."
      exit 1
    fi
    log "Cluster is reachable"
    return
  fi

  # Build the menu options
  local options=()
  local labels=()

  # Option: use current context
  if [[ -n "$current_ctx" ]]; then
    options+=("current")
    labels+=("Use current context: ${current_ctx}")
  fi

  # Options: existing Kind clusters
  local kind_clusters=()
  if command -v kind &>/dev/null; then
    while IFS= read -r c; do
      [[ -n "$c" ]] && kind_clusters+=("$c")
    done < <(kind get clusters 2>/dev/null)

    # bash 3.2 (macOS default) treats ${empty_array[@]} as unbound with set -u
    if [[ ${#kind_clusters[@]} -gt 0 ]]; then
      for c in "${kind_clusters[@]}"; do
        options+=("kind:${c}")
        if [[ "kind-${c}" == "$current_ctx" ]]; then
          labels+=("Kind cluster: ${c}  ${DIM}(current context)${NC}")
        else
          labels+=("Kind cluster: ${c}")
        fi
      done
    fi
  fi

  # Option: switch to another kubectl context
  options+=("context")
  labels+=("Use a different kubectl context")

  # Option: create a new Kind cluster (always available)
  options+=("kind:new")
  labels+=("Create a new Kind cluster")

  echo ""
  local i=1
  for label in "${labels[@]}"; do
    echo -e "    ${BOLD}${i})${NC} ${label}"
    i=$((i + 1))
  done
  echo ""

  local default_choice=1
  prompt "Select an option ${CYAN}[${default_choice}]${NC}${BOLD}: "
  tty_read -r choice
  choice="${choice:-$default_choice}"

  if [[ "$choice" -lt 1 || "$choice" -gt "${#options[@]}" ]]; then
    err "Invalid choice"
    exit 1
  fi

  local selected="${options[$((choice - 1))]}"

  case "$selected" in
    current)
      CLUSTER_NAME="$current_ctx"
      log "Using current context '${current_ctx}'"
      ;;
    kind:new)
      if ! command -v kind &>/dev/null; then
        step "Installing kind"
        if [[ "$(uname -s)" == "Linux" ]]; then
          _install_kind_linux
        elif [[ "$(uname -s)" == "Darwin" ]]; then
          _install_kind_macos
        else
          err "Unsupported OS for automatic kind installation. Install kind manually: https://kind.sigs.k8s.io/docs/user/quick-start/"
          exit 1
        fi
      fi
      prompt "Enter a name for the new cluster ${CYAN}[caipe]${NC}${BOLD}: "
      tty_read -r CLUSTER_NAME
      CLUSTER_NAME="${CLUSTER_NAME:-caipe}"
      log "Creating Kind cluster '${CLUSTER_NAME}'..."
      kind create cluster --name "$CLUSTER_NAME" </dev/null
      kubectl config use-context "kind-${CLUSTER_NAME}" 2>/dev/null || true
      log "Context set to kind-${CLUSTER_NAME}"
      ;;
    kind:*)
      CLUSTER_NAME="${selected#kind:}"
      if ! kubectl config use-context "kind-${CLUSTER_NAME}" 2>/dev/null; then
        warn "Context 'kind-${CLUSTER_NAME}' not found in kubeconfig — restoring via kind export kubeconfig..."
        if ! kind export kubeconfig --name "${CLUSTER_NAME}" 2>/dev/null; then
          err "Could not restore kubeconfig for kind cluster '${CLUSTER_NAME}'."
          err "The cluster container may be stopped. Try: docker start $(docker ps -aqf name=kind)"
          exit 1
        fi
        kubectl config use-context "kind-${CLUSTER_NAME}" 2>/dev/null || true
      fi
      log "Context set to kind-${CLUSTER_NAME}"
      ;;
    context)
      echo ""
      echo -e "  ${DIM}Available kubectl contexts:${NC}"
      local ctx_arr=()
      while IFS= read -r ctx; do
        [[ -n "$ctx" ]] && ctx_arr+=("$ctx")
      done < <(kubectl config get-contexts -o name 2>/dev/null)

      local j=1
      if [[ ${#ctx_arr[@]} -gt 0 ]]; then
        for ctx in "${ctx_arr[@]}"; do
          if [[ "$ctx" == "$current_ctx" ]]; then
            echo -e "    ${BOLD}${j})${NC} ${ctx}  ${DIM}(current)${NC}"
          else
            echo -e "    ${BOLD}${j})${NC} ${ctx}"
          fi
          j=$((j + 1))
        done
      fi
      echo ""
      prompt "Select a context ${CYAN}[1]${NC}${BOLD}: "
      tty_read -r ctx_choice
      ctx_choice="${ctx_choice:-1}"
      if [[ "$ctx_choice" -ge 1 && "$ctx_choice" -le "${#ctx_arr[@]}" ]]; then
        local target_ctx="${ctx_arr[$((ctx_choice - 1))]}"
        if ! kubectl config use-context "$target_ctx" 2>/dev/null; then
          err "Could not switch to context '${target_ctx}'."
          err "Run 'kubectl config get-contexts' to verify available contexts."
          exit 1
        fi
        CLUSTER_NAME="$target_ctx"
        log "Switched to context '${target_ctx}'"
      else
        err "Invalid choice"
        exit 1
      fi
      ;;
  esac

  # Verify cluster is reachable
  if ! kubectl cluster-info &>/dev/null; then
    err "Cannot reach the Kubernetes cluster. Check your configuration."
    exit 1
  fi
  log "Cluster is reachable"
}

choose_chart_version() {
  step "CAIPE Helm chart version"

  if [[ -n "$CAIPE_CHART_VERSION" ]]; then
    log "Using version from environment: ${CAIPE_CHART_VERSION}"
    return
  fi

  if $NON_INTERACTIVE; then
    local latest
    latest=$(helm show chart "$CAIPE_OCI_REPO" 2>/dev/null | grep '^version:' | awk '{print $2}' || true)
    CAIPE_CHART_VERSION="${latest:-0.2.31}"
    log "Using latest version: ${CAIPE_CHART_VERSION}"
    return
  fi

  echo -e "  ${DIM}Fetching available versions from OCI registry...${NC}"
  local versions_raw
  versions_raw=$(helm show chart "$CAIPE_OCI_REPO" 2>/dev/null | grep '^version:' | awk '{print $2}' || true)

  # Try to list tags via skopeo or crane if available, otherwise fall back
  local versions=()
  if command -v crane &>/dev/null; then
    while IFS= read -r v; do
      [[ -n "$v" ]] && versions+=("$v")
    done < <(crane ls ghcr.io/cnoe-io/charts/ai-platform-engineering 2>/dev/null | sort -Vr | head -10)
  fi

  if [[ ${#versions[@]} -eq 0 && -n "$versions_raw" ]]; then
    versions+=("$versions_raw")
  fi

  if [[ ${#versions[@]} -eq 0 ]]; then
    versions+=("0.2.31")
    warn "Could not fetch version list; using known default"
  fi

  if [[ ${#versions[@]} -eq 1 ]]; then
    echo -e "  ${DIM}Latest version: ${versions[0]}${NC}"
    prompt "Chart version ${CYAN}[${versions[0]}]${NC} (or 'b' to go back)${BOLD}: "
    tty_read -r input
    if _is_back "$input"; then return 1; fi
    CAIPE_CHART_VERSION="${input:-${versions[0]}}"
  else
    echo -e "  ${DIM}Available versions (most recent first):${NC}"
    echo -e "    ${BOLD}0)${NC} ${DIM}← Back to previous step${NC}"
    local i=1
    for v in "${versions[@]}"; do
      if [[ $i -eq 1 ]]; then
        echo -e "    ${BOLD}${i})${NC} $v  ${DIM}(latest)${NC}"
      else
        echo -e "    ${BOLD}${i})${NC} $v"
      fi
      i=$((i + 1))
    done
    echo -e "    ${BOLD}${i})${NC} Enter a custom version"

    prompt "Select a version ${CYAN}[1]${NC}${BOLD}: "
    tty_read -r choice
    choice="${choice:-1}"
    if _is_back "$choice"; then return 1; fi

    if [[ "$choice" -eq "$i" ]]; then
      prompt "Enter chart version: "
      tty_read -r CAIPE_CHART_VERSION
      if [[ -z "$CAIPE_CHART_VERSION" ]]; then
        err "Version is required"
        exit 1
      fi
    elif [[ "$choice" -ge 1 && "$choice" -lt "$i" ]]; then
      CAIPE_CHART_VERSION="${versions[$((choice - 1))]}"
    else
      err "Invalid choice"
      exit 1
    fi
  fi

  log "Using chart version ${CAIPE_CHART_VERSION}"
}

collect_credentials() {
  step "LLM credentials"

  # If detect_deployed_features wasn't called first (e.g. fresh wizard run after
  # a partial install), try to read directly from the cluster secret now.
  if ! $NON_INTERACTIVE && [[ -z "${LLM_PROVIDER:-}" ]]; then
    local _raw
    _raw=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
    if [[ -n "$_raw" ]]; then
      local _sv; _sv() { echo "$_raw" | jq -r --arg k "$1" '.data[$k] // empty' 2>/dev/null | base64 -d 2>/dev/null || true; }
      LLM_PROVIDER=$(_sv LLM_PROVIDER)
      case "${LLM_PROVIDER:-}" in
        anthropic-claude)
          [[ -z "${ANTHROPIC_API_KEY:-}" ]]   && ANTHROPIC_API_KEY=$(_sv ANTHROPIC_API_KEY)
          [[ -z "${ANTHROPIC_MODEL_NAME:-}" ]] && ANTHROPIC_MODEL_NAME=$(_sv ANTHROPIC_MODEL_NAME)
          ;;
        aws-bedrock)
          [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]     && AWS_ACCESS_KEY_ID=$(_sv AWS_ACCESS_KEY_ID)
          [[ -z "${AWS_SECRET_ACCESS_KEY:-}" ]] && AWS_SECRET_ACCESS_KEY=$(_sv AWS_SECRET_ACCESS_KEY)
          [[ -z "${AWS_REGION:-}" ]]            && AWS_REGION=$(_sv AWS_REGION)
          [[ -z "${AWS_BEDROCK_MODEL_ID:-}" ]]  && AWS_BEDROCK_MODEL_ID=$(_sv AWS_BEDROCK_MODEL_ID)
          [[ -z "${AWS_BEDROCK_PROVIDER:-}" ]]  && AWS_BEDROCK_PROVIDER=$(_sv AWS_BEDROCK_PROVIDER)
          ;;
        *)
          [[ -z "${OPENAI_API_KEY:-}" ]]   && OPENAI_API_KEY=$(_sv OPENAI_API_KEY)
          [[ -z "${OPENAI_ENDPOINT:-}" ]]  && OPENAI_ENDPOINT=$(_sv OPENAI_ENDPOINT)
          [[ -z "${OPENAI_MODEL_NAME:-}" ]] && OPENAI_MODEL_NAME=$(_sv OPENAI_MODEL_NAME)
          ;;
      esac
      [[ -n "${LLM_PROVIDER:-}" ]] && log "Loaded LLM config from existing cluster secret (provider: ${LLM_PROVIDER})"
    fi
  fi

  # If the provider is already known from the cluster (env, detect_deployed_features,
  # or the inline read above) AND the llm-secret exists, offer to keep it.
  # We don't require the API key to be in shell variables — the secret already has it.
  if [[ -n "${LLM_PROVIDER:-}" ]] && ! $NON_INTERACTIVE; then
    if kubectl get secret llm-secret -n caipe &>/dev/null 2>&1; then
      log "Existing llm-secret found in cluster (provider: ${LLM_PROVIDER})"
      if ! ask_yn "Keep existing LLM provider (${LLM_PROVIDER})?" "y"; then
        LLM_PROVIDER=""  # fall through to full prompt
      else
        return 0
      fi
    fi
  fi

  # ── Provider selection loop — user can go back to re-pick provider ────
  while true; do
    # Reset provider-specific flags on each loop so a back→re-select is clean
    if ! $NON_INTERACTIVE; then
      ENABLE_VLLM=false
      ENABLE_OLLAMA=false

      echo ""
      echo -e "  ${DIM}Select your LLM provider (powered by cnoe-agent-utils LLMFactory):${NC}"
      echo -e "    ${BOLD}0)${NC} ${DIM}← Back to previous step${NC}"
      echo -e "    ${BOLD}1)${NC} Ollama            ${DIM}(in-cluster: qwen3:0.6b, qwen2.5:1.5b, lfm2.5, arcee-ai/arcee-agent, etc.) — default${NC}"
      echo -e "    ${BOLD}2)${NC} Anthropic Claude  ${DIM}(claude-haiku-4-5, claude-sonnet-4, etc.)${NC}"
      echo -e "    ${BOLD}3)${NC} AWS Bedrock       ${DIM}(Claude on Bedrock, cross-region inference)${NC}"
      echo -e "    ${BOLD}4)${NC} OpenAI            ${DIM}(gpt-5.2, gpt-4.1, etc.)${NC}"
      echo -e "    ${BOLD}5)${NC} LiteLLM Proxy     ${DIM}(gpt-oss-20B or any OpenAI-compatible endpoint)${NC}"
      echo ""
      prompt "Select provider ${CYAN}[1]${NC}${BOLD}: "
      tty_read -r provider_choice
      provider_choice="${provider_choice:-1}"
      if _is_back "$provider_choice"; then return 1; fi
      case "$provider_choice" in
        1) ENABLE_OLLAMA=true; LLM_PROVIDER="openai" ;;
        2) LLM_PROVIDER="anthropic-claude" ;;
        3) LLM_PROVIDER="aws-bedrock" ;;
        4) LLM_PROVIDER="openai" ;;
        5) ENABLE_VLLM=true; LLM_PROVIDER="openai" ;;
        *) err "Invalid choice"; continue ;;
      esac
    fi

    # If ENABLE_VLLM was set via env or option 4, collect vLLM-specific config
    if $ENABLE_VLLM; then
      LLM_PROVIDER="openai"
      _collect_vllm_credentials || continue
    fi

    # If ENABLE_OLLAMA was set via env or option 5, ensure Ollama is installed
    if $ENABLE_OLLAMA; then
      LLM_PROVIDER="openai"
      _collect_ollama_config || continue
    fi

    # Non-interactive: apply default if still unset (env var not provided, no cluster secret)
    if $NON_INTERACTIVE && [[ -z "${LLM_PROVIDER:-}" ]]; then
      LLM_PROVIDER="anthropic-claude"
      log "LLM_PROVIDER not set — defaulting to anthropic-claude"
    fi

    # ── Collect credentials per provider — return 1 loops back to provider menu
    local _cred_status=0
    case "$LLM_PROVIDER" in
      anthropic-claude) _collect_anthropic_credentials    || _cred_status=$? ;;
      aws-bedrock)      _collect_bedrock_credentials      || _cred_status=$? ;;
      azure-openai)     _collect_azure_openai_credentials || _cred_status=$? ;;
      *)
        # Ollama and vLLM set their own endpoint and credentials before reaching
        # here — prompting again would be redundant and misleading.
        if ! $ENABLE_OLLAMA && ! $ENABLE_VLLM; then
          _collect_openai_credentials || _cred_status=$?
        fi
        ;;
    esac

    [[ $_cred_status -eq 0 ]] && break
    # _cred_status=1 means user typed 'b' — re-show provider menu
    warn "Going back to provider selection..."
  done
}

_collect_anthropic_credentials() {
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    log "Using ANTHROPIC_API_KEY from environment"
  elif [[ -f "${HOME}/.config/claude.txt" ]]; then
    ANTHROPIC_API_KEY=$(tr -d '[:space:]' < "${HOME}/.config/claude.txt")
    log "Using ANTHROPIC_API_KEY from ~/.config/claude.txt"
  else
    if $NON_INTERACTIVE; then
      err "Anthropic API key is required (set ANTHROPIC_API_KEY or create ~/.config/claude.txt)"
      exit 1
    fi
    prompt "Enter your Anthropic API key (or 'b' to go back): "
    tty_read -rs ANTHROPIC_API_KEY
    echo ""
    if _is_back "$ANTHROPIC_API_KEY"; then ANTHROPIC_API_KEY=""; return 1; fi
    if [[ -z "$ANTHROPIC_API_KEY" ]]; then
      err "API key is required"
      exit 1
    fi
    log "API key received"
  fi

  if ! $NON_INTERACTIVE; then
    echo ""
    echo -e "  ${DIM}Anthropic model:${NC}"
    echo -e "    ${BOLD}0)${NC} ${DIM}← Back to provider selection${NC}"
    echo -e "    ${BOLD}1)${NC} claude-haiku-4-5     ${DIM}(fast, low cost — default)${NC}"
    echo -e "    ${BOLD}2)${NC} claude-sonnet-4-20250514    ${DIM}(balanced)${NC}"
    echo -e "    ${BOLD}3)${NC} claude-opus-4-20250514      ${DIM}(most capable)${NC}"
    echo -e "    ${BOLD}4)${NC} Custom"
    echo ""
    prompt "Select model ${CYAN}[1]${NC}${BOLD}: "
    tty_read -r model_choice
    model_choice="${model_choice:-1}"
    if _is_back "$model_choice"; then ANTHROPIC_API_KEY=""; return 1; fi
    case "$model_choice" in
      1) ANTHROPIC_MODEL_NAME="claude-haiku-4-5-20251001" ;;
      2) ANTHROPIC_MODEL_NAME="claude-sonnet-4-20250514" ;;
      3) ANTHROPIC_MODEL_NAME="claude-opus-4-20250514" ;;
      4)
        prompt "Enter Anthropic model name: "
        tty_read -r ANTHROPIC_MODEL_NAME
        if [[ -z "$ANTHROPIC_MODEL_NAME" ]]; then
          err "Model name is required"
          exit 1
        fi
        ;;
      *) err "Invalid choice"; exit 1 ;;
    esac
  fi
  log "Provider: ${LLM_PROVIDER}  Model: ${ANTHROPIC_MODEL_NAME}"
}

_resolve_aws_keys_from_profile() {
  # Extract access keys from ~/.aws/credentials for a given profile.
  # In-cluster pods can't use profiles, so we resolve to actual keys.
  local profile="${1:-default}"
  local creds_file="${HOME}/.aws/credentials"

  if [[ ! -f "$creds_file" ]]; then
    return 1
  fi

  local in_profile=false
  while IFS= read -r line; do
    line="${line%%#*}"        # strip comments
    line="${line// /}"        # strip spaces
    [[ -z "$line" ]] && continue

    if [[ "$line" =~ ^\[(.+)\]$ ]]; then
      [[ "${BASH_REMATCH[1]}" == "$profile" ]] && in_profile=true || in_profile=false
      continue
    fi
    if $in_profile; then
      case "$line" in
        aws_access_key_id=*)     AWS_ACCESS_KEY_ID="${line#*=}" ;;
        aws_secret_access_key=*) AWS_SECRET_ACCESS_KEY="${line#*=}" ;;
      esac
    fi
  done < "$creds_file"

  [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]
}

_parse_bedrock_txt() {
  # Parse ~/.config/bedrock.txt which can be in three formats:
  #
  #   Format A — .env style (KEY=VALUE per line):
  #     AWS_ACCESS_KEY_ID=AKIA...
  #     AWS_SECRET_ACCESS_KEY=...
  #     AWS_REGION=us-east-2
  #     AWS_BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0
  #
  #   Format B — key:secret pair (single line):
  #     AKIAEXAMPLE:wJalrXUtnFEMI/K7MDENG
  #
  #   Format C — profile name (single line):
  #     my-profile-name

  local file="$1"
  local line_count key_found=false

  line_count=$(grep -cve '^\s*$' "$file" 2>/dev/null || echo 0)

  # Multi-line or contains '=' → .env format
  if [[ "$line_count" -gt 1 ]] || grep -q '=' "$file" 2>/dev/null; then
    log "Parsing ~/.config/bedrock.txt (.env format)"
    while IFS= read -r line; do
      line="${line%%#*}"                     # strip inline comments
      [[ -z "${line// /}" ]] && continue     # skip blank lines
      [[ "$line" != *=* ]] && continue       # skip non-assignment lines

      local k="${line%%=*}"
      local v="${line#*=}"
      v="${v%\"}"; v="${v#\"}"               # strip surrounding quotes

      case "$k" in
        AWS_ACCESS_KEY_ID)       AWS_ACCESS_KEY_ID="$v";       key_found=true ;;
        AWS_SECRET_ACCESS_KEY)   AWS_SECRET_ACCESS_KEY="$v"    ;;
        AWS_REGION)              AWS_REGION="$v"               ;;
        AWS_DEFAULT_REGION)      [[ -z "${AWS_REGION:-}" || "$AWS_REGION" == "us-east-2" ]] && AWS_REGION="$v" ;;
        AWS_BEDROCK_MODEL_ID)    AWS_BEDROCK_MODEL_ID="${v}"   ;;
        AWS_BEDROCK_PROVIDER)    AWS_BEDROCK_PROVIDER="$v"     ;;
        AWS_BEDROCK_ENABLE_PROMPT_CACHE) AWS_BEDROCK_ENABLE_PROMPT_CACHE="$v" ;;
        LLM_PROVIDER)            LLM_PROVIDER="$v"            ;;
      esac
    done < "$file"

    if [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
      log "Using AWS access keys from ~/.config/bedrock.txt"
    else
      err "~/.config/bedrock.txt is missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY"
      exit 1
    fi
    return
  fi

  # Single line — key:secret or profile name
  local bedrock_val
  bedrock_val=$(tr -d '[:space:]' < "$file")

  if [[ "$bedrock_val" == *:* ]]; then
    AWS_ACCESS_KEY_ID="${bedrock_val%%:*}"
    AWS_SECRET_ACCESS_KEY="${bedrock_val#*:}"
    log "Using AWS access keys from ~/.config/bedrock.txt"
  else
    log "Resolving AWS profile '${bedrock_val}' from ~/.config/bedrock.txt"
    if _resolve_aws_keys_from_profile "$bedrock_val"; then
      log "Resolved access keys from profile '${bedrock_val}'"
    else
      err "Could not resolve AWS keys from profile '${bedrock_val}' in ~/.aws/credentials"
      exit 1
    fi
  fi
}

_collect_bedrock_credentials() {
  # AWS Bedrock needs access keys in the K8s secret (pods can't use local
  # profiles). We resolve keys from multiple sources in priority order:
  #
  #   1. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars
  #   2. ~/.config/bedrock.txt  — .env format, key:secret pair, or profile name
  #   3. AWS_PROFILE env → resolve keys from ~/.aws/credentials
  #   4. Default profile in ~/.aws/credentials
  #   5. Interactive prompt

  if [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    log "Using AWS access keys from environment"

  elif [[ -f "${HOME}/.config/bedrock.txt" ]]; then
    _parse_bedrock_txt "${HOME}/.config/bedrock.txt"

  elif [[ -n "${AWS_PROFILE:-}" ]]; then
    log "Resolving AWS_PROFILE=${AWS_PROFILE} from ~/.aws/credentials"
    if _resolve_aws_keys_from_profile "$AWS_PROFILE"; then
      log "Resolved access keys from profile '${AWS_PROFILE}'"
    else
      err "Could not resolve AWS keys from profile '${AWS_PROFILE}'"
      exit 1
    fi

  elif _resolve_aws_keys_from_profile "default"; then
    log "Using default AWS credentials from ~/.aws/credentials"

  else
    if $NON_INTERACTIVE; then
      err "AWS credentials required. Options:"
      err "  - Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY env vars"
      err "  - Create ~/.config/bedrock.txt with ACCESS_KEY:SECRET_KEY"
      err "  - Create ~/.config/bedrock.txt with a profile name"
      err "  - Set AWS_PROFILE env var (requires ~/.aws/credentials)"
      err "  - Ensure a [default] profile exists in ~/.aws/credentials"
      exit 1
    fi

    echo ""
    echo -e "  ${DIM}AWS Bedrock authentication (keys will be stored in the K8s secret):${NC}"
    echo -e "    ${BOLD}0)${NC} ${DIM}← Back to provider selection${NC}"
    echo -e "    ${BOLD}1)${NC} Enter access key + secret key directly"
    echo -e "    ${BOLD}2)${NC} Read from an AWS profile ${DIM}(~/.aws/credentials)${NC}"
    echo ""
    prompt "Select auth method ${CYAN}[1]${NC}${BOLD}: "
    tty_read -r auth_choice
    auth_choice="${auth_choice:-1}"
    if _is_back "$auth_choice"; then return 1; fi
    case "$auth_choice" in
      1)
        prompt "AWS Access Key ID (or 'b' to go back): "
        tty_read -r AWS_ACCESS_KEY_ID
        if _is_back "$AWS_ACCESS_KEY_ID"; then AWS_ACCESS_KEY_ID=""; return 1; fi
        prompt "AWS Secret Access Key: "
        tty_read -rs AWS_SECRET_ACCESS_KEY
        echo ""
        if [[ -z "$AWS_ACCESS_KEY_ID" || -z "$AWS_SECRET_ACCESS_KEY" ]]; then
          err "Both access key and secret key are required"
          exit 1
        fi
        log "AWS access keys received"
        ;;
      2)
        prompt "AWS profile name ${CYAN}[default]${NC}${BOLD}: "
        tty_read -r input
        if _is_back "$input"; then return 1; fi
        local prof="${input:-default}"
        if _resolve_aws_keys_from_profile "$prof"; then
          log "Resolved access keys from profile '${prof}'"
        else
          err "Could not resolve AWS keys from profile '${prof}' in ~/.aws/credentials"
          exit 1
        fi
        ;;
      *) err "Invalid choice"; exit 1 ;;
    esac
  fi

  if ! $NON_INTERACTIVE; then
    prompt "AWS region ${CYAN}[${AWS_REGION}]${NC}${BOLD}: "
    tty_read -r input
    if _is_back "$input"; then AWS_ACCESS_KEY_ID=""; AWS_SECRET_ACCESS_KEY=""; return 1; fi
    AWS_REGION="${input:-$AWS_REGION}"

    echo ""
    echo -e "  ${DIM}Bedrock model:${NC}"
    echo -e "    ${BOLD}0)${NC} ${DIM}← Back to provider selection${NC}"
    echo -e "    ${BOLD}1)${NC} global.anthropic.claude-haiku-4-5-20251001-v1:0 ${DIM}(default, fast, low cost)${NC}"
    echo -e "    ${BOLD}2)${NC} global.anthropic.claude-sonnet-4-6           ${DIM}(balanced)${NC}"
    echo -e "    ${BOLD}3)${NC} global.anthropic.claude-3-5-sonnet"
    echo -e "    ${BOLD}4)${NC} Custom"
    echo ""
    prompt "Select model ${CYAN}[1]${NC}${BOLD}: "
    tty_read -r model_choice
    model_choice="${model_choice:-1}"
    if _is_back "$model_choice"; then AWS_ACCESS_KEY_ID=""; AWS_SECRET_ACCESS_KEY=""; return 1; fi
    case "$model_choice" in
      1) AWS_BEDROCK_MODEL_ID="global.anthropic.claude-haiku-4-5-20251001-v1:0" ;;
      2) AWS_BEDROCK_MODEL_ID="global.anthropic.claude-sonnet-4-6" ;;
      3) AWS_BEDROCK_MODEL_ID="global.anthropic.claude-3-5-sonnet" ;;
      4)
        prompt "Enter Bedrock model ID: "
        tty_read -r AWS_BEDROCK_MODEL_ID
        if [[ -z "$AWS_BEDROCK_MODEL_ID" ]]; then
          err "Model ID is required"
          exit 1
        fi
        ;;
      *) err "Invalid choice"; exit 1 ;;
    esac

    prompt "Bedrock provider ${CYAN}[${AWS_BEDROCK_PROVIDER}]${NC}${BOLD}: "
    tty_read -r input
    AWS_BEDROCK_PROVIDER="${input:-$AWS_BEDROCK_PROVIDER}"
  fi
  log "Provider: ${LLM_PROVIDER}  Region: ${AWS_REGION}  Model: ${AWS_BEDROCK_MODEL_ID}"
}

_collect_openai_credentials() {
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    log "Using OPENAI_API_KEY from environment"
  elif [[ -f "${HOME}/.config/openai.txt" ]]; then
    OPENAI_API_KEY=$(tr -d '[:space:]' < "${HOME}/.config/openai.txt")
    log "Using OPENAI_API_KEY from ~/.config/openai.txt"
  else
    if $NON_INTERACTIVE; then
      err "API key is required (set OPENAI_API_KEY or create ~/.config/openai.txt)"
      exit 1
    fi
    prompt "Enter your OpenAI API key (or 'b' to go back): "
    tty_read -rs OPENAI_API_KEY
    echo ""
    if _is_back "$OPENAI_API_KEY"; then OPENAI_API_KEY=""; return 1; fi
    if [[ -z "$OPENAI_API_KEY" ]]; then
      err "API key is required"
      exit 1
    fi
    log "API key received"
  fi

  if ! $NON_INTERACTIVE; then
    prompt "OpenAI endpoint ${CYAN}[${OPENAI_ENDPOINT}]${NC}${BOLD}: "
    tty_read -r input
    if _is_back "$input"; then OPENAI_API_KEY=""; return 1; fi
    OPENAI_ENDPOINT="${input:-$OPENAI_ENDPOINT}"

    prompt "Model name ${CYAN}[${OPENAI_MODEL_NAME}]${NC}${BOLD}: "
    tty_read -r input
    OPENAI_MODEL_NAME="${input:-$OPENAI_MODEL_NAME}"
  fi
  log "Provider: ${LLM_PROVIDER}  Endpoint: ${OPENAI_ENDPOINT}  Model: ${OPENAI_MODEL_NAME}"
}

_collect_azure_openai_credentials() {
  local missing=()
  [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]    && missing+=(AZURE_OPENAI_API_KEY)
  [[ -z "${AZURE_OPENAI_ENDPOINT:-}" ]]   && missing+=(AZURE_OPENAI_ENDPOINT)
  [[ -z "${AZURE_OPENAI_DEPLOYMENT:-}" ]] && missing+=(AZURE_OPENAI_DEPLOYMENT)
  [[ -z "${AZURE_OPENAI_API_VERSION:-}" ]] && missing+=(AZURE_OPENAI_API_VERSION)
  if [[ ${#missing[@]} -gt 0 ]]; then
    if $NON_INTERACTIVE; then
      err "Missing Azure OpenAI environment variable(s): ${missing[*]}"
      exit 1
    fi
    echo -e "  ${DIM}Enter 'b' at any prompt to go back to provider selection.${NC}"
    for var in "${missing[@]}"; do
      prompt "Enter ${var}: "
      tty_read -rs val
      echo ""
      if _is_back "$val"; then
        # clear any vars we already set in this loop
        unset AZURE_OPENAI_API_KEY AZURE_OPENAI_ENDPOINT AZURE_OPENAI_DEPLOYMENT AZURE_OPENAI_API_VERSION
        return 1
      fi
      [[ -z "$val" ]] && { err "${var} is required"; exit 1; }
      export "$var"="$val"
    done
  fi
  log "Provider: ${LLM_PROVIDER}  Endpoint: ${AZURE_OPENAI_ENDPOINT}  Deployment: ${AZURE_OPENAI_DEPLOYMENT}"
}

_collect_vllm_credentials() {
  # vLLM + LiteLLM: we deploy both in-cluster. vLLM serves the model,
  # LiteLLM proxies it as an OpenAI-compatible endpoint for CAIPE.
  # LLM_PROVIDER is already set to "openai" by the caller.

  # Collect HuggingFace token (needed by vLLM to download model weights)
  if [[ -n "${HF_TOKEN:-}" ]]; then
    log "Using HF_TOKEN from environment"
  elif [[ -f "${HOME}/.config/hf_token.txt" ]]; then
    HF_TOKEN=$(tr -d '[:space:]' < "${HOME}/.config/hf_token.txt")
    log "Using HF_TOKEN from ~/.config/hf_token.txt"
  elif [[ -f "${HOME}/.cache/huggingface/token" ]]; then
    HF_TOKEN=$(tr -d '[:space:]' < "${HOME}/.cache/huggingface/token")
    log "Using HF_TOKEN from ~/.cache/huggingface/token"
  else
    if $NON_INTERACTIVE; then
      warn "HF_TOKEN not set — vLLM may fail to download gated models"
    else
      echo ""
      echo -e "  ${DIM}vLLM needs a HuggingFace token to download model weights.${NC}"
      echo -e "  ${DIM}Get one at https://huggingface.co/settings/tokens${NC}"
      prompt "HuggingFace token ${DIM}(leave blank for public models)${NC}${BOLD}: "
      tty_read -rs HF_TOKEN
      echo ""
    fi
  fi

  if ! $NON_INTERACTIVE; then
    prompt "vLLM model ${CYAN}[${VLLM_MODEL}]${NC}${BOLD}: "
    tty_read -r input
    VLLM_MODEL="${input:-$VLLM_MODEL}"

    prompt "LiteLLM model name ${CYAN}[${LITELLM_MODEL_NAME}]${NC}${BOLD}: "
    tty_read -r input
    LITELLM_MODEL_NAME="${input:-$LITELLM_MODEL_NAME}"
  fi

  # Auto-configure in-cluster endpoints (deployed by deploy_vllm / deploy_litellm)
  LITELLM_ENDPOINT="http://litellm-proxy.caipe.svc.cluster.local:4000/v1"
  LITELLM_API_KEY="not-needed"

  # Pre-set OpenAI env vars so _collect_openai_credentials finds them
  OPENAI_ENDPOINT="${LITELLM_ENDPOINT}"
  OPENAI_API_KEY="${LITELLM_API_KEY}"
  OPENAI_MODEL_NAME="${LITELLM_MODEL_NAME}"

  EMBEDDINGS_PROVIDER="litellm"

  log "Provider: openai (via LiteLLM proxy)  Model: ${LITELLM_MODEL_NAME}"
  log "vLLM will serve ${VLLM_MODEL} in-cluster"
  log "Embeddings will also use LiteLLM proxy"
}

_collect_ollama_config() {
  if ! $NON_INTERACTIVE; then
    echo ""
    echo -e "  ${DIM}Tool-calling models (required for agents):${NC}"
    echo -e "  ${DIM}  qwen3:0.6b (default) · qwen3:1.7b · qwen2.5:1.5b · lfm2.5 · arcee-ai/arcee-agent${NC}"
    echo -e "  ${DIM}  qwen2.5:7b · qwen2.5:14b · mistral:7b · ministral3:3b · phi4-mini${NC}"
    echo -e "  ${DIM}  smollm2:1.7b · smollm2:360m · smollm2:135m  (ultra-compact, no tool support)${NC}"
    echo -e "  ${DIM}Other models (no tool support): gemma3, llama3.2${NC}"
    echo -e "  ${DIM}lfm2.5: https://ollama.com/library/lfm2.5${NC}"
    echo -e "  ${DIM}smollm2: https://ollama.com/library/smollm2${NC}"
    echo -e "  ${DIM}arcee-ai/arcee-agent: https://ollama.com/arcee-ai/arcee-agent${NC}"
    prompt "Ollama model to use ${CYAN}[${OLLAMA_MODEL}]${NC}${BOLD}: "
    tty_read -r input
    OLLAMA_MODEL="${input:-$OLLAMA_MODEL}"
  fi

  # Ollama runs in-cluster; use the FQDN so DNS resolution works regardless of
  # the pod's search domain. The OpenAI SDK appends /chat/completions to the
  # base URL, so the /v1 prefix is required or requests will 404.
  local _ollama_fqdn="http://ollama.${CAIPE_NAMESPACE:-caipe}.svc.cluster.local:${OLLAMA_PORT}"
  OPENAI_ENDPOINT="${_ollama_fqdn}/v1"
  OPENAI_API_KEY="ollama"
  OPENAI_MODEL_NAME="${OLLAMA_MODEL}"

  EMBEDDINGS_PROVIDER="ollama"
  # Default to nomic-embed-text when no embeddings model is set — gemma3 and
  # most chat models lack the /api/embed capability Ollama embeddings require.
  # nomic-embed-text is a small (274 MB), purpose-built embedding model that
  # the Ollama init container will pull alongside the chat model.
  if [[ -z "${EMBEDDINGS_MODEL:-}" || "${EMBEDDINGS_MODEL}" == "text-embedding-3-large" ]]; then
    EMBEDDINGS_MODEL="snowflake-arctic-embed2"
  fi

  # Offer LiteLLM as a proxy in front of Ollama. This is recommended for local
  # setups: it adds a stable OpenAI-compatible endpoint, enables multi-model
  # routing, and matches the production vLLM architecture.
  if ! $NON_INTERACTIVE && ! $LLM_VIA_LITELLM; then
    echo ""
    echo -e "  ${DIM}LiteLLM proxy provides a stable OpenAI-compatible endpoint in front of${NC}"
    echo -e "  ${DIM}Ollama, enables multi-model routing, and is recommended for local setups.${NC}"
    if ask_yn "Deploy LiteLLM proxy in front of Ollama? (recommended)" "y"; then
      LLM_VIA_LITELLM=true
      log "LiteLLM proxy enabled (will front Ollama at ${_ollama_fqdn})"
    fi
  fi

  log "Provider: openai (via in-cluster Ollama)  Model: ${OLLAMA_MODEL}  Embeddings: ${EMBEDDINGS_MODEL}"
}

_collect_openai_embeddings_key() {
  # When using a non-OpenAI LLM provider with OpenAI embeddings, the RAG
  # server still needs an OPENAI_API_KEY. Collect it here.
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    log "Using OPENAI_API_KEY for embeddings (from environment)"
    return
  fi
  if [[ -f "${HOME}/.config/openai.txt" ]]; then
    OPENAI_API_KEY=$(tr -d '[:space:]' < "${HOME}/.config/openai.txt")
    log "Using OPENAI_API_KEY for embeddings (from ~/.config/openai.txt)"
    return
  fi
  if $NON_INTERACTIVE; then
    err "RAG with OpenAI embeddings requires OPENAI_API_KEY (set env var or create ~/.config/openai.txt)"
    exit 1
  fi
  echo ""
  echo -e "  ${DIM}RAG embeddings use OpenAI, but your LLM provider is ${BOLD}${LLM_PROVIDER}${NC}${DIM}.${NC}"
  echo -e "  ${DIM}An OpenAI API key is needed for the embeddings model.${NC}"
  prompt "Enter your OpenAI API key (for embeddings): "
  tty_read -rs OPENAI_API_KEY
  echo ""
  if [[ -z "$OPENAI_API_KEY" ]]; then
    err "OpenAI API key is required for embeddings"
    exit 1
  fi
  log "OpenAI API key received (for embeddings)"
}

_collect_cohere_embeddings_creds() {
  if [[ -n "${COHERE_API_KEY:-}" ]]; then
    log "Using COHERE_API_KEY for embeddings (from environment)"
    return
  fi
  if [[ -f "${HOME}/.config/cohere.txt" ]]; then
    COHERE_API_KEY=$(tr -d '[:space:]' < "${HOME}/.config/cohere.txt")
    log "Using COHERE_API_KEY for embeddings (from ~/.config/cohere.txt)"
    return
  fi
  if $NON_INTERACTIVE; then
    err "RAG with Cohere embeddings requires COHERE_API_KEY (set env var or create ~/.config/cohere.txt)"
    exit 1
  fi
  echo ""
  echo -e "  ${DIM}Cohere embeddings credentials:${NC}"
  prompt "Enter your Cohere API key: "
  tty_read -rs COHERE_API_KEY
  echo ""
  if [[ -z "$COHERE_API_KEY" ]]; then
    err "Cohere API key is required for embeddings"
    exit 1
  fi
  log "Cohere API key received (for embeddings)"
}

_collect_voyage_embeddings_creds() {
  # Voyage AI is Anthropic's recommended embeddings provider. The RAG server
  # talks to Voyage through the LiteLLM-compatible code path (provider=litellm),
  # so we materialise a litellm config that points at Voyage's public endpoint.
  if [[ -n "${VOYAGE_API_KEY:-}" ]]; then
    log "Using VOYAGE_API_KEY for embeddings (from environment)"
  elif [[ -f "${HOME}/.config/voyage.txt" ]]; then
    VOYAGE_API_KEY=$(tr -d '[:space:]' < "${HOME}/.config/voyage.txt")
    log "Using VOYAGE_API_KEY for embeddings (from ~/.config/voyage.txt)"
  else
    if $NON_INTERACTIVE; then
      err "RAG with Voyage AI embeddings requires VOYAGE_API_KEY (set env var or create ~/.config/voyage.txt)"
      err "Get a key at https://www.voyageai.com/ (free tier available)"
      exit 1
    fi
    echo ""
    echo -e "  ${DIM}Voyage AI embeddings credentials:${NC}"
    echo -e "  ${DIM}Get a free API key at ${BOLD}https://www.voyageai.com${NC}"
    prompt "Enter your Voyage AI API key: "
    tty_read -rs VOYAGE_API_KEY
    echo ""
    if [[ -z "$VOYAGE_API_KEY" ]]; then
      err "Voyage AI API key is required for embeddings"
      exit 1
    fi
  fi

  # Materialise Voyage as a LiteLLM-compatible config (the RAG factory's
  # litellm path is OpenAI-compatible and works against api.voyageai.com).
  LITELLM_ENDPOINT="https://api.voyageai.com/v1"
  LITELLM_API_KEY="$VOYAGE_API_KEY"
  log "Voyage AI configured as LiteLLM-compatible embeddings endpoint"
}

_collect_aws_bedrock_embeddings_creds() {
  # AWS Bedrock embeddings reuse the LLM-side AWS credentials. If the user
  # already picked aws-bedrock as their LLM provider, those are already set.
  # Otherwise, prompt for the same triple (access key, secret, region).
  if [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    log "Using AWS credentials for Bedrock embeddings (from LLM provider config or environment)"
    return
  fi
  if [[ -f "${HOME}/.config/bedrock.txt" ]]; then
    _parse_bedrock_txt "${HOME}/.config/bedrock.txt"
    if [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
      return
    fi
  fi
  if $NON_INTERACTIVE; then
    err "RAG with AWS Bedrock embeddings requires AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY"
    err "(or ~/.config/bedrock.txt with profile name or .env-style creds)"
    exit 1
  fi
  echo ""
  echo -e "  ${DIM}AWS Bedrock embeddings credentials:${NC}"
  prompt "AWS_ACCESS_KEY_ID: "; tty_read -r AWS_ACCESS_KEY_ID
  prompt "AWS_SECRET_ACCESS_KEY: "; tty_read -rs AWS_SECRET_ACCESS_KEY; echo ""
  prompt "AWS_REGION ${CYAN}[${AWS_REGION:-us-east-1}]${NC}${BOLD}: "
  tty_read -r _r
  AWS_REGION="${_r:-${AWS_REGION:-us-east-1}}"
  if [[ -z "$AWS_ACCESS_KEY_ID" || -z "$AWS_SECRET_ACCESS_KEY" ]]; then
    err "AWS Bedrock embeddings require both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
    exit 1
  fi
  log "AWS Bedrock credentials collected (region: ${AWS_REGION})"
}

_collect_huggingface_embeddings_creds() {
  # HuggingFace embeddings run locally inside the rag-server pod and only
  # need a token for gated models. The default model (all-MiniLM-L6-v2) is
  # public and does not require a token, so the token is optional.
  if [[ -n "${HUGGINGFACEHUB_API_TOKEN:-}" || -n "${HF_TOKEN:-}" ]]; then
    HUGGINGFACEHUB_API_TOKEN="${HUGGINGFACEHUB_API_TOKEN:-$HF_TOKEN}"
    log "Using HUGGINGFACEHUB_API_TOKEN for embeddings (from environment)"
    return
  fi
  if [[ -f "${HOME}/.config/huggingface.txt" ]]; then
    HUGGINGFACEHUB_API_TOKEN=$(tr -d '[:space:]' < "${HOME}/.config/huggingface.txt")
    log "Using HUGGINGFACEHUB_API_TOKEN for embeddings (from ~/.config/huggingface.txt)"
    return
  fi
  if $NON_INTERACTIVE; then
    warn "HuggingFace embeddings: HUGGINGFACEHUB_API_TOKEN not set"
    warn "  Public models (all-MiniLM-L6-v2, all-mpnet-base-v2) will work without a token."
    warn "  Gated models (e.g. BAAI/bge-*) require a token; set HUGGINGFACEHUB_API_TOKEN if needed."
    return
  fi
  echo ""
  echo -e "  ${DIM}HuggingFace embeddings token (OPTIONAL — only needed for gated models):${NC}"
  echo -e "  ${DIM}Public models like all-MiniLM-L6-v2 work without a token. Press Enter to skip.${NC}"
  prompt "HUGGINGFACEHUB_API_TOKEN (Enter to skip): "
  tty_read -rs HUGGINGFACEHUB_API_TOKEN
  echo ""
  if [[ -z "${HUGGINGFACEHUB_API_TOKEN:-}" ]]; then
    log "HuggingFace token skipped (only public models will work)"
  else
    log "HuggingFace token received"
  fi

  echo ""
  echo -e "  ${DIM}HuggingFace device (cpu = portable, cuda/mps = GPU acceleration):${NC}"
  prompt "Device ${CYAN}[cpu]${NC}${BOLD}: "
  tty_read -r _dev
  EMBEDDINGS_DEVICE="${_dev:-cpu}"
  log "HuggingFace device: ${EMBEDDINGS_DEVICE}"
}

# ─── MetalLB / Ingress / TLS ──────────────────────────────────────────────────

install_metallb() {
  step "Installing MetalLB (LoadBalancer support for kind)"

  kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.9/config/manifests/metallb-native.yaml 2>&1 \
    | grep -v "^Warning\|unchanged" || true

  log "Waiting for MetalLB pods..."
  kubectl wait --namespace metallb-system \
    --for=condition=ready pod \
    --selector=app=metallb \
    --timeout=120s 2>/dev/null || {
      kubectl rollout status deployment/controller -n metallb-system --timeout=120s 2>/dev/null || true
  }

  # Detect kind docker network IPv4 subnet to derive the IP pool
  local kind_subnet
  kind_subnet=$(docker network inspect kind --format '{{json .IPAM.Config}}' 2>/dev/null \
    | tr ',' '\n' | grep '"Subnet":"[0-9]' | head -1 \
    | sed 's/.*"Subnet":"\([^"]*\)".*/\1/' || true)
  if [[ -z "$kind_subnet" ]]; then
    err "Could not detect kind docker network IPv4 subnet (is the kind cluster running?)"
    exit 1
  fi

  # Derive a pool from the last octet range .200-.250
  local base
  base=$(echo "$kind_subnet" | cut -d'/' -f1 | sed 's/\.[0-9]*$//')
  local pool_start="${base}.200"
  local pool_end="${base}.250"
  log "MetalLB IP pool: ${pool_start}-${pool_end}  (kind network: ${kind_subnet})"

  # The MetalLB admission webhook may take a few seconds after pod Running.
  # Retry the IPAddressPool/L2Advertisement apply until the webhook accepts it.
  local metallb_retries=0
  until kubectl apply -f - <<EOF 2>/dev/null
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: kind-pool
  namespace: metallb-system
spec:
  addresses:
  - ${pool_start}-${pool_end}
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: kind-l2
  namespace: metallb-system
spec:
  ipAddressPools:
  - kind-pool
EOF
  do
    metallb_retries=$((metallb_retries + 1))
    if [[ $metallb_retries -ge 30 ]]; then
      err "MetalLB IPAddressPool apply failed after ${metallb_retries} attempts"
      exit 1
    fi
    warn "MetalLB webhook not ready yet, retrying in 10s (attempt ${metallb_retries}/30)..."
    sleep 10
  done
  log "MetalLB configured"
}

install_nginx_ingress() {
  step "Installing nginx-ingress controller"

  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx &>/dev/null 2>&1 || true
  # Scope the refresh to just this repo and tolerate failure: a globally
  # configured but unreachable third-party repo (e.g. a private chartmuseum)
  # makes `helm repo update` (all repos) return non-zero, which would abort the
  # whole script under `set -e`. We only need the ingress-nginx index here.
  helm repo update ingress-nginx &>/dev/null 2>&1 || true

  helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
    --namespace ingress-nginx --create-namespace \
    --set controller.service.type=LoadBalancer \
    --set controller.admissionWebhooks.enabled=false \
    2>&1 | grep -v "^Warning\|unchanged" || true

  # Wait for the controller pod to become Ready before polling for IP
  kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx \
    --timeout=120s 2>/dev/null || true

  # Wait for LoadBalancer IP assignment from MetalLB
  local ingress_ip="" retries=0
  while [[ -z "$ingress_ip" && $retries -lt 36 ]]; do
    ingress_ip=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
      -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    [[ -z "$ingress_ip" ]] && sleep 5 && retries=$((retries + 1))
  done
  if [[ -z "$ingress_ip" ]]; then
    err "nginx-ingress LoadBalancer IP not assigned — MetalLB may not be ready"
    exit 1
  fi
  log "nginx-ingress ready at ${ingress_ip}"

  # On kind clusters (MetalLB), the ingress LB IP is a private kind-network
  # address. NAT the host's external IP to the ingress IP so external traffic
  # reaches the cluster. On cloud clusters (EKS/GKE/AKS) the cloud LB handles
  # this automatically — skip iptables entirely.
  #
  # This whole block is Linux-only: it relies on `hostname -I`, /proc/sys, and
  # iptables, none of which exist on macOS. On Docker Desktop (macOS) the kind
  # network is not routable from the host regardless, so external DNAT can't
  # work — local access is via `*.local.me` → 127.0.0.1 and/or port-forward.
  if $ENABLE_METALLB && [[ -n "$CAIPE_DOMAIN" ]] && [[ "$(uname -s)" == "Linux" ]]; then
    # DNAT requires IP forwarding to be enabled at runtime — not just in sysctl.conf.
    if [[ "$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)" != "1" ]]; then
      sudo sysctl -w net.ipv4.ip_forward=1 &>/dev/null \
        && log "Enabled ip_forward (net.ipv4.ip_forward=1)" \
        || warn "Could not enable ip_forward — DNAT rules may not work"
    fi

    local host_ip
    host_ip=$(hostname -I | awk '{print $1}')
    # Guard every iptables add with -C (check) to prevent duplicate rules on re-runs.
    log "Ensuring iptables DNAT rules: ${host_ip}:80/443 → ${ingress_ip}:80/443"
    local _dnat_failed=false
    if ! sudo iptables -t nat -C PREROUTING -d "$host_ip" -p tcp --dport 443 \
         -j DNAT --to-destination "${ingress_ip}:443" 2>/dev/null; then
      sudo iptables -t nat -A PREROUTING -d "$host_ip" -p tcp --dport 443 \
        -j DNAT --to-destination "${ingress_ip}:443" 2>/dev/null \
        || _dnat_failed=true
    fi
    if ! sudo iptables -t nat -C PREROUTING -d "$host_ip" -p tcp --dport 80 \
         -j DNAT --to-destination "${ingress_ip}:80" 2>/dev/null; then
      sudo iptables -t nat -A PREROUTING -d "$host_ip" -p tcp --dport 80 \
        -j DNAT --to-destination "${ingress_ip}:80" 2>/dev/null \
        || _dnat_failed=true
    fi
    if $_dnat_failed; then
      warn "iptables DNAT rules could not be added automatically (sudo required)."
      warn "Run the following as root to enable external access, then persist them:"
      warn "  sudo iptables -t nat -A PREROUTING -d ${host_ip} -p tcp --dport 443 -j DNAT --to-destination ${ingress_ip}:443"
      warn "  sudo iptables -t nat -A PREROUTING -d ${host_ip} -p tcp --dport 80  -j DNAT --to-destination ${ingress_ip}:80"
      warn "  sudo iptables -A FORWARD -d ${ingress_ip} -j ACCEPT"
      warn "  sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save"
    fi
    if ! sudo iptables -t nat -C OUTPUT -d "$host_ip" -p tcp --dport 443 \
         -j DNAT --to-destination "${ingress_ip}:443" 2>/dev/null; then
      sudo iptables -t nat -A OUTPUT -d "$host_ip" -p tcp --dport 443 \
        -j DNAT --to-destination "${ingress_ip}:443" 2>/dev/null || true
    fi
    if ! sudo iptables -t nat -C OUTPUT -d "$host_ip" -p tcp --dport 80 \
         -j DNAT --to-destination "${ingress_ip}:80" 2>/dev/null; then
      sudo iptables -t nat -A OUTPUT -d "$host_ip" -p tcp --dport 80 \
        -j DNAT --to-destination "${ingress_ip}:80" 2>/dev/null || true
    fi

    # Docker's DOCKER chain contains a blanket DROP for all traffic to the kind
    # bridge that wasn't initiated from inside the container network. DNAT'd
    # packets from the host (external → ingress IP) hit this DROP before they
    # reach nginx. Fix: insert ACCEPT rules for ports 80/443 to the ingress IP
    # at the top of the DOCKER chain, before the DROP catch-all.
    #
    # We target the DOCKER chain directly (not DOCKER-USER) because the
    # DOCKER-USER approach requires knowing the exact bridge interface name,
    # which is not always exposed via docker network inspect on kind clusters.
    _fix_docker_chain_drop() {
      local _ip="$1"
      if ! sudo iptables -L DOCKER -n &>/dev/null 2>&1; then
        return 0  # DOCKER chain doesn't exist — not a Docker-managed host
      fi
      # Check if the DOCKER chain has any DROP rules at all; skip if clean.
      if ! sudo iptables -L DOCKER -n 2>/dev/null | grep -q "^DROP"; then
        return 0
      fi
      log "Detected DROP catch-all in DOCKER chain — inserting ACCEPT rules for ingress IP"
      for _port in 443 80; do
        if ! sudo iptables -C DOCKER -p tcp -d "$_ip" --dport "$_port" -j ACCEPT 2>/dev/null; then
          sudo iptables -I DOCKER 1 -p tcp -d "$_ip" --dport "$_port" -j ACCEPT 2>/dev/null \
            || warn "Could not insert DOCKER chain ACCEPT for port ${_port} — external traffic may be blocked"
        fi
      done
      # Also add to DOCKER-USER (Docker never resets this chain) so the rules
      # survive a 'docker restart' which rebuilds the DOCKER chain from scratch.
      for _port in 443 80; do
        if ! sudo iptables -C DOCKER-USER -p tcp -d "$_ip" --dport "$_port" -j ACCEPT 2>/dev/null; then
          sudo iptables -I DOCKER-USER 1 -p tcp -d "$_ip" --dport "$_port" -j ACCEPT 2>/dev/null || true
        fi
      done
      log "DOCKER chain: ACCEPT rules added for ${_ip}:80,443"
    }
    _fix_docker_chain_drop "$ingress_ip"

    # Persist iptables rules and ip_forward so they survive a reboot.
    _persist_iptables "$ingress_ip"

    # Update /etc/hosts so local health-check curls (run_validation, sanity tests)
    # resolve the domain to the MetalLB IP directly, bypassing the *.local.me →
    # 127.0.0.1 special-domain default. Idempotent: removes stale entry first.
    if [[ -n "${CAIPE_DOMAIN:-}" ]]; then
      local _hosts_marker="# caipe-ingress"
      sudo sed -i "/${_hosts_marker}/d" /etc/hosts 2>/dev/null || true
      echo "${ingress_ip} ${CAIPE_DOMAIN} ${_hosts_marker}" | sudo tee -a /etc/hosts >/dev/null \
        && log "/etc/hosts: ${CAIPE_DOMAIN} → ${ingress_ip} (local health-check resolution)"
    fi
  elif $ENABLE_METALLB && [[ "$(uname -s)" != "Linux" ]]; then
    log "Skipping iptables DNAT (non-Linux host) — use port-forward or *.local.me → 127.0.0.1 for local access"
  fi
}

# Persist iptables rules across reboots (no iptables-persistent package needed).
_persist_iptables() {
  local ingress_ip="$1"

  # 1. Ensure ip_forward=1 survives reboot via sysctl.conf.
  if sudo grep -q '^net.ipv4.ip_forward' /etc/sysctl.conf 2>/dev/null; then
    sudo sed -i 's/^net.ipv4.ip_forward.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf 2>/dev/null || true
  else
    echo 'net.ipv4.ip_forward=1' | sudo tee -a /etc/sysctl.conf >/dev/null 2>/dev/null || true
  fi
  # Remove any duplicate lines leaving only the first occurrence.
  sudo awk '/net.ipv4.ip_forward/ && seen { next } /net.ipv4.ip_forward/ { seen=1 } { print }' \
    /etc/sysctl.conf 2>/dev/null | sudo tee /etc/sysctl.conf.tmp >/dev/null 2>/dev/null \
    && sudo mv /etc/sysctl.conf.tmp /etc/sysctl.conf 2>/dev/null || true

  # 2. Set the kind container to restart=always so it comes back after a host reboot.
  local kind_container
  kind_container=$(docker ps --filter 'label=io.x-k8s.kind.role=control-plane' --format '{{.Names}}' 2>/dev/null | head -1)
  if [[ -n "$kind_container" ]]; then
    docker update --restart=always "$kind_container" >/dev/null 2>&1 || true
    log "Kind container '${kind_container}' restart policy set to always"
  fi

  # 3. Save iptables rules and install a one-shot systemd service to restore them at boot.
  sudo mkdir -p /etc/iptables 2>/dev/null || true
  sudo iptables-save 2>/dev/null | sudo tee /etc/iptables/rules.v4 >/dev/null || true
  if [[ ! -f /etc/systemd/system/iptables-restore.service ]]; then
    sudo tee /etc/systemd/system/iptables-restore.service >/dev/null 2>/dev/null <<'SVCEOF'
[Unit]
Description=Restore iptables rules
After=network.target docker.service
Wants=docker.service
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'iptables-restore < /etc/iptables/rules.v4'
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
SVCEOF
    sudo systemctl daemon-reload 2>/dev/null || true
    sudo systemctl enable iptables-restore.service 2>/dev/null || true
    log "iptables-restore.service installed and enabled"
  else
    # Re-save with latest rules (idempotent on re-runs).
    log "iptables rules saved to /etc/iptables/rules.v4"
  fi
}

# Print a clear, single-source-of-truth banner whenever we plan to generate
# a self-signed TLS cert. Used by both the interactive ingress flow and any
# code path that intentionally falls through without a user-supplied cert.
#
# Args:
#   $1 — domain (CN/SAN), informational only
#   $2 — optional reason, shown in parentheses (e.g. "default hostname")
_announce_self_signed() {
  local _dom="$1" _reason="${2:-}"
  echo ""
  if [[ -n "$_reason" ]]; then
    warn "Will generate a SELF-SIGNED TLS cert for ${_dom} (${_reason})."
  else
    warn "Will generate a SELF-SIGNED TLS cert for ${_dom}."
  fi
  echo -e "  ${DIM}Browsers and CLI tools will show a 'NET::ERR_CERT_AUTHORITY_INVALID' /${NC}"
  echo -e "  ${DIM}'self signed certificate' warning on first visit. To use a trusted cert${NC}"
  echo -e "  ${DIM}instead, re-run with --tls-cert=FILE --tls-key=FILE (Let's Encrypt,${NC}"
  echo -e "  ${DIM}corporate CA, etc.) or drop PEMs at \$HOME/certs/{fullchain,privkey}.pem${NC}"
  echo -e "  ${DIM}and re-run the setup.${NC}"
}

setup_tls() {
  step "Configuring TLS for ${CAIPE_DOMAIN}"

  # Expand leading ~ manually — kubectl doesn't go through the shell so it
  # receives the literal tilde and fails with "no such file or directory".
  TLS_CERT_FILE="${TLS_CERT_FILE/#\~/$HOME}"
  TLS_KEY_FILE="${TLS_KEY_FILE/#\~/$HOME}"

  if [[ -n "$TLS_CERT_FILE" && -n "$TLS_KEY_FILE" ]]; then
    if [[ ! -f "$TLS_CERT_FILE" ]]; then
      err "TLS cert file not found: ${TLS_CERT_FILE}"
      exit 1
    fi
    if [[ ! -f "$TLS_KEY_FILE" ]]; then
      err "TLS key file not found: ${TLS_KEY_FILE}"
      exit 1
    fi
    log "Using provided TLS cert: ${TLS_CERT_FILE}"
  else
    # Always announce self-signed up-front, even if the interactive flow
    # already did — duplication is cheap and makes scripted/CI runs honest.
    local _reason=""
    [[ "$CAIPE_DOMAIN" == *.local.me ]] && _reason="*.local.me has no public CA"
    _announce_self_signed "${CAIPE_DOMAIN}" "${_reason}"
    log "Generating self-signed certificate for ${CAIPE_DOMAIN}"
    # Trailing X's only: BSD mktemp (macOS) treats any chars after the X's as a
    # literal filename (no randomization), which collides on re-runs. The .pem
    # extension is cosmetic — openssl writes by path, not extension.
    TLS_CERT_FILE=$(mktemp /tmp/caipe-tls-cert-XXXXXX)
    TLS_KEY_FILE=$(mktemp /tmp/caipe-tls-key-XXXXXX)
    local _san
    if [[ "$CAIPE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      _san="IP:${CAIPE_DOMAIN}"
    else
      _san="DNS:${CAIPE_DOMAIN},DNS:*.${CAIPE_DOMAIN}"
    fi
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout "$TLS_KEY_FILE" \
      -out "$TLS_CERT_FILE" \
      -subj "/CN=${CAIPE_DOMAIN}/O=CAIPE" \
      -addext "subjectAltName=${_san}" \
      2>/dev/null
    log "Self-signed cert generated (valid 365 days)"
  fi

  kubectl create secret tls caipe-tls \
    --cert="$TLS_CERT_FILE" \
    --key="$TLS_KEY_FILE" \
    -n caipe --dry-run=client -o yaml | kubectl apply -f - 2>&1 \
    | grep -v "^Warning\|unchanged" || true
  log "TLS secret 'caipe-tls' created in namespace caipe"
}

_choose_agents() {
  # All available agents with display labels
  local -a _agent_keys=(argocd aws backstage confluence github gitlab jira komodor netutils pagerduty slack splunk webex aigateway)
  local -a _agent_labels=(
    "ArgoCD        — GitOps / CD pipelines"
    "AWS           — cloud resources & infrastructure"
    "Backstage     — developer portal & catalog"
    "Confluence    — wiki & knowledge base"
    "GitHub        — repos, PRs, issues, Actions"
    "GitLab        — repos, MRs, pipelines"
    "Jira          — tickets & project tracking"
    "Komodor       — Kubernetes health & incidents"
    "NetUtils      — network diagnostics"
    "PagerDuty     — on-call & incident response"
    "Slack         — messaging & notifications"
    "Splunk        — log search & SIEM"
    "Webex         — video meetings & messaging"
    "AI Gateway    — multi-model LLM routing"
  )

  # If not already populated, try reading from the live Helm release
  if [[ ${#SELECTED_AGENTS[@]} -eq 0 ]]; then
    local _ha
    _ha=$(helm get values caipe -n caipe -o json 2>/dev/null \
      | jq -r '.tags // {} | to_entries[] | select(.key | startswith("agent-")) | select(.value==true) | .key | sub("^agent-"; "")' \
      2>/dev/null || true)
    if [[ -n "$_ha" ]]; then
      while IFS= read -r _akey; do
        [[ -n "$_akey" ]] && SELECTED_AGENTS+=("$_akey")
      done <<< "$_ha"
      log "Detected enabled agents from cluster: ${SELECTED_AGENTS[*]}"
    fi
  fi

  # Already known — confirm and skip
  if [[ ${#SELECTED_AGENTS[@]} -gt 0 ]]; then
    log "Detected enabled agents: ${SELECTED_AGENTS[*]}"
    if ask_yn "Keep existing agent selection?" "y"; then
      return 0
    fi
    SELECTED_AGENTS=()
    HELM_AGENT_ARGS=()
  fi

  echo ""
  echo -e "  ${BOLD}Select agents to install${NC} ${DIM}(all enabled by default)${NC}"
  echo -e "  ${DIM}Enter comma-separated numbers, 'all', or press Enter for all:${NC}"
  echo ""

  local i=1
  for label in "${_agent_labels[@]}"; do
    printf "    ${BOLD}%2d)${NC} %s\n" "$i" "$label"
    i=$((i + 1))
  done
  echo ""
  prompt "Select agents ${CYAN}[all]${NC}${BOLD}: "
  tty_read -r _input
  _input="${_input:-all}"

  SELECTED_AGENTS=()
  if [[ "$(echo "$_input" | tr '[:upper:]' '[:lower:]')" == "all" || -z "$_input" ]]; then
    SELECTED_AGENTS=("${_agent_keys[@]}")
    log "All agents selected"
    return
  fi

  # Parse comma-separated numbers
  local _invalid=()
  IFS=',' read -ra _picks <<< "$_input"
  for _pick in "${_picks[@]}"; do
    _pick="${_pick// /}"  # trim spaces
    if [[ "$_pick" =~ ^[0-9]+$ ]] && [[ "$_pick" -ge 1 && "$_pick" -le "${#_agent_keys[@]}" ]]; then
      SELECTED_AGENTS+=("${_agent_keys[$((_pick - 1))]}")
    else
      _invalid+=("$_pick")
    fi
  done

  if [[ ${#_invalid[@]} -gt 0 ]]; then
    warn "Ignored invalid selections: ${_invalid[*]}"
  fi
  if [[ ${#SELECTED_AGENTS[@]} -eq 0 ]]; then
    warn "No valid agents selected — falling back to all agents"
    SELECTED_AGENTS=("${_agent_keys[@]}")
  fi

  log "Selected agents: ${SELECTED_AGENTS[*]}"
}

choose_features() {
  step "Feature selection"

  echo -e "  ${DIM}Base setup always includes: dynamic agents runtime and NetUtils agent${NC}"

  if $NON_INTERACTIVE; then
    if $ENABLE_RAG; then
      log "RAG enabled (--rag)"
      $ENABLE_GRAPH_RAG && log "Graph RAG enabled (--graph-rag)" || log "Graph RAG disabled (pass --graph-rag to enable)"
      if [[ "$EMBEDDINGS_PROVIDER" == "openai" && "$LLM_PROVIDER" != "openai" ]]; then
        _collect_openai_embeddings_key
      fi
    else
      log "RAG skipped (pass --rag to enable)"
    fi
    $ENABLE_TRACING && log "Tracing enabled (--tracing)" || log "Tracing skipped (pass --tracing to enable)"
    log "AgentGateway enabled (required)"
    log "RBAC runtime enabled (required — Keycloak + OpenFGA)"
    log "Dynamic-agent persistence uses caipe-mongodb"
    log "Dynamic Agents runtime included"
    $ENABLE_METALLB && log "MetalLB enabled (default; pass --no-metallb to skip)" || log "MetalLB disabled (--no-metallb)"
    if $ENABLE_INGRESS; then
      if [[ -z "$CAIPE_DOMAIN" ]]; then
        CAIPE_DOMAIN="$CAIPE_DOMAIN_DEFAULT"
        log "Ingress enabled with default domain: ${CAIPE_DOMAIN} (resolves to 127.0.0.1 via *.local.me; override with --domain=<hostname>)"
      else
        log "Ingress enabled for domain: ${CAIPE_DOMAIN} (--ingress --domain)"
      fi
    fi
    return
  fi

  echo ""

  # ── RAG: detect from cluster ──────────────────────────────────────────────────
  # Always check the cluster — detect_deployed_features may have already set
  # ENABLE_RAG=true, but we still need to read embeddings config and confirm.
  local _rag_from_cluster=false
  if kubectl get svc rag-server -n caipe &>/dev/null 2>&1; then
    ENABLE_RAG=true
    _rag_from_cluster=true
    # Read embeddings config from live Helm values
    local _helm_vals_json
    _helm_vals_json=$(helm get values caipe -n caipe -o json 2>/dev/null || true)
    local _ep _em
    _ep=$(echo "$_helm_vals_json" | jq -r '."rag-stack"."rag-server".env.EMBEDDINGS_PROVIDER // empty' 2>/dev/null || true)
    _em=$(echo "$_helm_vals_json" | jq -r '."rag-stack"."rag-server".env.EMBEDDINGS_MODEL // empty' 2>/dev/null || true)
    [[ -n "$_ep" ]] && EMBEDDINGS_PROVIDER="$_ep"
    [[ -n "$_em" ]] && EMBEDDINGS_MODEL="$_em"
    # Read Azure embeddings creds from llm-secret (they are merged in there)
    if [[ "${EMBEDDINGS_PROVIDER:-}" == "azure-openai" ]]; then
      local _ls
      _ls=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
      if [[ -n "$_ls" ]]; then
        local _sv2; _sv2() { echo "$_ls" | jq -r --arg k "$1" '.data[$k] // empty' 2>/dev/null | base64 -d 2>/dev/null || true; }
        [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]     && AZURE_OPENAI_API_KEY=$(_sv2 AZURE_OPENAI_API_KEY)
        [[ -z "${AZURE_OPENAI_ENDPOINT:-}" ]]    && AZURE_OPENAI_ENDPOINT=$(_sv2 AZURE_OPENAI_ENDPOINT)
        [[ -z "${AZURE_OPENAI_API_VERSION:-}" ]] && AZURE_OPENAI_API_VERSION=$(_sv2 AZURE_OPENAI_API_VERSION)
      fi
    fi
  fi

  if $ENABLE_RAG && $_rag_from_cluster; then
    log "Detected RAG is enabled (embeddings: ${EMBEDDINGS_PROVIDER:-openai}/${EMBEDDINGS_MODEL:-text-embedding-3-large})"
    local _keep_rag=true
    if ! ask_yn "Keep existing RAG configuration (${EMBEDDINGS_PROVIDER:-openai})?" "y"; then
      ENABLE_RAG=false
      EMBEDDINGS_PROVIDER="${EMBEDDINGS_PROVIDER:-openai}"  # reset to default for re-prompt below
      _keep_rag=false
    fi
    if $_keep_rag; then
      log "RAG kept"
      # Validate that the required embeddings credentials are available.
      # They may be missing if the LLM provider changed and the old secret was wiped.
      # Prompt now so provision_secrets can include them in the rebuilt llm-secret.
      case "${EMBEDDINGS_PROVIDER:-openai}" in
        openai)
          if [[ "$LLM_PROVIDER" != "openai" && -z "${OPENAI_API_KEY:-}" ]]; then
            # Try to rescue from the existing secret first
            local _ols
            _ols=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
            [[ -n "$_ols" ]] && OPENAI_API_KEY=$(echo "$_ols" | jq -r '.data.OPENAI_API_KEY // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
            if [[ -z "${OPENAI_API_KEY:-}" ]]; then
              warn "OpenAI embeddings require OPENAI_API_KEY (not found in existing secret)"
              _collect_openai_embeddings_key
            fi
          fi
          ;;
        azure-openai)
          if [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]; then
            local _als
            _als=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
            if [[ -n "$_als" ]]; then
              [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]     && AZURE_OPENAI_API_KEY=$(echo "$_als" | jq -r '.data.AZURE_OPENAI_API_KEY // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
              [[ -z "${AZURE_OPENAI_ENDPOINT:-}" ]]    && AZURE_OPENAI_ENDPOINT=$(echo "$_als" | jq -r '.data.AZURE_OPENAI_ENDPOINT // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
              [[ -z "${AZURE_OPENAI_API_VERSION:-}" ]] && AZURE_OPENAI_API_VERSION=$(echo "$_als" | jq -r '.data.AZURE_OPENAI_API_VERSION // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
            fi
            if [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]; then
              warn "Azure OpenAI embeddings credentials not found — please enter them now"
              prompt "Azure OpenAI API key: "; tty_read -rs AZURE_OPENAI_API_KEY; echo ""
              prompt "Azure OpenAI endpoint: "; tty_read -r AZURE_OPENAI_ENDPOINT
              prompt "API version [2025-04-01-preview]: "; tty_read -r _v; AZURE_OPENAI_API_VERSION="${_v:-2025-04-01-preview}"
            fi
          fi
          ;;
        aws-bedrock)
          # Reuses the LLM AWS creds when LLM_PROVIDER=aws-bedrock; otherwise
          # rescue from the existing secret and re-prompt if still missing.
          if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
            local _abs
            _abs=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
            if [[ -n "$_abs" ]]; then
              [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]     && AWS_ACCESS_KEY_ID=$(echo "$_abs" | jq -r '.data.AWS_ACCESS_KEY_ID // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
              [[ -z "${AWS_SECRET_ACCESS_KEY:-}" ]] && AWS_SECRET_ACCESS_KEY=$(echo "$_abs" | jq -r '.data.AWS_SECRET_ACCESS_KEY // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
              [[ -z "${AWS_REGION:-}" ]]            && AWS_REGION=$(echo "$_abs" | jq -r '.data.AWS_REGION // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
            fi
            if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
              warn "AWS Bedrock embeddings credentials not found — please enter them now"
              _collect_aws_bedrock_embeddings_creds
            fi
          fi
          ;;
        cohere)
          if [[ -z "${COHERE_API_KEY:-}" ]]; then
            local _cls
            _cls=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
            [[ -n "$_cls" ]] && COHERE_API_KEY=$(echo "$_cls" | jq -r '.data.COHERE_API_KEY // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
            if [[ -z "${COHERE_API_KEY:-}" ]]; then
              warn "Cohere embeddings credentials not found — please enter them now"
              _collect_cohere_embeddings_creds
            fi
          fi
          ;;
        litellm)
          # Could be Voyage (api.voyageai.com) or a generic LiteLLM proxy.
          # Both rescue the same way — endpoint + key from the live secret.
          if [[ -z "${LITELLM_ENDPOINT:-}" ]]; then
            local _vls
            _vls=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
            if [[ -n "$_vls" ]]; then
              [[ -z "${LITELLM_ENDPOINT:-}" ]] && LITELLM_ENDPOINT=$(echo "$_vls" | jq -r '.data.LITELLM_API_BASE // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
              [[ -z "${LITELLM_API_KEY:-}" ]]  && LITELLM_API_KEY=$(echo "$_vls" | jq -r '.data.LITELLM_API_KEY // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
            fi
            if [[ -z "${LITELLM_ENDPOINT:-}" ]]; then
              warn "LiteLLM/Voyage embeddings credentials not found — please enter them now"
              if [[ "${EMBEDDINGS_MODEL:-}" =~ ^voyage- ]]; then
                _collect_voyage_embeddings_creds
              else
                prompt "LiteLLM endpoint: "; tty_read -r LITELLM_ENDPOINT
                prompt "LiteLLM API key (Enter for 'not-needed'): "; tty_read -rs LITELLM_API_KEY; echo ""
                LITELLM_API_KEY="${LITELLM_API_KEY:-not-needed}"
              fi
            fi
          fi
          ;;
        huggingface)
          # HF token is OPTIONAL — public models don't need it. Just log
          # whether we have one; never block the re-run.
          if [[ -z "${HUGGINGFACEHUB_API_TOKEN:-}" ]]; then
            local _hls
            _hls=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
            [[ -n "$_hls" ]] && HUGGINGFACEHUB_API_TOKEN=$(echo "$_hls" | jq -r '.data.HUGGINGFACEHUB_API_TOKEN // empty' 2>/dev/null | base64 -d 2>/dev/null || true)
          fi
          ;;
      esac
      # Fall through — agent prompts still need to run below
    fi
  fi

  if ! $ENABLE_RAG; then
    if ask_yn "Enable RAG (knowledge base retrieval)?" "n"; then
      ENABLE_RAG=true
      log "RAG enabled"

      # Anthropic-aware note: Anthropic does not ship a native embeddings
      # model. Their official recommendation is Voyage AI. We surface that
      # here so a Claude user knows their options without forcing a choice.
      # Source: https://platform.claude.com/docs/en/build-with-claude/embeddings
      if [[ "${LLM_PROVIDER:-}" == "anthropic-claude" ]]; then
        echo ""
        echo -e "  ${YELLOW}${BOLD}Note:${NC} ${DIM}Anthropic does not ship its own embeddings model.${NC}"
        echo -e "  ${DIM}Their official recommendation is ${BOLD}Voyage AI${NC}${DIM} (option 5 below).${NC}"
        echo -e "  ${DIM}OpenAI, Azure OpenAI, AWS Bedrock, and Cohere all work too — pick whatever${NC}"
        echo -e "  ${DIM}fits your existing account / latency / data-residency requirements.${NC}"
      fi

      echo ""
      echo -e "  ${DIM}Embeddings provider:${NC}"
      echo -e "    ${BOLD}1)${NC} Ollama             ${DIM}(local — snowflake-arctic-embed2 default, no API key needed) — default${NC}"
      echo -e "    ${BOLD}2)${NC} OpenAI             ${DIM}(text-embedding-3-large)${NC}"
      echo -e "    ${BOLD}3)${NC} Azure OpenAI        ${DIM}(uses your Azure deployment)${NC}"
      echo -e "    ${BOLD}4)${NC} AWS Bedrock         ${DIM}(Titan / Cohere on Bedrock — reuses LLM AWS creds)${NC}"
      echo -e "    ${BOLD}5)${NC} Cohere              ${DIM}(direct Cohere API: embed-english-v3.0, etc.)${NC}"
      echo -e "    ${BOLD}6)${NC} Voyage AI           ${DIM}(Anthropic's official recommendation — voyage-4-large)${NC}"
      echo -e "    ${BOLD}7)${NC} HuggingFace         ${DIM}(local — requires rag-server -hf image variant)${NC}"
      echo -e "    ${BOLD}8)${NC} LiteLLM Proxy       ${DIM}(any OpenAI-compatible endpoint you operate)${NC}"
      echo ""
      prompt "Select embeddings provider ${CYAN}[1]${NC}${BOLD}: "
      tty_read -r emb_provider_choice
      emb_provider_choice="${emb_provider_choice:-1}"
      case "$emb_provider_choice" in
        1) EMBEDDINGS_PROVIDER="ollama" ;;
        2) EMBEDDINGS_PROVIDER="openai" ;;
        3) EMBEDDINGS_PROVIDER="azure-openai" ;;
        4) EMBEDDINGS_PROVIDER="aws-bedrock" ;;
        5) EMBEDDINGS_PROVIDER="cohere" ;;
        6) EMBEDDINGS_PROVIDER="litellm"; EMBEDDINGS_PROVIDER_SOURCE="voyage" ;;
        7) EMBEDDINGS_PROVIDER="huggingface" ;;
        8) EMBEDDINGS_PROVIDER="litellm"; EMBEDDINGS_PROVIDER_SOURCE="custom-litellm" ;;
        *) err "Invalid choice"; exit 1 ;;
      esac

      # Model menu varies per provider. We keep the OpenAI / Azure / generic
      # path identical to before; new providers get their canonical defaults.
      echo ""
      echo -e "  ${DIM}Embeddings model:${NC}"
      case "${EMBEDDINGS_PROVIDER_SOURCE:-$EMBEDDINGS_PROVIDER}" in
        openai|azure-openai)
          echo -e "    ${BOLD}1)${NC} text-embedding-3-large  ${DIM}(default, higher quality, 3072 dims)${NC}"
          echo -e "    ${BOLD}2)${NC} text-embedding-3-small  ${DIM}(faster, lower cost, 1536 dims)${NC}"
          echo -e "    ${BOLD}3)${NC} Custom"
          echo ""
          prompt "Select embeddings model ${CYAN}[1]${NC}${BOLD}: "
          tty_read -r emb_choice
          emb_choice="${emb_choice:-1}"
          case "$emb_choice" in
            1) EMBEDDINGS_MODEL="text-embedding-3-large" ;;
            2) EMBEDDINGS_MODEL="text-embedding-3-small" ;;
            3)
              prompt "Enter custom embeddings model name: "
              tty_read -r EMBEDDINGS_MODEL
              [[ -z "$EMBEDDINGS_MODEL" ]] && { err "Model name is required"; exit 1; }
              ;;
            *) err "Invalid choice"; exit 1 ;;
          esac
          ;;
        aws-bedrock)
          echo -e "    ${BOLD}1)${NC} amazon.titan-embed-text-v2:0   ${DIM}(default, 1024 dims, lowest cost)${NC}"
          echo -e "    ${BOLD}2)${NC} amazon.titan-embed-text-v1     ${DIM}(legacy, 1536 dims)${NC}"
          echo -e "    ${BOLD}3)${NC} cohere.embed-english-v3        ${DIM}(English, 1024 dims)${NC}"
          echo -e "    ${BOLD}4)${NC} cohere.embed-multilingual-v3   ${DIM}(100+ languages, 1024 dims)${NC}"
          echo -e "    ${BOLD}5)${NC} Custom Bedrock model ID"
          echo ""
          prompt "Select embeddings model ${CYAN}[1]${NC}${BOLD}: "
          tty_read -r emb_choice
          emb_choice="${emb_choice:-1}"
          case "$emb_choice" in
            1) EMBEDDINGS_MODEL="amazon.titan-embed-text-v2:0" ;;
            2) EMBEDDINGS_MODEL="amazon.titan-embed-text-v1" ;;
            3) EMBEDDINGS_MODEL="cohere.embed-english-v3" ;;
            4) EMBEDDINGS_MODEL="cohere.embed-multilingual-v3" ;;
            5)
              prompt "Enter Bedrock embeddings model ID: "
              tty_read -r EMBEDDINGS_MODEL
              [[ -z "$EMBEDDINGS_MODEL" ]] && { err "Model ID is required"; exit 1; }
              ;;
            *) err "Invalid choice"; exit 1 ;;
          esac
          ;;
        cohere)
          echo -e "    ${BOLD}1)${NC} embed-english-v3.0             ${DIM}(default, 1024 dims)${NC}"
          echo -e "    ${BOLD}2)${NC} embed-multilingual-v3.0        ${DIM}(100+ languages, 1024 dims)${NC}"
          echo -e "    ${BOLD}3)${NC} embed-english-light-v3.0       ${DIM}(faster, 384 dims)${NC}"
          echo -e "    ${BOLD}4)${NC} Custom"
          echo ""
          prompt "Select embeddings model ${CYAN}[1]${NC}${BOLD}: "
          tty_read -r emb_choice
          emb_choice="${emb_choice:-1}"
          case "$emb_choice" in
            1) EMBEDDINGS_MODEL="embed-english-v3.0" ;;
            2) EMBEDDINGS_MODEL="embed-multilingual-v3.0" ;;
            3) EMBEDDINGS_MODEL="embed-english-light-v3.0" ;;
            4)
              prompt "Enter custom Cohere model name: "
              tty_read -r EMBEDDINGS_MODEL
              [[ -z "$EMBEDDINGS_MODEL" ]] && { err "Model name is required"; exit 1; }
              ;;
            *) err "Invalid choice"; exit 1 ;;
          esac
          ;;
        voyage)
          echo -e "    ${BOLD}1)${NC} voyage-4-large    ${DIM}(default, best quality, 1024 dims, 32K ctx)${NC}"
          echo -e "    ${BOLD}2)${NC} voyage-4          ${DIM}(balanced cost/quality, 1024 dims)${NC}"
          echo -e "    ${BOLD}3)${NC} voyage-4-lite     ${DIM}(lowest latency/cost, 1024 dims)${NC}"
          echo -e "    ${BOLD}4)${NC} voyage-code-3     ${DIM}(code-optimised, 1024 dims)${NC}"
          echo -e "    ${BOLD}5)${NC} Custom Voyage model"
          echo ""
          prompt "Select embeddings model ${CYAN}[1]${NC}${BOLD}: "
          tty_read -r emb_choice
          emb_choice="${emb_choice:-1}"
          case "$emb_choice" in
            1) EMBEDDINGS_MODEL="voyage-4-large" ;;
            2) EMBEDDINGS_MODEL="voyage-4" ;;
            3) EMBEDDINGS_MODEL="voyage-4-lite" ;;
            4) EMBEDDINGS_MODEL="voyage-code-3" ;;
            5)
              prompt "Enter Voyage model name: "
              tty_read -r EMBEDDINGS_MODEL
              [[ -z "$EMBEDDINGS_MODEL" ]] && { err "Model name is required"; exit 1; }
              ;;
            *) err "Invalid choice"; exit 1 ;;
          esac
          ;;
        huggingface)
          echo -e "    ${BOLD}1)${NC} sentence-transformers/all-MiniLM-L6-v2   ${DIM}(default, 384 dims, lightweight)${NC}"
          echo -e "    ${BOLD}2)${NC} sentence-transformers/all-mpnet-base-v2  ${DIM}(higher quality, 768 dims)${NC}"
          echo -e "    ${BOLD}3)${NC} sentence-transformers/all-MiniLM-L12-v2  ${DIM}(384 dims)${NC}"
          echo -e "    ${BOLD}4)${NC} Custom HF model ID"
          echo ""
          prompt "Select embeddings model ${CYAN}[1]${NC}${BOLD}: "
          tty_read -r emb_choice
          emb_choice="${emb_choice:-1}"
          case "$emb_choice" in
            1) EMBEDDINGS_MODEL="sentence-transformers/all-MiniLM-L6-v2" ;;
            2) EMBEDDINGS_MODEL="sentence-transformers/all-mpnet-base-v2" ;;
            3) EMBEDDINGS_MODEL="sentence-transformers/all-MiniLM-L12-v2" ;;
            4)
              prompt "Enter HuggingFace model ID (org/model): "
              tty_read -r EMBEDDINGS_MODEL
              [[ -z "$EMBEDDINGS_MODEL" ]] && { err "Model ID is required"; exit 1; }
              ;;
            *) err "Invalid choice"; exit 1 ;;
          esac
          warn "HuggingFace embeddings require the rag-server -hf image variant (~900MB larger)."
          warn "  Ensure your chart sets rag-stack.rag-server.image.tag to a tag with the -hf suffix."
          ;;
        ollama)
          echo -e "    ${BOLD}1)${NC} nomic-embed-text          ${DIM}(274 MB · 768 dims · fast CPU)${NC}"
          echo -e "    ${BOLD}2)${NC} mxbai-embed-large         ${DIM}(670 MB · 1024 dims · MTEB 64.68 English)${NC}"
          echo -e "    ${BOLD}3)${NC} qwen3-embedding:0.6b      ${DIM}(639 MB · 1024 dims · MTEB 64.33 multilingual · 32K ctx)${NC}"
          echo -e "    ${BOLD}4)${NC} snowflake-arctic-embed2   ${DIM}(default · 1.2 GB · 1024 dims · strong retrieval)${NC}"
          echo -e "    ${BOLD}5)${NC} bge-m3                    ${DIM}(1.2 GB · 1024 dims · hybrid dense+sparse+multi-vector)${NC}"
          echo -e "    ${BOLD}6)${NC} qwen3-embedding:8b        ${DIM}(4.7 GB · 4096 dims · MTEB #1 multilingual — GPU recommended)${NC}"
          echo -e "    ${BOLD}7)${NC} Custom"
          echo ""
          prompt "Select embeddings model ${CYAN}[1]${NC}${BOLD}: "
          tty_read -r emb_choice
          emb_choice="${emb_choice:-1}"
          case "$emb_choice" in
            1) EMBEDDINGS_MODEL="nomic-embed-text" ;;
            2) EMBEDDINGS_MODEL="mxbai-embed-large" ;;
            3) EMBEDDINGS_MODEL="qwen3-embedding:0.6b" ;;
            4) EMBEDDINGS_MODEL="snowflake-arctic-embed2" ;;
            5) EMBEDDINGS_MODEL="bge-m3" ;;
            6) EMBEDDINGS_MODEL="qwen3-embedding:8b" ;;
            7)
              prompt "Enter Ollama model name: "
              tty_read -r EMBEDDINGS_MODEL
              [[ -z "$EMBEDDINGS_MODEL" ]] && { err "Model name is required"; exit 1; }
              ;;
            *) err "Invalid choice"; exit 1 ;;
          esac
          ;;
        custom-litellm|*)
          echo -e "    ${DIM}Enter the model identifier your LiteLLM proxy expects.${NC}"
          echo -e "    ${DIM}Examples: voyage/voyage-3, mistral/mistral-embed, gemini/text-embedding-004${NC}"
          echo ""
          prompt "Enter embeddings model name: "
          tty_read -r EMBEDDINGS_MODEL
          [[ -z "$EMBEDDINGS_MODEL" ]] && { err "Model name is required"; exit 1; }
          ;;
      esac
      log "Embeddings: ${EMBEDDINGS_PROVIDER} / ${EMBEDDINGS_MODEL}"
      # Resolve dimensions for known models; leave unset for unknowns so the RAG
      # server's live-embed detection (restapi.py) is the authoritative source.
      if [[ -z "${EMBEDDINGS_DIMENSIONS:-}" ]]; then
        case "${EMBEDDINGS_MODEL}" in
          # Ollama local models
          nomic-embed-text)              EMBEDDINGS_DIMENSIONS=768  ;;
          mxbai-embed-large)             EMBEDDINGS_DIMENSIONS=1024 ;;
          snowflake-arctic-embed2)       EMBEDDINGS_DIMENSIONS=1024 ;;
          bge-m3)                        EMBEDDINGS_DIMENSIONS=1024 ;;
          qwen3-embedding:0.6b)          EMBEDDINGS_DIMENSIONS=1024 ;;
          qwen3-embedding:1.7b)          EMBEDDINGS_DIMENSIONS=1536 ;;
          qwen3-embedding:4b)            EMBEDDINGS_DIMENSIONS=2560 ;;
          qwen3-embedding:8b)            EMBEDDINGS_DIMENSIONS=4096 ;;
          # OpenAI / Azure
          text-embedding-3-small|text-embedding-ada-002) EMBEDDINGS_DIMENSIONS=1536 ;;
          text-embedding-3-large)        EMBEDDINGS_DIMENSIONS=3072 ;;
          # AWS Bedrock
          amazon.titan-embed-text-v1)    EMBEDDINGS_DIMENSIONS=1536 ;;
          amazon.titan-embed-text-v2:0)  EMBEDDINGS_DIMENSIONS=1024 ;;
          cohere.embed-english-v3|cohere.embed-multilingual-v3) EMBEDDINGS_DIMENSIONS=1024 ;;
          # Cohere direct
          embed-english-v3.0|embed-multilingual-v3.0) EMBEDDINGS_DIMENSIONS=1024 ;;
          embed-english-light-v3.0)      EMBEDDINGS_DIMENSIONS=384  ;;
          # Voyage / LiteLLM
          voyage/voyage-3-lite)          EMBEDDINGS_DIMENSIONS=512  ;;
          voyage/voyage-*)               EMBEDDINGS_DIMENSIONS=1024 ;;
          mistral/mistral-embed)         EMBEDDINGS_DIMENSIONS=1024 ;;
          gemini/text-embedding-004|vertex_ai/textembedding-gecko*) EMBEDDINGS_DIMENSIONS=768 ;;
        esac
        [[ -n "${EMBEDDINGS_DIMENSIONS:-}" ]] && log "Resolved embedding dimensions: ${EMBEDDINGS_DIMENSIONS} (model: ${EMBEDDINGS_MODEL})"
      fi

      # Collect any extra credentials the chosen embeddings provider needs.
      case "${EMBEDDINGS_PROVIDER_SOURCE:-$EMBEDDINGS_PROVIDER}" in
        openai)
          if [[ "$LLM_PROVIDER" != "openai" ]]; then
            _collect_openai_embeddings_key
          fi
          ;;
        azure-openai)
          echo ""
          echo -e "  ${DIM}Azure OpenAI embeddings credentials:${NC}"
          if [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]; then
            prompt "Azure OpenAI API key: "
            tty_read -rs AZURE_OPENAI_API_KEY; echo ""
            [[ -z "$AZURE_OPENAI_API_KEY" ]] && { err "AZURE_OPENAI_API_KEY is required"; exit 1; }
          fi
          if [[ -z "${AZURE_OPENAI_ENDPOINT:-}" ]]; then
            prompt "Azure OpenAI endpoint (e.g. https://my-resource.openai.azure.com): "
            tty_read -r AZURE_OPENAI_ENDPOINT
            [[ -z "$AZURE_OPENAI_ENDPOINT" ]] && { err "AZURE_OPENAI_ENDPOINT is required"; exit 1; }
          fi
          if [[ -z "${AZURE_OPENAI_API_VERSION:-}" ]]; then
            prompt "API version ${CYAN}[2025-04-01-preview]${NC}${BOLD}: "
            tty_read -r input
            AZURE_OPENAI_API_VERSION="${input:-2025-04-01-preview}"
          fi
          log "Azure OpenAI embeddings credentials collected"
          ;;
        aws-bedrock)
          _collect_aws_bedrock_embeddings_creds
          ;;
        cohere)
          _collect_cohere_embeddings_creds
          ;;
        voyage)
          _collect_voyage_embeddings_creds
          ;;
        huggingface)
          _collect_huggingface_embeddings_creds
          ;;
        ollama)
          # Ollama embeddings reach the same cluster-local ollama service the
          # LLM path uses (option 5 on the LLM menu sets ENABLE_OLLAMA=true).
          # Warn if the user picked Ollama embeddings without an Ollama LLM,
          # because the chart doesn't yet stand up a standalone ollama pod
          # purely for embeddings.
          if ! $ENABLE_OLLAMA; then
            warn "Ollama embeddings selected, but no Ollama LLM was configured."
            warn "  You must deploy an Ollama server reachable from inside the cluster."
          else
            # The in-cluster Ollama init container pulls EMBEDDINGS_MODEL at pod
            # startup when it differs from OPENAI_MODEL_NAME (via the optional
            # secretKeyRef in deploy/kind/ollama.yaml). No host-side pull needed.
            log "Embedding model '${EMBEDDINGS_MODEL}' will be pulled by the Ollama init container."
          fi
          ;;
        custom-litellm)
          if [[ -z "${LITELLM_ENDPOINT:-}" ]]; then
            echo ""
            echo -e "  ${DIM}LiteLLM proxy credentials:${NC}"
            prompt "LiteLLM endpoint (e.g. http://litellm:4000): "
            tty_read -r LITELLM_ENDPOINT
            [[ -z "$LITELLM_ENDPOINT" ]] && { err "LITELLM endpoint is required"; exit 1; }
            prompt "LiteLLM API key (Enter for 'not-needed'): "
            tty_read -rs LITELLM_API_KEY; echo ""
            LITELLM_API_KEY="${LITELLM_API_KEY:-not-needed}"
            log "LiteLLM proxy credentials collected"
          fi
          ;;
      esac
      # Clear the source hint so re-runs don't leak it.
      unset EMBEDDINGS_PROVIDER_SOURCE

      warn "Graph RAG is NOT needed for the basic setup. It requires Neo4j + ontology agent and uses significantly more resources. Most users should skip this."
      if ask_yn "Enable Graph RAG? (requires Neo4j + ontology agent, uses more resources)" "n"; then
        ENABLE_GRAPH_RAG=true
        log "Graph RAG enabled"
      else
        log "Graph RAG disabled (vector-only RAG)"
      fi
    else
      log "RAG skipped"
    fi
  fi

  # ── Agent selection ───────────────────────────────────────────────────
  _choose_agents

  # ── Per-agent credentials ─────────────────────────────────────────────
  echo ""
  echo -e "  ${BOLD}Agent credentials${NC}"
  echo -e "  ${DIM}Enter credentials for each selected agent. Leave blank to skip (agent will be disabled).${NC}"

  # Agents that need no credentials
  local _no_creds_agents=(netutils aigateway)

  for _agent in "${SELECTED_AGENTS[@]}"; do
    # Skip agents that don't need creds
    local _needs_creds=true
    for _nc in "${_no_creds_agents[@]}"; do
      [[ "$_agent" == "$_nc" ]] && { _needs_creds=false; break; }
    done
    $_needs_creds || continue

    echo ""
    echo -e "  ${CYAN}${BOLD}── ${_agent} ──${NC}"
    local _secret_name="caipe-${_agent}-secret"
    local _secret_args=()
    local _skip=false

    # If the secret already exists in the cluster, offer to keep it
    if kubectl get secret "$_secret_name" -n caipe &>/dev/null 2>&1; then
      log "Secret '${_secret_name}' already exists in cluster"
      if ask_yn "Keep existing ${_agent} credentials?" "y"; then
        HELM_AGENT_ARGS+=(
          --set "tags.mcp-${_agent}=true"
          --set "mcp-${_agent}.agentSecrets.secretName=${_secret_name}"
        )
        continue
      fi
    fi

    case "$_agent" in
      argocd)
        prompt "ArgoCD API URL (e.g. https://argocd.example.com, blank to skip): "
        tty_read -r _v; [[ -z "$_v" ]] && { warn "Skipping argocd"; _skip=true; } || _secret_args+=(--from-literal=ARGOCD_API_URL="$_v")
        if ! $_skip; then
          prompt "ArgoCD token: "; tty_read -rs _v; echo ""; _secret_args+=(--from-literal=ARGOCD_TOKEN="$_v")
          prompt "Verify SSL? ${CYAN}[true]${NC}${BOLD}: "; tty_read -r _v; _secret_args+=(--from-literal=ARGOCD_VERIFY_SSL="${_v:-true}")
        fi ;;
      aws)
        prompt "AWS Access Key ID (blank to skip): "
        tty_read -r _v; [[ -z "$_v" ]] && { warn "Skipping aws"; _skip=true; } || _secret_args+=(--from-literal=AWS_ACCESS_KEY_ID="$_v")
        if ! $_skip; then
          prompt "AWS Secret Access Key: "; tty_read -rs _v; echo ""; _secret_args+=(--from-literal=AWS_SECRET_ACCESS_KEY="$_v")
          prompt "AWS Region ${CYAN}[${AWS_REGION:-us-east-1}]${NC}${BOLD}: "; tty_read -r _v; _v="${_v:-${AWS_REGION:-us-east-1}}"
          _secret_args+=(--from-literal=AWS_REGION="$_v" --from-literal=AWS_DEFAULT_REGION="$_v")
        fi ;;
      backstage)
        prompt "Backstage URL (e.g. https://backstage.example.com, blank to skip): "
        tty_read -r _v; [[ -z "$_v" ]] && { warn "Skipping backstage"; _skip=true; } || _secret_args+=(--from-literal=BACKSTAGE_URL="$_v")
        if ! $_skip; then
          prompt "Backstage API token: "; tty_read -rs _v; echo ""; _secret_args+=(--from-literal=BACKSTAGE_API_TOKEN="$_v")
        fi ;;
      confluence)
        prompt "Confluence URL (e.g. https://company.atlassian.net/wiki, blank to skip): "
        tty_read -r _v; [[ -z "$_v" ]] && { warn "Skipping confluence"; _skip=true; } || _secret_args+=(--from-literal=CONFLUENCE_URL="$_v" --from-literal=CONFLUENCE_API_URL="$_v")
        if ! $_skip; then
          prompt "Atlassian email: "; tty_read -r _v; _secret_args+=(--from-literal=CONFLUENCE_USERNAME="$_v" --from-literal=ATLASSIAN_EMAIL="$_v")
          prompt "Atlassian API token: "; tty_read -rs _v; echo ""; _secret_args+=(--from-literal=CONFLUENCE_API_TOKEN="$_v" --from-literal=CONFLUENCE_TOKEN="$_v" --from-literal=ATLASSIAN_TOKEN="$_v")
        fi ;;
      github)
        prompt "GitHub Personal Access Token (blank to skip): "
        tty_read -rs _v; echo ""; [[ -z "$_v" ]] && { warn "Skipping github"; _skip=true; } || _secret_args+=(--from-literal=GITHUB_PERSONAL_ACCESS_TOKEN="$_v" --from-literal=GITHUB_TOKEN="$_v")
        ;;
      jira)
        prompt "Jira/Atlassian API URL (e.g. https://company.atlassian.net, blank to skip): "
        tty_read -r _v; [[ -z "$_v" ]] && { warn "Skipping jira"; _skip=true; } || _secret_args+=(--from-literal=ATLASSIAN_API_URL="$_v" --from-literal=JIRA_URL="$_v")
        if ! $_skip; then
          prompt "Atlassian email: "; tty_read -r _v; _secret_args+=(--from-literal=ATLASSIAN_EMAIL="$_v" --from-literal=JIRA_USERNAME="$_v")
          prompt "Atlassian API token: "; tty_read -rs _v; echo ""; _secret_args+=(--from-literal=ATLASSIAN_TOKEN="$_v" --from-literal=JIRA_API_TOKEN="$_v")
        fi ;;
      komodor)
        prompt "Komodor API URL (e.g. https://app.komodor.com, blank to skip): "
        tty_read -r _v; [[ -z "$_v" ]] && { warn "Skipping komodor"; _skip=true; } || _secret_args+=(--from-literal=KOMODOR_API_URL="$_v")
        if ! $_skip; then
          prompt "Komodor token: "; tty_read -rs _v; echo ""; _secret_args+=(--from-literal=KOMODOR_TOKEN="$_v")
        fi ;;
      pagerduty)
        prompt "PagerDuty API URL ${CYAN}[https://api.pagerduty.com]${NC}${BOLD}: "
        tty_read -r _v; _secret_args+=(--from-literal=PAGERDUTY_API_URL="${_v:-https://api.pagerduty.com}")
        prompt "PagerDuty API key (blank to skip): "; tty_read -rs _v; echo ""
        [[ -z "$_v" ]] && { warn "Skipping pagerduty"; _skip=true; } || _secret_args+=(--from-literal=PAGERDUTY_API_KEY="$_v") ;;
      slack)
        prompt "Slack Bot Token (xoxb-..., blank to skip): "
        tty_read -rs _v; echo ""; [[ -z "$_v" ]] && { warn "Skipping slack"; _skip=true; } || _secret_args+=(--from-literal=SLACK_BOT_TOKEN="$_v")
        if ! $_skip; then
          prompt "Slack App Token (xapp-..., optional): "; tty_read -rs _v; echo ""; [[ -n "$_v" ]] && _secret_args+=(--from-literal=SLACK_APP_TOKEN="$_v")
          prompt "Slack Signing Secret (optional): "; tty_read -rs _v; echo ""; [[ -n "$_v" ]] && _secret_args+=(--from-literal=SLACK_SIGNING_SECRET="$_v")
          prompt "Slack Team ID (optional): "; tty_read -r _v; [[ -n "$_v" ]] && _secret_args+=(--from-literal=SLACK_TEAM_ID="$_v")
        fi ;;
      splunk)
        prompt "Splunk API URL (e.g. https://splunk.example.com:8089, blank to skip): "
        tty_read -r _v; [[ -z "$_v" ]] && { warn "Skipping splunk"; _skip=true; } || _secret_args+=(--from-literal=SPLUNK_API_URL="$_v")
        if ! $_skip; then
          prompt "Splunk token: "; tty_read -rs _v; echo ""; _secret_args+=(--from-literal=SPLUNK_TOKEN="$_v")
        fi ;;
      webex)
        prompt "Webex Bot Token (blank to skip): "
        tty_read -rs _v; echo ""; [[ -z "$_v" ]] && { warn "Skipping webex"; _skip=true; } || _secret_args+=(--from-literal=WEBEX_INTEGRATION_BOT_ACCESS_TOKEN="$_v")
        if ! $_skip; then
          prompt "Webex Webhook Secret (optional): "; tty_read -rs _v; echo ""; [[ -n "$_v" ]] && _secret_args+=(--from-literal=WEBEX_WEBHOOK_SECRET="$_v")
        fi ;;
    esac

    if ! $_skip && [[ ${#_secret_args[@]} -gt 0 ]]; then
      kubectl create secret generic "$_secret_name" \
        -n caipe "${_secret_args[@]}" \
        --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
      HELM_AGENT_ARGS+=(
        --set "tags.mcp-${_agent}=true"
        --set "mcp-${_agent}.agentSecrets.secretName=${_secret_name}"
      )
      log "${_agent}: secret created"
    else
      $_skip && HELM_AGENT_ARGS+=(--set "tags.mcp-${_agent}=false")
    fi
  done

  # Disable all agents NOT in SELECTED_AGENTS
  local -a _all_agents=(argocd aws backstage confluence github gitlab jira komodor netutils pagerduty slack splunk webex aigateway)
  for _agent in "${_all_agents[@]}"; do
    local _selected=false
    for _s in "${SELECTED_AGENTS[@]}"; do [[ "$_agent" == "$_s" ]] && { _selected=true; break; }; done
    $_selected || HELM_AGENT_ARGS+=(--set "tags.mcp-${_agent}=false")
  done

  echo ""
  log "Dynamic Agents runtime included (chat and custom agent builder)"

  if $ENABLE_TRACING; then
    log "Langfuse tracing already enabled (detected from cluster)"
    if ! ask_yn "Keep Langfuse tracing?" "y"; then ENABLE_TRACING=false; fi
  else
    if ask_yn "Enable Langfuse tracing (observability)?" "n"; then
      ENABLE_TRACING=true
      log "Tracing enabled"
    else
      log "Tracing skipped"
    fi
  fi

  # AgentGateway, Keycloak, and OpenFGA are required components in 0.5.10+.
  # They are always enabled; the flags remain so env-var overrides still work.
  ENABLE_AGENTGATEWAY=true
  ENABLE_RBAC_RUNTIME=true
  log "AgentGateway enabled (required — federates MCP servers)"
  log "RBAC runtime enabled (required — Keycloak + OpenFGA + ext_authz)"

  echo ""
  echo -e "  ${DIM}Dynamic-agent checkpoints use the caipe-mongodb service in the baseline stack.${NC}"

  echo ""
  echo -e "  ${DIM}MetalLB provides real LoadBalancer IPs for kind clusters. Required for ingress.${NC}"
  local _metallb_default="n"; $ENABLE_METALLB && _metallb_default="y"
  if ask_yn "Enable MetalLB (LoadBalancer support for kind)?" "$_metallb_default"; then
    ENABLE_METALLB=true
    log "MetalLB enabled"

    echo ""
    echo -e "  ${DIM}nginx-ingress + a domain lets you access the UI at https://<domain> instead of localhost.${NC}"
    local _ingress_default="n"; $ENABLE_INGRESS && _ingress_default="y"
    if ask_yn "Enable nginx-ingress and expose UI via a domain?" "$_ingress_default"; then
      ENABLE_INGRESS=true
      prompt "Enter the domain hostname (e.g. my-caipe.example.com) [${CAIPE_DOMAIN_DEFAULT}]: "
      tty_read -r CAIPE_DOMAIN
      local _used_default_domain=false
      if [[ -z "$CAIPE_DOMAIN" ]]; then
        CAIPE_DOMAIN="$CAIPE_DOMAIN_DEFAULT"
        _used_default_domain=true
        log "No hostname provided — using default: ${CAIPE_DOMAIN} (resolves to 127.0.0.1 via *.local.me)"
      fi
      log "Ingress enabled for: ${CAIPE_DOMAIN}"

      echo ""
      if $_used_default_domain; then
        # Local-dev default (*.local.me) — no public cert authority will
        # issue for this, so always self-sign and skip the auto-detect /
        # manual prompt flow entirely.
        _announce_self_signed "${CAIPE_DOMAIN}" "default hostname — no public CA can issue for *.local.me"
      else
        # Auto-detect certs in common locations
        local _auto_cert="" _auto_key=""
        local _cert_search_paths=(
          "$HOME/certs/fullchain.pem"   "$HOME/certs/cert.pem"   "$HOME/certs/tls.crt"
          "$HOME/.certs/fullchain.pem"  "$HOME/.certs/cert.pem"
          "/etc/letsencrypt/live/${CAIPE_DOMAIN}/fullchain.pem"
          "/etc/letsencrypt/live/${CAIPE_DOMAIN}/cert.pem"
          "/etc/ssl/certs/${CAIPE_DOMAIN}.pem"
        )
        local _key_search_paths=(
          "$HOME/certs/privkey.pem"     "$HOME/certs/key.pem"    "$HOME/certs/tls.key"
          "$HOME/.certs/privkey.pem"    "$HOME/.certs/key.pem"
          "/etc/letsencrypt/live/${CAIPE_DOMAIN}/privkey.pem"
          "/etc/ssl/private/${CAIPE_DOMAIN}.key"
        )
        for _p in "${_cert_search_paths[@]}"; do
          [[ -f "$_p" ]] && { _auto_cert="$_p"; break; }
        done
        for _p in "${_key_search_paths[@]}"; do
          [[ -f "$_p" ]] && { _auto_key="$_p"; break; }
        done

        if [[ -n "$_auto_cert" && -n "$_auto_key" ]]; then
          echo -e "  ${GREEN}  ✓${NC} Auto-detected TLS certificates:"
          echo -e "      cert: ${_auto_cert}"
          echo -e "      key:  ${_auto_key}"
          if ask_yn "Use these certificates?" "y"; then
            TLS_CERT_FILE="$_auto_cert"
            TLS_KEY_FILE="$_auto_key"
            log "Using auto-detected TLS cert: ${TLS_CERT_FILE}"
          else
            _auto_cert=""  # fall through to manual prompt
          fi
        fi

        if [[ -z "$_auto_cert" ]]; then
          echo -e "  ${DIM}Provide custom TLS cert/key files, or leave blank to generate a self-signed cert.${NC}"
          while true; do
            prompt "TLS cert file path (leave blank for self-signed): "
            tty_read -r TLS_CERT_FILE
            TLS_CERT_FILE="${TLS_CERT_FILE/#\~/$HOME}"
            if [[ -z "$TLS_CERT_FILE" ]]; then
              _announce_self_signed "${CAIPE_DOMAIN}" "no TLS cert provided"
              break
            elif [[ ! -f "$TLS_CERT_FILE" ]]; then
              warn "File not found: ${TLS_CERT_FILE}"
            else
              while true; do
                prompt "TLS key file path: "
                tty_read -r TLS_KEY_FILE
                TLS_KEY_FILE="${TLS_KEY_FILE/#\~/$HOME}"
                if [[ -z "$TLS_KEY_FILE" ]]; then
                  err "TLS key file is required when cert is provided"
                elif [[ ! -f "$TLS_KEY_FILE" ]]; then
                  warn "File not found: ${TLS_KEY_FILE}"
                else
                  log "Using custom TLS cert: ${TLS_CERT_FILE}"
                  break
                fi
              done
              break
            fi
          done
        fi
      fi

      # Offer GitHub social login now that the public domain is known (in-chart
      # Keycloak only). Declining keeps local Keycloak username/password.
      prompt_github_social
    else
      ENABLE_INGRESS=false
      log "Ingress skipped"
    fi
  else
    ENABLE_METALLB=false
    ENABLE_INGRESS=false
    log "MetalLB skipped"
  fi
}

# ─── Env-file based agent + UI secret provisioning ───────────────────────────

# Read a single key from a .env-style file. Strips surrounding quotes.
# Always exits 0 (grep returning 1 on no-match must not kill set -euo pipefail).
# Usage: _env_get FILE KEY
_env_get() {
  local file="$1" key="$2"
  grep -m1 "^${key}=" "$file" 2>/dev/null \
    | cut -d'=' -f2- \
    | sed "s/^['\"]//;s/['\"]$//" \
    || true
}

# Read a boolean-ish flag from .env: returns 0 (true) if value is true/yes/1.
_env_true() {
  local val
  val=$(echo "$1" | tr '[:upper:]' '[:lower:]')
  [[ "$val" == "true" || "$val" == "yes" || "$val" == "1" ]]
}

_compose_env_file() {
  if [[ -n "${COMPOSE_ENV_FILE:-}" ]]; then
    echo "$COMPOSE_ENV_FILE"
  elif [[ -n "${ENV_FILE:-}" ]]; then
    echo "$ENV_FILE"
  else
    echo ".env"
  fi
}

_ensure_compose_env_file() {
  local env_file="$1"
  if [[ -f "$env_file" ]]; then
    return 0
  fi
  if [[ ! -f ".env.example" ]]; then
    err "Env file not found: ${env_file}; .env.example is also missing"
    exit 1
  fi
  cp .env.example "$env_file"
  log "Created ${env_file} from .env.example"
}

_compose_env_edit_target() {
  local env_file="$1"
  if [[ ! -L "$env_file" ]]; then
    echo "$env_file"
    return 0
  fi

  local target
  target=$(readlink "$env_file")
  if [[ "$target" != /* ]]; then
    local env_dir
    env_dir=$(cd "$(dirname "$env_file")" && pwd)
    target="${env_dir}/${target}"
  fi

  echo "$target"
}

_update_compose_image_tag() {
  local env_file="$1"
  _ensure_compose_env_file "$env_file"
  local latest
  if command -v gh &>/dev/null; then
    latest=$(gh release view --repo caipe-io/ai-platform-engineering --json tagName -q .tagName)
  elif command -v curl &>/dev/null; then
    latest=$(curl -sf "https://api.github.com/repos/caipe-io/ai-platform-engineering/releases/latest" \
      | jq .tag_name)
  else
    err "Either GitHub CLI (gh) or curl is required to fetch the latest CAIPE release"
    err "Install gh/curl or edit IMAGE_TAG in ${env_file} manually."
    exit 1
  fi
  latest="${latest#v}"
  if [[ -z "$latest" ]]; then
    err "Could not resolve the latest CAIPE release tag"
    exit 1
  fi

  local edit_file
  edit_file=$(_compose_env_edit_target "$env_file")
  if [[ ! -f "$edit_file" ]]; then
    err "Compose env file target is not a regular file: ${edit_file}"
    exit 1
  fi

  cp "$edit_file" "${env_file}.bak"
  if grep -q '^IMAGE_TAG=' "$edit_file"; then
    local tmp_file
    tmp_file=$(mktemp "${edit_file}.XXXXXX")
    awk -v latest="$latest" '
      /^IMAGE_TAG=/ { print "IMAGE_TAG=" latest; next }
      { print }
    ' "$edit_file" > "$tmp_file"
    mv "$tmp_file" "$edit_file"
  else
    printf '\nIMAGE_TAG=%s\n' "$latest" >> "$edit_file"
  fi

  if [[ "$edit_file" != "$env_file" ]]; then
    log "Updated IMAGE_TAG=${latest} in ${env_file} -> ${edit_file} (backup: ${env_file}.bak)"
  else
    log "Updated IMAGE_TAG=${latest} in ${env_file} (backup: ${env_file}.bak)"
  fi
}

# Create a Kubernetes generic secret from a list of key names sourced from a
# .env file. Keys with empty values are silently skipped. The secret is applied
# idempotently (--dry-run=client | kubectl apply). No values are written to
# disk or logged.
#
# Usage: _create_secret_from_env ENV_FILE SECRET_NAME NAMESPACE KEY [KEY ...]
_create_secret_from_env() {
  local env_file="$1" secret_name="$2" ns="$3"
  shift 3
  local keys=("$@")
  local literal_args=()
  for key in "${keys[@]}"; do
    local val
    val=$(_env_get "$env_file" "$key")
    if [[ -n "$val" ]]; then literal_args+=(--from-literal="${key}=${val}"); fi
  done
  if [[ ${#literal_args[@]} -eq 0 ]]; then
    return 0  # nothing to create
  fi
  kubectl create secret generic "$secret_name" \
    "${literal_args[@]}" \
    -n "$ns" --dry-run=client -o yaml \
    | kubectl apply -f - &>/dev/null || {
      warn "Secret ${secret_name} apply returned non-zero (check kubectl access)"
    }
}

# Maps each Helm agent tag to:  (tag_name  secret_name  env_enable_key  keys...)
# declare -A can't hold arrays so we use parallel indexed arrays.
_AGENT_TAGS=(argocd github gitlab jira confluence backstage slack pagerduty webex komodor aws splunk)

_agent_enable_key() {
  case "$1" in
    argocd) echo "ENABLE_ARGOCD" ;;
    github) echo "ENABLE_GITHUB" ;;
    gitlab) echo "ENABLE_GITLAB" ;;
    jira) echo "ENABLE_JIRA" ;;
    confluence) echo "ENABLE_CONFLUENCE" ;;
    backstage) echo "ENABLE_BACKSTAGE" ;;
    slack) echo "ENABLE_SLACK" ;;
    pagerduty) echo "ENABLE_PAGERDUTY" ;;
    webex) echo "ENABLE_WEBEX" ;;
    komodor) echo "ENABLE_KOMODOR" ;;
    aws) echo "ENABLE_AWS" ;;
    splunk) echo "ENABLE_SPLUNK" ;;
  esac
}

_agent_secret_keys() {
  case "$1" in
    argocd) echo "ARGOCD_TOKEN ARGOCD_API_URL ARGOCD_VERIFY_SSL" ;;
    github) echo "GITHUB_PERSONAL_ACCESS_TOKEN" ;;
    gitlab) echo "GITLAB_PERSONAL_ACCESS_TOKEN GITLAB_API_URL" ;;
    jira) echo "ATLASSIAN_TOKEN ATLASSIAN_EMAIL ATLASSIAN_API_URL JIRA_URL JIRA_USERNAME JIRA_API_TOKEN JIRA_SSL_VERIFY" ;;
    confluence) echo "CONFLUENCE_API_TOKEN CONFLUENCE_USERNAME CONFLUENCE_URL CONFLUENCE_API_URL CONFLUENCE_SSL_VERIFY ATLASSIAN_TOKEN ATLASSIAN_EMAIL ATLASSIAN_API_URL ATLASSIAN_VERIFY_SSL" ;;
    backstage) echo "BACKSTAGE_API_TOKEN BACKSTAGE_URL" ;;
    slack) echo "SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_SIGNING_SECRET SLACK_CLIENT_SECRET SLACK_TEAM_ID" ;;
    pagerduty) echo "PAGERDUTY_API_KEY PAGERDUTY_API_URL" ;;
    webex) echo "WEBEX_INTEGRATION_BOT_ACCESS_TOKEN" ;;
    komodor) echo "KOMODOR_TOKEN KOMODOR_API_URL" ;;
    aws) echo "AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION AWS_DEFAULT_REGION AWS_BEDROCK_MODEL_ID AWS_BEDROCK_PROVIDER AWS_BEDROCK_ENABLE_PROMPT_CACHE" ;;
    splunk) echo "SPLUNK_TOKEN SPLUNK_API_URL" ;;
  esac
}

# Called from create_namespace_and_secrets when ENV_FILE is set.
# Creates per-agent k8s secrets and populates HELM_AGENT_ARGS (global array)
# with the --set flags to wire them into the Helm deploy.
HELM_AGENT_ARGS=()

provision_agent_secrets() {
  local env_file="$1"
  step "Provisioning agent secrets from env file"

  for agent in "${_AGENT_TAGS[@]}"; do
    local enable_key
    enable_key=$(_agent_enable_key "$agent")
    local enable_val
    enable_val=$(_env_get "$env_file" "$enable_key")
    if ! _env_true "$enable_val"; then
      continue
    fi

    # shellcheck disable=SC2206
    local keys=($(_agent_secret_keys "$agent"))
    local secret_name="caipe-${agent}-secret"

    _create_secret_from_env "$env_file" "$secret_name" caipe "${keys[@]}"
    log "Agent ${agent}: secret '${secret_name}' ready"

    # tags.mcp-* deploys the MCP server as its own service.
    HELM_AGENT_ARGS+=(
      --set "tags.mcp-${agent}=true"
      --set "mcp-${agent}.agentSecrets.secretName=${secret_name}"
    )
  done
}

# Called from create_namespace_and_secrets when UI_ENV_FILE is set.
# Creates a caipe-ui-secret and adds the Helm flag to wire it in.
HELM_UI_SECRET_ARGS=()

provision_ui_secret() {
  local ui_env_file="$1"
  step "Provisioning UI secret from env file"

  local ui_keys=(
    NEXTAUTH_SECRET NEXTAUTH_URL
    OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET
    OIDC_REQUIRED_GROUP OIDC_REQUIRED_ADMIN_GROUP OIDC_ENABLE_REFRESH_TOKEN
    INGESTOR_OIDC_ISSUER INGESTOR_OIDC_CLIENT_ID INGESTOR_OIDC_CLIENT_SECRET
    MONGODB_URI MONGODB_DATABASE MONGODB_ROOT_USERNAME MONGODB_ROOT_PASSWORD
    RAG_SERVER_URL PROMETHEUS_URL
    LANGFUSE_SECRET_KEY LANGFUSE_PUBLIC_KEY LANGFUSE_HOST
    RBAC_CLIENT_CREDENTIALS_ROLE
  )

  _create_secret_from_env "$ui_env_file" "caipe-ui-secret" caipe "${ui_keys[@]}"

  # When a public domain is set, override localhost-defaulted secrets with
  # the correct values for a k8s deployment.
  if [[ -n "$CAIPE_DOMAIN" ]]; then
    local _patches=()
    _patches+=("{\"op\":\"add\",\"path\":\"/data/NEXTAUTH_URL\",\"value\":\"$(echo -n "https://${CAIPE_DOMAIN}" | base64 -w0)\"}")
    # RAG BFF: Next.js server-side calls use the in-cluster service, not localhost
    _patches+=("{\"op\":\"add\",\"path\":\"/data/RAG_SERVER_URL\",\"value\":\"$(echo -n "http://rag-server:${RAG_SERVER_PORT}" | base64 -w0)\"}")
    # In-chart Keycloak SSO over a public DNS domain: the dev env file points
    # OIDC at localhost:7080, which is unreachable from the pod (ECONNREFUSED at
    # signin). Rewrite to the public issuer (browser + token `iss`) while server
    # discovery uses the in-cluster service (OIDC_DISCOVERY_URL is the issuer
    # BASE; the app appends /.well-known/openid-configuration). Also clear the
    # Cisco-specific OIDC_REQUIRED_GROUP=backstage-access copied from the dev env
    # file so any authenticated Keycloak user is admitted (chart default = empty).
    if $ENABLE_RBAC_RUNTIME && [[ ! "$CAIPE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      _patches+=("{\"op\":\"add\",\"path\":\"/data/OIDC_ISSUER\",\"value\":\"$(echo -n "https://${CAIPE_DOMAIN}/realms/caipe" | base64 -w0)\"}")
      _patches+=("{\"op\":\"add\",\"path\":\"/data/OIDC_DISCOVERY_URL\",\"value\":\"$(echo -n "http://caipe-keycloak:8080/realms/caipe" | base64 -w0)\"}")
      _patches+=("{\"op\":\"add\",\"path\":\"/data/OIDC_REQUIRED_GROUP\",\"value\":\"$(echo -n "" | base64 -w0)\"}")
    fi
    kubectl patch secret caipe-ui-secret -n caipe --type='json' \
      -p="[$(IFS=,; echo "${_patches[*]}")]" 2>/dev/null || true
    log "NEXTAUTH_URL overridden to https://${CAIPE_DOMAIN}"
    log "RAG_SERVER_URL overridden to http://rag-server:${RAG_SERVER_PORT} (cluster service)"
    if $ENABLE_RBAC_RUNTIME && [[ ! "$CAIPE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      log "OIDC issuer -> https://${CAIPE_DOMAIN}/realms/caipe (discovery via in-cluster caipe-keycloak; group gate cleared)"
    fi
  fi

  log "UI secret 'caipe-ui-secret' ready"
  HELM_UI_SECRET_ARGS+=(--set "caipe-ui.existingSecret=caipe-ui-secret")

  # Also pass SSO_ENABLED via Helm env so it takes effect at runtime
  if [[ -n "$CAIPE_DOMAIN" ]]; then
    HELM_UI_SECRET_ARGS+=(--set "caipe-ui.env.SSO_ENABLED=true")
  fi

  # Propagate NEXT_PUBLIC_* and feature flags as Helm env overrides
  local next_public_keys=(
    NEXT_PUBLIC_SSO_ENABLED
    NEXT_PUBLIC_ENABLE_SUBAGENT_CARDS NEXT_PUBLIC_RAG_ENABLED
    NEXT_PUBLIC_RAG_URL NEXT_PUBLIC_RAG_WEBUI_URL NEXT_PUBLIC_MONGODB_ENABLED
    AUDIT_LOGS_ENABLED WORKFLOW_RUNNER_ENABLED FEEDBACK_ENABLED NPS_ENABLED
    DYNAMIC_AGENTS_URL
  )
  for key in "${next_public_keys[@]}"; do
    local val
    val=$(_env_get "$ui_env_file" "$key")
    if [[ -n "$val" ]]; then
      HELM_UI_SECRET_ARGS+=(--set "caipe-ui.env.${key}=${val}")
    fi
  done
}

# ─── Chat-bot surfaces (slack-bot / webex-bot) ───────────────────────────────
# These mirror the slack-bot / webex-bot profiles in docker-compose.dev.yaml.
# They are deployed via the umbrella chart's slack-bot / webex-bot subcharts
# (tags.slack-bot / tags.webex-bot) wired onto the in-chart Keycloak + OpenFGA +
# MongoDB stack. Bot tokens go into k8s Secrets (envFrom secretRef); non-secret
# wiring goes into the subchart `config:` map written by _write_bot_values.
HELM_BOT_ARGS=()

# Create slack-bot-secrets / webex-bot-secrets from the env file (tokens only).
# Falls back to the committed dev client secrets (realm-config.json) for the
# Keycloak OBO/admin clients ONLY in local dev (no public domain), so the bot
# can do RBAC user-lookup + token-exchange against the in-chart Keycloak.
provision_bot_secrets() {
  local env_file="${1:-}"
  step "Provisioning chat-bot secrets"

  if $ENABLE_SLACK_BOT; then
    local _slack_keys=(
      SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_SIGNING_SECRET SLACK_CLIENT_SECRET
      SLACK_INTEGRATION_AUTH_CLIENT_SECRET
      KEYCLOAK_BOT_CLIENT_SECRET OAUTH2_CLIENT_SECRET
    )
    local _slack_literals=()
    if [[ -n "$env_file" && -f "$env_file" ]]; then
      local _k _v
      for _k in "${_slack_keys[@]}"; do
        _v=$(_env_get "$env_file" "$_k")
        [[ -n "$_v" ]] && _slack_literals+=(--from-literal="${_k}=${_v}")
      done
    fi
    # Local-dev OBO defaults (match charts/.../keycloak/realm-config.json).
    if [[ -z "$CAIPE_DOMAIN" ]]; then
      _bot_default_literal _slack_literals "${_slack_literals[*]}" KEYCLOAK_BOT_CLIENT_SECRET caipe-slack-bot-dev-secret
      _bot_default_literal _slack_literals "${_slack_literals[*]}" OAUTH2_CLIENT_SECRET caipe-slack-bot-dev-secret
    fi
    if [[ ${#_slack_literals[@]} -gt 0 ]]; then
      kubectl create secret generic slack-bot-secrets -n caipe "${_slack_literals[@]}" \
        --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
      log "slack-bot: secret 'slack-bot-secrets' ready"
    else
      warn "slack-bot enabled but no Slack tokens found in env file — bot will not start until SLACK_BOT_TOKEN/SLACK_APP_TOKEN are provided"
    fi
  fi

  if $ENABLE_WEBEX_BOT; then
    local _webex_keys=(
      WEBEX_INTEGRATION_BOT_ACCESS_TOKEN WEBEX_TOKEN
      WEBEX_INTEGRATION_AUTH_CLIENT_SECRET KEYCLOAK_WEBEX_BOT_CLIENT_SECRET
    )
    local _webex_literals=()
    if [[ -n "$env_file" && -f "$env_file" ]]; then
      local _k _v
      for _k in "${_webex_keys[@]}"; do
        _v=$(_env_get "$env_file" "$_k")
        [[ -n "$_v" ]] && _webex_literals+=(--from-literal="${_k}=${_v}")
      done
    fi
    if [[ -z "$CAIPE_DOMAIN" ]]; then
      _bot_default_literal _webex_literals "${_webex_literals[*]}" KEYCLOAK_WEBEX_BOT_CLIENT_SECRET caipe-webex-bot-dev-secret
    fi
    if [[ ${#_webex_literals[@]} -gt 0 ]]; then
      kubectl create secret generic webex-bot-secrets -n caipe "${_webex_literals[@]}" \
        --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
      log "webex-bot: secret 'webex-bot-secrets' ready"
    else
      warn "webex-bot enabled but no Webex token found in env file — bot will not start until WEBEX_INTEGRATION_BOT_ACCESS_TOKEN is provided"
    fi
  fi
}

# Append --from-literal=KEY=DEFAULT to the named array unless KEY is already
# present in its current contents. Usage:
#   _bot_default_literal ARRAY_NAME "${ARRAY[*]}" KEY DEFAULT
_bot_default_literal() {
  local _arr_name="$1" _current="$2" _key="$3" _default="$4"
  case " $_current " in
    *"--from-literal=${_key}="*) return 0 ;;  # already set from env file
  esac
  eval "${_arr_name}+=(--from-literal=\"\${_key}=\${_default}\")"
}

# Write a Helm values file enabling the requested bot surfaces and pointing
# them at the in-cluster Keycloak/OpenFGA/MongoDB/UI services (release "caipe").
# Echoes the values-file path (empty if no bot is enabled). MONGODB_URI is built
# from the resolved cluster password (same pattern as dynamic-agents).
_write_bot_values() {
  $ENABLE_SLACK_BOT || $ENABLE_WEBEX_BOT || { printf '%s' ""; return 0; }

  local values_file
  values_file=$(mktemp /tmp/caipe-bot-values-XXXXXX)
  local _mongo_pw="${MONGODB_ROOT_PASSWORD:-MONGODB_ROOT_PASSWORD_UNSET}"
  local _mongo_uri="mongodb://admin:${_mongo_pw}@caipe-mongodb:27017/caipe?authSource=caipe"
  local _kc="http://caipe-keycloak:8080"
  local _issuer="${_kc}/realms/caipe"

  {
    echo "tags:"
    $ENABLE_SLACK_BOT && echo "  slack-bot: true"
    $ENABLE_WEBEX_BOT && echo "  webex-bot: true"
  } >> "$values_file"

  if $ENABLE_SLACK_BOT; then
    cat >> "$values_file" <<SLACKEOF
slack-bot:
  existingSecret: "slack-bot-secrets"
  config:
    CAIPE_API_URL: "http://caipe-caipe-ui:3000"
    SLACK_BOT_MODE: "socket"
    SLACK_INTEGRATION_BOT_MODE: "socket"
    MONGODB_URI: "${_mongo_uri}"
    MONGODB_DATABASE: "caipe"
    KEYCLOAK_URL: "${_kc}"
    KEYCLOAK_REALM: "caipe"
    OPENFGA_HTTP: "http://caipe-openfga:8080"
    OPENFGA_STORE_NAME: "caipe-openfga"
    SLACK_RBAC_ENABLED: "true"
    SLACK_AGENT_ROUTES_MODE: "db_prefer"
    SLACK_ADMIN_API_ENABLED: "true"
    SLACK_ADMIN_API_PORT: "3001"
    SLACK_ADMIN_JWT_ISSUER: "${_issuer}"
    SLACK_ADMIN_JWKS_URL: "${_kc}/realms/caipe/protocol/openid-connect/certs"
    SLACK_ADMIN_JWT_AUDIENCE: "caipe-slack-bot-admin"
    SLACK_ADMIN_ALLOWED_CLIENT_IDS: "caipe-ui"
    SLACK_INTEGRATION_ENABLE_AUTH: "true"
    SLACK_INTEGRATION_AUTH_TOKEN_URL: "${_issuer}/protocol/openid-connect/token"
    SLACK_INTEGRATION_AUTH_CLIENT_ID: "caipe-slack-bot"
    KEYCLOAK_BOT_CLIENT_ID: "caipe-slack-bot"
    SLACK_JIT_CREATE_USER: "true"
SLACKEOF
  fi

  if $ENABLE_WEBEX_BOT; then
    cat >> "$values_file" <<WEBEXEOF
webex-bot:
  existingSecret: "webex-bot-secrets"
  config:
    CAIPE_API_URL: "http://caipe-caipe-ui:3000"
    MONGODB_URI: "${_mongo_uri}"
    MONGODB_DATABASE: "caipe"
    KEYCLOAK_URL: "${_kc}"
    KEYCLOAK_REALM: "caipe"
    OPENFGA_HTTP: "http://caipe-openfga:8080"
    OPENFGA_STORE_NAME: "caipe-openfga"
    KEYCLOAK_WEBEX_BOT_ADMIN_CLIENT_ID: "caipe-platform"
    WEBEX_ADMIN_API_ENABLED: "true"
    WEBEX_ADMIN_API_PORT: "3002"
    WEBEX_ADMIN_JWT_ISSUER: "${_issuer}"
    WEBEX_ADMIN_JWKS_URL: "${_kc}/realms/caipe/protocol/openid-connect/certs"
    WEBEX_ADMIN_JWT_AUDIENCE: "caipe-webex-bot-admin"
    WEBEX_ADMIN_ALLOWED_CLIENT_IDS: "caipe-ui"
WEBEXEOF
  fi

  printf '%s' "$values_file"
}

create_namespace_and_secrets() {
  step "Namespace and secrets"

  if ! kubectl create namespace caipe --dry-run=client -o yaml | kubectl apply -f - 2>&1; then
    err "Failed to create namespace 'caipe' — check your kubectl context and cluster connectivity"
    exit 1
  fi
  log "Namespace 'caipe' ready"

  _ensure_caipe_platform_secret  # must exist before helm install; see PR #1519

  # Rescue embeddings credentials from the existing llm-secret before we
  # overwrite it, so a LLM-provider switch doesn't silently break RAG.
  local _existing_lls
  _existing_lls=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
  if [[ -n "$_existing_lls" ]]; then
    _elv() { echo "$_existing_lls" | jq -r --arg k "$1" '.data[$k] // empty' 2>/dev/null | base64 -d 2>/dev/null || true; }
    if $ENABLE_RAG; then
      case "${EMBEDDINGS_PROVIDER:-}" in
        openai)
          [[ -z "${OPENAI_API_KEY:-}" ]] && OPENAI_API_KEY=$(_elv OPENAI_API_KEY)
          ;;
        azure-openai)
          [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]     && AZURE_OPENAI_API_KEY=$(_elv AZURE_OPENAI_API_KEY)
          [[ -z "${AZURE_OPENAI_ENDPOINT:-}" ]]    && AZURE_OPENAI_ENDPOINT=$(_elv AZURE_OPENAI_ENDPOINT)
          [[ -z "${AZURE_OPENAI_API_VERSION:-}" ]] && AZURE_OPENAI_API_VERSION=$(_elv AZURE_OPENAI_API_VERSION)
          ;;
        aws-bedrock)
          [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]     && AWS_ACCESS_KEY_ID=$(_elv AWS_ACCESS_KEY_ID)
          [[ -z "${AWS_SECRET_ACCESS_KEY:-}" ]] && AWS_SECRET_ACCESS_KEY=$(_elv AWS_SECRET_ACCESS_KEY)
          [[ -z "${AWS_REGION:-}" ]]            && AWS_REGION=$(_elv AWS_REGION)
          ;;
        cohere)
          [[ -z "${COHERE_API_KEY:-}" ]] && COHERE_API_KEY=$(_elv COHERE_API_KEY)
          ;;
        huggingface)
          [[ -z "${HUGGINGFACEHUB_API_TOKEN:-}" ]] && HUGGINGFACEHUB_API_TOKEN=$(_elv HUGGINGFACEHUB_API_TOKEN)
          ;;
        litellm)
          [[ -z "${LITELLM_ENDPOINT:-}" ]]  && LITELLM_ENDPOINT=$(_elv LITELLM_API_BASE)
          [[ -z "${LITELLM_API_KEY:-}" ]]   && LITELLM_API_KEY=$(_elv LITELLM_API_KEY)
          ;;
      esac
    fi
  fi

  local secret_args=()

  if $LLM_VIA_LITELLM; then
    # Unified mode: agents talk to the in-cluster LiteLLM proxy as plain OpenAI.
    # The real upstream provider credentials live only in litellm-upstream-secret
    # (created by deploy_litellm), never in this agent-facing secret. The chat
    # alias "caipe-chat" is resolved by the proxy's model_list to the real model.
    local _lep="http://litellm-proxy.caipe.svc.cluster.local:4000/v1"
    secret_args+=(
      --from-literal=LLM_PROVIDER="openai"
      --from-literal=OPENAI_API_KEY="${LITELLM_MASTER_KEY}"
      --from-literal=OPENAI_ENDPOINT="${_lep}"
      --from-literal=OPENAI_BASE_URL="${_lep}"
      --from-literal=OPENAI_MODEL_NAME="caipe-chat"
    )
  else
  secret_args+=(
    --from-literal=LLM_PROVIDER="$LLM_PROVIDER"
  )

  case "$LLM_PROVIDER" in
    anthropic-claude)
      secret_args+=(
        --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
        --from-literal=ANTHROPIC_MODEL_NAME="$ANTHROPIC_MODEL_NAME"
      )
      ;;
    aws-bedrock)
      secret_args+=(
        --from-literal=AWS_BEDROCK_MODEL_ID="$AWS_BEDROCK_MODEL_ID"
        --from-literal=AWS_BEDROCK_PROVIDER="$AWS_BEDROCK_PROVIDER"
        --from-literal=AWS_REGION="$AWS_REGION"
        --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
        --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
      )
      [[ -n "$AWS_BEDROCK_ENABLE_PROMPT_CACHE" ]] && \
        secret_args+=(--from-literal=AWS_BEDROCK_ENABLE_PROMPT_CACHE="$AWS_BEDROCK_ENABLE_PROMPT_CACHE")
      ;;
    azure-openai)
      secret_args+=(
        --from-literal=AZURE_OPENAI_API_KEY="$AZURE_OPENAI_API_KEY"
        --from-literal=AZURE_OPENAI_ENDPOINT="$AZURE_OPENAI_ENDPOINT"
        --from-literal=AZURE_OPENAI_DEPLOYMENT="$AZURE_OPENAI_DEPLOYMENT"
        --from-literal=AZURE_OPENAI_API_VERSION="$AZURE_OPENAI_API_VERSION"
      )
      ;;
    *)
      secret_args+=(
        --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY:-}"
        --from-literal=OPENAI_ENDPOINT="${OPENAI_ENDPOINT:-}"
        --from-literal=OPENAI_BASE_URL="${OPENAI_ENDPOINT:-}"
        --from-literal=OPENAI_MODEL_NAME="${OPENAI_MODEL_NAME:-}"
      )
      ;;
  esac
  fi

  # When using non-OpenAI LLM with OpenAI embeddings for RAG, the RAG server
  # needs OPENAI_API_KEY in the same secret.
  if $ENABLE_RAG && [[ "$EMBEDDINGS_PROVIDER" == "openai" && "$LLM_PROVIDER" != "openai" && -n "${OPENAI_API_KEY:-}" ]]; then
    secret_args+=(--from-literal=OPENAI_API_KEY="$OPENAI_API_KEY")
    log "Added OPENAI_API_KEY to llm-secret (needed for OpenAI embeddings)"
  fi

  # When using LiteLLM for embeddings, the RAG server needs LITELLM_API_BASE
  # and LITELLM_API_KEY to reach the proxy.
  if $ENABLE_RAG && [[ "$EMBEDDINGS_PROVIDER" == "litellm" && -n "${LITELLM_ENDPOINT:-}" ]]; then
    secret_args+=(
      --from-literal=LITELLM_API_BASE="$LITELLM_ENDPOINT"
      --from-literal=LITELLM_API_KEY="${LITELLM_API_KEY:-not-needed}"
    )
    log "Added LITELLM_API_BASE/LITELLM_API_KEY to llm-secret (needed for LiteLLM embeddings)"
  fi

  # When using Azure OpenAI for embeddings, add the credentials directly into
  # llm-secret. The rag-stack subchart hardcodes envFrom=[llm-secret] and does
  # not expose envFrom as a configurable value, so merging the Azure keys here
  # is the only approach that survives helm upgrades without a post-deploy patch.
  if $ENABLE_RAG && [[ "$EMBEDDINGS_PROVIDER" == "azure-openai" ]]; then
    if [[ -z "${AZURE_OPENAI_API_KEY:-}" || -z "${AZURE_OPENAI_ENDPOINT:-}" ]]; then
      err "Azure OpenAI embeddings require AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT — re-run and select Azure OpenAI embeddings to be prompted for them"
      exit 1
    fi
    secret_args+=(
      --from-literal=AZURE_OPENAI_API_KEY="${AZURE_OPENAI_API_KEY}"
      --from-literal=AZURE_OPENAI_ENDPOINT="${AZURE_OPENAI_ENDPOINT}"
      --from-literal=AZURE_OPENAI_API_VERSION="${AZURE_OPENAI_API_VERSION:-2025-04-01-preview}"
    )
    log "Added AZURE_OPENAI_API_KEY/ENDPOINT/API_VERSION to llm-secret (needed for Azure OpenAI embeddings)"
  fi

  # AWS Bedrock embeddings — reuse the existing AWS_* trio. If the LLM is
  # also aws-bedrock, the AWS_* keys are already in the secret_args bundle
  # above and we don't duplicate them.
  if $ENABLE_RAG && [[ "$EMBEDDINGS_PROVIDER" == "aws-bedrock" && "$LLM_PROVIDER" != "aws-bedrock" ]]; then
    if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
      err "AWS Bedrock embeddings require AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
      exit 1
    fi
    secret_args+=(
      --from-literal=AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}"
      --from-literal=AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}"
      --from-literal=AWS_REGION="${AWS_REGION:-us-east-1}"
    )
    log "Added AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY/REGION to llm-secret (needed for Bedrock embeddings)"
  fi

  # Cohere embeddings — single API key.
  if $ENABLE_RAG && [[ "$EMBEDDINGS_PROVIDER" == "cohere" ]]; then
    if [[ -z "${COHERE_API_KEY:-}" ]]; then
      err "Cohere embeddings require COHERE_API_KEY — re-run and select Cohere embeddings to be prompted for it"
      exit 1
    fi
    secret_args+=(--from-literal=COHERE_API_KEY="${COHERE_API_KEY}")
    log "Added COHERE_API_KEY to llm-secret (needed for Cohere embeddings)"
  fi

  # HuggingFace embeddings — token is optional (only required for gated models).
  if $ENABLE_RAG && [[ "$EMBEDDINGS_PROVIDER" == "huggingface" ]]; then
    if [[ -n "${HUGGINGFACEHUB_API_TOKEN:-}" ]]; then
      secret_args+=(--from-literal=HUGGINGFACEHUB_API_TOKEN="${HUGGINGFACEHUB_API_TOKEN}")
      log "Added HUGGINGFACEHUB_API_TOKEN to llm-secret (for gated HF models)"
    fi
    secret_args+=(--from-literal=EMBEDDINGS_DEVICE="${EMBEDDINGS_DEVICE:-cpu}")
    log "HuggingFace embeddings configured (device: ${EMBEDDINGS_DEVICE:-cpu})"
  fi

  # Ollama embeddings — the RAG server (EmbeddingsFactory) reads OLLAMA_BASE_URL,
  # whose default http://localhost:11434 is the pod's own loopback and cannot
  # reach Ollama. Wire it explicitly into llm-secret, defaulting to the
  # in-cluster Ollama Service (deploy/kind/ollama.yaml); override with the
  # OLLAMA_BASE_URL env var for an external/host Ollama.
  # EMBEDDINGS_MODEL is also written so the Ollama init container (which reads
  # it via an optional secretKeyRef) can pull the embedding model on first run.
  if $ENABLE_RAG && [[ "$EMBEDDINGS_PROVIDER" == "ollama" ]]; then
    local _ollama_base="${OLLAMA_BASE_URL:-http://ollama.${CAIPE_NAMESPACE:-caipe}.svc.cluster.local:${OLLAMA_PORT}}"
    secret_args+=(--from-literal=OLLAMA_BASE_URL="${_ollama_base}")
    secret_args+=(--from-literal=EMBEDDINGS_MODEL="${EMBEDDINGS_MODEL}")
    log "Added OLLAMA_BASE_URL=${_ollama_base} to llm-secret (Ollama embeddings)"
    log "Added EMBEDDINGS_MODEL=${EMBEDDINGS_MODEL} to llm-secret (Ollama init container pull)"
  fi

  kubectl create secret generic llm-secret -n caipe \
    "${secret_args[@]}" \
    --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
  log "llm-secret created (provider: ${LLM_PROVIDER})"

  if [[ -n "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_FILE" ]]; then
      err "Env file not found: ${ENV_FILE}"
      exit 1
    fi
    provision_agent_secrets "$ENV_FILE"
  fi

  if [[ -n "$UI_ENV_FILE" ]]; then
    if [[ ! -f "$UI_ENV_FILE" ]]; then
      err "UI env file not found: ${UI_ENV_FILE}"
      exit 1
    fi
    provision_ui_secret "$UI_ENV_FILE"
  fi

  # Keycloak "platform" confidential-client secret for the BFF -> Keycloak Admin
  # REST wiring. The chart references an existing Secret named
  # caipe-platform-secret (caipe-ui.keycloakAdminClient.secretName +
  # keycloak.platformClient.secretRef both default to it) but, unless ESO is
  # enabled, NOTHING creates it — so the caipe-ui pod stays in
  # CreateContainerConfigError once SSO is on (SSO is auto-enabled when a domain
  # is set). Pre-create it whenever the in-chart Keycloak (RBAC runtime) is used.
  # The value is the caipe-platform client secret; in the committed dev realm
  # that is caipe-platform-dev-secret (env KEYCLOAK_CLIENT_SECRET).
  if $ENABLE_RBAC_RUNTIME; then
    local _platform_client_secret=""
    if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
      _platform_client_secret=$(_env_get "$ENV_FILE" KEYCLOAK_CLIENT_SECRET)
    fi
    [[ -z "$_platform_client_secret" ]] && _platform_client_secret="caipe-platform-dev-secret"
    kubectl create secret generic caipe-platform-secret -n caipe \
      --from-literal=OIDC_CLIENT_SECRET="$_platform_client_secret" \
      --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
    log "caipe-platform-secret ready (Keycloak platform client -> caipe-ui admin REST)"
  fi

  # caipe-ui-secret for the DEFAULT (no --ui-env-file) SSO install: NextAuth needs
  # a stable NEXTAUTH_SECRET to sign sessions, and the UI authenticates to
  # Keycloak as the caipe-ui confidential client (the committed dev realm ships
  # secret caipe-ui-dev-secret). With a --ui-env-file these come from
  # provision_ui_secret; here we synthesize them so a vanilla install can do SSO.
  # NEXTAUTH_SECRET is generated once and persisted (idempotent re-runs). These
  # MUST live in the Secret (not config) so the chart's envFrom secretRef wins
  # over the empty config defaults.
  if $ENABLE_RBAC_RUNTIME && [[ -z "$UI_ENV_FILE" ]]; then
    local _ui_nextauth
    _ui_nextauth=$(kubectl get secret caipe-ui-secret -n caipe \
      -o jsonpath='{.data.NEXTAUTH_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true)
    [[ -z "$_ui_nextauth" ]] && _ui_nextauth="$(openssl rand -hex 32)"
    local _ui_client_id="${OIDC_CLIENT_ID:-caipe-ui}"
    local _ui_client_secret="${OIDC_CLIENT_SECRET:-caipe-ui-dev-secret}"
    # OIDC_CLIENT_ID MUST be provided too: NextAuth's oidc provider throws
    # "client_id is required" (login error=OAuthSignin) if only the secret is set.
    # The chart default config.OIDC_CLIENT_ID is empty, so without this the UI can
    # never start the auth flow. Keep it in the Secret alongside the secret so the
    # envFrom secretRef wins over the empty config default.
    kubectl create secret generic caipe-ui-secret -n caipe \
      --from-literal=NEXTAUTH_SECRET="$_ui_nextauth" \
      --from-literal=OIDC_CLIENT_ID="$_ui_client_id" \
      --from-literal=OIDC_CLIENT_SECRET="$_ui_client_secret" \
      --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
    HELM_UI_SECRET_ARGS+=(--set "caipe-ui.existingSecret=caipe-ui-secret")
    log "caipe-ui-secret ready (NextAuth secret + caipe-ui client id/secret; default SSO)"
  fi

  # Inject AGENTGATEWAY_TARGETS_TOKEN into caipe-ui-secret so the config-bridge
  # sidecar and the BFF share the same bearer token. Generated once and persisted
  # (idempotent re-runs). Both code paths above (--ui-env-file and default SSO)
  # produce caipe-ui-secret before this point.
  if $ENABLE_AGENTGATEWAY; then
    local _ag_token
    _ag_token=$(kubectl get secret caipe-ui-secret -n caipe \
      -o jsonpath='{.data.AGENTGATEWAY_TARGETS_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)
    [[ -z "$_ag_token" ]] && _ag_token="$(openssl rand -hex 32)"
    kubectl patch secret caipe-ui-secret -n caipe --type='json' \
      -p="[{\"op\":\"add\",\"path\":\"/data/AGENTGATEWAY_TARGETS_TOKEN\",\"value\":\"$(echo -n "$_ag_token" | base64 -w0)\"}]" &>/dev/null
    log "AGENTGATEWAY_TARGETS_TOKEN patched into caipe-ui-secret"

    # Shared HMAC for signed agent_id context (dynamic-agents + openfga-authz-bridge).
    # Prefer an existing value in the secret or .env; generate once when missing.
    local _hmac_secret
    _hmac_secret=$(kubectl get secret caipe-ui-secret -n caipe \
      -o jsonpath='{.data.CAIPE_AGENT_CONTEXT_HMAC_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true)
    if [[ -z "$_hmac_secret" && -n "${ENV_FILE:-}" ]]; then
      _hmac_secret=$(_env_get "$ENV_FILE" "CAIPE_AGENT_CONTEXT_HMAC_SECRET" || true)
    fi
    if [[ -z "$_hmac_secret" && -n "${UI_ENV_FILE:-}" ]]; then
      _hmac_secret=$(_env_get "$UI_ENV_FILE" "CAIPE_AGENT_CONTEXT_HMAC_SECRET" || true)
    fi
    [[ -z "$_hmac_secret" ]] && _hmac_secret="$(openssl rand -hex 32)"
    kubectl patch secret caipe-ui-secret -n caipe --type='json' \
      -p="[{\"op\":\"add\",\"path\":\"/data/CAIPE_AGENT_CONTEXT_HMAC_SECRET\",\"value\":\"$(echo -n "$_hmac_secret" | base64 -w0)\"}]" &>/dev/null
    log "CAIPE_AGENT_CONTEXT_HMAC_SECRET patched into caipe-ui-secret"
  fi

  # Chat-bot surfaces (slack-bot / webex-bot). Token secrets are created here;
  # the Helm tags + in-cluster config (incl. MONGODB_URI built from the resolved
  # cluster password) are written by _write_bot_values and applied in deploy_caipe.
  if $ENABLE_SLACK_BOT || $ENABLE_WEBEX_BOT; then
    provision_bot_secrets "$ENV_FILE"
  fi
}

_fix_langfuse_minio_credentials() {
  local expected_pw="${1:-}"

  # If no password passed, read what Langfuse-web expects from its env
  if [[ -z "$expected_pw" ]]; then
    expected_pw=$(kubectl get deployment langfuse-web -n langfuse \
      -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY")].value}' 2>/dev/null || true)
  fi
  [[ -z "$expected_pw" ]] && return 0

  # Read what MinIO is actually using
  local actual_pw
  actual_pw=$(kubectl get secret langfuse-s3 -n langfuse \
    -o jsonpath='{.data.root-password}' 2>/dev/null | base64 -d 2>/dev/null || true)

  if [[ "$actual_pw" != "$expected_pw" ]]; then
    log "Syncing MinIO credentials with Langfuse S3 config..."
    kubectl patch secret langfuse-s3 -n langfuse --type='json' \
      -p="[{\"op\":\"replace\",\"path\":\"/data/root-password\",\"value\":\"$(echo -n "$expected_pw" | base64)\"}]" &>/dev/null || true
    kubectl set env deployment/langfuse-s3 -n langfuse \
      MINIO_ROOT_PASSWORD="$expected_pw" &>/dev/null || true
    log "MinIO credentials synced"
  fi
}

deploy_langfuse() {
  step "Deploying Langfuse"

  # If Langfuse is already deployed and healthy, skip re-deploy to avoid
  # password mismatch (new passwords vs existing PostgreSQL PVC data).
  if helm status langfuse -n langfuse &>/dev/null; then
    local ready
    ready=$(kubectl get pods -n langfuse --no-headers 2>/dev/null \
      | awk '$3=="Running" && $2~"^[0-9]+/[0-9]+$" {split($2,a,"/"); if(a[1]==a[2]) print}' \
      | wc -l | tr -d ' ')
    if [[ "$ready" -gt 0 ]]; then
      log "Langfuse already deployed (${ready} pods running) — skipping"
      return
    fi
    warn "Langfuse release exists but pods are unhealthy; re-deploying"
    helm uninstall langfuse -n langfuse &>/dev/null || true
    kubectl delete pvc --all -n langfuse &>/dev/null || true
    sleep 5
  fi

  helm repo add langfuse https://langfuse.github.io/langfuse-k8s &>/dev/null 2>&1 || true
  # Scope to the langfuse repo and tolerate failure so an unrelated unreachable
  # repo in the user's global helm config can't abort the script under `set -e`.
  helm repo update langfuse &>/dev/null || true
  log "Langfuse Helm repo ready"

  kubectl create namespace langfuse --dry-run=client -o yaml | kubectl apply -f - &>/dev/null

  # Use hex for passwords to avoid special chars that break connection-string URLs
  local salt enc_key nextauth_secret pg_pw ch_pw redis_pw minio_pw
  salt=$(openssl rand -hex 24)
  enc_key=$(openssl rand -hex 32)
  nextauth_secret=$(openssl rand -hex 24)
  pg_pw=$(openssl rand -hex 16)
  ch_pw=$(openssl rand -hex 16)
  redis_pw=$(openssl rand -hex 16)
  minio_pw=$(openssl rand -hex 16)
  log "Generated Langfuse secrets"

  helm upgrade --install langfuse langfuse/langfuse -n langfuse \
    --set langfuse.salt.value="$salt" \
    --set langfuse.encryptionKey.value="$enc_key" \
    --set langfuse.nextauth.secret.value="$nextauth_secret" \
    --set postgresql.auth.password="$pg_pw" \
    --set clickhouse.auth.password="$ch_pw" \
    --set redis.auth.password="$redis_pw" \
    --set s3.accessKeyId.value=minio \
    --set s3.secretAccessKey.value="$minio_pw" \
    --set s3.auth.rootUser=minio \
    --set s3.auth.rootPassword="$minio_pw" &>/dev/null
  log "Langfuse Helm release deployed"

  wait_for_pods langfuse 420
}

create_langfuse_api_keys() {
  step "Creating Langfuse account and API keys"

  # Workshop credentials are per-install: generated fresh on first run, then
  # reused from the `langfuse-credentials` Secret on subsequent runs so the UI
  # login keeps working after a re-run. Anyone with cluster access can retrieve
  # them with the kubectl command printed in the "Services Ready" banner.
  LANGFUSE_EMAIL="lab@lab.com"
  local existing_pw
  existing_pw=$(kubectl get secret langfuse-credentials -n langfuse -o jsonpath='{.data.LANGFUSE_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || true)
  if [[ -n "$existing_pw" ]]; then
    LANGFUSE_PASSWORD="$existing_pw"
    log "Reusing existing Langfuse workshop password from langfuse-credentials Secret"
  else
    # Langfuse password policy requires upper, lower, digit and >=8 chars; the
    # "Lf!" prefix guarantees that even though `openssl rand -hex` only emits
    # hex digits.
    LANGFUSE_PASSWORD="Lf!$(openssl rand -hex 16)"
    log "Generated random Langfuse workshop password"
  fi

  # Check if API keys already exist from a previous run
  local existing_pk existing_sk
  existing_pk=$(kubectl get secret langfuse-secret -n caipe -o jsonpath='{.data.LANGFUSE_PUBLIC_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)
  existing_sk=$(kubectl get secret langfuse-secret -n caipe -o jsonpath='{.data.LANGFUSE_SECRET_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)

  if [[ -n "$existing_pk" && -n "$existing_sk" && "$existing_pk" == pk-* ]]; then
    LANGFUSE_PUBLIC_KEY="$existing_pk"
    LANGFUSE_SECRET_KEY="$existing_sk"
    log "Reusing existing API keys (pk: ${LANGFUSE_PUBLIC_KEY:0:20}...)"
    return 0
  fi

  kill_port_on "$LANGFUSE_PORT"
  kubectl port-forward svc/langfuse-web -n langfuse "${LANGFUSE_PORT}:3000" &>/dev/null &
  disown $! 2>/dev/null || true
  PF_PIDS+=($!)
  sleep 3

  local base="http://localhost:${LANGFUSE_PORT}"
  local _lf_tries=0
  while [[ $_lf_tries -lt 6 ]]; do
    if curl -sf "${base}/api/auth/providers" &>/dev/null; then
      break
    fi
    _lf_tries=$((_lf_tries + 1))
    if [[ $_lf_tries -ge 6 ]]; then
      err "Cannot reach Langfuse at ${base}"
      return 1
    fi
    kill_port_on "$LANGFUSE_PORT"
    kubectl port-forward svc/langfuse-web -n langfuse "${LANGFUSE_PORT}:3000" &>/dev/null &
    disown $! 2>/dev/null || true
    PF_PIDS+=($!)
    sleep 5
  done

  # The signup body is JSON; build it in Python so the generated password is
  # safely JSON-escaped (the hex+"Lf!" prefix avoids quote/backslash hazards
  # today, but doing this defensively keeps the call correct if the generator
  # ever changes).
  local signup_body
  signup_body=$(LANGFUSE_EMAIL="$LANGFUSE_EMAIL" LANGFUSE_PASSWORD="$LANGFUSE_PASSWORD" \
    python3 -c 'import json,os; print(json.dumps({"name":"lab","email":os.environ["LANGFUSE_EMAIL"],"password":os.environ["LANGFUSE_PASSWORD"]}))')
  curl -sf -X POST "${base}/api/auth/signup" \
    -H 'Content-Type: application/json' \
    -d "${signup_body}" &>/dev/null || true
  log "User account ready"

  local csrf
  csrf=$(curl -sf -c /tmp/langfuse-cookies "${base}/api/auth/csrf" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")

  # The credentials callback expects application/x-www-form-urlencoded; the
  # password can in principle contain reserved chars (& = +), so url-encode
  # it via Python rather than naive string interpolation.
  local lf_email_enc lf_password_enc
  lf_email_enc=$(LANGFUSE_EMAIL="$LANGFUSE_EMAIL" python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["LANGFUSE_EMAIL"], safe=""))')
  lf_password_enc=$(LANGFUSE_PASSWORD="$LANGFUSE_PASSWORD" python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["LANGFUSE_PASSWORD"], safe=""))')

  curl -sf -c /tmp/langfuse-cookies -b /tmp/langfuse-cookies \
    -X POST "${base}/api/auth/callback/credentials" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d "csrfToken=${csrf}&email=${lf_email_enc}&password=${lf_password_enc}&callbackUrl=${base}" \
    -o /dev/null

  local org_id
  org_id=$(curl -sf -b /tmp/langfuse-cookies \
    -X POST "${base}/api/trpc/organizations.create" \
    -H 'Content-Type: application/json' \
    -d '{"json":{"name":"lab"}}' \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['data']['json']['id'])")

  local project_id
  project_id=$(curl -sf -b /tmp/langfuse-cookies \
    -X POST "${base}/api/trpc/projects.create" \
    -H 'Content-Type: application/json' \
    -d "{\"json\":{\"name\":\"lab-tracing\",\"orgId\":\"${org_id}\"}}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['data']['json']['id'])")

  local keys_json
  keys_json=$(curl -sf -b /tmp/langfuse-cookies \
    -X POST "${base}/api/trpc/projectApiKeys.create" \
    -H 'Content-Type: application/json' \
    -d "{\"json\":{\"projectId\":\"${project_id}\",\"note\":\"lab-tracing\"}}")

  LANGFUSE_PUBLIC_KEY=$(echo "$keys_json" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['data']['json']['publicKey'])")
  LANGFUSE_SECRET_KEY=$(echo "$keys_json" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['data']['json']['secretKey'])")
  log "API keys created (pk: ${LANGFUSE_PUBLIC_KEY:0:20}...)"

  local langfuse_baseurl="http://langfuse-web.langfuse.svc.cluster.local:3000"

  kubectl create secret generic langfuse-secret -n caipe \
    --from-literal=LANGFUSE_SECRET_KEY="$LANGFUSE_SECRET_KEY" \
    --from-literal=LANGFUSE_PUBLIC_KEY="$LANGFUSE_PUBLIC_KEY" \
    --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
  log "langfuse-secret created in caipe namespace"

  kubectl create namespace langfuse &>/dev/null 2>&1 || true
  kubectl create secret generic langfuse-credentials -n langfuse \
    --from-literal=LANGFUSE_PUBLIC_KEY="$LANGFUSE_PUBLIC_KEY" \
    --from-literal=LANGFUSE_SECRET_KEY="$LANGFUSE_SECRET_KEY" \
    --from-literal=LANGFUSE_BASEURL="$langfuse_baseurl" \
    --from-literal=LANGFUSE_EMAIL="$LANGFUSE_EMAIL" \
    --from-literal=LANGFUSE_PASSWORD="$LANGFUSE_PASSWORD" \
    --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
  log "langfuse-credentials stored in langfuse namespace"

  kill "${PF_PIDS[-1]}" 2>/dev/null || true
  unset 'PF_PIDS[-1]'
  rm -f /tmp/langfuse-cookies
}

prepare_corporate_ca() {
  local ns="caipe"
  local cm_name="corporate-ca-bundle"

  if kubectl get configmap "$cm_name" -n "$ns" &>/dev/null; then
    log "ConfigMap '${cm_name}' already exists — skipping CA extraction"
    return 0
  fi

  step "Corporate CA patch"

  local test_host="api.openai.com"
  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf '$tmp_dir'" RETURN

  log "Extracting CA chain from ${test_host} via current network..."
  local proxy_chain="${tmp_dir}/proxy-chain.pem"
  if ! openssl s_client -connect "${test_host}:443" -showcerts </dev/null 2>/dev/null \
       | awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' > "$proxy_chain"; then
    err "Could not connect to ${test_host}; skipping CA patch"
    return 1
  fi

  local cert_count
  cert_count=$(grep -c 'BEGIN CERTIFICATE' "$proxy_chain" 2>/dev/null || echo 0)
  if [[ "$cert_count" -lt 2 ]]; then
    log "No proxy CA chain detected (${cert_count} cert); CA patch not needed"
    INJECT_CORPORATE_CA=false
    return 0
  fi
  log "Detected ${cert_count} certificates in proxy chain"

  local issuer
  issuer=$(openssl x509 -in "$proxy_chain" -noout -issuer 2>/dev/null || true)
  log "Leaf cert issuer: ${issuer#issuer=}"

  local system_bundle="${tmp_dir}/system-ca.pem"
  local combined="${tmp_dir}/combined.pem"

  log "Fetching system CA bundle from container image..."
  kubectl delete pod ca-extract -n "$ns" --force --grace-period=0 &>/dev/null 2>&1 || true
  kubectl run ca-extract -n "$ns" --image=python:3.13-slim --restart=Never \
    --command -- sleep 300 &>/dev/null 2>&1 || true
  local retries=0
  while [[ $retries -lt 24 ]]; do
    if kubectl get pod ca-extract -n "$ns" -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Running; then
      break
    fi
    sleep 5
    retries=$((retries + 1))
  done

  if kubectl exec ca-extract -n "$ns" -- cat /etc/ssl/certs/ca-certificates.crt > "$system_bundle" 2>/dev/null; then
    cat "$system_bundle" "$proxy_chain" > "$combined"
  else
    warn "Could not extract system CAs; using proxy chain only"
    cp "$proxy_chain" "$combined"
  fi
  kubectl delete pod ca-extract -n "$ns" --force --grace-period=0 &>/dev/null 2>&1 || true

  python3 -c "
import re, sys
with open('${combined}') as f:
    data = f.read()
certs = re.findall(r'(-----BEGIN CERTIFICATE-----\n.*?\n-----END CERTIFICATE-----)', data, re.DOTALL)
seen = set()
unique = []
for cert in certs:
    if cert not in seen:
        seen.add(cert)
        unique.append(cert)
with open('${combined}', 'w') as f:
    for cert in unique:
        f.write(cert + '\n\n')
print(f'{len(unique)} unique certs in clean bundle')
" 2>&1

  kubectl delete configmap "$cm_name" -n "$ns" &>/dev/null 2>&1 || true
  kubectl create configmap "$cm_name" -n "$ns" \
    --from-file=ca-certificates.crt="$combined" &>/dev/null
  log "ConfigMap '${cm_name}' created in namespace '${ns}' ($(wc -c < "$combined" | tr -d ' ') bytes)"
}

patch_deployment_with_ca() {
  local deploy="$1" ns="$2" container="${3:-}"
  local cm_name="corporate-ca-bundle"

  if [[ -z "$container" ]]; then
    container=$(kubectl get deployment "$deploy" -n "$ns" \
      -o jsonpath='{.spec.template.spec.containers[0].name}' 2>/dev/null)
  fi

  kubectl patch deployment "$deploy" -n "$ns" --type='strategic' -p="{
    \"spec\": {
      \"template\": {
        \"spec\": {
          \"volumes\": [{
            \"name\": \"corporate-ca\",
            \"configMap\": {\"name\": \"${cm_name}\"}
          }],
          \"containers\": [{
            \"name\": \"${container}\",
            \"volumeMounts\": [{
              \"name\": \"corporate-ca\",
              \"mountPath\": \"/etc/ssl/certs/ca-certificates.crt\",
              \"subPath\": \"ca-certificates.crt\",
              \"readOnly\": true
            }],
            \"env\": [
              {\"name\": \"SSL_CERT_FILE\", \"value\": \"/etc/ssl/certs/ca-certificates.crt\"},
              {\"name\": \"REQUESTS_CA_BUNDLE\", \"value\": \"/etc/ssl/certs/ca-certificates.crt\"}
            ]
          }]
        }
      }
    }
  }" &>/dev/null
  log "Patched deployment '${deploy}' with corporate CA bundle"
}

# ─── Post-deploy patches ─────────────────────────────────────────────────────
# Consolidated workarounds for upstream chart issues.
# Called once after helm install and idempotently by auto-heal.
#
# 1. Corporate CA mount — optional; mounts pre-created CA ConfigMap into pods.
#    The ConfigMap is created by prepare_corporate_ca() before Helm deploy.
# 2. Langfuse secret injection — tracing secret patched into dynamic-agents.
# 3. RAG startup sequencing — waits for Milvus, then restarts RAG server
#    with SKIP_INIT_TESTS=false so it can run its full initialization checks.

AGENT_DEPLOYMENTS="caipe-dynamic-agents caipe-mcp-netutils-mcp"

# Resolve script dir (used for bundled kind manifests).
if [[ -f "$0" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
else
  SCRIPT_DIR="$PWD"
fi

post_deploy_patches() {
  step "Applying post-deploy patches"
  local needs_rollout=false

  # ── 1. Corporate CA patch (optional) ──
  # The CA ConfigMap was already created by prepare_corporate_ca() before Helm deploy.
  # Here we just mount it into the deployments that need outbound TLS.
  if $INJECT_CORPORATE_CA && kubectl get configmap corporate-ca-bundle -n caipe &>/dev/null; then
    for deploy in $AGENT_DEPLOYMENTS; do
      if kubectl get deployment "$deploy" -n caipe &>/dev/null; then
        local container
        container=$(kubectl get deployment "$deploy" -n caipe \
          -o jsonpath='{.spec.template.spec.containers[0].name}' 2>/dev/null)
        local vol_names
        vol_names=$(kubectl get deployment "$deploy" -n caipe \
          -o jsonpath='{.spec.template.spec.volumes[*].name}' 2>/dev/null)
        if ! echo "$vol_names" | grep -q "corporate-ca"; then
          patch_deployment_with_ca "$deploy" caipe "$container"
          needs_rollout=true
        fi
      fi
    done
    if $ENABLE_RAG; then
      local vol_names
      vol_names=$(kubectl get deployment rag-server -n caipe \
        -o jsonpath='{.spec.template.spec.volumes[*].name}' 2>/dev/null || true)
      if ! echo "$vol_names" | grep -q "corporate-ca"; then
        patch_deployment_with_ca rag-server caipe rag-server
        needs_rollout=true
      fi
    fi
  fi

  # ── 2. Langfuse secret injection ──
  if $ENABLE_TRACING; then
    local envfrom
    envfrom=$(kubectl get deployment caipe-dynamic-agents -n caipe \
      -o jsonpath='{.spec.template.spec.containers[0].envFrom}' 2>/dev/null || true)
    if ! echo "$envfrom" | grep -q "langfuse-secret"; then
      kubectl patch deployment caipe-dynamic-agents -n caipe --type='json' \
        -p='[{"op":"add","path":"/spec/template/spec/containers/0/envFrom/-","value":{"secretRef":{"name":"langfuse-secret"}}}]' &>/dev/null
      log "Langfuse secret patched into dynamic-agents"
      needs_rollout=true
    fi
  fi

  if $needs_rollout; then
    log "Waiting for patched deployments to roll out..."
    if $ENABLE_RAG; then
      wait_for_pods caipe 300 "rag-server"
    else
      wait_for_pods caipe 300
    fi
  else
    log "All patches already applied — nothing to do"
  fi

  # ── 3. RAG startup sequencing + RBAC ──
  # RAG server was deployed with SKIP_INIT_TESTS=true so it wouldn't fail before
  # Milvus/Redis were ready and before the CA bundle was mounted. Now that infra
  # is healthy we disable the skip and restart RAG to run its full init checks.
  if $ENABLE_RAG; then
    _finalize_rag_startup
    # Propagate OIDC config from caipe-ui-secret so RAG can validate tokens.
    # Also set OIDC_GROUP_CLAIM=members,groups to match prod group claim names.
    _rag_oidc_issuer=$(kubectl get secret caipe-ui-secret -n caipe \
      -o jsonpath='{.data.OIDC_ISSUER}' 2>/dev/null | base64 -d || true)
    _rag_oidc_client_id=$(kubectl get secret caipe-ui-secret -n caipe \
      -o jsonpath='{.data.OIDC_CLIENT_ID}' 2>/dev/null | base64 -d || true)
    _rag_ingestor_issuer=$(kubectl get secret rag-ingestor-secret -n caipe \
      -o jsonpath='{.data.INGESTOR_OIDC_ISSUER}' 2>/dev/null | base64 -d || true)
    _rag_ingestor_client_id=$(kubectl get secret rag-ingestor-secret -n caipe \
      -o jsonpath='{.data.INGESTOR_OIDC_CLIENT_ID}' 2>/dev/null | base64 -d || true)
    if [[ -n "$_rag_oidc_issuer" && -n "$_rag_oidc_client_id" ]]; then
      local _rag_env_args=(
        "OIDC_ISSUER=$_rag_oidc_issuer"
        "OIDC_CLIENT_ID=$_rag_oidc_client_id"
        "OIDC_GROUP_CLAIM=members,groups"
      )
      [[ -n "$_rag_ingestor_issuer" ]]    && _rag_env_args+=("INGESTOR_OIDC_ISSUER=$_rag_ingestor_issuer")
      [[ -n "$_rag_ingestor_client_id" ]] && _rag_env_args+=("INGESTOR_OIDC_CLIENT_ID=$_rag_ingestor_client_id")
      kubectl set env deployment/rag-server -n caipe "${_rag_env_args[@]}" &>/dev/null \
        && log "rag-server: OIDC providers configured (issuer=${_rag_oidc_issuer})"
    else
      log "rag-server: No OIDC config found in caipe-ui-secret — skipping OIDC patch (no-SSO deployment)"
    fi
  fi

  # ── 6. caipe-ui: raise Node.js HTTP header size limit ──
  # Users with many OIDC group claims (e.g. 500+) produce a session JWT that
  # exceeds Node.js's default 16 KB header limit, causing HTTP 431 errors.
  # 65536 bytes (64 KB) is sufficient for even the largest enterprise OIDC tokens.
  local cur_node_opts
  cur_node_opts=$(kubectl get deployment caipe-caipe-ui -n caipe \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="NODE_OPTIONS")].value}' \
    2>/dev/null || true)
  if [[ "$cur_node_opts" != *"--max-http-header-size"* ]]; then
    kubectl set env deployment/caipe-caipe-ui -n caipe \
      NODE_OPTIONS="--max-http-header-size=65536" &>/dev/null \
      && log "caipe-ui: NODE_OPTIONS set to --max-http-header-size=65536"
  fi

  # ── 7. MongoDB for dynamic-agents ──
  # The dynamic-agents chart defaults MONGODB_URI to localhost:27017 (no-op
  # default). Setup deploys a bitnami/mongodb instance (if none exists) and
  # patches the ConfigMap with the real cluster URI.
  _ensure_dynamic_agents_mongodb

  # ── 9. Domain-scoped Keycloak SSO setup ──
  if [[ -n "${CAIPE_DOMAIN:-}" ]]; then
    # In-chart Keycloak SSO over a public DNS domain: NextAuth's server-side
    # callback (token exchange + JWKS) hits the PUBLIC Keycloak endpoints
    # (KC_HOSTNAME). The UI pod resolves the public host to the public IP and
    # usually cannot hairpin back to its own ingress (OAuthCallback failure).
    # Pin the public host to the in-cluster ingress ClusterIP via hostAliases so
    # server-side calls route internally (TLS SNI/cert still match the host).
    if $ENABLE_RBAC_RUNTIME && [[ ! "$CAIPE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      local _ningx_ip
      _ningx_ip=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
        -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
      if [[ -n "$_ningx_ip" ]]; then
        kubectl patch deploy caipe-caipe-ui -n caipe --type=merge \
          -p "{\"spec\":{\"template\":{\"spec\":{\"hostAliases\":[{\"ip\":\"${_ningx_ip}\",\"hostnames\":[\"${CAIPE_DOMAIN}\"]}]}}}}" &>/dev/null \
          && log "caipe-ui hostAliases: ${CAIPE_DOMAIN} -> ${_ningx_ip} (in-cluster ingress; fixes SSO callback)"
      fi
    fi

    # Optional GitHub social login broker (configured only when requested).
    configure_github_idp

    # Default local Keycloak logins (no upstream IdP): an org-admin and a
    # non-admin user. Self-guards via _local_admin_active (RBAC + DNS domain +
    # no brokered IdP).
    provision_local_users

    # RAG web-ingestor service account: creates caipe-web-ingestor client in
    # Keycloak and stores credentials in rag-ingestor-secret. Must run after
    # Keycloak is ready and before helm install so the secret exists when the
    # rag-server and web-ingestor pods start.
    provision_rag_ingestor_client

    # Add aud=caipe-ui to user access tokens so the Next.js gateway accepts
    # bearer auth on dynamic-agents streaming endpoints.
    provision_caipe_ui_audience_mapper

    # Sync Keycloak client redirect URIs / web origins to the current domain.
    # Must run after audience mapper (which establishes the port-forward pattern)
    # and is idempotent: safe to re-run on domain changes.
    update_keycloak_client_urls
  fi
}

# Ask the operator whether to enable GitHub social login (Keycloak "github"
# broker) for public users. Only relevant for an in-chart Keycloak exposed on a
# public DNS domain. Non-interactive runs honour ENABLE_GITHUB_SOCIAL + the
# GITHUB_SOCIAL_CLIENT_ID/SECRET env vars and never prompt. If declined or
# unconfigured, the deployment falls back to local Keycloak username/password.
prompt_github_social() {
  $ENABLE_RBAC_RUNTIME || return 0
  [[ -n "$CAIPE_DOMAIN" ]] || return 0
  [[ "$CAIPE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && return 0
  [[ "$ENABLE_GITHUB_SOCIAL" == "false" ]] && return 0
  if [[ "$ENABLE_GITHUB_SOCIAL" != "true" ]]; then
    $NON_INTERACTIVE && return 0
    local cb="https://${CAIPE_DOMAIN}/realms/caipe/broker/github/endpoint"
    header "Optional: GitHub social login (public users)"
    echo -e "  ${DIM}Lets anyone with a GitHub account sign in, in addition to local Keycloak users.${NC}"
    echo -e "  ${DIM}Requires a DEDICATED GitHub OAuth App with this Authorization callback URL:${NC}"
    echo -e "  ${BOLD}${cb}${NC}"
    if ! ask_yn "Set up GitHub social login now?" "n"; then
      log "GitHub social login: skipped (local Keycloak username/password only)"
      ENABLE_GITHUB_SOCIAL=false
      return 0
    fi
    ENABLE_GITHUB_SOCIAL=true
  fi
  if [[ -z "$GITHUB_SOCIAL_CLIENT_ID" ]]; then
    prompt "GitHub OAuth App Client ID: "; tty_read -r GITHUB_SOCIAL_CLIENT_ID
  fi
  if [[ -z "$GITHUB_SOCIAL_CLIENT_SECRET" ]]; then
    prompt "GitHub OAuth App Client Secret: "; tty_read -rs GITHUB_SOCIAL_CLIENT_SECRET; echo
  fi
  if [[ -z "$GITHUB_SOCIAL_CLIENT_ID" || -z "$GITHUB_SOCIAL_CLIENT_SECRET" ]]; then
    warn "GitHub social login: missing client id/secret — falling back to local Keycloak"
    ENABLE_GITHUB_SOCIAL=false
  fi
}

# Upsert the Keycloak "github" identity-provider broker via the admin REST API.
# Runs only when GitHub social login was requested. The admin API is NOT exposed
# publicly, so we reach it over a temporary port-forward and authenticate with
# the caipe-platform service account (client_credentials). Idempotent: updates
# the broker in place when it already exists.
configure_github_idp() {
  $ENABLE_GITHUB_SOCIAL || return 0
  $ENABLE_RBAC_RUNTIME || { warn "GitHub social login requires the in-chart Keycloak (RBAC runtime); skipping"; return 0; }
  if [[ -z "$GITHUB_SOCIAL_CLIENT_ID" || -z "$GITHUB_SOCIAL_CLIENT_SECRET" ]]; then
    warn "GitHub social login: client id/secret not set; skipping broker config"
    return 0
  fi
  step "Configuring GitHub social login (Keycloak broker)"
  local _pf_port=17081
  kubectl port-forward svc/caipe-keycloak -n caipe ${_pf_port}:8080 >/dev/null 2>&1 &
  local _pf=$!
  sleep 4
  local kc="http://localhost:${_pf_port}"
  local cs="${KEYCLOAK_CLIENT_SECRET:-}"
  [[ -z "$cs" && -n "${ENV_FILE:-}" && -f "${ENV_FILE:-}" ]] && cs=$(_env_get "$ENV_FILE" KEYCLOAK_CLIENT_SECRET)
  [[ -z "$cs" ]] && cs="caipe-platform-dev-secret"
  local tok
  tok=$(curl -s "$kc/realms/caipe/protocol/openid-connect/token" \
    -d grant_type=client_credentials -d client_id=caipe-platform -d client_secret="$cs" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  if [[ -z "$tok" ]]; then
    warn "GitHub social login: could not obtain a Keycloak admin token; skipping"
    kill "$_pf" 2>/dev/null || true
    return 0
  fi
  local body
  body=$(cat <<JSON
{"alias":"github","providerId":"github","enabled":true,"trustEmail":true,"storeToken":false,"config":{"clientId":"${GITHUB_SOCIAL_CLIENT_ID}","clientSecret":"${GITHUB_SOCIAL_CLIENT_SECRET}","defaultScope":"read:user user:email"}}
JSON
)
  local exists code
  exists=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" \
    "$kc/admin/realms/caipe/identity-provider/instances/github")
  if [[ "$exists" == "200" ]]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
      -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
      "$kc/admin/realms/caipe/identity-provider/instances/github" -d "$body")
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
      -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
      "$kc/admin/realms/caipe/identity-provider/instances" -d "$body")
  fi
  kill "$_pf" 2>/dev/null || true
  if [[ "$code" =~ ^20[0-9]$ ]]; then
    log "GitHub social login enabled (Keycloak 'github' broker)"
    log "Verify the GitHub OAuth App callback URL is: https://${CAIPE_DOMAIN}/realms/caipe/broker/github/endpoint"
  else
    warn "GitHub social login: Keycloak IdP upsert returned HTTP ${code} (check client id/secret)"
  fi
}

# Idempotently creates a `caipe-web-ingestor` Keycloak client (client-credentials
# grant, service-account enabled) and stores the secret in the k8s Secret
# `rag-ingestor-secret`. Both the rag-server (token validation) and the
# web-ingestor sidecar (token acquisition) read their INGESTOR_OIDC_* vars from
# that secret via envFrom, so no credentials appear in Helm values.
# Must be called after Keycloak is Ready and before helm install/upgrade.
provision_rag_ingestor_client() {
  $ENABLE_RAG || return 0

  # Use the public domain issuer when available; fall back to the in-cluster
  # Keycloak service URL so the web-ingestor works on Kind without a domain.
  local issuer_base
  if [[ -n "${CAIPE_DOMAIN:-}" ]]; then
    issuer_base="https://${CAIPE_DOMAIN}"
  else
    issuer_base="http://caipe-keycloak.${CAIPE_NAMESPACE:-caipe}.svc.cluster.local:8080"
  fi

  local kcadm_user kcadm_pw="${KEYCLOAK_ADMIN_PASSWORD:-}"
  kcadm_user=$(kubectl get secret caipe-keycloak-admin -n caipe \
    -o jsonpath='{.data.username}' 2>/dev/null | base64 -d 2>/dev/null || true)
  [[ -z "$kcadm_user" ]] && kcadm_user="admin"
  if [[ -z "$kcadm_pw" ]]; then
    kcadm_pw=$(kubectl get secret caipe-keycloak-admin -n caipe \
      -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
  fi
  if [[ -z "$kcadm_pw" ]]; then
    warn "RAG ingestor client: no Keycloak admin password available; skipping"
    return 0
  fi

  local _pf_port=17085
  kubectl port-forward svc/caipe-keycloak -n caipe ${_pf_port}:8080 >/dev/null 2>&1 &
  local _pf=$!
  sleep 4
  local kc="http://localhost:${_pf_port}"

  local tok
  tok=$(curl -s "$kc/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    --data-urlencode "username=${kcadm_user}" --data-urlencode "password=${kcadm_pw}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  if [[ -z "$tok" ]]; then
    warn "RAG ingestor client: could not obtain Keycloak admin token; skipping"
    kill "$_pf" 2>/dev/null || true
    return 0
  fi

  local client_id="caipe-web-ingestor"
  local issuer="${issuer_base}/realms/caipe"

  # Check if client already exists
  local existing_uuid
  existing_uuid=$(curl -s -H "Authorization: Bearer $tok" \
    "$kc/admin/realms/caipe/clients?clientId=${client_id}" \
    | jq -r '.[0].id // empty' 2>/dev/null)

  local client_secret
  if [[ -n "$existing_uuid" ]]; then
    # Regenerate secret for idempotency (re-runs get a fresh secret stored in k8s)
    client_secret=$(curl -s -X POST -H "Authorization: Bearer $tok" \
      "$kc/admin/realms/caipe/clients/${existing_uuid}/client-secret" \
      | jq -r '.value // empty' 2>/dev/null)
    log "RAG ingestor client: reused existing '${client_id}', refreshed secret"
  else
    # Create the client
    local create_body
    create_body=$(cat <<JSON
{
  "clientId": "${client_id}",
  "name": "CAIPE RAG Web Ingestor",
  "description": "Service account for the RAG web-ingestor sidecar to authenticate to the RAG server",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "bearerOnly": false,
  "standardFlowEnabled": false,
  "implicitFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": true,
  "clientAuthenticatorType": "client-secret"
}
JSON
)
    local create_code
    create_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
      -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
      "$kc/admin/realms/caipe/clients" -d "$create_body")
    if [[ ! "$create_code" =~ ^20 ]]; then
      warn "RAG ingestor client: Keycloak client creation returned HTTP ${create_code}; skipping"
      kill "$_pf" 2>/dev/null || true
      return 0
    fi
    existing_uuid=$(curl -s -H "Authorization: Bearer $tok" \
      "$kc/admin/realms/caipe/clients?clientId=${client_id}" \
      | jq -r '.[0].id // empty' 2>/dev/null)
    client_secret=$(curl -s -H "Authorization: Bearer $tok" \
      "$kc/admin/realms/caipe/clients/${existing_uuid}/client-secret" \
      | jq -r '.value // empty' 2>/dev/null)
    # Add a hardcoded-audience mapper so the token carries aud=caipe-web-ingestor.
    # The rag-server auth manager validates audience against INGESTOR_OIDC_CLIENT_ID;
    # Keycloak does not include the client_id in aud by default.
    curl -s -o /dev/null -X POST \
      -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
      "$kc/admin/realms/caipe/clients/${existing_uuid}/protocol-mappers/models" -d "{
        \"name\": \"caipe-web-ingestor-audience\",
        \"protocol\": \"openid-connect\",
        \"protocolMapper\": \"oidc-hardcoded-claim-mapper\",
        \"config\": {
          \"claim.name\": \"aud\",
          \"claim.value\": \"${client_id}\",
          \"jsonType.label\": \"String\",
          \"id.token.claim\": \"false\",
          \"access.token.claim\": \"true\",
          \"access.tokenResponse.claim\": \"false\"
        }
      }"
    log "RAG ingestor client: created '${client_id}' in Keycloak realm 'caipe'"
  fi

  kill "$_pf" 2>/dev/null || true

  if [[ -z "$client_secret" ]]; then
    warn "RAG ingestor client: could not retrieve client secret; skipping"
    return 0
  fi

  # Store in k8s secret so both rag-server and web-ingestor can mount it via envFrom
  kubectl create secret generic rag-ingestor-secret -n caipe \
    --from-literal=INGESTOR_OIDC_ISSUER="${issuer}" \
    --from-literal=INGESTOR_OIDC_CLIENT_ID="${client_id}" \
    --from-literal=INGESTOR_OIDC_CLIENT_SECRET="${client_secret}" \
    --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
  log "RAG ingestor client: credentials stored in rag-ingestor-secret (issuer=${issuer})"
  RAG_INGESTOR_SECRET_READY=true
  RAG_INGESTOR_OIDC_ISSUER="${issuer}"
  RAG_INGESTOR_OIDC_CLIENT_ID="${client_id}"

  # Restart rag-server so the web-ingestor sidecar picks up the new secret.
  # Use maxUnavailable=1/maxSurge=0 to avoid scheduling failure on CPU-constrained
  # single-node clusters where a surge pod cannot fit alongside the old pod.
  if kubectl get deploy rag-server -n caipe &>/dev/null 2>&1; then
    local _rs_patch='{"spec":{"strategy":{"rollingUpdate":{"maxUnavailable":1,"maxSurge":0}}}}'
    kubectl patch deploy rag-server -n caipe -p "$_rs_patch" &>/dev/null 2>&1 || true
    kubectl rollout restart deploy/rag-server -n caipe &>/dev/null 2>&1 || true
    kubectl rollout status deploy/rag-server -n caipe --timeout=120s &>/dev/null 2>&1 || true
    local _rs_restore='{"spec":{"strategy":{"rollingUpdate":{"maxUnavailable":"25%","maxSurge":"25%"}}}}'
    kubectl patch deploy rag-server -n caipe -p "$_rs_restore" &>/dev/null 2>&1 || true
    log "RAG ingestor: rag-server restarted to pick up new client secret"
  fi
}

# Update caipe-ui and caipe-platform Keycloak client redirect URIs, web origins,
# and root URL to match CAIPE_DOMAIN. Keycloak imports the realm once at first
# install; the imported URIs are never updated by helm upgrade, so a domain
# change (e.g. caipe.local.me → caipe.example.com) leaves stale URIs
# that cause "Invalid parameter: redirect_uri" on login.
update_keycloak_client_urls() {
  $ENABLE_RBAC_RUNTIME || return 0
  [[ -n "${CAIPE_DOMAIN:-}" ]] || return 0

  local kcadm_pw="${KEYCLOAK_ADMIN_PASSWORD:-}"
  if [[ -z "$kcadm_pw" ]]; then
    kcadm_pw=$(kubectl get secret caipe-keycloak-admin -n caipe \
      -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
  fi
  if [[ -z "$kcadm_pw" ]]; then
    warn "update_keycloak_client_urls: no Keycloak admin password; skipping"
    return 0
  fi

  local _pf_port=17087
  kubectl port-forward svc/caipe-keycloak -n caipe ${_pf_port}:8080 >/dev/null 2>&1 &
  local _pf=$!
  sleep 4
  local kc="http://localhost:${_pf_port}"

  local tok
  tok=$(curl -s "$kc/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    --data-urlencode "username=admin" --data-urlencode "password=${kcadm_pw}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  if [[ -z "$tok" ]]; then
    warn "update_keycloak_client_urls: could not obtain Keycloak admin token; skipping"
    kill "$_pf" 2>/dev/null || true
    return 0
  fi

  local target_origin="https://${CAIPE_DOMAIN}"
  for client_id in caipe-ui caipe-platform; do
    local uuid
    uuid=$(curl -s -H "Authorization: Bearer $tok" \
      "$kc/admin/realms/caipe/clients?clientId=${client_id}" \
      | jq -r '.[0].id // empty' 2>/dev/null)
    [[ -z "$uuid" ]] && continue

    local current body http_code
    current=$(curl -s -H "Authorization: Bearer $tok" \
      "$kc/admin/realms/caipe/clients/${uuid}")
    body=$(echo "$current" | jq \
      --arg origin "$target_origin" \
      '.redirectUris = [$origin + "/*"] | .webOrigins = [$origin] | .rootUrl = $origin | .baseUrl = "/"')
    http_code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
      -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
      "$kc/admin/realms/caipe/clients/${uuid}" -d "$body")

    if [[ "$http_code" == "204" ]]; then
      log "Keycloak ${client_id}: redirect URIs updated to ${target_origin}/*"
    else
      warn "Keycloak ${client_id}: redirect URI update returned HTTP ${http_code}"
    fi
  done

  kill "$_pf" 2>/dev/null || true
}

# Add an oidc-audience-mapper to the caipe-ui Keycloak client so that the
# user's access token carries aud=caipe-ui. The Next.js gateway validates bearer
# tokens against OIDC_CLIENT_ID=caipe-ui; without this mapper the token has
# aud=["account"] only and the dynamic-agents streaming endpoint returns 401
# BEARER_AUDIENCE_MISMATCH.
provision_caipe_ui_audience_mapper() {
  $ENABLE_RBAC_RUNTIME || return 0
  [[ -n "${CAIPE_DOMAIN:-}" ]] || return 0

  local kcadm_user kcadm_pw="${KEYCLOAK_ADMIN_PASSWORD:-}"
  kcadm_user=$(kubectl get secret caipe-keycloak-admin -n caipe \
    -o jsonpath='{.data.username}' 2>/dev/null | base64 -d 2>/dev/null || true)
  [[ -z "$kcadm_user" ]] && kcadm_user="admin"
  if [[ -z "$kcadm_pw" ]]; then
    kcadm_pw=$(kubectl get secret caipe-keycloak-admin -n caipe \
      -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
  fi
  if [[ -z "$kcadm_pw" ]]; then
    warn "caipe-ui audience mapper: no Keycloak admin password available; skipping"
    return 0
  fi

  local _pf_port=17086
  kubectl port-forward svc/caipe-keycloak -n caipe ${_pf_port}:8080 >/dev/null 2>&1 &
  local _pf=$!
  sleep 4
  local kc="http://localhost:${_pf_port}"

  local tok
  tok=$(curl -s "$kc/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    --data-urlencode "username=${kcadm_user}" --data-urlencode "password=${kcadm_pw}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  if [[ -z "$tok" ]]; then
    warn "caipe-ui audience mapper: could not obtain Keycloak admin token; skipping"
    kill "$_pf" 2>/dev/null || true
    return 0
  fi

  local client_uuid
  client_uuid=$(curl -s -H "Authorization: Bearer $tok" \
    "$kc/admin/realms/caipe/clients?clientId=caipe-ui" \
    | jq -r '.[0].id // empty' 2>/dev/null)
  if [[ -z "$client_uuid" ]]; then
    warn "caipe-ui audience mapper: could not find caipe-ui client; skipping"
    kill "$_pf" 2>/dev/null || true
    return 0
  fi

  # Idempotent: 409 Conflict means the mapper already exists
  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
    "$kc/admin/realms/caipe/clients/${client_uuid}/protocol-mappers/models" -d '{
      "name": "caipe-ui-audience",
      "protocol": "openid-connect",
      "protocolMapper": "oidc-audience-mapper",
      "config": {
        "included.client.audience": "caipe-ui",
        "id.token.claim": "false",
        "access.token.claim": "true"
      }
    }')
  kill "$_pf" 2>/dev/null || true

  if [[ "$http_code" == "201" ]]; then
    log "caipe-ui audience mapper: created (aud=caipe-ui will be included in access tokens)"
  elif [[ "$http_code" == "409" ]]; then
    log "caipe-ui audience mapper: already exists (idempotent)"
  else
    warn "caipe-ui audience mapper: unexpected HTTP ${http_code}"
  fi
}

# True when we should self-provision a local Keycloak admin login. Requires the
# RBAC runtime + a DNS domain (SSO needs a browser-reachable issuer) and is
# skipped when an upstream IdP is brokered (IDP_ISSUER set in an env file) —
# in that case identity comes from the broker, not a local password user.
_local_admin_active() {
  $ENABLE_RBAC_RUNTIME || return 1
  [[ "$ENABLE_LOCAL_ADMIN" != "false" ]] || return 1
  [[ -n "$CAIPE_DOMAIN" && ! "$CAIPE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  if [[ -n "${UI_ENV_FILE:-}" && -f "${UI_ENV_FILE:-}" ]]; then
    [[ -z "$(_env_get "$UI_ENV_FILE" IDP_ISSUER)" ]] || return 1
  fi
  if [[ -n "${ENV_FILE:-}" && -f "${ENV_FILE:-}" ]]; then
    [[ -z "$(_env_get "$ENV_FILE" IDP_ISSUER)" ]] || return 1
  fi
  return 0
}

# Create (or refresh) local Keycloak realm users with passwords so the default
# in-chart Keycloak SSO install is actually loginable without any upstream IdP /
# Cisco SSO. We provision TWO users so both RBAC paths can be tested out of the
# box:
#   • admin@caipe.local — wired into BOOTSTRAP_ADMIN_EMAILS (caipe-ui.config), so
#     the BFF JWT callback grants it org-admin + reconciles the OpenFGA
#     super-admin tuple on first login (admin surfaces).
#   • user@caipe.local  — NOT in BOOTSTRAP_ADMIN_EMAILS, so it logs in as a plain
#     non-admin user (baseline chat access, denied the admin UI).
# The Keycloak admin API is not exposed publicly, so we reach it over a single
# temporary port-forward and authenticate with the master-realm bootstrap admin.
# Idempotent: resets passwords in place when users exist, and persists each
# credential in its own Secret (caipe-local-admin / caipe-local-user) so re-runs
# reuse them.
provision_local_users() {
  _local_admin_active || return 0
  step "Provisioning local Keycloak logins (no upstream IdP)"

  # Master-realm bootstrap admin (creating realm users needs manage-users; the
  # bootstrap admin has it without depending on the caipe-platform grants). The
  # chart-owned caipe-keycloak-admin Secret stores keys username/password — fall
  # back to those (NOT a non-existent admin-password key) when the in-process
  # KEYCLOAK_ADMIN_PASSWORD isn't set (e.g. an --upgrade/monitor re-entry).
  local kcadm_user kcadm_pw="${KEYCLOAK_ADMIN_PASSWORD:-}"
  kcadm_user=$(kubectl get secret caipe-keycloak-admin -n caipe \
    -o jsonpath='{.data.username}' 2>/dev/null | base64 -d 2>/dev/null || true)
  [[ -z "$kcadm_user" ]] && kcadm_user="admin"
  if [[ -z "$kcadm_pw" ]]; then
    kcadm_pw=$(kubectl get secret caipe-keycloak-admin -n caipe \
      -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
  fi
  if [[ -z "$kcadm_pw" ]]; then
    warn "Local logins: no Keycloak admin password available; skipping"
    return 0
  fi

  local _pf_port=17082
  kubectl port-forward svc/caipe-keycloak -n caipe ${_pf_port}:8080 >/dev/null 2>&1 &
  local _pf=$!
  sleep 4
  local kc="http://localhost:${_pf_port}"

  local tok
  tok=$(curl -s "$kc/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    --data-urlencode "username=${kcadm_user}" --data-urlencode "password=${kcadm_pw}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  if [[ -z "$tok" ]]; then
    warn "Local logins: could not obtain a Keycloak admin token; skipping"
    kill "$_pf" 2>/dev/null || true
    return 0
  fi

  # Upsert one realm user (idempotent). Args: email password first last.
  # Echoes the HTTP status code from the create/update call.
  _kc_upsert_user() {
    local email="$1" pw="$2" first="$3" last="$4" uid body
    uid=$(curl -s -H "Authorization: Bearer $tok" \
      "$kc/admin/realms/caipe/users?email=${email}&exact=true" \
      | jq -r '.[0].id // empty' 2>/dev/null)
    body=$(cat <<JSON
{"username":"${email}","email":"${email}","emailVerified":true,"enabled":true,"firstName":"${first}","lastName":"${last}","credentials":[{"type":"password","value":"${pw}","temporary":false}]}
JSON
)
    if [[ -n "$uid" ]]; then
      curl -s -o /dev/null -w '%{http_code}' -X PUT \
        -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
        "$kc/admin/realms/caipe/users/${uid}" -d "$body"
    else
      curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
        "$kc/admin/realms/caipe/users" -d "$body"
    fi
  }

  # ── Admin user (org-admin via BOOTSTRAP_ADMIN_EMAILS) ──
  local admin_pw code
  admin_pw=$(kubectl get secret caipe-local-admin -n caipe \
    -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
  [[ -z "$admin_pw" ]] && admin_pw="${LOCAL_ADMIN_PASSWORD:-$(openssl rand -hex 12)}"
  code=$(_kc_upsert_user "$LOCAL_ADMIN_EMAIL" "$admin_pw" "CAIPE" "Admin")
  if [[ "$code" =~ ^20[0-9]$ ]]; then
    kubectl create secret generic caipe-local-admin -n caipe \
      --from-literal=email="${LOCAL_ADMIN_EMAIL}" \
      --from-literal=password="${admin_pw}" \
      --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
    LOCAL_ADMIN_PASSWORD="$admin_pw"
    log "Local admin login ready: ${LOCAL_ADMIN_EMAIL} (org-admin via BOOTSTRAP_ADMIN_EMAILS)"
  else
    warn "Local admin: Keycloak user upsert returned HTTP ${code}; sign-in may not work"
  fi

  # ── Standard (non-admin) user — NOT in BOOTSTRAP_ADMIN_EMAILS ──
  if [[ "$ENABLE_LOCAL_USER" != "false" ]]; then
    local user_pw
    user_pw=$(kubectl get secret caipe-local-user -n caipe \
      -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
    [[ -z "$user_pw" ]] && user_pw="${LOCAL_USER_PASSWORD:-$(openssl rand -hex 12)}"
    code=$(_kc_upsert_user "$LOCAL_USER_EMAIL" "$user_pw" "CAIPE" "User")
    if [[ "$code" =~ ^20[0-9]$ ]]; then
      kubectl create secret generic caipe-local-user -n caipe \
        --from-literal=email="${LOCAL_USER_EMAIL}" \
        --from-literal=password="${user_pw}" \
        --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
      LOCAL_USER_PASSWORD="$user_pw"
      log "Local standard login ready: ${LOCAL_USER_EMAIL} (non-admin — baseline access, no admin UI)"
    else
      warn "Local user: Keycloak user upsert returned HTTP ${code}; sign-in may not work"
    fi
  fi

  kill "$_pf" 2>/dev/null || true
}

_patch_rag_server_envfrom() {
  # The rag-stack subchart template builds envFrom from a hardcoded llm-secret
  # reference; it does not expose envFrom as a values key that propagates from
  # the parent chart. Append rag-azure-openai-secret as a second envFrom entry
  # via a JSON-patch so that AZURE_OPENAI_API_KEY reaches the rag-server.
  local ns="${CAIPE_NAMESPACE:-caipe}"
  # Check if already patched to avoid accumulating duplicate entries
  local current_envfrom
  current_envfrom=$(kubectl get deploy rag-server -n "$ns" \
    -o jsonpath='{.spec.template.spec.containers[0].envFrom}' 2>/dev/null || echo "[]")
  if echo "$current_envfrom" | grep -q "rag-azure-openai-secret"; then
    log "rag-server envFrom already has rag-azure-openai-secret"
    return 0
  fi
  kubectl patch deploy rag-server -n "$ns" --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/envFrom/-","value":{"secretRef":{"name":"rag-azure-openai-secret"}}}]' \
    &>/dev/null
  log "Patched rag-server: added rag-azure-openai-secret to envFrom"
}

# MongoDB credentials are random per install and persisted in the
# `caipe-mongodb-credentials` Secret so reruns reuse the same password and
# operators can recover it for debugging, backup, or restore.
# True when a shared Postgres should be deployed: opt-in via ENABLE_SHARED_POSTGRES
# AND at least one consumer that needs persistence (RBAC runtime or LiteLLM DB).
_shared_postgres_active() {
  $ENABLE_SHARED_POSTGRES || return 1
  $ENABLE_RBAC_RUNTIME && return 0
  $ENABLE_LITELLM_DB && return 0
  return 1
}

# Best-effort guard: chart releases that predate the Keycloak `database.*`
# contract ignore the shared-Postgres wiring and run Keycloak on embedded H2,
# so RBAC identity/realm state is lost on every pod restart. Detect that case by
# inspecting the selected chart's Keycloak templates and warn loudly. OpenFGA
# persistence is unaffected (its datastore.engine=postgres support predates this).
# Never fails the install — on any pull/inspect error it simply skips the warning.
_warn_if_chart_lacks_keycloak_db() {
  _shared_postgres_active || return 0
  [[ -n "${CAIPE_CHART_VERSION:-}" ]] || return 0
  local tmpd kc_dir
  tmpd=$(mktemp -d 2>/dev/null) || return 0
  if helm pull "$CAIPE_OCI_REPO" --version "$CAIPE_CHART_VERSION" \
       --untar --untardir "$tmpd" >/dev/null 2>&1; then
    kc_dir=$(find "$tmpd" -type d -name keycloak 2>/dev/null | head -1)
    # Inspect templates/ only — values.yaml ships commented KC_DB examples even on
    # charts that hardcode start-dev (H2), which would false-negative the check.
    # The #1686 contract is the deployment template consuming .Values.database /
    # wiring KC_DB env, so the absence of those in templates/ means H2 fallback.
    if [[ -d "$kc_dir/templates" ]] && ! grep -rqE "KC_DB|\.Values\.database" "$kc_dir/templates" 2>/dev/null; then
      warn "Chart v${CAIPE_CHART_VERSION} predates the Keycloak database.* contract —"
      warn "  Keycloak will run on embedded H2 (state lost on pod restart) even though"
      warn "  shared Postgres is deployed and its 'keycloak' database is created."
      warn "  OpenFGA still persists to Postgres. Upgrade to a chart release that wires"
      warn "  Keycloak to Postgres (CAIPE_CHART_VERSION=<newer>) to make Keycloak durable."
    fi
  fi
  rm -rf "$tmpd" 2>/dev/null
}

# Resolve (reuse-or-generate) the admin + per-consumer Postgres passwords and
# persist them in the caipe-postgres-credentials Secret so re-runs are stable.
# Hex passwords avoid any URL-encoding pitfalls inside connection strings.
_resolve_shared_postgres_passwords() {
  local secret_json
  secret_json=$(kubectl get secret caipe-postgres-credentials -n caipe -o json 2>/dev/null || true)
  _pg_field() {
    local key="$1"
    [[ -n "$secret_json" ]] || return 0
    echo "$secret_json" | python3 -c "
import sys, json, base64
try:
    d = json.load(sys.stdin).get('data', {})
    v = d.get('$key')
    print(base64.b64decode(v).decode() if v else '')
except Exception:
    print('')
" 2>/dev/null || true
  }

  SHARED_PG_ADMIN_PASSWORD="$(_pg_field POSTGRES_ADMIN_PASSWORD)"
  KEYCLOAK_DB_PASSWORD="$(_pg_field KEYCLOAK_DB_PASSWORD)"
  OPENFGA_DB_PASSWORD="$(_pg_field OPENFGA_DB_PASSWORD)"
  LITELLM_DB_PASSWORD="$(_pg_field LITELLM_DB_PASSWORD)"

  [[ -n "$SHARED_PG_ADMIN_PASSWORD" ]] || SHARED_PG_ADMIN_PASSWORD="$(openssl rand -hex 24)"
  [[ -n "$KEYCLOAK_DB_PASSWORD" ]] || KEYCLOAK_DB_PASSWORD="$(openssl rand -hex 24)"
  [[ -n "$OPENFGA_DB_PASSWORD" ]] || OPENFGA_DB_PASSWORD="$(openssl rand -hex 24)"
  [[ -n "$LITELLM_DB_PASSWORD" ]] || LITELLM_DB_PASSWORD="$(openssl rand -hex 24)"

  if [[ -n "$secret_json" ]]; then
    log "Reusing existing Postgres passwords from caipe-postgres-credentials Secret"
  else
    log "Generated random Postgres passwords (admin + keycloak/openfga/litellm roles)"
  fi

  kubectl create secret generic caipe-postgres-credentials \
    --namespace caipe \
    --from-literal=POSTGRES_ADMIN_PASSWORD="${SHARED_PG_ADMIN_PASSWORD}" \
    --from-literal=KEYCLOAK_DB_PASSWORD="${KEYCLOAK_DB_PASSWORD}" \
    --from-literal=OPENFGA_DB_PASSWORD="${OPENFGA_DB_PASSWORD}" \
    --from-literal=LITELLM_DB_PASSWORD="${LITELLM_DB_PASSWORD}" \
    --dry-run=client -o yaml \
    | kubectl apply -f - &>/dev/null
}

# Deploy a single shared bitnami/postgresql instance that backs Keycloak,
# OpenFGA, and (optionally) LiteLLM. Per-consumer roles + databases are created
# via an initdb script (runs once on an empty data dir). Consumer-facing secrets
# (caipe-keycloak-db / caipe-openfga-db / caipe-litellm-db) carry exactly the
# password or connection-string shape each chart expects.
deploy_shared_postgres() {
  _resolve_shared_postgres_passwords

  # Consumer-facing secrets (created/refreshed every run so wiring stays correct
  # even if the chart values change between runs).
  kubectl create secret generic caipe-keycloak-db \
    --namespace caipe \
    --from-literal=KC_DB_PASSWORD="${KEYCLOAK_DB_PASSWORD}" \
    --dry-run=client -o yaml | kubectl apply -f - &>/dev/null

  local openfga_uri="postgres://openfga:${OPENFGA_DB_PASSWORD}@${SHARED_PG_SERVICE}:5432/openfga?sslmode=disable"
  kubectl create secret generic caipe-openfga-db \
    --namespace caipe \
    --from-literal=OPENFGA_DATASTORE_URI="${openfga_uri}" \
    --dry-run=client -o yaml | kubectl apply -f - &>/dev/null

  if $ENABLE_LITELLM_DB; then
    local litellm_uri="postgresql://litellm:${LITELLM_DB_PASSWORD}@${SHARED_PG_SERVICE}:5432/litellm"
    kubectl create secret generic caipe-litellm-db \
      --namespace caipe \
      --from-literal=DATABASE_URL="${litellm_uri}" \
      --dry-run=client -o yaml | kubectl apply -f - &>/dev/null
  fi

  # Try known name variants (bitnami 18.x uses -primary suffix in standalone mode).
  # Use GET-by-name to avoid RBAC restrictions on cluster-wide LIST operations.
  local _pg_sts_check
  for _pg_sts_check in "${SHARED_PG_SERVICE}" "${SHARED_PG_SERVICE}-primary"; do
    if kubectl get statefulset "$_pg_sts_check" -n caipe &>/dev/null; then
      log "Shared Postgres already present (${_pg_sts_check}) — skipping install"
      return 0
    fi
  done

  step "Deploying shared Postgres (${SHARED_PG_SERVICE}) for Keycloak/OpenFGA"

  # initdb bootstrap: create a login role + owned database per consumer. Only
  # runs when the PVC is empty (first install); harmless to define on re-runs.
  local initdb_file
  initdb_file=$(mktemp /tmp/caipe-pg-initdb-XXXXXX.sql)
  cat > "$initdb_file" <<PGINIT
CREATE ROLE keycloak WITH LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}';
CREATE DATABASE keycloak OWNER keycloak;
CREATE ROLE openfga WITH LOGIN PASSWORD '${OPENFGA_DB_PASSWORD}';
CREATE DATABASE openfga OWNER openfga;
PGINIT
  if $ENABLE_LITELLM_DB; then
    cat >> "$initdb_file" <<PGINIT
CREATE ROLE litellm WITH LOGIN PASSWORD '${LITELLM_DB_PASSWORD}';
CREATE DATABASE litellm OWNER litellm;
PGINIT
  fi

  helm repo add bitnami https://charts.bitnami.com/bitnami 2>/dev/null || true
  helm repo update bitnami 2>/dev/null || true
  if ! helm upgrade --install "${SHARED_PG_SERVICE}" bitnami/postgresql \
    -n caipe \
    --create-namespace \
    --set "fullnameOverride=${SHARED_PG_SERVICE}" \
    --set architecture=standalone \
    --set "auth.postgresPassword=${SHARED_PG_ADMIN_PASSWORD}" \
    --set primary.persistence.size=4Gi \
    --set-file "primary.initdb.scripts.caipe-init\.sql=${initdb_file}" \
    --timeout 5m 2>&1 | while IFS= read -r line; do log "$line"; done; then
    rm -f "$initdb_file"
    err "Shared Postgres install failed — check the output above and re-run"
    exit 1
  fi
  rm -f "$initdb_file"

  # Let the API server process all resource creation before we start polling.
  sleep 5

  # Resolve the actual StatefulSet name — bitnami postgresql 18.x names it
  # 'caipe-postgres-primary' in standalone mode, not 'caipe-postgres'.
  # Use GET-by-name for each known variant to avoid RBAC list restrictions.
  log "Waiting for Postgres StatefulSet to appear..."
  local _pg_sts="" _pg_deadline=$(( SECONDS + 90 ))
  until [[ -n "$_pg_sts" ]]; do
    local _candidate
    for _candidate in "${SHARED_PG_SERVICE}" "${SHARED_PG_SERVICE}-primary"; do
      if kubectl get statefulset "$_candidate" -n caipe &>/dev/null; then
        _pg_sts="$_candidate"
        break
      fi
    done
    if [[ -z "$_pg_sts" ]]; then
      if [[ $SECONDS -ge $_pg_deadline ]]; then
        err "Timed out waiting for ${SHARED_PG_SERVICE} StatefulSet after 90s"
        err "--- helm release status ---"
        helm status "${SHARED_PG_SERVICE}" -n caipe 2>&1 | while IFS= read -r l; do err "  $l"; done
        err "--- GET by name attempts ---"
        kubectl get statefulset "${SHARED_PG_SERVICE}" -n caipe 2>&1 | while IFS= read -r l; do err "  $l"; done
        kubectl get statefulset "${SHARED_PG_SERVICE}-primary" -n caipe 2>&1 | while IFS= read -r l; do err "  $l"; done
        err "--- StatefulSets in all namespaces ---"
        kubectl get statefulset --all-namespaces 2>&1 | while IFS= read -r l; do err "  $l"; done
        err "--- Pods in namespace caipe ---"
        kubectl get pods -n caipe 2>&1 | while IFS= read -r l; do err "  $l"; done
        err "--- GET pod caipe-postgres-0 by name ---"
        kubectl get pod caipe-postgres-0 -n caipe 2>&1 | while IFS= read -r l; do err "  $l"; done
        err "--- kubectl context + server ---"
        kubectl config current-context 2>&1 | while IFS= read -r l; do err "  context: $l"; done
        kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}{"\n"}' 2>&1 \
          | while IFS= read -r l; do err "  server: $l"; done
        err "--- helm env (shows KUBECONFIG helm is using) ---"
        helm env 2>&1 | grep -E 'KUBE|DATA' | while IFS= read -r l; do err "  $l"; done
        err "--- KUBECONFIG env var ---"
        err "  KUBECONFIG=${KUBECONFIG:-<unset>}"
        exit 1
      fi
      sleep 3
    fi
  done
  log "Waiting for Postgres to be ready (StatefulSet: ${_pg_sts})..."
  kubectl rollout status statefulset/"${_pg_sts}" -n caipe --timeout=300s 2>&1 \
    | while IFS= read -r line; do log "$line"; done
  log "Shared Postgres deployed (${SHARED_PG_SERVICE}) with keycloak/openfga databases"
}

_resolve_mongodb_password() {
  local existing_pw
  existing_pw=$(kubectl get secret caipe-mongodb-credentials -n caipe \
    -o jsonpath='{.data.MONGODB_ROOT_PASSWORD}' 2>/dev/null \
    | base64 -d 2>/dev/null || true)
  if [[ -n "$existing_pw" ]]; then
    MONGODB_ROOT_PASSWORD="$existing_pw"
    log "Reusing existing MongoDB root password from caipe-mongodb-credentials Secret"
  else
    # `openssl rand -hex 24` → 48 hex chars (24 bytes of entropy). Hex
    # avoids any character that would need URL-encoding inside the
    # MONGODB_URI connection string (no '@', '/', ':', '?', etc.).
    MONGODB_ROOT_PASSWORD="$(openssl rand -hex 24)"
    log "Generated random MongoDB root password"
  fi
  # Persist (or refresh) the Secret so re-runs reuse it. --dry-run +
  # apply is the standard idempotent pattern used elsewhere in this
  # script.
  kubectl create secret generic caipe-mongodb-credentials \
    --namespace caipe \
    --from-literal=MONGODB_ROOT_USERNAME="admin" \
    --from-literal=MONGODB_ROOT_PASSWORD="${MONGODB_ROOT_PASSWORD}" \
    --from-literal=MONGODB_DATABASE="caipe" \
    --dry-run=client -o yaml \
    | kubectl apply -f - &>/dev/null
}

# Resolve (reuse-or-generate) the Keycloak bootstrap admin password and persist
# it in the caipe-keycloak-admin Secret so re-runs reuse the same value. The
# keycloak subchart requires keycloak.admin.password (or a secretRef) to be set
# — it refuses to auto-generate because Keycloak stores the bootstrap admin in
# its database, so a regenerated value on upgrade would silently drift from the
# already-bootstrapped admin. Mirrors _resolve_mongodb_password.
_resolve_keycloak_admin_password() {
  # The keycloak subchart owns the caipe-keycloak-admin Secret (keys
  # username/password) and marks it helm.sh/resource-policy: keep, so it
  # survives uninstalls. We must NOT create our own Secret of that name —
  # Helm refuses to adopt a non-Helm-owned object. Instead read the existing
  # chart-owned value for reuse (idempotent across upgrades), or generate a
  # fresh one on first install and let the chart create+own the Secret.
  local existing_pw
  existing_pw=$(kubectl get secret caipe-keycloak-admin -n caipe \
    -o jsonpath='{.data.password}' 2>/dev/null \
    | base64 -d 2>/dev/null || true)
  if [[ -n "$existing_pw" ]]; then
    KEYCLOAK_ADMIN_PASSWORD="$existing_pw"
    log "Reusing existing Keycloak admin password from caipe-keycloak-admin Secret"
  else
    # Hex avoids characters that would need escaping in YAML / URLs.
    KEYCLOAK_ADMIN_PASSWORD="$(openssl rand -hex 24)"
    log "Generated random Keycloak admin password"
  fi
}

# Pre-create caipe-platform-secret before helm install. PR #1519 wired a hard
# secretKeyRef to this Secret in the caipe-ui Deployment unconditionally, so
# the pod fails with CreateContainerConfigError if it is absent. Reuses the
# existing value on re-runs; Keycloak init-idp reconciles it into the
# caipe-platform client on first boot.
_ensure_caipe_platform_secret() {
  local existing
  existing=$(kubectl get secret caipe-platform-secret -n caipe \
    -o jsonpath='{.data.OIDC_CLIENT_SECRET}' 2>/dev/null \
    | base64 -d 2>/dev/null || true)
  if [[ -n "$existing" ]]; then
    log "Reusing existing caipe-platform-secret"
    return 0
  fi
  kubectl create secret generic caipe-platform-secret \
    --namespace caipe \
    --from-literal=OIDC_CLIENT_SECRET="$(openssl rand -hex 32)" \
    --dry-run=client -o yaml \
    | kubectl apply -f - &>/dev/null
  log "Created caipe-platform-secret (OIDC_CLIENT_SECRET, 32-byte random)"
}

_ensure_dynamic_agents_mongodb() {
  local mongo_svc="caipe-mongodb"
  _resolve_mongodb_password
  local mongo_uri="mongodb://admin:${MONGODB_ROOT_PASSWORD}@${mongo_svc}:27017/caipe?authSource=caipe"

  if ! kubectl get deploy "${mongo_svc}" -n caipe &>/dev/null; then
    step "Deploying MongoDB for dynamic-agents"
    helm repo add bitnami https://charts.bitnami.com/bitnami &>/dev/null 2>&1 || true
    helm upgrade --install "${mongo_svc}" bitnami/mongodb \
      -n caipe \
      --set auth.enabled=true \
      --set "auth.rootPassword=${MONGODB_ROOT_PASSWORD}" \
      --set "auth.databases[0]=caipe" \
      --set "auth.usernames[0]=admin" \
      --set "auth.passwords[0]=${MONGODB_ROOT_PASSWORD}" \
      --set persistence.size=2Gi \
      --timeout 3m &>/dev/null
    kubectl rollout status deploy/"${mongo_svc}" -n caipe --timeout=180s &>/dev/null
    log "MongoDB deployed (${mongo_svc}) with random root password"
  else
    log "MongoDB already present (${mongo_svc}) — skipping install"
  fi

  # Patch MONGODB_URI into dynamic-agents ConfigMap using python3 to avoid
  # shell special-character escaping issues with ? in the URI.
  if kubectl get cm caipe-dynamic-agents-config -n caipe &>/dev/null; then
    local cur_uri
    cur_uri=$(kubectl get cm caipe-dynamic-agents-config -n caipe \
      -o jsonpath='{.data.MONGODB_URI}' 2>/dev/null || true)
    if [[ "$cur_uri" != "$mongo_uri" ]]; then
      python3 -c "
import subprocess, json
patch = json.dumps({'data': {'MONGODB_URI': '${mongo_uri}'}})
subprocess.run(['kubectl','patch','cm','caipe-dynamic-agents-config',
  '-n','caipe','--type','merge','-p',patch], check=False)
"
      kubectl rollout restart deploy/caipe-dynamic-agents -n caipe &>/dev/null
      log "dynamic-agents MONGODB_URI patched → ${mongo_uri}"
    fi
  else
    warn "caipe-dynamic-agents-config ConfigMap not found — skipping MONGODB_URI patch (will be set on next helm upgrade)"
  fi

  # Also ensure the UI secret has a MONGODB_URI so the UI can persist sessions
  if kubectl get secret caipe-ui-secret -n caipe &>/dev/null; then
    local ui_uri_b64
    ui_uri_b64=$(echo -n "${mongo_uri}" | base64 -w0)
    kubectl patch secret caipe-ui-secret -n caipe --type='json' \
      -p="[{\"op\":\"add\",\"path\":\"/data/MONGODB_URI\",\"value\":\"${ui_uri_b64}\"}]" \
      &>/dev/null || true
  fi

}

_wait_for_milvus() {
  local ns="caipe" timeout=120 interval=5 elapsed=0
  log "Waiting for Milvus to become ready..."
  while [[ $elapsed -lt $timeout ]]; do
    local milvus_ready
    milvus_ready=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null \
      | awk '/milvus-standalone/ && $3=="Running" && $2~"^[0-9]+/[0-9]+$" {split($2,a,"/"); if(a[1]==a[2]) print}' \
      | wc -l | tr -d ' ')
    if [[ "$milvus_ready" -gt 0 ]]; then
      log "Milvus standalone is ready"
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  warn "Milvus did not become ready within ${timeout}s; RAG init may retry"
  return 1
}

_finalize_rag_startup() {
  step "Finalizing RAG server startup"

  _wait_for_milvus || true

  # Re-enable init tests and restart RAG server
  kubectl set env deployment/rag-server -n caipe -c rag-server \
    SKIP_INIT_TESTS=false &>/dev/null 2>&1
  log "RAG server restarted with init tests enabled"

  local rag_timeout=120 elapsed=0 ssl_checked_here=false
  while [[ $elapsed -lt $rag_timeout ]]; do
    local rag_status
    rag_status=$(kubectl get pods -n caipe --no-headers 2>/dev/null \
      | awk '/rag-server/ && $3=="Running" && $2~"^[0-9]+/[0-9]+$" {split($2,a,"/"); if(a[1]==a[2]) print}' \
      | wc -l | tr -d ' ')
    if [[ "$rag_status" -gt 0 ]]; then
      log "RAG server is healthy"
      return 0
    fi

    # Check for SSL errors while waiting (after 15s to let pods attempt startup)
    if ! $ssl_checked_here && ! $INJECT_CORPORATE_CA && ! $CA_SSL_FIX_PROMPTED \
       && [[ $elapsed -ge 15 ]]; then
      local rag_pod
      rag_pod=$(kubectl get pods -n caipe --no-headers 2>/dev/null \
        | awk '/rag-server/ && $3!="Terminating" {print $1; exit}')
      if [[ -n "$rag_pod" ]]; then
        local rag_logs
        rag_logs=$(kubectl logs "$rag_pod" -n caipe -c rag-server --tail=200 2>/dev/null || true)
        if echo "$rag_logs" | grep -q "CERTIFICATE_VERIFY_FAILED\|SSL.*certificate\|SSLCertVerificationError"; then
          echo ""
          _auto_heal_offer_corporate_ca "RAG server"
          ssl_checked_here=true
          if $INJECT_CORPORATE_CA; then
            log "Corporate CA patched; waiting for RAG server to restart..."
            elapsed=0
            sleep 10
            continue
          fi
        fi
      fi
      ssl_checked_here=true
    fi

    printf "\r${DIM}  Waiting for RAG server  (%ds)${NC}  " "$elapsed"
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo ""
  warn "RAG server did not become healthy within ${rag_timeout}s"
}

# ─── Knowledge base ingestion ────────────────────────────────────────────────
# Calls the RAG server's webloader ingestion API to crawl and index URLs.
# The web-ingestor sidecar picks up the job from a Redis queue, crawls the
# site (using sitemap discovery), chunks the content, and stores embeddings
# in Milvus.  CAIPE docs site uses Docusaurus, which the ingestor auto-detects.
_rag_api() {
  # Call the RAG server API from inside its own pod using python3 (no curl
  # available in the distroless image).  $1=method $2=path $3=json_body (optional)
  local method="$1" path="$2" body="${3:-}"
  local py_script
  read -r -d '' py_script <<'PYEOF' || true
import sys, json, urllib.request, urllib.error
method, path = sys.argv[1], sys.argv[2]
body = sys.argv[3] if len(sys.argv) > 3 else None
url = f"http://localhost:9446{path}"
data = body.encode() if body else None
req = urllib.request.Request(url, data=data, method=method)
if data:
    req.add_header("Content-Type", "application/json")
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(resp.read().decode())
except urllib.error.HTTPError as e:
    err_body = e.read().decode() if e.fp else ""
    print(err_body)
    sys.exit(1)
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
PYEOF
  if [[ -n "$body" ]]; then
    kubectl exec -n caipe "$RAG_POD" -c rag-server -- \
      python3 -c "$py_script" "$method" "$path" "$body" 2>&1
  else
    kubectl exec -n caipe "$RAG_POD" -c rag-server -- \
      python3 -c "$py_script" "$method" "$path" 2>&1
  fi
}

_wait_for_rag_api() {
  local timeout=90 elapsed=0
  while [[ $elapsed -lt $timeout ]]; do
    RAG_POD=$(kubectl get pods -n caipe -l app.kubernetes.io/name=rag-server \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' 2>/dev/null \
      | awk -F'\t' '$2=="Running" && $3=="" {print $1; exit}')

    if [[ -n "$RAG_POD" ]]; then
      local health
      health=$(_rag_api GET /healthz 2>&1) || true
      if echo "$health" | grep -q '"healthy"'; then
        return 0
      fi
    fi
    printf "\r${DIM}  Waiting for RAG server API  (%ds)${NC}  " "$elapsed"
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo ""
  return 1
}

ingest_knowledge_base() {
  [[ ${#INGEST_URLS[@]} -eq 0 ]] && return 0

  step "Ingesting knowledge base URLs"

  RAG_POD=""
  if ! _wait_for_rag_api; then
    warn "RAG server API not reachable after 90s; skipping ingestion"
    return 1
  fi
  log "RAG server is healthy (pod: ${RAG_POD})"

  local success=0 fail=0
  for url in "${INGEST_URLS[@]}"; do
    log "Submitting: ${url}"

    local body resp
    body="{\"url\":\"${url}\",\"description\":\"Auto-ingested by setup-caipe.sh\",\"settings\":{\"crawl_mode\":\"sitemap\",\"max_pages\":2000,\"chunk_size\":10000,\"chunk_overlap\":2000,\"concurrent_requests\":10,\"download_delay\":0.1}}"
    resp=$(_rag_api POST /v1/ingest/webloader/url "$body") || true

    if echo "$resp" | grep -q '"datasource_id"'; then
      local ds_id job_id
      ds_id=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('datasource_id',''))" 2>/dev/null || true)
      job_id=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('job_id',''))" 2>/dev/null || true)
      log "Queued — datasource=${ds_id}  job=${job_id}"
      success=$((success + 1))
    elif echo "$resp" | grep -q "already ingested"; then
      warn "Already ingested: ${url} (delete datasource first to re-ingest)"
      success=$((success + 1))
    else
      err "Failed to queue: ${url}"
      err "  Response: ${resp}"
      fail=$((fail + 1))
    fi
  done

  if [[ $success -gt 0 ]]; then
    log "Ingestion jobs queued: ${success} succeeded, ${fail} failed"
    log "The web-ingestor will crawl the site(s) in the background"
    log "Monitor progress in the CAIPE UI Knowledge Base tab"
  fi
}

deploy_vllm() {
  step "Deploying vLLM (model: ${VLLM_MODEL})"

  # GPU node detection
  local gpu_nodes
  gpu_nodes=$(kubectl get nodes -o json \
    | jq '[.items[] | select(.status.capacity."nvidia.com/gpu" != null)] | length' 2>/dev/null || echo "0")
  if [[ "$gpu_nodes" -eq 0 ]]; then
    warn "No GPU nodes detected in the cluster"
    warn "vLLM serving ${VLLM_MODEL} typically requires GPU (A100/H100)"
    warn "The deployment will proceed but pods may stay Pending without GPU resources"
    if ! $NON_INTERACTIVE; then
      if ! ask_yn "Continue vLLM deployment without GPU nodes?" "y"; then
        log "Skipping vLLM deployment"
        return 0
      fi
    fi
  else
    log "Found ${gpu_nodes} GPU node(s)"
  fi

  helm repo add vllm https://vllm-project.github.io/production-stack 2>/dev/null || true
  helm repo update vllm 2>/dev/null || true

  local vllm_args=(
    --namespace caipe
    --create-namespace
    --set "servingEngineSpec.modelSpec[0].modelURL=${VLLM_MODEL}"
    --set "servingEngineSpec.modelSpec[0].replicaCount=1"
  )

  if [[ "$gpu_nodes" -gt 0 ]]; then
    vllm_args+=(--set "servingEngineSpec.modelSpec[0].requestGPU=${VLLM_GPU_COUNT}")
  fi

  if [[ -n "${HF_TOKEN:-}" ]]; then
    vllm_args+=(--set "servingEngineSpec.modelSpec[0].hf_token=${HF_TOKEN}")
  fi

  if ! helm upgrade --install vllm vllm/vllm-stack "${vllm_args[@]}" 2>&1; then
    err "vLLM Helm install failed"
    return 1
  fi
  log "vLLM Helm release deployed (model: ${VLLM_MODEL})"
  log "vLLM API will be available at http://vllm-router.caipe.svc.cluster.local:80/v1"
}

# Resolve unified --litellm mode once, after credential collection. Validates
# the provider is supported, captures the *real* chat/embeddings providers (so
# deploy_litellm can build the proxy model_list), then rewrites the working
# LLM_PROVIDER/EMBEDDINGS_PROVIDER so agents (via llm-secret) and RAG (via helm)
# are repointed at the in-cluster proxy. Self-disables (warn) on unsupported
# combos so a bare --litellm never breaks an otherwise-valid install.
_finalize_litellm_mode() {
  $LLM_VIA_LITELLM || return 0
  if $ENABLE_VLLM; then
    warn "--litellm ignored: vLLM mode already routes through LiteLLM"
    LLM_VIA_LITELLM=false
    return 0
  fi
  case "$LLM_PROVIDER" in
    anthropic-claude|openai|aws-bedrock|azure-openai) ;;
    *)
      # Ollama sets LLM_PROVIDER=openai, so it passes the check above.
      # Any other unknown provider is unsupported.
      if ! $ENABLE_OLLAMA; then
        warn "--litellm does not support LLM provider '${LLM_PROVIDER}' yet — continuing without the proxy"
        LLM_VIA_LITELLM=false
        return 0
      fi
      ;;
  esac

  local _lep="http://litellm-proxy.caipe.svc.cluster.local:4000/v1"
  LITELLM_ENDPOINT="$_lep"
  LITELLM_API_KEY="$LITELLM_MASTER_KEY"
  LITELLM_EMBED_MODEL_REAL="$EMBEDDINGS_MODEL"
  LITELLM_EMBED_SOURCE="$EMBEDDINGS_PROVIDER"

  if $ENABLE_OLLAMA; then
    LITELLM_CHAT_SOURCE="ollama"
    # Route Ollama embeddings through LiteLLM too so everything goes via
    # the single proxy endpoint.
    LITELLM_ROUTE_EMBEDDINGS=true
    LITELLM_EMBED_SOURCE="ollama"
    EMBEDDINGS_PROVIDER="litellm"
    # Keep the real embed model name (e.g. nomic-embed-text) — LiteLLM
    # registers it under that same alias in the model_list.
  else
    LITELLM_CHAT_SOURCE="$LLM_PROVIDER"
    # Only OpenAI-compatible embeddings can be fronted by the proxy; other
    # providers (bedrock/cohere/huggingface/voyage) keep their native path.
    case "$EMBEDDINGS_PROVIDER" in
      openai|azure-openai)
        LITELLM_ROUTE_EMBEDDINGS=true
        EMBEDDINGS_PROVIDER="litellm"
        EMBEDDINGS_MODEL="caipe-embeddings"
        ;;
      *)
        LITELLM_ROUTE_EMBEDDINGS=false
        ;;
    esac
  fi

  log "LiteLLM proxy mode ON — chat=${LITELLM_CHAT_SOURCE}, embed_source=${LITELLM_EMBED_SOURCE} (routed: ${LITELLM_ROUTE_EMBEDDINGS})"
}

# Build the proxy model_list for unified mode from the captured real provider and
# (re)create litellm-upstream-secret with the upstream provider credentials the
# proxy reads via os.environ/*. Echoes the model_list YAML (6-space indented,
# ready to drop under `model_list:`) to stdout; creates the Secret as a side
# effect. Credentials live only in this Secret + the proxy pod — never in the
# agent-facing llm-secret.
_litellm_unified_assets() {
  local up_args=(--from-literal=LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY}")
  local ml=""

  # Azure OpenAI routes by *deployment* name, which can differ from the model
  # name and is absent from many env files (e.g. the docker-compose .env only
  # carries EMBEDDINGS_MODEL). Resolve sensible fallbacks so a bare azure-openai
  # install never dies under `set -u`, and surface the assumption on stderr
  # (this function's stdout is captured as the model_list, so log/warn — which
  # print to stdout — must NOT be used here; use `>&2`).
  #
  # Embeddings: fall back to LITELLM_EMBED_MODEL_REAL (the real upstream model
  # captured before EMBEDDINGS_MODEL is aliased to "caipe-embeddings"), NOT
  # EMBEDDINGS_MODEL — by the time this runs EMBEDDINGS_MODEL is the proxy alias.
  # Chat: there is no separate real azure-chat model var, so only the explicit
  # deployment vars are honored; an unset deployment is a hard misconfig that the
  # stderr note flags (the proxy chat model would 404 until it is set).
  local azure_chat_deploy="${AZURE_OPENAI_DEPLOYMENT:-${AZURE_OPENAI_CHAT_DEPLOYMENT:-}}"
  local azure_embed_deploy="${AZURE_OPENAI_EMBEDDING_DEPLOYMENT:-${AZURE_OPENAI_DEPLOYMENT:-${LITELLM_EMBED_MODEL_REAL:-text-embedding-3-large}}}"

  case "$LITELLM_CHAT_SOURCE" in
    ollama)
      local _ollama_base="http://ollama.${CAIPE_NAMESPACE:-caipe}.svc.cluster.local:${OLLAMA_PORT}"
      ml+='      - model_name: "caipe-chat"
        litellm_params:
          model: "ollama/'"${OLLAMA_MODEL}"'"
          api_base: "'"${_ollama_base}"'"
'
      # No upstream secret needed — Ollama has no auth
      ;;
    anthropic-claude)
      ml+='      - model_name: "caipe-chat"
        litellm_params:
          model: "anthropic/'"${ANTHROPIC_MODEL_NAME}"'"
          api_key: "os.environ/ANTHROPIC_API_KEY"
'
      up_args+=(--from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}")
      ;;
    openai)
      ml+='      - model_name: "caipe-chat"
        litellm_params:
          model: "openai/'"${OPENAI_MODEL_NAME}"'"
          api_key: "os.environ/LITELLM_UPSTREAM_OPENAI_API_KEY"
          api_base: "os.environ/LITELLM_UPSTREAM_OPENAI_BASE"
'
      up_args+=(--from-literal=LITELLM_UPSTREAM_OPENAI_API_KEY="${OPENAI_API_KEY}")
      up_args+=(--from-literal=LITELLM_UPSTREAM_OPENAI_BASE="${OPENAI_ENDPOINT}")
      ;;
    aws-bedrock)
      ml+='      - model_name: "caipe-chat"
        litellm_params:
          model: "bedrock/'"${AWS_BEDROCK_MODEL_ID}"'"
          aws_access_key_id: "os.environ/AWS_ACCESS_KEY_ID"
          aws_secret_access_key: "os.environ/AWS_SECRET_ACCESS_KEY"
          aws_region_name: "os.environ/AWS_REGION"
'
      up_args+=(--from-literal=AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}")
      up_args+=(--from-literal=AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}")
      up_args+=(--from-literal=AWS_REGION="${AWS_REGION:-us-east-1}")
      ;;
    azure-openai)
      [[ -n "$azure_chat_deploy" ]] || echo "  ! azure-openai chat via --litellm: set AZURE_OPENAI_DEPLOYMENT (the Azure deployment name); the proxy chat model may 404 until then" >&2
      ml+='      - model_name: "caipe-chat"
        litellm_params:
          model: "azure/'"${azure_chat_deploy}"'"
          api_base: "os.environ/AZURE_OPENAI_ENDPOINT"
          api_key: "os.environ/AZURE_OPENAI_API_KEY"
          api_version: "os.environ/AZURE_OPENAI_API_VERSION"
'
      up_args+=(--from-literal=AZURE_OPENAI_ENDPOINT="${AZURE_OPENAI_ENDPOINT}")
      up_args+=(--from-literal=AZURE_OPENAI_API_KEY="${AZURE_OPENAI_API_KEY}")
      up_args+=(--from-literal=AZURE_OPENAI_API_VERSION="${AZURE_OPENAI_API_VERSION:-2025-04-01-preview}")
      ;;
  esac

  if $LITELLM_ROUTE_EMBEDDINGS; then
    case "$LITELLM_EMBED_SOURCE" in
      ollama)
        local _ollama_base="http://ollama.${CAIPE_NAMESPACE:-caipe}.svc.cluster.local:${OLLAMA_PORT}"
        ml+='      - model_name: "'"${LITELLM_EMBED_MODEL_REAL}"'"
        litellm_params:
          model: "ollama/'"${LITELLM_EMBED_MODEL_REAL}"'"
          api_base: "'"${_ollama_base}"'"
'
        ;;
      openai)
        ml+='      - model_name: "caipe-embeddings"
        litellm_params:
          model: "openai/'"${LITELLM_EMBED_MODEL_REAL:-text-embedding-3-large}"'"
          api_key: "os.environ/LITELLM_UPSTREAM_EMBED_OPENAI_API_KEY"
'
        up_args+=(--from-literal=LITELLM_UPSTREAM_EMBED_OPENAI_API_KEY="${OPENAI_API_KEY}")
        ;;
      azure-openai)
        [[ -n "${AZURE_OPENAI_EMBEDDING_DEPLOYMENT:-${AZURE_OPENAI_DEPLOYMENT:-}}" ]] || echo "  ! azure-openai embeddings via --litellm: AZURE_OPENAI_DEPLOYMENT unset, defaulting deployment to '${azure_embed_deploy}' (the embeddings model name) — set AZURE_OPENAI_EMBEDDING_DEPLOYMENT if your Azure deployment is named differently" >&2
        ml+='      - model_name: "caipe-embeddings"
        litellm_params:
          model: "azure/'"${azure_embed_deploy}"'"
          api_base: "os.environ/AZURE_OPENAI_ENDPOINT"
          api_key: "os.environ/AZURE_OPENAI_API_KEY"
          api_version: "os.environ/AZURE_OPENAI_API_VERSION"
'
        # Azure creds already added by the chat case above when chat is azure;
        # add them here too for the chat!=azure combination (kubectl de-dupes
        # only fails on duplicate keys, so guard with the chat source).
        if [[ "$LITELLM_CHAT_SOURCE" != "azure-openai" ]]; then
          up_args+=(--from-literal=AZURE_OPENAI_ENDPOINT="${AZURE_OPENAI_ENDPOINT}")
          up_args+=(--from-literal=AZURE_OPENAI_API_KEY="${AZURE_OPENAI_API_KEY}")
          up_args+=(--from-literal=AZURE_OPENAI_API_VERSION="${AZURE_OPENAI_API_VERSION:-2025-04-01-preview}")
        fi
        ;;
    esac
  fi

  kubectl create secret generic litellm-upstream-secret -n caipe \
    "${up_args[@]}" \
    --dry-run=client -o yaml | kubectl apply -f - &>/dev/null

  printf '%s' "$ml"
}

deploy_litellm() {
  step "Deploying LiteLLM Proxy"

  local model_list_yaml="" envfrom_yaml="" general_yaml=""

  if $LLM_VIA_LITELLM && ! $ENABLE_VLLM; then
    # Unified mode: front the real provider, require the routing master key, and
    # read upstream creds from litellm-upstream-secret (+ optional DB).
    model_list_yaml="$(_litellm_unified_assets)"
    general_yaml='    general_settings:
      master_key: "os.environ/LITELLM_MASTER_KEY"'
    envfrom_yaml='        envFrom:
        - secretRef:
            name: litellm-upstream-secret'
    if $ENABLE_LITELLM_DB; then
      envfrom_yaml+='
        - secretRef:
            name: caipe-litellm-db'
    fi
  else
    # vLLM mode: proxy the in-cluster vLLM router as an OpenAI-compatible model.
    local vllm_api_base="http://vllm-router.caipe.svc.cluster.local:80/v1"
    model_list_yaml="      - model_name: \"${LITELLM_MODEL_NAME}\"
        litellm_params:
          model: \"openai/${VLLM_MODEL}\"
          api_base: \"${vllm_api_base}\"
          api_key: \"not-needed\"
      - model_name: \"text-embedding-3-small\"
        litellm_params:
          model: \"openai/text-embedding-3-small\"
          api_base: \"${vllm_api_base}\"
          api_key: \"not-needed\""
  fi

  kubectl apply -n caipe -f - <<LITELLM_EOF
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: litellm-config
  namespace: caipe
  labels:
    app: litellm-proxy
    app.kubernetes.io/managed-by: setup-caipe
data:
  config.yaml: |
    model_list:
${model_list_yaml}
${general_yaml}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: litellm-proxy
  namespace: caipe
  labels:
    app: litellm-proxy
    app.kubernetes.io/managed-by: setup-caipe
spec:
  replicas: 1
  selector:
    matchLabels:
      app: litellm-proxy
  template:
    metadata:
      labels:
        app: litellm-proxy
    spec:
      containers:
      - name: litellm
        image: ghcr.io/berriai/litellm:main-stable
        args: ["--config", "/app/config.yaml", "--port", "4000"]
${envfrom_yaml}
        ports:
        - containerPort: 4000
          name: http
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /health/liveliness
            port: 4000
          initialDelaySeconds: 15
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/readiness
            port: 4000
          initialDelaySeconds: 10
          periodSeconds: 5
        volumeMounts:
        - name: config
          mountPath: /app/config.yaml
          subPath: config.yaml
          readOnly: true
        resources:
          # litellm:main-stable loads a large dependency tree at startup and is
          # OOMKilled (exit 137) at 512Mi or 1Gi limits even with no traffic;
          # ~2Gi is required for it to reach a Ready state. See PR verification.
          requests:
            cpu: 250m
            memory: 512Mi
          limits:
            cpu: "1"
            memory: 2Gi
      volumes:
      - name: config
        configMap:
          name: litellm-config
---
apiVersion: v1
kind: Service
metadata:
  name: litellm-proxy
  namespace: caipe
  labels:
    app: litellm-proxy
    app.kubernetes.io/managed-by: setup-caipe
spec:
  type: ClusterIP
  ports:
  - port: 4000
    targetPort: 4000
    protocol: TCP
    name: http
  selector:
    app: litellm-proxy
LITELLM_EOF

  kubectl rollout restart deployment/litellm-proxy -n caipe &>/dev/null || true
  log "LiteLLM proxy deployed (endpoint: http://litellm-proxy.caipe.svc.cluster.local:4000)"
}

_write_rbac_runtime_values() {
  local values_file
  values_file=$(mktemp /tmp/caipe-rbac-runtime-XXXXXX)

  local keycloak_ssl_required="external"
  if [[ -z "$CAIPE_DOMAIN" ]]; then
    keycloak_ssl_required="none"
  fi

  # When a public DNS domain is set, make Keycloak browser-reachable and emit a
  # stable public issuer: expose /realms/caipe + /resources via ingress, force
  # KC_HOSTNAME so discovery/issuer/endpoints are the public URL (server-side
  # discovery via the in-cluster service still resolves to public endpoints),
  # and register the public NextAuth callback on the caipe-ui client. Skipped
  # for IP domains (Ingress host must be a DNS name) and local installs.
  local _kc_public_yaml=""
  if [[ -n "$CAIPE_DOMAIN" && ! "$CAIPE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    _kc_public_yaml=$(cat <<KCPUB
  env:
    KC_HOSTNAME: "https://${CAIPE_DOMAIN}"
    KC_PROXY_HEADERS: "xforwarded"
  ingress:
    enabled: true
    className: "nginx"
    hosts:
      - host: "${CAIPE_DOMAIN}"
        paths:
          - path: /realms/caipe
            pathType: Prefix
          - path: /resources
            pathType: Prefix
    tls:
      - secretName: caipe-tls
        hosts:
          - "${CAIPE_DOMAIN}"
  uiClient:
    redirectUris:
      - "https://${CAIPE_DOMAIN}/*"
      - "http://localhost:3000/*"
    webOrigins:
      - "https://${CAIPE_DOMAIN}"
KCPUB
)
  fi

  # When the shared Postgres is active, point Keycloak at it via the keycloak
  # chart's database.* contract (the chart renders KC_DB / KC_DB_URL /
  # KC_DB_USERNAME and injects KC_DB_PASSWORD from existingSecret) and OpenFGA
  # (datastore.engine=postgres) so RBAC state survives pod restarts. The DB
  # password comes from the caipe-keycloak-db Secret — never written here.
  local kc_db_block="" fga_ds_block=""
  if _shared_postgres_active; then
    kc_db_block=$(cat <<KCDB
  database:
    enabled: true
    host: "${SHARED_PG_SERVICE}"
    port: 5432
    name: keycloak
    username: keycloak
    existingSecret: "caipe-keycloak-db"
    existingSecretPasswordKey: "KC_DB_PASSWORD"
KCDB
)
    fga_ds_block=$(cat <<FGADB
  datastore:
    engine: "postgres"
    uriSecretRef:
      name: "caipe-openfga-db"
      key: "OPENFGA_DATASTORE_URI"
FGADB
)
  fi

  cat > "$values_file" <<RBACEOF
tags:
  keycloak: true

global:
  openfga:
    httpUrl: "http://caipe-openfga:8080"
    storeName: "caipe-openfga"
  agentgateway:
    enabled: true
    proxyPort: ${AGENTGATEWAY_PORT}
    extAuth:
      enabled: true
      serviceName: "caipe-openfga-authz-bridge"
      serviceNamespace: "caipe"
      port: 9100

keycloak:
  admin:
    username: "admin"
    password: "${KEYCLOAK_ADMIN_PASSWORD}"
  realm:
    sslRequired: "${keycloak_ssl_required}"
${_kc_public_yaml}
${kc_db_block}

openfga:
  enabled: true
${fga_ds_block}
  init:
    enabled: true
    storeName: "caipe-openfga"

openfgaAuthzBridge:
  enabled: true

openfga-authz-bridge:
  openfga:
    httpUrl: "http://caipe-openfga:8080"
    storeName: "caipe-openfga"
  tokenValidation:
    jwksUrl: "http://caipe-keycloak:8080/realms/caipe/protocol/openid-connect/certs"
    algorithms:
      - RS256

agentgateway:
  enabled: true

caipe-ui:
  config:
    OPENFGA_HTTP: "http://caipe-openfga:8080"
    OPENFGA_STORE_NAME: "caipe-openfga"
    OPENFGA_RECONCILE_ENABLED: "true"
    KEYCLOAK_URL: "http://caipe-keycloak:8080"
    KEYCLOAK_REALM: "caipe"
    KEYCLOAK_RESOURCE_SERVER_ID: "caipe-platform"
RBACEOF

  if [[ -n "$UI_ENV_FILE" ]]; then
    local oidc_issuer
    oidc_issuer=$(_env_get "$UI_ENV_FILE" "OIDC_ISSUER")
    # With a public DNS domain the token `iss` is the public Keycloak URL
    # (KC_HOSTNAME above), so the authz-bridge must validate against that —
    # not the localhost:7080 default copied from the dev env file.
    if [[ -n "$CAIPE_DOMAIN" && ! "$CAIPE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      oidc_issuer="https://${CAIPE_DOMAIN}/realms/caipe"
    fi
    if [[ -n "$oidc_issuer" ]]; then
      cat >> "$values_file" <<RBACEOF
    SSO_ENABLED: "true"

openfga-authz-bridge:
  tokenValidation:
    issuer: "${oidc_issuer}"
RBACEOF
    fi
  fi

  printf '%s' "$values_file"
}

# Install the CRDs that the AgentGateway proxy and Gateway API resources depend
# on (Gateway API + agentgateway.dev). Idempotent. This MUST run before the
# CAIPE Helm install when the RBAC runtime is enabled, because the chart renders
# Gateway / HTTPRoute / AgentgatewayBackend / AgentgatewayPolicy objects that
# Helm validates against installed CRDs at render time. Also reused by the
# legacy deploy_agentgateway path.
_install_agentgateway_crds() {
  log "Installing Gateway API CRDs..."
  kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.0/standard-install.yaml 2>&1 \
    | tail -1 || true
  log "Installing AgentGateway CRDs..."
  helm upgrade -i agentgateway-crds oci://ghcr.io/kgateway-dev/charts/agentgateway-crds \
    --create-namespace --namespace agentgateway-system \
    --version "$AGENTGATEWAY_VERSION" 2>&1 | tail -1 || true
}

deploy_agentgateway() {
  step "Deploying AgentGateway (${AGENTGATEWAY_VERSION})"

  # 1-2. Install Gateway API + AgentGateway CRDs
  _install_agentgateway_crds

  # 3. Install AgentGateway control plane
  log "Installing AgentGateway control plane..."
  if ! helm upgrade -i agentgateway oci://ghcr.io/kgateway-dev/charts/agentgateway \
    --namespace agentgateway-system \
    --version "$AGENTGATEWAY_VERSION" 2>&1; then
    err "AgentGateway Helm install failed"
    return 1
  fi

  # 4. Wait for control plane to be ready
  log "Waiting for AgentGateway control plane..."
  kubectl rollout status deployment/agentgateway -n agentgateway-system --timeout=120s 2>/dev/null || true

  # 5. Create the Gateway resource (data plane proxy)
  kubectl apply -f - <<GATEWAY_EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: agentgateway-proxy
  namespace: agentgateway-system
spec:
  gatewayClassName: agentgateway
  listeners:
  - protocol: HTTP
    port: 80
    name: http
    allowedRoutes:
      namespaces:
        from: All
GATEWAY_EOF
  log "AgentGateway proxy Gateway created"

  # 6. Wait for proxy deployment
  log "Waiting for AgentGateway proxy..."
  local retries=0
  while [[ $retries -lt 30 ]]; do
    if kubectl get deployment agentgateway-proxy -n agentgateway-system &>/dev/null; then
      kubectl rollout status deployment/agentgateway-proxy -n agentgateway-system --timeout=60s 2>/dev/null && break
    fi
    sleep 2
    retries=$((retries + 1))
  done

  # 7. Auto-discover CAIPE MCP services and create backends + routes
  _create_agentgateway_mcp_routes

  log "AgentGateway deployed successfully"
}

_create_agentgateway_mcp_routes() {
  log "Discovering MCP services in caipe namespace..."

  local mcp_svcs
  mcp_svcs=$(kubectl get svc -n caipe -o json 2>/dev/null \
    | jq -r '.items[] | select(.metadata.name | endswith("-mcp")) | .metadata.name' 2>/dev/null || true)

  if [[ -z "$mcp_svcs" ]]; then
    warn "No MCP services found in caipe namespace (services ending in -mcp)"
    warn "AgentGateway is deployed but has no MCP backends configured"
    warn "MCP backends will be auto-configured on next run after CAIPE deploys"
    return 0
  fi

  local count=0
  while IFS= read -r svc_name; do
    [[ -z "$svc_name" ]] && continue

    # Derive a short server name (e.g. "caipe-mcp-argocd-mcp" -> "argocd")
    local agent_name
    agent_name=$(echo "$svc_name" | sed 's/^caipe-//' | sed 's/^mcp-//' | sed 's/^agent-//' | sed 's/-mcp$//')

    local svc_port
    svc_port=$(kubectl get svc "$svc_name" -n caipe -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo "8000")

    kubectl apply -f - <<MCP_ROUTE_EOF
---
apiVersion: agentgateway.dev/v1alpha1
kind: AgentgatewayBackend
metadata:
  name: mcp-${agent_name}-backend
  namespace: caipe
  labels:
    app.kubernetes.io/managed-by: setup-caipe
    app.kubernetes.io/component: agentgateway-mcp
spec:
  mcp:
    targets:
    - name: ${agent_name}
      static:
        host: ${svc_name}.caipe.svc.cluster.local
        port: ${svc_port}
        protocol: SSE
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: mcp-${agent_name}
  namespace: caipe
  labels:
    app.kubernetes.io/managed-by: setup-caipe
    app.kubernetes.io/component: agentgateway-mcp
spec:
  parentRefs:
  - name: agentgateway-proxy
    namespace: agentgateway-system
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /mcp/${agent_name}
    backendRefs:
    - name: mcp-${agent_name}-backend
      group: agentgateway.dev
      kind: AgentgatewayBackend
MCP_ROUTE_EOF

    log "  MCP backend: ${agent_name} -> ${svc_name}:${svc_port} at /mcp/${agent_name}"
    count=$((count + 1))
  done <<< "$mcp_svcs"

  log "Created ${count} AgentGateway MCP backend(s)"
}

deploy_caipe() {
  step "Deploying CAIPE (v${CAIPE_CHART_VERSION})"

  # Warn early if the selected chart cannot persist Keycloak to the shared
  # Postgres (chart predates the database.* contract) so the operator is not
  # surprised by H2-backed Keycloak losing realm state on restart.
  _warn_if_chart_lacks_keycloak_db

  local helm_args=(
    --namespace caipe
    --version "$CAIPE_CHART_VERSION"
    # Keycloak's post-install hook (init-token-exchange) can't run until Keycloak
    # finishes its cold boot. helm's default 5m timeout leaves almost no margin
    # and aborts the release mid-boot, so give the hook real headroom.
    --timeout 10m
    --set tags.caipe-ui=true
    --set tags.mcp-netutils=true
    # The UI reaches the dynamic-agents runtime server-side via DYNAMIC_AGENTS_URL.
    # The caipe-ui chart already defaults that to http://<release>-dynamic-agents:8001
    # (the internal k8s service), so no override is needed here. The browser never
    # talks to dynamic-agents directly — chat streaming is proxied through the
    # Next.js BFF — so there is no public base URL to set.
  )

  # SSO: enable when a public domain is configured (NEXTAUTH_URL is already
  # patched in provision_ui_secret; here we flip the server-side flag too)
  if [[ -n "$CAIPE_DOMAIN" ]]; then
    helm_args+=(--set "caipe-ui.config.SSO_ENABLED=true")
  else
    helm_args+=(--set "caipe-ui.config.SSO_ENABLED=false")
  fi

  # Default (no --ui-env-file) in-chart Keycloak SSO. The dev/Cisco env file
  # normally supplies OIDC_ISSUER/NEXTAUTH_URL, so without it the chart defaults
  # leave OIDC_ISSUER empty (sign-in is impossible) and NEXTAUTH_URL pointing at
  # localhost. Synthesize them from the DNS domain so a vanilla install does
  # Keycloak SSO with zero external config. OIDC_DISCOVERY_URL/KEYCLOAK_URL
  # already default to the in-cluster service in the chart. The matching
  # NEXTAUTH_SECRET + caipe-ui client secret are created in
  # create_namespace_and_secrets (caipe-ui-secret). Skipped for IP domains (no
  # browser-reachable issuer) and when a ui-env-file already provides OIDC.
  if $ENABLE_RBAC_RUNTIME && [[ -z "$UI_ENV_FILE" \
      && -n "$CAIPE_DOMAIN" && ! "$CAIPE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    helm_args+=(
      --set "caipe-ui.config.NEXTAUTH_URL=https://${CAIPE_DOMAIN}"
      --set "caipe-ui.config.OIDC_ISSUER=https://${CAIPE_DOMAIN}/realms/caipe"
      --set "openfga-authz-bridge.tokenValidation.issuer=https://${CAIPE_DOMAIN}/realms/caipe"
    )
    if _local_admin_active; then
      helm_args+=(--set "caipe-ui.config.BOOTSTRAP_ADMIN_EMAILS=${LOCAL_ADMIN_EMAIL}")
    fi
  fi

  # Wire the config-bridge bearer token secret so the sidecar can authenticate
  # to the BFF's internal MCP-targets endpoint. caipe-ui-secret holds the same
  # key (patched in create_namespace_and_secrets), so both sides share the token.
  if $ENABLE_AGENTGATEWAY; then
    helm_args+=(
      --set "global.agentgateway.static.configBridge.ui.existingSecret.name=caipe-ui-secret"
      --set "openfga-authz-bridge.agentContext.existingSecret.name=caipe-ui-secret"
      --set "dynamic-agents.agentContext.existingSecret.name=caipe-ui-secret"
    )
  fi

  # Append per-agent enable/secret flags collected interactively
  if [[ ${#HELM_AGENT_ARGS[@]} -gt 0 ]]; then
    helm_args+=("${HELM_AGENT_ARGS[@]}")
    log "Wiring ${#HELM_AGENT_ARGS[@]} agent Helm flags from interactive selection"
  fi

  # Dynamic Agents runtime (chat and custom agent builder).
  # Service name: <release>-dynamic-agents (chart nameOverride="dynamic-agents")
  local release_name="caipe"
  local da_svc="${release_name}-dynamic-agents"
  local ns="caipe"

    helm_args+=(
      --set "tags.dynamic-agents=true"
      --set "caipe-ui.config.DYNAMIC_AGENTS_URL=http://${da_svc}:8001"
      # Inject the shared LLM secret (ANTHROPIC_API_KEY / AWS_* / AZURE_*) so
      # dynamic-agents can call the LLM backend.
      --set "dynamic-agents.llmSecret=llm-secret"
    )

    # Auth + OIDC: enable when a public domain + OIDC issuer are configured.
    # Without AUTH_ENABLED the API is open to anyone who can reach the service.
    local da_oidc_issuer="" da_oidc_client_id="" da_oidc_admin_group=""
    if [[ -n "$UI_ENV_FILE" ]]; then
      da_oidc_issuer=$(_env_get "$UI_ENV_FILE" "OIDC_ISSUER")
      da_oidc_client_id=$(_env_get "$UI_ENV_FILE" "OIDC_CLIENT_ID")
      da_oidc_admin_group=$(_env_get "$UI_ENV_FILE" "OIDC_REQUIRED_ADMIN_GROUP")
    fi
    # Fallback: derive issuer from CAIPE_DOMAIN when the env file doesn't have it.
    # Keycloak sets KC_HOSTNAME=https://${CAIPE_DOMAIN} so tokens carry that as iss.
    # dynamic-agents must use the same issuer string; without it tokens fail validation
    # with "Invalid issuer" (internal http://keycloak:8080 vs external https://domain).
    if [[ -z "$da_oidc_issuer" && -n "${CAIPE_DOMAIN:-}" ]]; then
      da_oidc_issuer="https://${CAIPE_DOMAIN}/realms/caipe"
    fi
    if [[ -z "$da_oidc_client_id" ]]; then
      da_oidc_client_id="caipe-platform"
    fi
    # Seed configuration: models + MCP servers pointing to cluster-local services.
    # Also carries auth/OIDC config — using a values file avoids --set comma
    # parsing issues with CORS_ORIGINS (Helm splits on unescaped commas).
    local _da_values_file
    _da_values_file=$(mktemp /tmp/caipe-da-seed-XXXXXX)

    # Build models list from llm-secret LLM_PROVIDER
    local _provider="${LLM_PROVIDER:-anthropic-claude}"

    # Write auth/OIDC config into the values file.
    # MONGODB_ROOT_PASSWORD comes from _resolve_mongodb_password() which
    # is called by _ensure_dynamic_agents_mongodb() — guaranteed to run
    # before deploy_caipe() per the orchestration at line ~6060.
    # Fall back to a clearly-broken placeholder if the variable isn't
    # set (defensive: should only happen if someone re-orders the call
    # graph and skips the MongoDB step), so the failure surfaces loudly
    # at pod start rather than silently using "changeme".
    local _mongo_pw="${MONGODB_ROOT_PASSWORD:-MONGODB_ROOT_PASSWORD_UNSET}"
    cat > "$_da_values_file" <<DAEOF
dynamic-agents:
  config:
    # MongoDB URI baked in at deploy time so the pod can start before post_deploy_patches.
    MONGODB_URI: "mongodb://admin:${_mongo_pw}@caipe-mongodb:27017/caipe?authSource=caipe"
DAEOF
    if [[ -n "$CAIPE_DOMAIN" && -n "$da_oidc_issuer" ]]; then
      cat >> "$_da_values_file" <<DAEOF
    AUTH_ENABLED: "true"
    OIDC_ISSUER: "${da_oidc_issuer}"
    OIDC_CLIENT_ID: "${da_oidc_client_id}"
    CORS_ORIGINS: '["https://${CAIPE_DOMAIN}", "http://localhost:3000"]'
DAEOF
      # Pass OIDC_REQUIRED_ADMIN_GROUP to dynamic-agents so it matches the UI's
      # admin group. When unset, it falls back to generic pattern matching
      # (groups containing "admin", "platform-admin", "administrators") which
      # misses site-specific group names like "caipe-internal-devnet-users".
      if [[ -n "$da_oidc_admin_group" ]]; then
        cat >> "$_da_values_file" <<DAEOF
    OIDC_REQUIRED_ADMIN_GROUP: "${da_oidc_admin_group}"
DAEOF
      fi
    fi

    # Build provider-appropriate model list.
    # caipe-ui.appConfig.models → caipe-caipe-ui-app-config ConfigMap →
    # APP_CONFIG_PATH env → applySeedConfig() at ui startup → llm_models MongoDB.
    # Bedrock requires cross-region inference profile IDs (global.anthropic.* or us.anthropic.*).
    # Anthropic-claude and Azure use short model names.
    cat >> "$_da_values_file" <<DAEOF
caipe-ui:
  appConfig:
    models:
DAEOF
    if [[ "$_provider" == "aws-bedrock" ]]; then
      # Use the actual Bedrock model ID configured in llm-secret.
      # Derive a haiku fallback by replacing common sonnet IDs with haiku equivalent.
      local _bedrock_primary="${AWS_BEDROCK_MODEL_ID:-global.anthropic.claude-haiku-4-5-20251001-v1:0}"
      # Best-effort haiku sibling: replace sonnet/opus model IDs with haiku
      local _bedrock_haiku
      _bedrock_haiku=$(echo "$_bedrock_primary" | sed \
        -e 's/claude-3-7-sonnet[^:"]*/claude-haiku-4-5-20251001-v1:0/g' \
        -e 's/claude-sonnet-4-20250514[^:"]*/claude-haiku-4-5-20251001-v1:0/g' \
        -e 's/claude-sonnet-4-5-20250929[^:"]*/claude-haiku-4-5-20251001-v1:0/g')
      cat >> "$_da_values_file" <<DAEOF
      - model_id: "${_bedrock_haiku}"
        name: "Claude Haiku 4.5 (Bedrock)"
        provider: "aws-bedrock"
        description: "Fast Claude Haiku via AWS Bedrock"
      - model_id: "${_bedrock_primary}"
        name: "Claude (Bedrock)"
        provider: "aws-bedrock"
        description: "Primary model via AWS Bedrock"
DAEOF
    elif [[ "$_provider" == "azure-openai" ]]; then
      cat >> "$_da_values_file" <<DAEOF
      - model_id: "gpt-4o-mini"
        name: "GPT-4o Mini (Azure)"
        provider: "azure-openai"
        description: "Fast GPT-4o Mini via Azure OpenAI"
      - model_id: "gpt-4o"
        name: "GPT-4o (Azure)"
        provider: "azure-openai"
        description: "GPT-4o via Azure OpenAI"
DAEOF
    elif $ENABLE_OLLAMA; then
      # Ollama uses the OpenAI-compatible API; seed the actual Ollama model name
      # (OPENAI_MODEL_NAME = OLLAMA_MODEL, e.g. lfm2.5) so dynamic agents can find it.
      local _ollama_display="${OPENAI_MODEL_NAME:-qwen3:0.6b}"
      cat >> "$_da_values_file" <<DAEOF
      - model_id: "${_ollama_display}"
        name: "${_ollama_display} (Ollama)"
        provider: "openai"
        description: "Local model served via in-cluster Ollama"
DAEOF
    elif [[ "$_provider" == "openai" ]]; then
      local _oai_model="${OPENAI_MODEL_NAME:-gpt-4o-mini}"
      cat >> "$_da_values_file" <<DAEOF
      - model_id: "gpt-4o-mini"
        name: "GPT-4o Mini"
        provider: "openai"
        description: "Fast GPT-4o Mini via OpenAI"
      - model_id: "${_oai_model}"
        name: "${_oai_model}"
        provider: "openai"
        description: "Primary model via OpenAI"
DAEOF
    else
      # anthropic-claude (default)
      local _anthropic_model="${ANTHROPIC_MODEL_NAME:-claude-haiku-4-5}"
      cat >> "$_da_values_file" <<DAEOF
      - model_id: "${_anthropic_model}"
        name: "Claude Haiku 4.5 (Anthropic)"
        provider: "${_provider}"
        description: "Fast Claude Haiku via Anthropic API"
      - model_id: "claude-sonnet-4-5"
        name: "Claude Sonnet 4.5 (Anthropic)"
        provider: "${_provider}"
        description: "Balanced Claude Sonnet 4.5 via Anthropic API"
DAEOF
    fi
    cat >> "$_da_values_file" <<DAEOF
    mcp_servers:
DAEOF

    # Add an appConfig entry for each deployed MCP agent.
    # The script deploys agents from _AGENT_TAGS when enabled; always add netutils.
    declare -A _MCP_META=(
      [argocd]="ArgoCD|ArgoCD application and deployment management"
      [backstage]="Backstage|Backstage catalog and developer portal"
      [confluence]="Confluence|Confluence wiki and documentation"
      [jira]="Jira|Jira issue tracking and project management"
      [netutils]="Network Utilities|Network diagnostic tools (ping, traceroute, DNS)"
      [pagerduty]="PagerDuty|PagerDuty incident management"
      [slack]="Slack|Slack messaging and collaboration"
      [splunk]="Splunk|Splunk log analysis and monitoring"
      [webex]="Webex|Webex messaging and meetings"
      [aws]="AWS|AWS cloud infrastructure management"
      [komodor]="Komodor|Komodor Kubernetes troubleshooting"
      [github]="GitHub|GitHub repository and workflow management"
    )
    # Always-on agents
    local _always_on=(netutils)
    local _seeded=()
    for _a in "${_always_on[@]}"; do
      [[ -n "${_MCP_META[$_a]+_}" ]] || continue
      local _meta="${_MCP_META[$_a]}"
      local _name="${_meta%%|*}"
      local _desc="${_meta##*|}"
      cat >> "$_da_values_file" <<DAEOF
      - id: "${_a}"
        name: "${_name}"
        description: "${_desc}"
        transport: "http"
        endpoint: "http://caipe-mcp-${_a}-mcp.${ns}.svc.cluster.local:8000/mcp"
        enabled: true
DAEOF
      _seeded+=("$_a")
    done
    # Enabled agents from _AGENT_TAGS
    for _a in "${_AGENT_TAGS[@]}"; do
      [[ -n "${_MCP_META[$_a]+_}" ]] || continue
      local _enable_key
      _enable_key=$(_agent_enable_key "$_a")
      local _ev=""
      [[ -n "$ENV_FILE" ]] && _ev=$(_env_get "$ENV_FILE" "$_enable_key")
      _env_true "$_ev" || continue
      # skip if already seeded (e.g. netutils)
      for _s in "${_seeded[@]}"; do [[ "$_s" == "$_a" ]] && continue 2; done
      local _meta="${_MCP_META[$_a]}"
      local _name="${_meta%%|*}"
      local _desc="${_meta##*|}"
      cat >> "$_da_values_file" <<DAEOF
      - id: "${_a}"
        name: "${_name}"
        description: "${_desc}"
        transport: "http"
        endpoint: "http://caipe-mcp-${_a}-mcp.${ns}.svc.cluster.local:8000/mcp"
        enabled: true
DAEOF
    done

    # Add knowledge-base MCP server when RAG is enabled
    if $ENABLE_RAG; then
      cat >> "$_da_values_file" <<DAEOF
      - id: "knowledge-base"
        name: "Knowledge Base"
        description: "Knowledge Base RAG tools for document search and retrieval"
        transport: "http"
        endpoint: "http://rag-server.${CAIPE_NAMESPACE:-caipe}.svc.cluster.local:${RAG_SERVER_PORT}/mcp"
        enabled: true
DAEOF
    fi

  helm_args+=(--values "$_da_values_file")
  log "caipe-ui appConfig + dynamic-agents auth: models + MCP servers written to ${_da_values_file}"

  # When a domain is set, push non-sensitive config values from the ui-env-file
  # into the chart ConfigMap (caipe-ui.config.*). The ConfigMap takes precedence
  # over envFrom-secret for same-named keys, so values like NEXTAUTH_URL,
  # OIDC groups, branding, and feature flags must be set here, not just in the secret.
  if [[ -n "$CAIPE_DOMAIN" && -n "$UI_ENV_FILE" ]]; then
    helm_args+=(--set "caipe-ui.config.NEXTAUTH_URL=https://${CAIPE_DOMAIN}")
    local _config_keys=(
      OIDC_REQUIRED_GROUP OIDC_REQUIRED_ADMIN_GROUP OIDC_ENABLE_REFRESH_TOKEN
      WORKFLOW_RUNNER_ENABLED AUDIT_LOGS_ENABLED FEEDBACK_ENABLED NPS_ENABLED
      JIRA_TICKET_ENABLED JIRA_TICKET_PROJECT
    )
    for key in "${_config_keys[@]}"; do
      local val
      val=$(_env_get "$UI_ENV_FILE" "$key")
      if [[ -n "$val" ]]; then helm_args+=(--set "caipe-ui.config.${key}=${val}"); fi
    done
  fi

  if $ENABLE_RAG; then
    helm_args+=(
      --set tags.rag-stack=true
      --set 'rag-stack.rag-webui.enabled=false'
      --set caipe-ui.env.RAG_URL=/api/rag
      --set caipe-ui.env.RAG_SERVER_URL=http://rag-server:${RAG_SERVER_PORT}
      --set caipe-ui.env.RAG_ENABLED=true
      --set caipe-ui.config.RAG_ENABLED=true
      --set "caipe-ui.config.RAG_SERVER_URL=http://rag-server:${RAG_SERVER_PORT}"
      --set "rag-stack.rag-server.env.EMBEDDINGS_MODEL=${EMBEDDINGS_MODEL}"
      --set "rag-stack.rag-server.env.EMBEDDINGS_PROVIDER=${EMBEDDINGS_PROVIDER}"
      ${EMBEDDINGS_DIMENSIONS:+--set "rag-stack.rag-server.env.EMBEDDINGS_DIMENSIONS=${EMBEDDINGS_DIMENSIONS}"}
      --set 'rag-stack.milvus.cluster.enabled=false'
      --set 'rag-stack.milvus.standalone.disk.enabled=true'
      --set 'rag-stack.milvus.etcd.replicaCount=1'
      --set 'rag-stack.milvus.minio.mode=standalone'
      --set 'rag-stack.milvus.minio.replicas=1'
      --set 'rag-stack.milvus.minio.persistence.size=10Gi'
      --set 'rag-stack.milvus.minio.resources.requests.memory=256Mi'
      --set 'rag-stack.rag-server.env.SKIP_INIT_TESTS=true'
    )
    # Wire UI OIDC provider into rag-server so user tokens are validated.
    if [[ -n "${CAIPE_DOMAIN:-}" ]]; then
      helm_args+=(
        --set "rag-stack.rag-server.env.OIDC_ISSUER=https://${CAIPE_DOMAIN}/realms/caipe"
        --set 'rag-stack.rag-server.env.OIDC_CLIENT_ID=caipe-ui'
        --set 'rag-stack.rag-server.env.OIDC_GROUP_CLAIM=members\,groups'
      )
    fi
    # Pre-load ingestor secret state from an existing cluster secret so that
    # re-runs (upgrade path) also get webIngestor.enabled=true without having
    # to wait for post_deploy_patches to re-provision Keycloak credentials.
    if [[ "${RAG_INGESTOR_SECRET_READY:-false}" != "true" ]] \
        && kubectl get secret rag-ingestor-secret -n caipe &>/dev/null 2>&1; then
      RAG_INGESTOR_OIDC_ISSUER=$(kubectl get secret rag-ingestor-secret -n caipe \
        -o jsonpath='{.data.INGESTOR_OIDC_ISSUER}' 2>/dev/null | base64 -d || true)
      RAG_INGESTOR_OIDC_CLIENT_ID=$(kubectl get secret rag-ingestor-secret -n caipe \
        -o jsonpath='{.data.INGESTOR_OIDC_CLIENT_ID}' 2>/dev/null | base64 -d || true)
      [[ -n "$RAG_INGESTOR_OIDC_ISSUER" ]] && RAG_INGESTOR_SECRET_READY=true \
        && log "RAG web-ingestor: loaded existing rag-ingestor-secret from cluster"
    fi
    # Wire Keycloak client credentials into both rag-server (token validation)
    # and web-ingestor (token acquisition) when the secret was provisioned.
    if [[ "${RAG_INGESTOR_SECRET_READY:-false}" == "true" ]]; then
      helm_args+=(
        --set 'rag-stack.rag-server.webIngestor.enabled=true'
        --set 'rag-stack.rag-server.webIngestor.envFrom[0].secretRef.name=rag-ingestor-secret'
        # Pass non-secret OIDC config directly as env so the rag-server auth manager
        # can validate ingestor tokens even before the envFrom template fix ships.
        --set "rag-stack.rag-server.env.INGESTOR_OIDC_ISSUER=${RAG_INGESTOR_OIDC_ISSUER}"
        --set "rag-stack.rag-server.env.INGESTOR_OIDC_CLIENT_ID=${RAG_INGESTOR_OIDC_CLIENT_ID}"
      )
      log "RAG web-ingestor: Keycloak OIDC credentials wired via rag-ingestor-secret"
    else
      helm_args+=(--set 'rag-stack.rag-server.webIngestor.enabled=false')
      log "RAG web-ingestor: disabled (no Keycloak credentials available)"
    fi

    if [[ "$EMBEDDINGS_PROVIDER" == "litellm" && -n "${LITELLM_ENDPOINT:-}" ]]; then
      helm_args+=(
        --set "rag-stack.rag-server.env.LITELLM_API_BASE=${LITELLM_ENDPOINT}"
        --set "rag-stack.rag-server.env.LITELLM_API_KEY=${LITELLM_API_KEY:-not-needed}"
      )
      log "LiteLLM embeddings configured (endpoint: ${LITELLM_ENDPOINT})"
    fi

    if [[ "$EMBEDDINGS_PROVIDER" == "azure-openai" ]]; then
      # Azure OpenAI embeddings: keys are merged into llm-secret by provision_secrets()
      # (the rag-stack subchart hardcodes envFrom=[llm-secret] and ignores user-supplied
      # envFrom values, so merging into llm-secret is the only upgrade-safe approach).
      if [[ -z "${AZURE_OPENAI_API_KEY:-}" || -z "${AZURE_OPENAI_ENDPOINT:-}" ]]; then
        err "azure-openai embeddings require AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT"
        exit 1
      fi
      log "Azure OpenAI embeddings configured (endpoint: ${AZURE_OPENAI_ENDPOINT})"
    fi

    if $ENABLE_GRAPH_RAG; then
      helm_args+=(
        --set 'global.rag.enableGraphRag=true'
        --set 'rag-stack.rag-server.enableGraphRag=true'
        --set 'rag-stack.neo4j.neo4j.resources.requests.memory=2Gi'
        --set 'rag-stack.neo4j.neo4j.resources.requests.cpu=500m'
        --set 'rag-stack.neo4j.volumes.data.mode=defaultStorageClass'
        --set 'rag-stack.neo4j.volumes.data.defaultStorageClass.requests.storage=10Gi'
      )
      log "RAG stack enabled with Graph RAG (embeddings: ${EMBEDDINGS_PROVIDER}/${EMBEDDINGS_MODEL})"
    else
      helm_args+=(
        --set 'global.rag.enableGraphRag=false'
        --set 'rag-stack.rag-server.enableGraphRag=false'
        --set 'rag-stack.agent-ontology.enabled=false'
        --set 'rag-stack.neo4j.enabled=false'
      )
      log "RAG stack enabled, vector-only (embeddings: ${EMBEDDINGS_PROVIDER}/${EMBEDDINGS_MODEL})"
    fi
  fi

  if $ENABLE_TRACING; then
    # dynamic-agents uses cnoe-agent-utils TracingManager, which reads
    # ENABLE_TRACING + the LANGFUSE_* creds from its config. Langfuse public/
    # secret keys are wired separately (langfuse secret); here we flip the
    # flag and point at the in-cluster Langfuse host.
    helm_args+=(
      --set dynamic-agents.config.ENABLE_TRACING=true
      --set dynamic-agents.config.LANGFUSE_HOST=http://langfuse-web.langfuse.svc.cluster.local:3000
    )
    log "Tracing configuration added"
  fi

  if $ENABLE_RBAC_RUNTIME; then
    # Must run BEFORE _write_rbac_runtime_values (it bakes the password into the
    # values file) and OUTSIDE the command substitution below, because it logs
    # to stdout which would otherwise be captured into the values file path.
    _resolve_keycloak_admin_password
    local _rbac_values_file
    _rbac_values_file=$(_write_rbac_runtime_values)
    helm_args+=(--values "$_rbac_values_file")
    log "RBAC runtime configured (Keycloak, OpenFGA, OpenFGA bridge, AgentGateway)"
  fi

  # Chat-bot surfaces (slack-bot / webex-bot) — wired onto the in-cluster
  # Keycloak/OpenFGA/MongoDB/UI. MONGODB_ROOT_PASSWORD is resolved by
  # _ensure_dynamic_agents_mongodb, which main() runs before deploy_caipe.
  if $ENABLE_SLACK_BOT || $ENABLE_WEBEX_BOT; then
    local _bot_values_file
    _bot_values_file=$(_write_bot_values)
    if [[ -n "$_bot_values_file" ]]; then
      helm_args+=(--values "$_bot_values_file")
      $ENABLE_SLACK_BOT && log "slack-bot surface enabled"
      $ENABLE_WEBEX_BOT && log "webex-bot surface enabled"
    fi
  fi

  if $ENABLE_INGRESS && [[ -n "$CAIPE_DOMAIN" ]]; then
    # Kubernetes Ingress spec.rules[].host must be a DNS name, not an IP address.
    # When CAIPE_DOMAIN is an IP, omit the host field (nginx will match all requests).
    local _ingress_host="${CAIPE_DOMAIN}"
    if [[ "$CAIPE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      _ingress_host=""
    fi
    helm_args+=(
      --set 'caipe-ui.ingress.enabled=true'
      --set "caipe-ui.ingress.className=nginx"
      --set "caipe-ui.ingress.hosts[0].paths[0].path=/"
      --set "caipe-ui.ingress.hosts[0].paths[0].pathType=Prefix"
      --set "caipe-ui.ingress.tls[0].secretName=caipe-tls"
    )
    if [[ -n "$_ingress_host" ]]; then
      helm_args+=(
        --set "caipe-ui.ingress.hosts[0].host=${_ingress_host}"
        --set "caipe-ui.ingress.tls[0].hosts[0]=${_ingress_host}"
      )
    fi
    helm_args+=(
      # OIDC callback sets a large Set-Cookie header (JWTs + many group claims).
      # Increase nginx proxy buffers to prevent 502 "upstream sent too big header".
      --set "caipe-ui.ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-buffer-size=128k"
      --set-string "caipe-ui.ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-buffers-number=4"
      --set "caipe-ui.ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-busy-buffers-size=256k"
      # Long timeout for SSE streaming (dynamic agents chat).
      # Default nginx 60s kills connections mid-stream when LLM is still generating.
      --set-string "caipe-ui.ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-read-timeout=3600"
      --set-string "caipe-ui.ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-send-timeout=3600"
    )
    log "Ingress configured for https://${CAIPE_DOMAIN}"
  fi

  # Agent and UI secrets provisioned from --env-file / --ui-env-file
  if [[ ${#HELM_AGENT_ARGS[@]} -gt 0 ]]; then
    helm_args+=("${HELM_AGENT_ARGS[@]}")
    log "Agent helm args added (${#HELM_AGENT_ARGS[@]} flags)"
  fi
  if [[ ${#HELM_UI_SECRET_ARGS[@]} -gt 0 ]]; then
    helm_args+=("${HELM_UI_SECRET_ARGS[@]}")
    log "UI secret helm args added"
  fi

  # Delete any stale helm hook Jobs from a previous failed install/upgrade.
  # If left behind they block pre-upgrade hooks on the next run (helm waits
  # for them and hits the deadline). Safe to delete: helm recreates them.
  kubectl delete jobs -n "${CAIPE_NAMESPACE:-caipe}" \
    -l 'helm.sh/hook' --ignore-not-found 2>/dev/null || true

  if ! helm upgrade --install caipe "$CAIPE_OCI_REPO" "${helm_args[@]}" 2>&1; then
    err "Helm install failed (see output above)"
    exit 1
  fi
  log "CAIPE Helm release deployed"

  # Helm only restarts pods when the Deployment spec changes, not on ConfigMap-only
  # updates. When OIDC_ISSUER / AUTH_ENABLED are freshly set (domain run), the
  # dynamic-agents pod must be cycled so it picks up the new issuer from the ConfigMap.
  # Without this it keeps using the internal http://keycloak:8080 issuer URL and rejects
  # every token with "Invalid issuer", blocking all chat in the Custom Agents UI.
  if [[ -n "${CAIPE_DOMAIN:-}" ]]; then
    if kubectl rollout restart deploy/caipe-dynamic-agents -n caipe &>/dev/null 2>&1; then
      kubectl rollout status deploy/caipe-dynamic-agents -n caipe --timeout=120s &>/dev/null 2>&1 || true
      log "dynamic-agents: restarted to apply OIDC issuer config"
    fi
  fi

  # Non-fatal: a timeout here (e.g. credential-less agents that never become
  # ready) must NOT abort the script under `set -e` — post_deploy_patches still
  # needs to run the RBAC reconcile + local-admin provisioning on the healthy
  # core. wait_for_pods already returns early once the cluster has settled.
  if $ENABLE_RAG; then
    wait_for_pods caipe 600 "rag-server" || warn "Proceeding despite not-ready pods (see above)"
  else
    wait_for_pods caipe 600 || warn "Proceeding despite not-ready pods (see above)"
  fi
}

# ─── Validation ──────────────────────────────────────────────────────────────
print_result() {
  local line="$1"
  if echo "$line" | grep -q '✓'; then
    echo -e "  ${GREEN}${line}${NC}"
  elif echo "$line" | grep -q '✗'; then
    echo -e "  ${RED}${line}${NC}"
  elif echo "$line" | grep -q '⚠'; then
    echo -e "  ${YELLOW}${line}${NC}"
  else
    echo -e "  ${DIM}${line}${NC}"
  fi
}

check_http() {
  local url="$1" label="$2"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 5 2>/dev/null || echo "000")
  if [[ "$code" =~ ^(200|301|302|405)$ ]]; then
    print_result "$(date '+%H:%M:%S') ✓ ${label} reachable (HTTP ${code})"
    return 0
  else
    print_result "$(date '+%H:%M:%S') ✗ ${label} unreachable (HTTP ${code})"
    return 1
  fi
}

run_validation() {
  echo ""
  header "Validation Results"

  local pass=0 fail=0 warn_count=0

  # ── Kubernetes health ──
  # Exclude Completed/Succeeded job pods — they are not failures.
  local total ready
  total=$(kubectl get pods -n caipe --no-headers 2>/dev/null \
    | awk '$3!="Completed" && $3!="Succeeded"' | wc -l | tr -d ' ')
  ready=$(kubectl get pods -n caipe --no-headers 2>/dev/null \
    | awk '$3=="Running" && $2~"^[0-9]+/[0-9]+$" {split($2,a,"/"); if(a[1]==a[2]) print}' \
    | wc -l | tr -d ' ')
  if [[ "$total" -gt 0 && "$total" -eq "$ready" ]]; then
    print_result "$(date '+%H:%M:%S') ✓ All ${total} pods in caipe namespace are running"
    pass=$((pass + 1))
  else
    print_result "$(date '+%H:%M:%S') ✗ Pods: ${ready}/${total} ready in caipe namespace"
    fail=$((fail + 1))
    kubectl get pods -n caipe --no-headers 2>/dev/null \
      | awk '$3!="Completed" && $3!="Succeeded" && ($3!="Running" || ($2~"^[0-9]+/[0-9]+$" && split($2,a,"/") && a[1]!=a[2]))' \
      | while IFS= read -r pod_line; do
          print_result "$(date '+%H:%M:%S')   ⚠ ${pod_line}"
        done
  fi

  # ── Dynamic agents runtime health ──
  local da_health
  da_health=$(curl -sf "http://localhost:${DYNAMIC_AGENTS_PORT}/healthz" --max-time 5 2>/dev/null || echo "")
  if [[ -n "$da_health" ]] && echo "$da_health" | jq -e '.status == "healthy"' &>/dev/null; then
    print_result "$(date '+%H:%M:%S') ✓ Dynamic agents runtime healthy"
    pass=$((pass + 1))
  else
    print_result "$(date '+%H:%M:%S') ✗ Dynamic agents runtime not healthy"
    fail=$((fail + 1))
  fi

  # ── MCP agent servers ──
  for agent in netutils; do
    if kubectl get deployment "caipe-mcp-${agent}-mcp" -n caipe &>/dev/null 2>&1; then
      print_result "$(date '+%H:%M:%S') ✓ ${agent} MCP server deployed"
      pass=$((pass + 1))
    else
      print_result "$(date '+%H:%M:%S') ⚠ ${agent} MCP server not found"
      warn_count=$((warn_count + 1))
    fi
  done

  # ── HTTP endpoints ──
  # When ingress is enabled the UI has no local port-forward; check via ingress.
  local _ui_url
  if $ENABLE_INGRESS && [[ -n "${CAIPE_DOMAIN:-}" ]]; then
    _ui_url="https://${CAIPE_DOMAIN}"
  else
    _ui_url="http://localhost:${UI_PORT}"
  fi
  if $ENABLE_INGRESS && [[ -n "${CAIPE_DOMAIN:-}" ]]; then
    local _ui_code
    _ui_code=$(curl -sk -o /dev/null -w "%{http_code}" "${_ui_url}/" --max-time 10 2>/dev/null || echo "000")
    if [[ "$_ui_code" =~ ^(200|301|302|405)$ ]]; then
      print_result "$(date '+%H:%M:%S') ✓ CAIPE UI reachable via ingress (HTTP ${_ui_code})"
      pass=$((pass + 1))
    else
      print_result "$(date '+%H:%M:%S') ✗ CAIPE UI unreachable via ingress (HTTP ${_ui_code})"
      fail=$((fail + 1))
    fi
  else
    if check_http "${_ui_url}" "CAIPE UI"; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
    fi
  fi
  if check_http "http://localhost:${DYNAMIC_AGENTS_PORT}/health" "Dynamic agents runtime"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
  fi

  # ── Tracing ──
  if $ENABLE_TRACING; then
    if check_http "http://localhost:${LANGFUSE_PORT}" "Langfuse UI"; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
    fi

    local da_tracing
    da_tracing=$(kubectl get deployment caipe-dynamic-agents -n caipe \
      -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="ENABLE_TRACING")].value}' 2>/dev/null || true)
    if [[ "$da_tracing" == "true" ]]; then
      print_result "$(date '+%H:%M:%S') ✓ Dynamic agents tracing enabled"
      pass=$((pass + 1))
    else
      print_result "$(date '+%H:%M:%S') ✗ Dynamic agents tracing not enabled"
      fail=$((fail + 1))
    fi
  fi

  # ── RAG ──
  if $ENABLE_RAG; then
    local rag_ready
    rag_ready=$(kubectl get pods -n caipe -l app.kubernetes.io/name=rag-server \
      --no-headers 2>/dev/null \
      | awk '$3=="Running" {split($2,a,"/"); if(a[1]==a[2]) print "ready"}' | head -1)
    if [[ "$rag_ready" == "ready" ]]; then
      print_result "$(date '+%H:%M:%S') ✓ RAG server pod is running and ready"
      pass=$((pass + 1))
    else
      print_result "$(date '+%H:%M:%S') ✗ RAG server pod is not ready"
      fail=$((fail + 1))
    fi
  fi

  # ── vLLM + LiteLLM ──
  if $ENABLE_VLLM; then
    local vllm_ready
    vllm_ready=$(kubectl get pods -n caipe -l app=vllm \
      --no-headers 2>/dev/null \
      | awk '$3=="Running" {split($2,a,"/"); if(a[1]==a[2]) print "ready"}' | head -1)
    if [[ "$vllm_ready" == "ready" ]]; then
      print_result "$(date '+%H:%M:%S') ✓ vLLM pod is running and ready"
      pass=$((pass + 1))
    else
      print_result "$(date '+%H:%M:%S') ✗ vLLM pod is not ready"
      fail=$((fail + 1))
    fi

    local litellm_ready
    litellm_ready=$(kubectl get pods -n caipe -l app=litellm-proxy \
      --no-headers 2>/dev/null \
      | awk '$3=="Running" {split($2,a,"/"); if(a[1]==a[2]) print "ready"}' | head -1)
    if [[ "$litellm_ready" == "ready" ]]; then
      print_result "$(date '+%H:%M:%S') ✓ LiteLLM proxy pod is running and ready"
      pass=$((pass + 1))
    else
      print_result "$(date '+%H:%M:%S') ✗ LiteLLM proxy pod is not ready"
      fail=$((fail + 1))
    fi
  fi

  # ── AgentGateway ──
  if $ENABLE_AGENTGATEWAY; then
    if $ENABLE_RBAC_RUNTIME; then
      local ag_proxy_ready
      ag_proxy_ready=$(kubectl get deployment caipe-agentgateway -n caipe \
        -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
      if [[ "${ag_proxy_ready:-0}" -ge 1 ]]; then
        print_result "$(date '+%H:%M:%S') ✓ AgentGateway proxy is running"
        pass=$((pass + 1))
      else
        print_result "$(date '+%H:%M:%S') ✗ AgentGateway proxy is not ready"
        fail=$((fail + 1))
      fi
    else
      local ag_ready
      ag_ready=$(kubectl get pods -n agentgateway-system -l app.kubernetes.io/name=agentgateway \
        --no-headers 2>/dev/null \
        | awk '$3=="Running" {split($2,a,"/"); if(a[1]==a[2]) print "ready"}' | head -1)
      if [[ "$ag_ready" == "ready" ]]; then
        print_result "$(date '+%H:%M:%S') ✓ AgentGateway control plane is running"
        pass=$((pass + 1))
      else
        print_result "$(date '+%H:%M:%S') ✗ AgentGateway control plane is not ready"
        fail=$((fail + 1))
      fi

      local ag_proxy_ready
      ag_proxy_ready=$(kubectl get deployment agentgateway-proxy -n agentgateway-system \
        -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
      if [[ "${ag_proxy_ready:-0}" -ge 1 ]]; then
        print_result "$(date '+%H:%M:%S') ✓ AgentGateway proxy is running"
        pass=$((pass + 1))
      else
        print_result "$(date '+%H:%M:%S') ✗ AgentGateway proxy is not ready"
        fail=$((fail + 1))
      fi

      local mcp_backend_count
      mcp_backend_count=$(kubectl get agentgatewaybackend -n caipe \
        -l app.kubernetes.io/managed-by=setup-caipe --no-headers 2>/dev/null | wc -l | tr -d ' ')
      if [[ "$mcp_backend_count" -gt 0 ]]; then
        print_result "$(date '+%H:%M:%S') ✓ ${mcp_backend_count} MCP backend(s) configured in AgentGateway"
        pass=$((pass + 1))
      else
        print_result "$(date '+%H:%M:%S') ⚠ No MCP backends configured in AgentGateway"
        warn_count=$((warn_count + 1))
      fi
    fi
  fi

  # ── RBAC runtime ──
  if $ENABLE_RBAC_RUNTIME; then
    local component deploy_name ready_replicas
    for component in keycloak openfga openfga-authz-bridge; do
      deploy_name="caipe-${component}"
      ready_replicas=$(kubectl get deployment "$deploy_name" -n caipe \
        -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
      if [[ "${ready_replicas:-0}" -ge 1 ]]; then
        print_result "$(date '+%H:%M:%S') ✓ ${deploy_name} is running"
        pass=$((pass + 1))
      else
        print_result "$(date '+%H:%M:%S') ✗ ${deploy_name} is not ready"
        fail=$((fail + 1))
      fi
    done
  fi

  # ── Summary ──
  echo ""
  local total_checks=$((pass + fail + warn_count))
  if [[ $fail -eq 0 ]]; then
    echo -e "  ${GREEN}${BOLD}All checks passed (${pass}/${total_checks})${NC}"
  else
    echo -e "  ${RED}${BOLD}${fail} failed${NC}, ${GREEN}${pass} passed${NC}, ${YELLOW}${warn_count} warnings${NC} (${total_checks} total)"
  fi
  echo ""
}

# ─── Sanity Tests ────────────────────────────────────────────────────────────
run_sanity_tests() {
  echo ""
  header "Sanity Tests"

  local pass=0 fail=0

  # ── Test 1: Dynamic agents health endpoint ──
  local da_health
  da_health=$(curl -sf "http://localhost:${DYNAMIC_AGENTS_PORT}/healthz" --max-time 5 2>/dev/null || echo "")
  if [[ -n "$da_health" ]] && echo "$da_health" | jq -e '.status' &>/dev/null; then
    print_result "$(date '+%H:%M:%S') ✓ [T1] Dynamic agents /healthz OK"
    pass=$((pass + 1))
  else
    print_result "$(date '+%H:%M:%S') ✗ [T1] Dynamic agents /healthz failed"
    fail=$((fail + 1))
  fi

  # ── Test 3: CAIPE UI serves HTML ──
  local ui_content_type _t3_url
  if $ENABLE_INGRESS && [[ -n "${CAIPE_DOMAIN:-}" ]]; then
    _t3_url="https://${CAIPE_DOMAIN}/"
    ui_content_type=$(curl -sk -o /dev/null -w "%{content_type}" "${_t3_url}" --max-time 10 2>/dev/null || echo "")
  else
    _t3_url="http://localhost:${UI_PORT}/"
    ui_content_type=$(curl -sf -o /dev/null -w "%{content_type}" "${_t3_url}" --max-time 5 2>/dev/null || echo "")
  fi
  if echo "$ui_content_type" | grep -qi "text/html"; then
    print_result "$(date '+%H:%M:%S') ✓ [T3] CAIPE UI serves HTML content"
    pass=$((pass + 1))
  else
    print_result "$(date '+%H:%M:%S') ✗ [T3] CAIPE UI content-type: ${ui_content_type:-none}"
    fail=$((fail + 1))
  fi

  # ── Test 4: Sub-agent MCP deployments exist ──
  for agent_svc in caipe-mcp-netutils-mcp; do
    local agent_label="${agent_svc#caipe-mcp-}"
    if kubectl get deployment "$agent_svc" -n caipe &>/dev/null; then
      print_result "$(date '+%H:%M:%S') ✓ [T4] ${agent_label} deployment present"
      pass=$((pass + 1))
    else
      print_result "$(date '+%H:%M:%S') ─ [T4] ${agent_label} deployment not present (agent disabled)"
    fi
  done

  # ── Test 5: RAG server health (if RAG enabled) ──
  if $ENABLE_RAG; then
    local rag_health
    rag_health=$(kubectl exec deployment/caipe-dynamic-agents -n caipe -- \
      curl -sf "http://rag-server:9446/healthz" --max-time 5 2>/dev/null || echo "")
    if [[ -n "$rag_health" ]] && echo "$rag_health" | jq -e '.status // .config' &>/dev/null; then
      print_result "$(date '+%H:%M:%S') ✓ [T5] RAG server /healthz OK"
      pass=$((pass + 1))
    else
      print_result "$(date '+%H:%M:%S') ✗ [T5] RAG server /healthz failed"
      fail=$((fail + 1))
    fi
  fi

  # ── Test 6: Langfuse API health (if tracing enabled) ──
  if $ENABLE_TRACING; then
    local lf_api
    lf_api=$(curl -sf "http://localhost:${LANGFUSE_PORT}/api/public/health" --max-time 5 2>/dev/null || echo "")
    if [[ -n "$lf_api" ]] && echo "$lf_api" | jq -e '.status' &>/dev/null; then
      local lf_status
      lf_status=$(echo "$lf_api" | jq -r '.status')
      print_result "$(date '+%H:%M:%S') ✓ [T6] Langfuse API health: ${lf_status}"
      pass=$((pass + 1))
    else
      print_result "$(date '+%H:%M:%S') ✗ [T6] Langfuse API health check failed"
      fail=$((fail + 1))
    fi
  fi

  # ── Summary ──
  echo ""
  local total=$((pass + fail))
  if [[ $fail -eq 0 ]]; then
    echo -e "  ${GREEN}${BOLD}All ${total} sanity tests passed${NC}"
  else
    echo -e "  ${RED}${BOLD}${fail}/${total} sanity tests failed${NC}"
  fi
  echo ""
}

# ─── Auto-Heal ───────────────────────────────────────────────────────────────
AUTOHEAL_ENABLED=true
AUTOHEAL_LAST_RUN=0
AUTOHEAL_INTERVAL=30    # seconds between heal cycles

auto_heal_pods() {
  local ns="$1"
  local healed=0

  # CrashLoopBackOff / Error — rollout restart the owning deployment
  # Skip Terminating pods (old replicas being replaced) to avoid restart storms
  local bad_pods
  bad_pods=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null \
    | awk '$3=="CrashLoopBackOff" || $3=="Error" || $3=="CreateContainerConfigError" {print $1}')

  for pod in $bad_pods; do
    # Skip pods that are already being terminated
    local pod_phase
    pod_phase=$(kubectl get pod "$pod" -n "$ns" -o jsonpath='{.metadata.deletionTimestamp}' 2>/dev/null || true)
    [[ -n "$pod_phase" ]] && continue

    local owner
    owner=$(kubectl get pod "$pod" -n "$ns" -o jsonpath='{.metadata.ownerReferences[0].name}' 2>/dev/null || true)
    if [[ -z "$owner" ]]; then continue; fi

    # ReplicaSet -> Deployment
    local deploy
    deploy=$(kubectl get rs "$owner" -n "$ns" -o jsonpath='{.metadata.ownerReferences[0].name}' 2>/dev/null || true)
    if [[ -n "$deploy" ]]; then
      warn "[auto-heal] Pod ${pod} in ${3:-CrashLoop}; restarting deployment/${deploy}"
      kubectl rollout restart "deployment/${deploy}" -n "$ns" &>/dev/null || true
      ((healed++))
    fi
  done

  # ErrImagePull / ImagePullBackOff — log only (requires manual image fix)
  local pull_errors
  pull_errors=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null \
    | awk '$3=="ErrImagePull" || $3=="ImagePullBackOff" {print $1}')
  for pod in $pull_errors; do
    warn "[auto-heal] Pod ${pod} has image pull error (manual fix needed)"
  done

  return $healed
}

auto_heal_pvcs() {
  local ns="$1"
  local healed=0

  local pending_pvcs
  pending_pvcs=$(kubectl get pvc -n "$ns" --no-headers 2>/dev/null \
    | awk '$2=="Pending" {print $1}')

  for pvc in $pending_pvcs; do
    local sc
    sc=$(kubectl get pvc "$pvc" -n "$ns" -o jsonpath='{.spec.storageClassName}' 2>/dev/null || true)

    # Check if the requested storageClass exists
    if [[ -n "$sc" ]] && ! kubectl get storageclass "$sc" &>/dev/null 2>&1; then
      local default_sc
      default_sc=$(kubectl get storageclass -o jsonpath='{.items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")].metadata.name}' 2>/dev/null || true)

      if [[ -n "$default_sc" && "$default_sc" != "$sc" ]]; then
        warn "[auto-heal] PVC ${pvc} requests non-existent storageClass '${sc}'; recreating with '${default_sc}'"
        local pvc_size
        pvc_size=$(kubectl get pvc "$pvc" -n "$ns" -o jsonpath='{.spec.resources.requests.storage}' 2>/dev/null || echo "10Gi")
        local access_mode
        access_mode=$(kubectl get pvc "$pvc" -n "$ns" -o jsonpath='{.spec.accessModes[0]}' 2>/dev/null || echo "ReadWriteOnce")

        kubectl delete pvc "$pvc" -n "$ns" --wait=false &>/dev/null || true
        kubectl apply -f - &>/dev/null <<EOFPVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${pvc}
  namespace: ${ns}
spec:
  accessModes: ["${access_mode}"]
  storageClassName: "${default_sc}"
  resources:
    requests:
      storage: "${pvc_size}"
EOFPVC
        log "[auto-heal] PVC ${pvc} recreated with storageClass '${default_sc}'"
        ((healed++))
      fi
    fi
  done

  return $healed
}

auto_heal_langfuse_secret() {
  if ! $ENABLE_TRACING; then return 0; fi

  # Verify langfuse-secret exists
  if ! kubectl get secret langfuse-secret -n caipe &>/dev/null; then
    return 0
  fi

  # Check if dynamic-agents deployment has langfuse-secret in envFrom
  local envfrom
  envfrom=$(kubectl get deployment caipe-dynamic-agents -n caipe \
    -o jsonpath='{.spec.template.spec.containers[0].envFrom[*].secretRef.name}' 2>/dev/null || true)

  if ! echo "$envfrom" | grep -q "langfuse-secret"; then
    warn "[auto-heal] dynamic-agents missing langfuse-secret; re-patching"
    kubectl patch deployment caipe-dynamic-agents -n caipe --type='json' \
      -p='[{"op":"add","path":"/spec/template/spec/containers/0/envFrom/-","value":{"secretRef":{"name":"langfuse-secret"}}}]' &>/dev/null || true
    log "[auto-heal] langfuse-secret patched into dynamic-agents"
    return 1
  fi

  # Verify the secret actually has the expected keys
  local has_keys
  has_keys=$(kubectl get secret langfuse-secret -n caipe \
    -o jsonpath='{.data.LANGFUSE_SECRET_KEY}' 2>/dev/null || true)
  if [[ -z "$has_keys" ]]; then
    warn "[auto-heal] langfuse-secret exists but LANGFUSE_SECRET_KEY is empty"
  fi

  # Check MinIO credential mismatch (Langfuse chart bug: s3.secretAccessKey
  # only configures the app side, MinIO sub-chart generates its own password)
  local minio_expected minio_actual
  minio_expected=$(kubectl get deployment langfuse-web -n langfuse \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY")].value}' 2>/dev/null || true)
  minio_actual=$(kubectl get secret langfuse-s3 -n langfuse \
    -o jsonpath='{.data.root-password}' 2>/dev/null | base64 -d 2>/dev/null || true)

  if [[ -n "$minio_expected" && -n "$minio_actual" && "$minio_expected" != "$minio_actual" ]]; then
    warn "[auto-heal] Langfuse MinIO credential mismatch; syncing"
    _fix_langfuse_minio_credentials "$minio_expected"
    return 1
  fi

  return 0
}

_auto_heal_offer_corporate_ca() {
  local source="${1:-a pod}"
  CA_SSL_FIX_PROMPTED=true

  echo ""
  warn "[auto-heal] SSL/TLS certificate errors detected in ${source}."
  echo -e "  ${YELLOW}This usually means a corporate proxy or firewall is intercepting TLS traffic.${NC}"
  echo -e "  ${DIM}The script can auto-detect your corporate CA chain and patch it into the pods.${NC}"
  echo ""

  if ! $NON_INTERACTIVE && ask_yn "Attempt to auto-detect and apply corporate CA patch to fix SSL errors?" "y"; then
    echo ""
    prepare_corporate_ca
    if kubectl get configmap corporate-ca-bundle -n caipe &>/dev/null; then
      INJECT_CORPORATE_CA=true
      log "[auto-heal] Corporate CA bundle created; patching all deployments..."
      for deploy in $AGENT_DEPLOYMENTS; do
        if kubectl get deployment "$deploy" -n caipe &>/dev/null; then
          local container
          container=$(kubectl get deployment "$deploy" -n caipe \
            -o jsonpath='{.spec.template.spec.containers[0].name}' 2>/dev/null)
          local vol_names
          vol_names=$(kubectl get deployment "$deploy" -n caipe \
            -o jsonpath='{.spec.template.spec.volumes[*].name}' 2>/dev/null)
          if ! echo "$vol_names" | grep -q "corporate-ca"; then
            patch_deployment_with_ca "$deploy" caipe "$container"
          fi
        fi
      done
      if $ENABLE_RAG; then
        patch_deployment_with_ca rag-server caipe rag-server
      fi
      log "[auto-heal] Corporate CA patched into all deployments; pods will restart"
    else
      warn "[auto-heal] Could not detect a corporate CA chain; no changes made"
    fi
  else
    warn "[auto-heal] Skipped corporate CA patch. Re-run with --corporate-ca if needed."
  fi
  echo ""
}

auto_heal_rag_server() {
  if ! $ENABLE_RAG; then return 0; fi

  # Get the most recent rag-server pod (skip Terminating)
  local rag_pod rag_status rag_ready_str
  rag_pod=$(kubectl get pods -n caipe --no-headers 2>/dev/null \
    | awk '/rag-server/ && $3!="Terminating" {print $1; exit}')

  if [[ -z "$rag_pod" ]]; then
    return 0
  fi

  rag_status=$(kubectl get pod "$rag_pod" -n caipe --no-headers 2>/dev/null | awk '{print $3}')
  rag_ready_str=$(kubectl get pod "$rag_pod" -n caipe --no-headers 2>/dev/null | awk '{print $2}')

  # Check logs for fixable errors when pod is not fully ready
  # (Running but not all containers ready, CrashLoopBackOff, or Error)
  local is_fully_ready=false
  if [[ "$rag_status" == "Running" ]] && echo "$rag_ready_str" | grep -qE '^[0-9]+/[0-9]+$'; then
    local r_num r_den
    r_num=$(echo "$rag_ready_str" | cut -d/ -f1)
    r_den=$(echo "$rag_ready_str" | cut -d/ -f2)
    [[ "$r_num" -eq "$r_den" ]] && is_fully_ready=true
  fi

  if ! $is_fully_ready; then
    local recent_logs
    recent_logs=$(kubectl logs "$rag_pod" -n caipe -c rag-server \
      --tail=200 2>/dev/null || true)

    # EMBEDDINGS_PROVIDER defaulting to azure-openai when the user picked
    # a different provider. We only correct this when the user's chosen
    # provider is NOT azure-openai — otherwise a real Azure pick would get
    # clobbered the moment the rag-server logs a normal "endpoint=..." line.
    if [[ "${EMBEDDINGS_PROVIDER:-}" != "azure-openai" ]] \
       && echo "$recent_logs" | grep -q "AZURE_OPENAI_ENDPOINT\|azure_endpoint"; then
      warn "[auto-heal] RAG server has wrong embeddings provider; patching to ${EMBEDDINGS_PROVIDER:-openai}"
      kubectl set env deployment/rag-server -n caipe \
        EMBEDDINGS_PROVIDER="${EMBEDDINGS_PROVIDER:-openai}" \
        EMBEDDINGS_MODEL="${EMBEDDINGS_MODEL}" &>/dev/null || true
      log "[auto-heal] RAG server embeddings provider corrected"
      return 1
    fi

    # SSL certificate errors (corporate proxy)
    if echo "$recent_logs" | grep -q "CERTIFICATE_VERIFY_FAILED\|SSL.*certificate\|SSLCertVerificationError"; then
      if $INJECT_CORPORATE_CA; then
        warn "[auto-heal] RAG server SSL error; re-applying corporate CA"
        patch_deployment_with_ca rag-server caipe rag-server
        return 1
      elif ! $CA_SSL_FIX_PROMPTED; then
        _auto_heal_offer_corporate_ca "RAG server"
        if $INJECT_CORPORATE_CA; then return 1; fi
      fi
    fi
  fi

  return 0
}

# Scan running pod logs for known error patterns and remediate.
# Unlike pod-status checks, this catches issues where the pod is "Running"
# but the application inside has errors (SSL, misconfigured providers, etc.)
auto_heal_pod_logs() {
  local ns="$1"
  local healed=0

  # Get all running (non-Terminating) pods in namespace, excluding infra pods
  local pods
  pods=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null \
    | awk '$3!="Terminating" && $1!~/etcd|milvus|minio|redis/ {print $1}')

  for pod in $pods; do
    local logs
    logs=$(kubectl logs "$pod" -n "$ns" --tail=200 --all-containers 2>/dev/null || true)
    [[ -z "$logs" ]] && continue

    # SSL / certificate errors → offer corporate CA patch (once)
    if ! $INJECT_CORPORATE_CA && ! $CA_SSL_FIX_PROMPTED; then
      if echo "$logs" | grep -q "CERTIFICATE_VERIFY_FAILED\|SSLCertVerificationError"; then
        _auto_heal_offer_corporate_ca "$pod"
        $INJECT_CORPORATE_CA && healed=$((healed + 1))
        break
      fi
    fi

    # UI: ECONNREFUSED to rag-server → rag-server not ready yet, will self-resolve
    # No action needed, just informational
  done

  return $healed
}

auto_heal_services() {
  local ns="$1"
  local healed=0

  local svcs
  svcs=$(kubectl get svc -n "$ns" --no-headers 2>/dev/null \
    | awk '$2=="ClusterIP" {print $1}')

  for svc in $svcs; do
    local ep_count
    ep_count=$(kubectl get endpoints "$svc" -n "$ns" \
      -o jsonpath='{.subsets[*].addresses}' 2>/dev/null | wc -c | tr -d ' ')

    if [[ "$ep_count" -lt 3 ]]; then
      # Service has no ready endpoints — find its deployment and restart
      local selector
      selector=$(kubectl get svc "$svc" -n "$ns" \
        -o jsonpath='{.spec.selector}' 2>/dev/null || true)
      if [[ -z "$selector" ]]; then continue; fi

      local deploy_name
      deploy_name=$(kubectl get deployments -n "$ns" \
        -o jsonpath="{.items[?(@.metadata.name=='${svc}')].metadata.name}" 2>/dev/null || true)

      if [[ -n "$deploy_name" ]]; then
        local pod_count
        pod_count=$(kubectl get deployment "$deploy_name" -n "$ns" \
          -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
        if [[ "${pod_count:-0}" -eq 0 ]]; then
          warn "[auto-heal] Service ${svc} has no endpoints; restarting deployment/${deploy_name}"
          kubectl rollout restart "deployment/${deploy_name}" -n "$ns" &>/dev/null || true
          ((healed++))
        fi
      fi
    fi
  done

  return $healed
}

run_auto_heal() {
  local now
  now=$(date +%s)

  if (( now - AUTOHEAL_LAST_RUN < AUTOHEAL_INTERVAL )); then
    return
  fi
  AUTOHEAL_LAST_RUN=$now

  local total_healed=0

  # 1. Fix Pending PVCs with wrong storageClass
  auto_heal_pvcs caipe || total_healed=$((total_healed + $?))

  # 2. Fix crashing/errored pods
  auto_heal_pods caipe || total_healed=$((total_healed + $?))

  # 3. Fix RAG server configuration issues
  auto_heal_rag_server || total_healed=$((total_healed + $?))

  # 4. Fix services with no endpoints
  auto_heal_services caipe || total_healed=$((total_healed + $?))

  # 5. Scan running pod logs for errors (SSL, misconfig, etc.)
  auto_heal_pod_logs caipe || total_healed=$((total_healed + $?))

  # 6. Fix Langfuse secret missing from dynamic-agents
  if $ENABLE_TRACING; then
    auto_heal_langfuse_secret || total_healed=$((total_healed + $?))
  fi

  if $ENABLE_TRACING; then
    auto_heal_pvcs langfuse || total_healed=$((total_healed + $?))
    auto_heal_pods langfuse || total_healed=$((total_healed + $?))
    auto_heal_services langfuse || total_healed=$((total_healed + $?))
  fi

  if [[ $total_healed -gt 0 ]]; then
    log "[auto-heal] Applied ${total_healed} remediation(s) this cycle"
  fi
}

# ─── Port Forward Monitor ───────────────────────────────────────────────────
PF_SVCS=()          # parallel array: "svc ns local_port remote_port label"
PF_FAIL_COUNT=()    # consecutive failure count per forward (for backoff)
PF_LAST_RESTART=()  # epoch of last restart per forward

start_pf() {
  local svc="$1" ns="$2" local_port="$3" remote_port="$4" label="$5"
  kill_port_on "$local_port"
  kubectl port-forward "svc/${svc}" -n "$ns" "${local_port}:${remote_port}" &>/dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  PF_PIDS+=($pid)
  PF_SVCS+=("${svc} ${ns} ${local_port} ${remote_port} ${label}")
  PF_FAIL_COUNT+=(0)
  PF_LAST_RESTART+=($(date +%s))
  log "${label}: http://localhost:${local_port}"
}

_pf_svc_ready() {
  local svc="$1" ns="$2"
  local ready
  ready=$(kubectl get endpoints "$svc" -n "$ns" -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)
  [[ -n "$ready" ]]
}

restart_pf() {
  local idx="$1"
  local entry="${PF_SVCS[$idx]}"
  # shellcheck disable=SC2086
  set -- $entry
  local svc="$1" ns="$2" local_port="$3" remote_port="$4"
  shift 4
  local label="$*"

  if ! _pf_svc_ready "$svc" "$ns"; then
    local fails=$(( ${PF_FAIL_COUNT[$idx]} + 1 ))
    PF_FAIL_COUNT[$idx]=$fails
    if [[ $fails -eq 1 ]]; then
      warn "Port-forward dropped for ${label}; waiting for service endpoint..."
    fi
    return 1
  fi

  kill_port_on "$local_port"
  sleep 1
  kubectl port-forward "svc/${svc}" -n "$ns" "${local_port}:${remote_port}" &>/dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  PF_PIDS[$idx]=$pid
  PF_LAST_RESTART[$idx]=$(date +%s)

  local prev_fails=${PF_FAIL_COUNT[$idx]}
  PF_FAIL_COUNT[$idx]=0

  if [[ $prev_fails -gt 0 ]]; then
    log "Reconnected ${label}: http://localhost:${local_port} (after ${prev_fails} retries)"
  else
    warn "Port-forward dropped for ${label}; restarted on http://localhost:${local_port}"
  fi
}

monitor_port_forwards() {
  step "Port-forwarding services"

  # Reset arrays so only start_pf entries are tracked (discard stale entries
  # from create_langfuse_api_keys or other earlier port-forwards)
  PF_PIDS=()
  PF_SVCS=()
  PF_FAIL_COUNT=()
  PF_LAST_RESTART=()

  start_pf caipe-dynamic-agents caipe "$DYNAMIC_AGENTS_PORT" 8001 "Dynamic agents"
  # When ingress is enabled the UI is served via nginx-ingress at the domain —
  # no local port-forward needed.
  if ! $ENABLE_INGRESS; then
    start_pf caipe-caipe-ui caipe "$UI_PORT" 3000 "CAIPE UI"
  fi

  if $ENABLE_TRACING; then
    start_pf langfuse-web langfuse "$LANGFUSE_PORT" 3000 "Langfuse UI"
  fi

  if $ENABLE_AGENTGATEWAY; then
    if $ENABLE_RBAC_RUNTIME; then
      start_pf caipe-agentgateway caipe "$AGENTGATEWAY_PORT" 4000 "AgentGateway MCP"
    else
      start_pf agentgateway-proxy agentgateway-system "$AGENTGATEWAY_PORT" 80 "AgentGateway MCP"
    fi
  fi

  if $ENABLE_RBAC_RUNTIME; then
    start_pf caipe-keycloak caipe "$KEYCLOAK_PORT" 8080 "Keycloak"
    start_pf caipe-openfga caipe "$OPENFGA_PORT" 8080 "OpenFGA"
  fi

  # Wait for port-forwards to become responsive before running tests
  local pf_wait=0
  while [[ $pf_wait -lt 15 ]]; do
    local all_up=true
    curl -sf -o /dev/null --max-time 2 "http://localhost:${DYNAMIC_AGENTS_PORT}/health" 2>/dev/null || all_up=false
    if ! $ENABLE_INGRESS; then
      curl -sf -o /dev/null --max-time 2 "http://localhost:${UI_PORT}/" 2>/dev/null || all_up=false
    else
      curl -sfk -o /dev/null --max-time 5 "https://${CAIPE_DOMAIN}/" 2>/dev/null || all_up=false
    fi
    if $ENABLE_TRACING; then
      curl -sf -o /dev/null --max-time 2 "http://localhost:${LANGFUSE_PORT}/api/public/health" 2>/dev/null || all_up=false
    fi
    $all_up && break
    sleep 2
    pf_wait=$((pf_wait + 2))
  done

  run_validation
  run_sanity_tests

  # Surface the default local Keycloak logins (no upstream IdP) in both
  # interactive and non-interactive modes so the operator can sign in and test
  # both RBAC paths (org-admin vs non-admin).
  if _local_admin_active && [[ -n "${LOCAL_ADMIN_PASSWORD:-}" ]]; then
    echo ""
    header "Local logins (in-chart Keycloak, no upstream IdP)"
    echo -e "    URL                ${CYAN}https://${CAIPE_DOMAIN}${NC}"
    echo ""
    echo -e "    ${BOLD}Admin${NC} (org-admin / admin UI)"
    echo -e "      Email            ${BOLD}${LOCAL_ADMIN_EMAIL}${NC}"
    echo -e "      Password         ${BOLD}${LOCAL_ADMIN_PASSWORD}${NC}"
    echo -e "      ${DIM}Recover: kubectl get secret caipe-local-admin -n caipe -o jsonpath='{.data.password}' | base64 -d${NC}"
    if [[ "$ENABLE_LOCAL_USER" != "false" && -n "${LOCAL_USER_PASSWORD:-}" ]]; then
      echo ""
      echo -e "    ${BOLD}Standard${NC} (non-admin / chat only, no admin UI)"
      echo -e "      Email            ${BOLD}${LOCAL_USER_EMAIL}${NC}"
      echo -e "      Password         ${BOLD}${LOCAL_USER_PASSWORD}${NC}"
      echo -e "      ${DIM}Recover: kubectl get secret caipe-local-user -n caipe -o jsonpath='{.data.password}' | base64 -d${NC}"
    fi
    echo ""
    echo -e "    ${DIM}Re-print these any time: ./$(basename "$0") creds${NC}"
    if [[ "$CAIPE_DOMAIN" == *.local.me ]]; then
      echo -e "    ${DIM}${CAIPE_DOMAIN} resolves to 127.0.0.1 — on a remote host, tunnel 443 (ssh -L 8443:127.0.0.1:443 <host>) or re-run with --domain=<public-dns>.${NC}"
    fi
  fi

  # In non-interactive (CI) mode, exit after validation — no need to keep
  # port-forwards alive for an interactive session.
  if $NON_INTERACTIVE; then
    log "Non-interactive mode: setup complete, exiting."
    return
  fi

  echo ""
  header "Services Ready"
  echo ""
  echo -e "  ${BOLD}Endpoints:${NC}"
  if $ENABLE_INGRESS && [[ -n "$CAIPE_DOMAIN" ]]; then
    echo -e "    CAIPE UI        ${CYAN}https://${CAIPE_DOMAIN}${NC}"
  else
    echo -e "    CAIPE UI        ${CYAN}http://localhost:${UI_PORT}${NC}"
  fi
  echo -e "    Dynamic agents  ${CYAN}http://localhost:${DYNAMIC_AGENTS_PORT}${NC}"
  if $ENABLE_RAG; then
    if $ENABLE_INGRESS && [[ -n "$CAIPE_DOMAIN" ]]; then
      echo -e "    RAG Server      ${CYAN}https://${CAIPE_DOMAIN}/api/rag${NC}  (proxied by UI)"
    else
      echo -e "    RAG Server      ${CYAN}http://localhost:${UI_PORT}/api/rag${NC}  (proxied by UI)"
    fi
  fi
  if $ENABLE_TRACING; then
    echo -e "    Langfuse UI     ${CYAN}http://localhost:${LANGFUSE_PORT}${NC}"
    if [[ -n "${LANGFUSE_EMAIL:-}" && -n "${LANGFUSE_PASSWORD:-}" ]]; then
      echo -e "      Login: ${DIM}${LANGFUSE_EMAIL} / ${LANGFUSE_PASSWORD}${NC}"
    else
      echo -e "      ${DIM}Login: see langfuse-credentials Secret (kubectl command below)${NC}"
    fi
  fi
  if $ENABLE_RBAC_RUNTIME; then
    echo -e "    Keycloak        ${CYAN}http://localhost:${KEYCLOAK_PORT}${NC}"
    echo -e "    OpenFGA         ${CYAN}http://localhost:${OPENFGA_PORT}${NC}"
  fi
  if $ENABLE_RBAC_RUNTIME; then
    echo -e "    Keycloak        ${CYAN}http://localhost:${KEYCLOAK_PORT}${NC}"
    echo -e "    OpenFGA         ${CYAN}http://localhost:${OPENFGA_PORT}${NC}"
  fi
  if $ENABLE_AGENTGATEWAY; then
    echo -e "    AgentGateway    ${CYAN}http://localhost:${AGENTGATEWAY_PORT}${NC}"
    if ! $ENABLE_RBAC_RUNTIME; then
      echo ""
      echo -e "  ${BOLD}MCP Client URLs (via AgentGateway):${NC}"
      local ag_svcs
      ag_svcs=$(kubectl get agentgatewaybackend -n caipe \
        -l app.kubernetes.io/managed-by=setup-caipe \
        -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
      if [[ -n "$ag_svcs" ]]; then
        while IFS= read -r backend_name; do
          [[ -z "$backend_name" ]] && continue
          local agent_short
          agent_short=$(echo "$backend_name" | sed 's/^mcp-//' | sed 's/-backend$//')
          echo -e "    ${DIM}http://localhost:${AGENTGATEWAY_PORT}/mcp/${agent_short}${NC}"
        done <<< "$ag_svcs"
      fi
    fi
  fi
  echo ""
  echo -e "  ${BOLD}Chart:${NC}   v${CAIPE_CHART_VERSION}"
  local agent_list="netutils"
  $ENABLE_RAG && agent_list+=", rag"
  echo -e "  ${BOLD}Agents:${NC}  ${agent_list}"
  $AUTOHEAL_ENABLED && echo -e "  ${BOLD}Auto-heal:${NC} ${GREEN}enabled${NC} (every ${AUTOHEAL_INTERVAL}s)"
  echo ""
  if $ENABLE_TRACING; then
    echo -e "  ${BOLD}Retrieve Langfuse credentials:${NC}"
    echo -e "    ${DIM}kubectl get secret langfuse-credentials -n langfuse -o jsonpath='{.data}' | python3 -c \"import sys,json,base64; d=json.load(sys.stdin); print('\n'.join(f'{k}: {base64.b64decode(v).decode()}' for k,v in sorted(d.items())))\"${NC}"
    echo ""
  fi
  echo -e "  ${BOLD}Retrieve MongoDB credentials${NC} ${DIM}(R2: random per-install, persisted in caipe-mongodb-credentials):${NC}"
  echo -e "    ${DIM}kubectl get secret caipe-mongodb-credentials -n caipe -o jsonpath='{.data}' | python3 -c \"import sys,json,base64; d=json.load(sys.stdin); print('\n'.join(f'{k}: {base64.b64decode(v).decode()}' for k,v in sorted(d.items())))\"${NC}"
  echo ""
  echo -e "  ${BOLD}Chat:${NC} open the CAIPE UI at ${CYAN}http://localhost:${UI_PORT}${NC}"
  echo ""
  echo -e "  ${YELLOW}${BOLD}Keep this script running to maintain port-forwarding.${NC}"
  echo -e "  ${DIM}Press Ctrl+C to stop all services.${NC}"
  echo ""

  local sanity_last_run
  sanity_last_run=$(date +%s)

  while true; do
    local now
    now=$(date +%s)

    for i in "${!PF_PIDS[@]}"; do
      local _pf_port
      # shellcheck disable=SC2086
      _pf_port=$(echo ${PF_SVCS[$i]} | awk '{print $3}')

      if ! kill -0 "${PF_PIDS[$i]}" 2>/dev/null; then
        # PID is gone — but check if another process already owns the port
        # (e.g., a previous restart_pf spawned a new PID we lost track of)
        local _actual_pid
        _actual_pid=$(lsof -ti :"$_pf_port" 2>/dev/null | head -1 || true)
        if [[ -n "$_actual_pid" ]]; then
          # Port is still served; adopt the existing PID
          PF_PIDS[$i]=$_actual_pid
          continue
        fi

        local fails=${PF_FAIL_COUNT[$i]}
        local last=${PF_LAST_RESTART[$i]}

        # Exponential backoff: 5s, 10s, 20s, 40s ... capped at 60s
        local backoff=$(( 5 * (1 << (fails > 5 ? 5 : fails)) ))
        [[ $backoff -gt 60 ]] && backoff=60

        if (( now - last < backoff )); then
          continue
        fi

        restart_pf "$i" || true
      fi
    done

    # Run auto-heal if enabled
    if $AUTOHEAL_ENABLED; then
      run_auto_heal
    fi

    # Periodic sanity check every 5 minutes
    if (( now - sanity_last_run >= 300 )); then
      echo ""
      echo -e "  ${DIM}── Periodic health check ($(date '+%H:%M:%S')) ──${NC}"
      run_validation || true
      sanity_last_run=$now
    fi

    sleep 10
  done
}

# ─── Cleanup ─────────────────────────────────────────────────────────────────

# Delete a whole namespace for a clean uninstall. Deleting the namespace cascades
# to every remaining namespaced resource (workloads, configmaps, secrets, PVCs),
# so it doesn't matter what the earlier per-type prompts left behind. --timeout
# bounds finalizer waits (e.g. a PVC still held by a running pod) so cleanup can't
# hang forever (warn instead). No-op if the namespace doesn't exist.
_delete_namespace_clean() {
  local ns="$1"
  kubectl get namespace "$ns" &>/dev/null || return 0
  if ask_yn "Delete ${ns} namespace?" "y"; then
    if ! kubectl delete namespace "$ns" --timeout=120s 2>/dev/null; then
      warn "${ns} namespace did not finalize within 120s (a resource has a pending finalizer) — it will remain in Terminating"
    else
      log "${ns} namespace deleted"
    fi
  fi
}

cmd_cleanup() {
  echo ""
  echo -e "${BLUE}${BOLD}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}${BOLD}║       CAIPE Lab Environment Cleanup          ║${NC}"
  echo -e "${BLUE}${BOLD}╚══════════════════════════════════════════════╝${NC}"
  echo ""

  if $AUTO_YES; then
    echo -e "  ${RED}${BOLD}WARNING:${NC} This will delete ALL CAIPE and Langfuse resources"
    echo -e "  ${RED}including Helm releases, secrets, PVCs, and namespaces.${NC}"
    echo ""
    prompt "Type 'yes' to confirm: "
    tty_read -r confirm
    if [[ "$confirm" != "yes" ]]; then
      log "Aborted"
      exit 0
    fi
    echo ""
  fi

  check_prerequisites

  # Kill any port-forwards on known ports
  for port in "$LANGFUSE_PORT" "$DYNAMIC_AGENTS_PORT" "$UI_PORT" "$AGENTGATEWAY_PORT"; do
    kill_port_on "$port"
  done

  step "Helm releases"

  if helm status caipe -n caipe &>/dev/null; then
    if ask_yn "Uninstall CAIPE Helm release?" "y"; then
      helm uninstall caipe -n caipe
      log "CAIPE uninstalled"
    fi
  else
    log "No CAIPE release found"
  fi

  # caipe-postgres / caipe-mongodb are deployed as their OWN Helm releases
  # (see deploy_postgres / deploy_mongodb), separate from the caipe umbrella.
  # They MUST be uninstalled here, while their release-tracking secrets still
  # exist. If we skip this, the later "kubectl delete secret --all" wipes the
  # release tracking (orphaning the live StatefulSet/Deployment) and the
  # subsequent "kubectl delete pvc --all" hangs forever waiting on PVCs the
  # still-running pods hold via the pvc-protection finalizer.
  if helm status "${SHARED_PG_SERVICE}" -n caipe &>/dev/null; then
    if ask_yn "Uninstall Postgres Helm release (${SHARED_PG_SERVICE})?" "y"; then
      helm uninstall "${SHARED_PG_SERVICE}" -n caipe
      log "Postgres uninstalled"
    fi
  else
    log "No Postgres release found"
  fi

  if helm status caipe-mongodb -n caipe &>/dev/null; then
    if ask_yn "Uninstall MongoDB Helm release (caipe-mongodb)?" "y"; then
      helm uninstall caipe-mongodb -n caipe
      log "MongoDB uninstalled"
    fi
  else
    log "No MongoDB release found"
  fi

  if helm status langfuse -n langfuse &>/dev/null; then
    if ask_yn "Uninstall Langfuse Helm release?" "y"; then
      helm uninstall langfuse -n langfuse
      log "Langfuse uninstalled"
    fi
  else
    log "No Langfuse release found"
  fi

  if helm status vllm -n caipe &>/dev/null; then
    if ask_yn "Uninstall vLLM Helm release?" "y"; then
      helm uninstall vllm -n caipe
      log "vLLM uninstalled"
    fi
  else
    log "No vLLM release found"
  fi

  # Remaining releases (caipe-mongodb, caipe-postgres, etc.). The app tier is
  # uninstalled above, so these databases are removed last.
  for _rel in $(helm list -n caipe -q 2>/dev/null); do
    if ask_yn "Uninstall '${_rel}' Helm release?" "y"; then
      helm uninstall "$_rel" -n caipe 2>/dev/null || true
      log "${_rel} uninstalled"
    fi
  done

  # LiteLLM proxy (deployed via kubectl, not Helm)
  if kubectl get deployment litellm-proxy -n caipe &>/dev/null; then
    if ask_yn "Delete LiteLLM proxy resources?" "y"; then
      kubectl delete deployment,svc,configmap -l app=litellm-proxy -n caipe 2>/dev/null || true
      log "LiteLLM proxy deleted"
    fi
  fi

  # Ollama (deployed via kubectl, not Helm)
  if kubectl get deployment ollama -n caipe &>/dev/null; then
    if ask_yn "Delete Ollama resources?" "y"; then
      local _ollama_yaml="${SCRIPT_DIR}/deploy/kind/ollama.yaml"
      if [[ -f "$_ollama_yaml" ]]; then
        kubectl delete -f "$_ollama_yaml" 2>/dev/null || true
      else
        kubectl delete deployment,svc,pvc -l app=ollama -n caipe 2>/dev/null || true
      fi
      log "Ollama deleted"
    fi
  fi

  # AgentGateway
  if helm status agentgateway -n agentgateway-system &>/dev/null; then
    if ask_yn "Uninstall AgentGateway?" "y"; then
      # Remove MCP backends and routes first
      kubectl delete agentgatewaybackend,httproute -l app.kubernetes.io/managed-by=setup-caipe -n caipe 2>/dev/null || true
      kubectl delete gateway agentgateway-proxy -n agentgateway-system 2>/dev/null || true
      helm uninstall agentgateway -n agentgateway-system 2>/dev/null || true
      log "AgentGateway uninstalled"
    fi
  fi

  # AgentGateway CRDs are their own Helm release, separate from the main
  # agentgateway release. Gate them independently so they aren't orphaned when
  # the main release is gone.
  if helm status agentgateway-crds -n agentgateway-system &>/dev/null; then
    if ask_yn "Uninstall AgentGateway CRDs?" "y"; then
      helm uninstall agentgateway-crds -n agentgateway-system 2>/dev/null || true
      kubectl delete namespace agentgateway-system 2>/dev/null || true
      log "AgentGateway CRDs uninstalled"
    fi
  fi

  # The upstream Gateway API CRDs (*.gateway.networking.k8s.io) are applied via
  # raw kubectl manifests (see _install_agentgateway_crds), not Helm, so they
  # belong to no release and survive both uninstalls above unless the kind
  # cluster is deleted. They are cluster-scoped shared infra and may be used by
  # other workloads, so gate them independently and default to "n". Deleting the
  # CRDs cascade-deletes any remaining Gateway/HTTPRoute/etc. objects.
  if kubectl get crd -o name 2>/dev/null | grep -q '\.gateway\.networking\.k8s\.io$'; then
    if ask_yn "Uninstall Gateway API CRDs (*.gateway.networking.k8s.io)?" "n"; then
      kubectl get crd -o name 2>/dev/null | grep '\.gateway\.networking\.k8s\.io$' | xargs -r kubectl delete 2>/dev/null || true
      log "Gateway API CRDs uninstalled"
    fi
  fi

  # ingress-nginx is a cluster-scoped Helm release (see install_nginx_ingress).
  # Unless the kind cluster is deleted, it survives cleanup, so offer to remove
  # it here too (default with "n" as it may be shared with other workloads).
  if helm status ingress-nginx -n ingress-nginx &>/dev/null; then
    if ask_yn "Uninstall ingress-nginx Helm release?" "n"; then
      helm uninstall ingress-nginx -n ingress-nginx 2>/dev/null || true
      kubectl delete namespace ingress-nginx 2>/dev/null || true
      log "ingress-nginx uninstalled"
    fi
  fi

  # MetalLB is applied via kubectl manifests (see install_metallb), not Helm, so
  # it survives cleanup unless the kind cluster is deleted. Offer to remove it:
  # the namespace clears the controller/speaker/pools, then the cluster-scoped
  # CRDs. Default with "n", it's shared cluster infra.
  if kubectl get namespace metallb-system &>/dev/null; then
    if ask_yn "Uninstall MetalLB?" "n"; then
      kubectl delete namespace metallb-system 2>/dev/null || true
      kubectl get crd -o name 2>/dev/null | grep '\.metallb\.io$' | xargs -r kubectl delete 2>/dev/null || true
      log "MetalLB uninstalled"
    fi
  fi

  step "Kubernetes resources"

  local caipe_job_count
  caipe_job_count=$(kubectl get jobs -n caipe --no-headers 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$caipe_job_count" -gt 0 ]]; then
    if ask_yn "Delete all jobs in caipe namespace ($caipe_job_count jobs)?" "y"; then
      kubectl delete jobs --all -n caipe 2>/dev/null || true
      log "Jobs in caipe namespace deleted"
    fi
  fi

  if kubectl get secret llm-secret -n caipe &>/dev/null || kubectl get secret langfuse-secret -n caipe &>/dev/null; then
    if ask_yn "Delete all secrets in caipe namespace?" "y"; then
      # Exclude Helm release-tracking secrets (type helm.sh/release.v1). Wiping
      # them while a release is still installed (e.g. the caipe uninstall above
      # was declined) orphans the live workloads.
      kubectl delete secret --all -n caipe --field-selector 'type!=helm.sh/release.v1' 2>/dev/null || true
      log "Secrets in caipe namespace deleted"
    fi
  fi

  local caipe_pvc_count langfuse_pvc_count
  caipe_pvc_count=$(kubectl get pvc -n caipe --no-headers 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$caipe_pvc_count" -gt 0 ]]; then
    if ask_yn "Delete CAIPE persistent volume claims ($caipe_pvc_count PVCs)?" "y"; then
      # --timeout bounds the wait: a PVC still held by a running pod sits in
      # Terminating (pvc-protection finalizer). Without a timeout the default
      # --wait blocks forever and hangs the whole cleanup. Bound it, then warn.
      if ! kubectl delete pvc --all -n caipe --timeout=120s 2>/dev/null; then
        warn "Some CAIPE PVCs did not finalize within 120s (likely still held by a running pod) — they will remain in Terminating"
      else
        log "CAIPE PVCs deleted"
      fi
    fi
  fi

  langfuse_pvc_count=$(kubectl get pvc -n langfuse --no-headers 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$langfuse_pvc_count" -gt 0 ]]; then
    if ask_yn "Delete Langfuse persistent volume claims ($langfuse_pvc_count PVCs)?" "y"; then
      kubectl delete pvc --all -n langfuse 2>/dev/null || true
      log "Langfuse PVCs deleted"
    fi
  fi

  # Helm hook Jobs (e.g. openfga-init/migrate) set hook-delete-policy
  # before-hook-creation, so `helm uninstall` leaves their completed pods behind.
  # They keep the namespace non-empty and block the namespace deletion below.
  if [[ "$(kubectl get jobs -n caipe --no-headers 2>/dev/null | wc -l | tr -d ' ')" -gt 0 ]]; then
    kubectl delete jobs --all -n caipe 2>/dev/null || true
    log "Leftover Jobs in caipe namespace deleted"
  fi

  step "Namespaces"

  _delete_namespace_clean caipe
  _delete_namespace_clean langfuse

  if command -v kind &>/dev/null; then
    step "Kind cluster"

    local clusters
    clusters=$(kind get clusters 2>/dev/null || true)
    if [[ -n "$clusters" ]]; then
      if $AUTO_YES; then
        warn "Skipping Kind cluster deletion in --yes mode (use interactive cleanup)"
      else
        echo -e "  ${DIM}Running Kind clusters:${NC}"
        while IFS= read -r c; do
          echo -e "    - $c"
        done <<< "$clusters"
        echo ""
        if ask_yn "Delete a Kind cluster?" "n"; then
          prompt "Enter the cluster name to delete: "
          tty_read -r del_cluster
          if [[ -n "$del_cluster" ]] && echo "$clusters" | grep -q "^${del_cluster}$"; then
            kind delete cluster --name "$del_cluster" </dev/null
            log "Cluster '${del_cluster}' deleted"
          else
            err "Cluster '${del_cluster}' not found"
          fi
        fi
      fi
    else
      log "No Kind clusters found"
    fi
  fi

  if [[ -f "$CAIPE_CONFIG_FILE" ]]; then
    step "Saved configuration"
    if ask_yn "Delete saved config ($CAIPE_CONFIG_FILE)?" "y"; then
      rm -f "$CAIPE_CONFIG_FILE"
      log "Saved configuration deleted"
    fi
  fi

  echo ""
  log "Cleanup complete"
}

# ─── Status ──────────────────────────────────────────────────────────────────
cmd_status() {
  echo ""
  header "Cluster status"
  echo ""
  echo -e "  ${BOLD}CAIPE pods:${NC}"
  kubectl get pods -n caipe 2>/dev/null || warn "No pods in caipe namespace"
  echo ""
  echo -e "  ${BOLD}Langfuse pods:${NC}"
  kubectl get pods -n langfuse 2>/dev/null || warn "No pods in langfuse namespace"
  if kubectl get namespace agentgateway-system &>/dev/null 2>&1; then
    echo ""
    echo -e "  ${BOLD}AgentGateway pods:${NC}"
    kubectl get pods -n agentgateway-system 2>/dev/null || warn "No pods in agentgateway-system namespace"
  fi
  echo ""
  echo -e "  ${BOLD}Helm releases:${NC}"
  helm list -A 2>/dev/null
}

cmd_update_compose_release() {
  local env_file
  env_file=$(_compose_env_file)
  _update_compose_image_tag "$env_file"
}

cmd_docker_compose() {
  local env_file
  env_file=$(_compose_env_file)
  _ensure_compose_env_file "$env_file"
  _update_compose_image_tag "$env_file"

  if [[ "$(uname -s)" == "Darwin" && -x "/usr/local/bin/docker" && ! "$(command -v docker 2>/dev/null)" ]]; then
    export PATH="/usr/local/bin:$PATH"
  fi
  if ! command -v docker &>/dev/null; then
    warn "Docker is not installed — it is required for Docker Compose setup."
    local os; os="$(uname -s)"
    if [[ "$os" == "Linux" || "$os" == "Darwin" ]] && ask_yn "Install Docker now?" "y"; then
      step "Installing Docker"
      if [[ "$os" == "Linux" ]]; then
        _install_docker_linux
      else
        _install_docker_macos
      fi
    else
      err "Docker is required. Install it from https://docs.docker.com/engine/install/ and re-run."
      exit 1
    fi
  fi
  _check_docker_access

  COMPOSE_PROFILES="${COMPOSE_PROFILES:-$(_env_get "$env_file" COMPOSE_PROFILES)}"
  COMPOSE_PROFILES="${COMPOSE_PROFILES:-$COMPOSE_PROFILES_DEFAULT}"
  export COMPOSE_PROFILES

  step "Starting Docker Compose all-in-one stack from docker-compose.yaml"
  log "Env file: ${env_file}"
  log "Profiles: ${COMPOSE_PROFILES}"
  docker compose --env-file "$env_file" -f docker-compose.yaml up -d

  log "CAIPE UI: http://localhost:3000"
  log "Knowledge Bases ingest: http://localhost:3000/knowledge-bases/ingest"
}

choose_setup_target() {
  $NON_INTERACTIVE && return 0

  echo ""
  echo -e "  ${BOLD}How do you want to run CAIPE?${NC}"
  echo -e "    ${CYAN}1)${NC} Kind/Kubernetes ${DIM}(default; uses saved setup configuration when available)${NC}"
  echo -e "    ${CYAN}2)${NC} Docker Compose ${DIM}(uses docker-compose.yaml + .env)${NC}"
  echo ""
  prompt "Select runtime [1]: "

  local choice
  tty_read -r choice
  choice="${choice:-1}"
  choice="$(echo "$choice" | tr '[:upper:]' '[:lower:]')"

  case "$choice" in
    1|kind|kubernetes|k8s)
      return 0
      ;;
    2|compose|docker-compose|docker)
      cmd_docker_compose
      exit 0
      ;;
    *)
      warn "Unknown choice '${choice}', continuing with Kind/Kubernetes"
      return 0
      ;;
  esac
}

# ─── Auto-Detect Features ────────────────────────────────────────────────────
detect_deployed_features() {
  if helm status langfuse -n langfuse &>/dev/null; then
    ENABLE_TRACING=true
  fi
  if kubectl get svc rag-server -n caipe &>/dev/null 2>&1; then
    ENABLE_RAG=true
  fi
  if kubectl get pods -n caipe -l app.kubernetes.io/name=agent-ontology \
       --no-headers 2>/dev/null | grep -q Running; then
    ENABLE_GRAPH_RAG=true
  fi
  if helm status vllm -n caipe &>/dev/null; then
    ENABLE_VLLM=true
  fi
  if kubectl get deployment ollama -n caipe &>/dev/null 2>&1; then
    ENABLE_OLLAMA=true
  fi
  if helm status agentgateway -n agentgateway-system &>/dev/null; then
    ENABLE_AGENTGATEWAY=true
  fi
  if kubectl get deployment caipe-agentgateway -n caipe &>/dev/null 2>&1; then
    ENABLE_AGENTGATEWAY=true
    ENABLE_RBAC_RUNTIME=true
  fi
  if kubectl get deployment caipe-openfga -n caipe &>/dev/null 2>&1 \
       || kubectl get deployment caipe-keycloak -n caipe &>/dev/null 2>&1; then
    ENABLE_RBAC_RUNTIME=true
  fi
  # Detect chart version from Helm; ignore "unknown" (local chart installs)
  if [[ -z "$CAIPE_CHART_VERSION" ]]; then
    local _detected_version
    _detected_version=$(helm get metadata caipe -n caipe -o json 2>/dev/null \
      | jq -r '.version // empty' 2>/dev/null || true)
    if [[ -n "$_detected_version" && "$_detected_version" != "unknown" ]]; then
      CAIPE_CHART_VERSION="$_detected_version"
      log "Detected deployed chart version: ${CAIPE_CHART_VERSION}"
    fi
  fi

  # ── Read LLM provider + credentials from the existing llm-secret ──────────
  # This lets the upgrade path skip all credential prompts when secrets are
  # already in the cluster — the user only needs to change what differs.
  local _llm_secret_data
  _llm_secret_data=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
  if [[ -n "$_llm_secret_data" ]]; then
    _secret_val() { echo "$_llm_secret_data" | jq -r --arg k "$1" '.data[$k] // empty' 2>/dev/null | base64 -d 2>/dev/null || true; }

    local _detected_provider; _detected_provider=$(_secret_val LLM_PROVIDER)
    [[ -n "$_detected_provider" && -z "$LLM_PROVIDER" ]] && LLM_PROVIDER="$_detected_provider"

    case "${LLM_PROVIDER:-}" in
      anthropic-claude)
        [[ -z "${ANTHROPIC_API_KEY:-}" ]]   && ANTHROPIC_API_KEY=$(_secret_val ANTHROPIC_API_KEY)
        [[ -z "${ANTHROPIC_MODEL_NAME:-}" ]] && ANTHROPIC_MODEL_NAME=$(_secret_val ANTHROPIC_MODEL_NAME)
        ;;
      aws-bedrock)
        [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]     && AWS_ACCESS_KEY_ID=$(_secret_val AWS_ACCESS_KEY_ID)
        [[ -z "${AWS_SECRET_ACCESS_KEY:-}" ]] && AWS_SECRET_ACCESS_KEY=$(_secret_val AWS_SECRET_ACCESS_KEY)
        [[ -z "${AWS_REGION:-}" ]]            && AWS_REGION=$(_secret_val AWS_REGION)
        [[ -z "${AWS_BEDROCK_MODEL_ID:-}" ]]  && AWS_BEDROCK_MODEL_ID=$(_secret_val AWS_BEDROCK_MODEL_ID)
        [[ -z "${AWS_BEDROCK_PROVIDER:-}" ]]  && AWS_BEDROCK_PROVIDER=$(_secret_val AWS_BEDROCK_PROVIDER)
        ;;
      openai|*)
        [[ -z "${OPENAI_API_KEY:-}" ]]    && OPENAI_API_KEY=$(_secret_val OPENAI_API_KEY)
        [[ -z "${OPENAI_ENDPOINT:-}" ]]   && OPENAI_ENDPOINT=$(_secret_val OPENAI_ENDPOINT)
        [[ -z "${OPENAI_MODEL_NAME:-}" ]] && OPENAI_MODEL_NAME=$(_secret_val OPENAI_MODEL_NAME)
        ;;
    esac
    log "Loaded LLM config from existing llm-secret (provider: ${LLM_PROVIDER:-unknown})"
  fi

  # ── Read RAG embeddings provider/model + creds from the deployed release ───
  # The interactive wizard reads these in choose_features, but that block sits
  # after choose_features' `--non-interactive` early return — so an unattended
  # upgrade never saw it and silently reset RAG embeddings to the
  # EMBEDDINGS_PROVIDER default (openai), dropping the deployed provider's
  # config. Read them here (the upgrade path always runs detect_deployed_features
  # first) so the non-interactive flow reaches parity with the interactive one.
  if $ENABLE_RAG; then
    local _rag_vals
    _rag_vals=$(helm get values caipe -n caipe -o json 2>/dev/null || true)
    # Adopt the deployed provider/model unless the caller set them explicitly.
    if [[ -z "${_EMBEDDINGS_PROVIDER_EXPLICIT:-}" ]]; then
      local _dep _dem
      _dep=$(echo "$_rag_vals" | jq -r '."rag-stack"."rag-server".env.EMBEDDINGS_PROVIDER // empty' 2>/dev/null || true)
      _dem=$(echo "$_rag_vals" | jq -r '."rag-stack"."rag-server".env.EMBEDDINGS_MODEL // empty' 2>/dev/null || true)
      if [[ -n "$_dep" ]]; then
        EMBEDDINGS_PROVIDER="$_dep"
        [[ -n "$_dem" && -z "${_EMBEDDINGS_MODEL_EXPLICIT:-}" ]] && EMBEDDINGS_MODEL="$_dem"
        log "Detected RAG embeddings: ${EMBEDDINGS_PROVIDER}/${EMBEDDINGS_MODEL}"
      fi
    fi
    # Rescue the active provider's embeddings credentials from the existing
    # llm-secret (fills only unset vars, so explicit env creds always win). No
    # prompts here — this is the unattended path; choose_features still prompts
    # interactively when a credential is genuinely absent.
    local _emb_secret
    _emb_secret=$(kubectl get secret llm-secret -n caipe -o json 2>/dev/null || true)
    if [[ -n "$_emb_secret" ]]; then
      _emb_val() { echo "$_emb_secret" | jq -r --arg k "$1" '.data[$k] // empty' 2>/dev/null | base64 -d 2>/dev/null || true; }
      case "$EMBEDDINGS_PROVIDER" in
        openai)
          [[ -z "${OPENAI_API_KEY:-}" ]] && OPENAI_API_KEY=$(_emb_val OPENAI_API_KEY)
          ;;
        azure-openai)
          [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]     && AZURE_OPENAI_API_KEY=$(_emb_val AZURE_OPENAI_API_KEY)
          [[ -z "${AZURE_OPENAI_ENDPOINT:-}" ]]    && AZURE_OPENAI_ENDPOINT=$(_emb_val AZURE_OPENAI_ENDPOINT)
          [[ -z "${AZURE_OPENAI_API_VERSION:-}" ]] && AZURE_OPENAI_API_VERSION=$(_emb_val AZURE_OPENAI_API_VERSION)
          ;;
        litellm)
          # RAG talks to a LiteLLM-compatible endpoint (generic proxy or Voyage);
          # recover endpoint + key so we re-point at the same backend.
          [[ -z "${LITELLM_ENDPOINT:-}" ]] && LITELLM_ENDPOINT=$(_emb_val LITELLM_API_BASE)
          [[ -z "${LITELLM_API_KEY:-}" ]]  && LITELLM_API_KEY=$(_emb_val LITELLM_API_KEY)
          ;;
        cohere)
          [[ -z "${COHERE_API_KEY:-}" ]] && COHERE_API_KEY=$(_emb_val COHERE_API_KEY)
          ;;
        huggingface)
          [[ -z "${HUGGINGFACEHUB_API_TOKEN:-}" ]] && HUGGINGFACEHUB_API_TOKEN=$(_emb_val HUGGINGFACEHUB_API_TOKEN)
          ;;
        # aws-bedrock embeddings reuse the LLM-side AWS creds loaded above.
      esac
    fi
  fi

  # ── Read selected agents from Helm values ─────────────────────────────────
  if [[ ${#SELECTED_AGENTS[@]} -eq 0 ]]; then
    local _helm_agents
    _helm_agents=$(helm get values caipe -n caipe -o json 2>/dev/null \
      | jq -r '.tags // {} | to_entries[] | select(.key | startswith("agent-")) | select(.value==true) | .key | sub("^agent-"; "")' \
      2>/dev/null || true)
    if [[ -n "$_helm_agents" ]]; then
      while IFS= read -r _a; do
        [[ -n "$_a" ]] && SELECTED_AGENTS+=("$_a")
      done <<< "$_helm_agents"
      log "Detected enabled agents: ${SELECTED_AGENTS[*]}"
    fi
  fi

  # ── Re-populate HELM_AGENT_ARGS from detected agent selection ─────────────
  if [[ ${#SELECTED_AGENTS[@]} -gt 0 && ${#HELM_AGENT_ARGS[@]} -eq 0 ]]; then
    local -a _all_agents=(argocd aws backstage confluence github gitlab jira komodor netutils pagerduty slack splunk webex aigateway)
    for _a in "${_all_agents[@]}"; do
      local _on=false
      for _s in "${SELECTED_AGENTS[@]}"; do [[ "$_a" == "$_s" ]] && { _on=true; break; }; done
      if $_on; then
        HELM_AGENT_ARGS+=(--set "tags.mcp-${_a}=true")
        # Wire existing agent secret if present
        local _sec="caipe-${_a}-secret"
        if kubectl get secret "$_sec" -n caipe &>/dev/null 2>&1; then
          HELM_AGENT_ARGS+=(--set "mcp-${_a}.agentSecrets.secretName=${_sec}")
        fi
      else
        HELM_AGENT_ARGS+=(--set "tags.mcp-${_a}=false")
      fi
    done
  fi
}

# ─── Port-Forward (standalone) ────────────────────────────────────────────────
cmd_port_forward() {
  check_prerequisites

  if ! helm status caipe -n caipe &>/dev/null; then
    err "CAIPE is not deployed. Run setup first."
    exit 1
  fi

  detect_deployed_features
  monitor_port_forwards
}

# ─── Validate (standalone) ───────────────────────────────────────────────────
cmd_validate() {
  check_prerequisites

  if ! helm status caipe -n caipe &>/dev/null; then
    err "CAIPE is not deployed. Run setup first."
    exit 1
  fi

  detect_deployed_features

  step "Port-forwarding for validation"
  start_pf caipe-dynamic-agents caipe "$DYNAMIC_AGENTS_PORT" 8001 "Dynamic agents"
  start_pf caipe-caipe-ui          caipe "$UI_PORT"         3000 "CAIPE UI"
  if $ENABLE_TRACING; then
    start_pf langfuse-web langfuse "$LANGFUSE_PORT" 3000 "Langfuse UI"
  fi
  sleep 3

  run_validation
  run_sanity_tests
}

# ─── Ensure Healthy ──────────────────────────────────────────────────────────
# Convergence loop that runs auto-heal cycles until all pods are healthy
# or a timeout is reached. Runs BEFORE "Services Ready" so the user gets
# a functioning system.
ensure_healthy() {
  step "Ensuring all services are healthy"
  local timeout=180 interval=10 elapsed=0

  while [[ $elapsed -lt $timeout ]]; do
    # Exclude Terminating pods from counts to avoid inflated totals during rollouts
    local total ready
    total=$(kubectl get pods -n caipe --no-headers 2>/dev/null \
      | awk '$3!="Terminating"' | wc -l | tr -d ' ')
    ready=$(kubectl get pods -n caipe --no-headers 2>/dev/null \
      | awk '$3=="Running" && $2~"^[0-9]+/[0-9]+$" {split($2,a,"/"); if(a[1]==a[2]) print}' \
      | wc -l | tr -d ' ')

    local lf_ok=true
    if $ENABLE_TRACING; then
      local lf_total lf_ready
      lf_total=$(kubectl get pods -n langfuse --no-headers 2>/dev/null \
        | awk '$3!="Terminating"' | wc -l | tr -d ' ')
      lf_ready=$(kubectl get pods -n langfuse --no-headers 2>/dev/null \
        | awk '$3=="Running" && $2~"^[0-9]+/[0-9]+$" {split($2,a,"/"); if(a[1]==a[2]) print}' \
        | wc -l | tr -d ' ')
      [[ "$lf_total" -eq 0 || "$lf_total" -ne "$lf_ready" ]] && lf_ok=false
    fi

    if [[ "$total" -gt 0 && "$total" -eq "$ready" ]] && $lf_ok; then
      log "All pods healthy (caipe: ${ready}/${total})"
      return 0
    fi

    printf "\r${DIM}  Converging: caipe %d/%d ready  (%ds/${timeout}s)${NC}  " "$ready" "$total" "$elapsed"

    run_auto_heal

    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  echo ""
  warn "Not all pods converged within ${timeout}s; continuing anyway"
  run_auto_heal
}

# ─── Saved configuration ─────────────────────────────────────────────────────
CAIPE_CONFIG_FILE="${CAIPE_CONFIG_FILE:-${HOME}/.config/caipe/config.yaml}"

_cfg_get() {
  # Extract a scalar value from the saved YAML: _cfg_get <key>
  local key="$1"
  grep -m1 "^${key}:" "$CAIPE_CONFIG_FILE" 2>/dev/null \
    | sed 's/^[^:]*:[[:space:]]*//' | tr -d '"' | tr -d "'"
}

_save_caipe_config() {
  mkdir -p "$(dirname "$CAIPE_CONFIG_FILE")"
  cat > "$CAIPE_CONFIG_FILE" <<CFGYAML
# CAIPE setup configuration — saved by setup-caipe.sh
# Edit or delete this file to change defaults on the next run.
# API keys and passwords are NOT stored here.
cluster_context: "$(kubectl config current-context 2>/dev/null || echo '')"
chart_version: "${CAIPE_CHART_VERSION:-}"
llm_provider: "${LLM_PROVIDER:-}"
enable_ollama: "${ENABLE_OLLAMA:-false}"
ollama_model: "${OLLAMA_MODEL:-qwen3:0.6b}"
embeddings_provider: "${EMBEDDINGS_PROVIDER:-}"
embeddings_model: "${EMBEDDINGS_MODEL:-}"
enable_rag: "${ENABLE_RAG:-false}"
enable_graph_rag: "${ENABLE_GRAPH_RAG:-false}"
enable_tracing: "${ENABLE_TRACING:-false}"
enable_metallb: "${ENABLE_METALLB:-false}"
enable_ingress: "${ENABLE_INGRESS:-false}"
domain: "${CAIPE_DOMAIN:-}"
selected_agents: "${SELECTED_AGENTS[*]:-}"
CFGYAML
  log "Configuration saved to ${CAIPE_CONFIG_FILE}"
}

_load_caipe_config() {
  [[ -f "$CAIPE_CONFIG_FILE" ]] || return 0
  $NON_INTERACTIVE && return 0

  echo ""
  echo -e "  ${DIM}Saved configuration found: ${CAIPE_CONFIG_FILE}${NC}"
  echo ""

  local _ctx _chart _llm _ollama _omodel _eprov _emodel _rag _grag _tracing _metallb _ingress _domain _agents
  _ctx=$(_cfg_get cluster_context)
  _chart=$(_cfg_get chart_version)
  _llm=$(_cfg_get llm_provider)
  _ollama=$(_cfg_get enable_ollama)
  _omodel=$(_cfg_get ollama_model)
  _eprov=$(_cfg_get embeddings_provider)
  _emodel=$(_cfg_get embeddings_model)
  _rag=$(_cfg_get enable_rag)
  _grag=$(_cfg_get enable_graph_rag)
  _tracing=$(_cfg_get enable_tracing)
  _metallb=$(_cfg_get enable_metallb)
  _ingress=$(_cfg_get enable_ingress)
  _domain=$(_cfg_get domain)
  _agents=$(_cfg_get selected_agents)

  [[ -n "$_ctx" ]]        && echo -e "    ${DIM}cluster:         ${NC}${_ctx}"
  [[ -n "$_chart" ]]      && echo -e "    ${DIM}chart version:   ${NC}${_chart}"
  if [[ "$_ollama" == "true" ]]; then
    echo -e "    ${DIM}LLM:             ${NC}Ollama (${_omodel})"
  elif [[ -n "$_llm" ]]; then
    echo -e "    ${DIM}LLM:             ${NC}${_llm}"
  fi
  [[ -n "$_eprov" ]]      && echo -e "    ${DIM}embeddings:      ${NC}${_eprov} (${_emodel})"
  [[ -n "$_rag" ]]        && echo -e "    ${DIM}RAG:             ${NC}${_rag}  graph-RAG: ${_grag:-false}"
  [[ -n "$_tracing" ]]    && echo -e "    ${DIM}tracing:         ${NC}${_tracing}"
  [[ -n "$_metallb" ]]    && echo -e "    ${DIM}metallb:         ${NC}${_metallb}  ingress: ${_ingress:-false}"
  [[ -n "$_domain" ]]     && echo -e "    ${DIM}domain:          ${NC}${_domain}"
  [[ -n "$_agents" ]]     && echo -e "    ${DIM}agents:          ${NC}${_agents}"
  echo ""

  if ! ask_yn "Use saved configuration?" "y"; then
    return 0
  fi

  # Apply saved values — only set if not already overridden by CLI flags / env
  [[ -n "$_chart"      && -z "${CAIPE_CHART_VERSION:-}"   ]] && CAIPE_CHART_VERSION="$_chart"
  [[ -n "$_llm"        && -z "${LLM_PROVIDER:-}"          ]] && LLM_PROVIDER="$_llm"
  [[ "$_ollama" == "true" ]] && ENABLE_OLLAMA=true
  [[ -n "$_omodel"     && -z "${OLLAMA_MODEL:-}"          ]] && OLLAMA_MODEL="$_omodel"
  [[ -n "$_eprov"      && -z "${EMBEDDINGS_PROVIDER:-}"   ]] && EMBEDDINGS_PROVIDER="$_eprov"
  # Use _EMBEDDINGS_MODEL_EXPLICIT (set at startup from env) rather than a
  # zero-check: EMBEDDINGS_MODEL defaults to text-embedding-3-large so -z
  # always fails and the saved model is never restored.
  [[ -n "$_emodel"     && -z "${_EMBEDDINGS_MODEL_EXPLICIT:-}" ]] && EMBEDDINGS_MODEL="$_emodel"
  [[ "$_rag"      == "true" ]] && ENABLE_RAG=true
  [[ "$_grag"     == "true" ]] && ENABLE_GRAPH_RAG=true && ENABLE_RAG=true
  [[ "$_tracing"  == "true"  ]] && ENABLE_TRACING=true
  [[ "$_metallb"  == "true"  ]] && ENABLE_METALLB=true
  [[ "$_metallb"  == "false" ]] && ENABLE_METALLB=false
  # MetalLB is a prerequisite for ingress; restore ingress flag from config,
  # but always disable it when MetalLB is disabled (even if config says true).
  if [[ "$_metallb" == "false" ]]; then
    ENABLE_INGRESS=false
  elif [[ "$_ingress" == "true" ]]; then
    ENABLE_INGRESS=true
  elif [[ "$_ingress" == "false" ]]; then
    ENABLE_INGRESS=false
  fi
  [[ -n "$_domain"     && -z "${CAIPE_DOMAIN:-}"          ]] && CAIPE_DOMAIN="$_domain"
  if [[ -n "$_agents" && ${#SELECTED_AGENTS[@]} -eq 0 ]]; then
    read -ra SELECTED_AGENTS <<< "$_agents"
  fi

  # Switch to the saved context; for kind contexts, re-export if missing.
  # If context can't be restored, skip NON_INTERACTIVE so cluster wizard runs.
  local _ctx_ok=true
  if [[ -n "$_ctx" ]]; then
    local _cur_ctx
    _cur_ctx=$(kubectl config current-context 2>/dev/null || true)
    if [[ "$_cur_ctx" != "$_ctx" ]]; then
      if kubectl config use-context "$_ctx" 2>/dev/null; then
        log "Switched to saved context '${_ctx}'"
      elif [[ "$_ctx" == kind-* ]] && command -v kind &>/dev/null; then
        local _kind_name="${_ctx#kind-}"
        if kind get clusters 2>/dev/null | grep -qx "$_kind_name"; then
          kind export kubeconfig --name "$_kind_name" </dev/null 2>/dev/null || true
          if kubectl config use-context "$_ctx" 2>/dev/null; then
            log "Restored context '${_ctx}' via kind export kubeconfig"
          else
            warn "Saved context '${_ctx}' not found — you will be prompted to choose a cluster"
            _ctx_ok=false
          fi
        else
          warn "Kind cluster '${_kind_name}' not found — you will be prompted to choose a cluster"
          _ctx_ok=false
        fi
      else
        warn "Saved context '${_ctx}' not found — you will be prompted to choose a cluster"
        _ctx_ok=false
      fi
    fi
  fi

  if $_ctx_ok; then
    NON_INTERACTIVE=true
    log "Saved configuration loaded — skipping wizard"
  else
    # Signal cmd_setup to activate non-interactive mode once the cluster
    # selection wizard has run and the correct context is established.
    _SAVED_CONFIG_ACCEPTED=true
    log "Saved configuration loaded (wizard will run for cluster selection only)"
  fi
}
_SAVED_CONFIG_ACCEPTED=false

# ─── Main ────────────────────────────────────────────────────────────────────
cmd_setup() {
  echo ""
  echo -e "${CYAN}${BOLD}"
  cat <<'BANNER'
   ██████╗ █████╗ ██╗██████╗ ███████╗
  ██╔════╝██╔══██╗██║██╔══██╗██╔════╝
  ██║     ███████║██║██████╔╝█████╗
  ██║     ██╔══██║██║██╔═══╝ ██╔══╝
  ╚██████╗██║  ██║██║██║     ███████╗
   ╚═════╝╚═╝  ╚═╝╚═╝╚═╝     ╚══════╝
BANNER
  echo -e "${NC}"
  echo -e "${BLUE}${BOLD}╔═══════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}${BOLD}║${NC}  ${BOLD}Welcome to CAIPE Setup${NC}                       ${BLUE}${BOLD}║${NC}"
  echo -e "${BLUE}${BOLD}║${NC}  Your 🤖 Agentic AI automation super hero 🦸  ${BLUE}${BOLD}║${NC}"
  echo -e "${BLUE}${BOLD}║${NC}                                               ${BLUE}${BOLD}║${NC}"
  echo -e "${BLUE}${BOLD}║${NC}  ${DIM}Multi-Agent System on Kubernetes${NC}             ${BLUE}${BOLD}║${NC}"
  echo -e "${BLUE}${BOLD}║${NC}                                               ${BLUE}${BOLD}║${NC}"
  echo -e "${BLUE}${BOLD}║${NC}  ${DIM}github.com/caipe-io/ai-platform-engineering${NC}   ${BLUE}${BOLD}║${NC}"
  echo -e "${BLUE}${BOLD}║${NC}  ${DIM}Powered by cnoe-agent-utils LLMFactory${NC}       ${BLUE}${BOLD}║${NC}"
  echo -e "${BLUE}${BOLD}║${NC}  ${DIM}github.com/cnoe-io/cnoe-agent-utils${NC}          ${BLUE}${BOLD}║${NC}"
  echo -e "${BLUE}${BOLD}╚═══════════════════════════════════════════════╝${NC}"
  echo ""

  # On hosts where kubectl is a k3s symlink (/usr/local/bin/kubectl -> k3s),
  # the binary reads /etc/rancher/k3s/k3s.yaml by default when KUBECONFIG is
  # unset, while helm uses the standard Go client which reads ~/.kube/config.
  # Set KUBECONFIG here — before any kubectl call — so both tools always read
  # the same file and see the same cluster and contexts.
  export KUBECONFIG="${KUBECONFIG:-${HOME}/.kube/config}"

  choose_setup_target
  check_prerequisites
  _load_caipe_config
  choose_cluster

  # If saved config was loaded but context needed interactive cluster selection,
  # now that the cluster is set activate non-interactive for the remaining steps.
  $_SAVED_CONFIG_ACCEPTED && NON_INTERACTIVE=true

  # ── Fast re-run detection ──
  # If CAIPE is already deployed, offer the user a shortcut instead of
  # running the full setup flow again.
  if helm status caipe -n caipe &>/dev/null; then
    local deployed_version
    deployed_version=$(helm get metadata caipe -n caipe -o json 2>/dev/null \
      | jq -r '.version // empty' 2>/dev/null || echo "unknown")
    local running_pods
    running_pods=$(kubectl get pods -n caipe --no-headers 2>/dev/null \
      | awk '$3=="Running" && $2~"^[0-9]+/[0-9]+$" {split($2,a,"/"); if(a[1]==a[2]) c++} END{print c+0}')

    echo ""
    echo -e "  ${GREEN}${BOLD}CAIPE is already deployed${NC} (v${deployed_version}, ${running_pods} pods running)"
    echo ""

    local rerun_choice=""
    if $FORCE_UPGRADE; then
      rerun_choice=2
    elif $NON_INTERACTIVE; then
      # Non-interactive: monitor only unless flags imply an upgrade
      if [[ -n "${CAIPE_CHART_VERSION:-}" ]] || $ENABLE_RAG || $ENABLE_GRAPH_RAG \
           || $ENABLE_TRACING || $ENABLE_AGENTGATEWAY || $ENABLE_RBAC_RUNTIME \
           || $INJECT_CORPORATE_CA || [[ ${#INGEST_URLS[@]} -gt 0 ]]; then
        rerun_choice=2
      else
        rerun_choice=1
      fi
    else
      echo -e "    ${BOLD}1)${NC} Monitor only — port-forwarding + auto-heal (fastest)"
      echo -e "    ${BOLD}2)${NC} Upgrade — re-collect credentials, re-deploy charts"
      echo -e "    ${BOLD}3)${NC} Full re-install — run full setup from scratch"
      echo ""
      prompt "Select an option ${CYAN}[1]${NC}${BOLD}: "
      tty_read -r rerun_choice
      rerun_choice="${rerun_choice:-1}"
    fi

    case "$rerun_choice" in
      1)
        log "Skipping to monitor mode"
        detect_deployed_features
        ensure_healthy
        monitor_port_forwards
        return
        ;;
      2)
        log "Upgrading existing deployment"
        detect_deployed_features
        ;;
      3)
        log "Running full setup from scratch"
        ;;
      *)
        err "Invalid choice"; exit 1
        ;;
    esac
  fi

  # Pre-load LLM_PROVIDER and credential env vars from --env-file so that
  # collect_credentials picks the right provider without requiring the caller
  # to also export them as shell environment variables.
  if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
    local _llm_vars=(LLM_PROVIDER
      ANTHROPIC_API_KEY ANTHROPIC_MODEL_NAME
      AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION AWS_DEFAULT_REGION
      AWS_BEDROCK_MODEL_ID AWS_BEDROCK_PROVIDER AWS_BEDROCK_ENABLE_PROMPT_CACHE
      BEDROCK_TEMPERATURE
      AZURE_OPENAI_API_KEY AZURE_OPENAI_ENDPOINT AZURE_OPENAI_API_VERSION
      AZURE_OPENAI_DEPLOYMENT OPENAI_API_KEY OPENAI_API_BASE
      EMBEDDINGS_PROVIDER EMBEDDINGS_MODEL EMBEDDINGS_DEVICE
      COHERE_API_KEY VOYAGE_API_KEY HUGGINGFACEHUB_API_TOKEN HF_TOKEN
      LITELLM_ENDPOINT LITELLM_API_KEY)
    for _v in "${_llm_vars[@]}"; do
      local _val
      _val=$(_env_get "$ENV_FILE" "$_v")
      [[ -n "$_val" && -z "${!_v:-}" ]] && export "$_v=$_val"
    done

    # Honor feature toggles from --env-file so a single .env reproduces the same
    # stack as docker-compose.dev.yaml (rag, tracing, graph-rag, slack-bot,
    # webex-bot). Enable-only semantics: an env-file value of "true" turns a
    # feature ON; a "false"/unset value never disables something already turned
    # on via a CLI flag (e.g. --rag, --tracing). Explicit --slack-bot /
    # --no-slack-bot (and webex) always win over the env-file value.
    if _env_true "$(_env_get "$ENV_FILE" ENABLE_RAG)"; then ENABLE_RAG=true; fi
    if _env_true "$(_env_get "$ENV_FILE" ENABLE_GRAPH_RAG)"; then ENABLE_GRAPH_RAG=true; ENABLE_RAG=true; fi
    if _env_true "$(_env_get "$ENV_FILE" ENABLE_TRACING)"; then ENABLE_TRACING=true; fi
    # The slack/webex MCP agents (ENABLE_SLACK/ENABLE_WEBEX) and the chat-bot
    # surfaces share the same .env. docker-compose.dev.yaml runs the bot
    # surfaces via the slack-bot/webex-bot profiles, so treat ENABLE_SLACK_BOT/
    # ENABLE_WEBEX_BOT (preferred) — or ENABLE_SLACK/ENABLE_WEBEX as a fallback —
    # as the trigger to deploy the surface here.
    if [[ -z "$_SLACK_BOT_FORCED" ]] \
       && { _env_true "$(_env_get "$ENV_FILE" ENABLE_SLACK_BOT)" \
            || _env_true "$(_env_get "$ENV_FILE" ENABLE_SLACK)"; }; then
      ENABLE_SLACK_BOT=true
    fi
    if [[ -z "$_WEBEX_BOT_FORCED" ]] \
       && { _env_true "$(_env_get "$ENV_FILE" ENABLE_WEBEX_BOT)" \
            || _env_true "$(_env_get "$ENV_FILE" ENABLE_WEBEX)"; }; then
      ENABLE_WEBEX_BOT=true
    fi
  fi

  # ── Wizard step loop — each step can return 1 to go back ─────────────
  # The || _rc=$? shield is required: set -e would otherwise kill the script
  # the moment any step function returns non-zero (e.g. user typed 'b').
  local _wizard_steps=(choose_chart_version collect_credentials choose_features)
  local _step=0
  while [[ $_step -lt ${#_wizard_steps[@]} ]]; do
    local _rc=0
    "${_wizard_steps[$_step]}" || _rc=$?
    case $_rc in
      0) _step=$((_step + 1)) ;;
      1) [[ $_step -gt 0 ]] && _step=$((_step - 1)) || _step=0 ;;
      *) exit 1 ;;
    esac
  done

  # Persist the wizard choices for the next run (no secrets stored).
  _save_caipe_config

  # Resolve unified LiteLLM mode before secrets/helm so the agent llm-secret and
  # RAG embeddings config are repointed at the proxy (must run after
  # collect_credentials, before create_namespace_and_secrets/provision_secrets).
  _finalize_litellm_mode

  create_namespace_and_secrets

  # Shared Postgres must exist before the CAIPE Helm deploy: OpenFGA's migrate
  # job + deployment read the caipe-openfga-db Secret, and _write_rbac_runtime_values
  # wires Keycloak's KC_DB_* env from the passwords resolved here.
  if _shared_postgres_active; then
    deploy_shared_postgres
  fi

  if $ENABLE_TRACING; then
    deploy_langfuse
    create_langfuse_api_keys
  fi

  if $INJECT_CORPORATE_CA; then
    prepare_corporate_ca
  fi

  # Deploy vLLM + LiteLLM before CAIPE so the endpoints are available.
  # Unified --litellm mode (no vLLM) deploys just the proxy after the shared
  # Postgres so the optional caipe-litellm-db secret exists when --litellm-db.
  if $ENABLE_VLLM; then
    deploy_vllm
    deploy_litellm
  elif $LLM_VIA_LITELLM; then
    deploy_litellm
  fi

  if $ENABLE_OLLAMA; then
    # The caipe namespace is already created by create_namespace_and_secrets,
    # and llm-secret (referenced by the Ollama pod) is provisioned there too.
    # Ollama must be fully ready before deploy_caipe so agents never start
    # against a missing LLM endpoint. The init container pulls the model
    # (potentially several GB), so allow up to 10 minutes on first run.
    step "Deploying in-cluster Ollama"
    local _ollama_yaml="${SCRIPT_DIR}/deploy/kind/ollama.yaml"
    if [[ ! -f "$_ollama_yaml" ]]; then
      err "deploy/kind/ollama.yaml not found at ${_ollama_yaml}."
      err "When running via 'curl | bash', clone the repo and run setup-caipe.sh directly:"
      err "  git clone https://github.com/caipe-io/ai-platform-engineering && cd ai-platform-engineering && bash setup-caipe.sh"
      exit 1
    fi
    kubectl apply -f "$_ollama_yaml" 2>&1 \
      | grep -v "^$" | while IFS= read -r line; do log "$line"; done
    log "Waiting for Ollama to be ready (model pull may take several minutes on first run)..."
    kubectl rollout status deployment/ollama -n caipe --timeout=10m 2>&1 \
      | while IFS= read -r line; do log "$line"; done

    # On re-runs that add RAG with Ollama embeddings, the Deployment spec is
    # unchanged so no new pod is created and the init container never re-runs.
    # Pull the embedding model directly on the running pod instead (idempotent —
    # Ollama skips models that are already cached).
    if $ENABLE_RAG && [[ "${EMBEDDINGS_PROVIDER:-}" == "ollama" && -n "${EMBEDDINGS_MODEL:-}" ]]; then
      log "Pulling Ollama embedding model '${EMBEDDINGS_MODEL}' on running pod (skips if already cached)..."
      kubectl exec deploy/ollama -n caipe -- ollama pull "${EMBEDDINGS_MODEL}" 2>&1 \
        | while IFS= read -r line; do log "$line"; done \
        || warn "Ollama embedding model pull failed — RAG may not work until '${EMBEDDINGS_MODEL}' is available"
    fi
  fi

  # MetalLB and nginx-ingress must be ready before CAIPE Helm deploy
  # so the ingress class exists when Helm creates the Ingress resource.
  if $ENABLE_METALLB; then
    install_metallb
  fi
  if $ENABLE_INGRESS; then
    install_nginx_ingress
    setup_tls
  fi

  # Deploy MongoDB before CAIPE so caipe-dynamic-agents (and the slack-bot /
  # webex-bot surfaces) can resolve the hostname on first start (avoiding
  # crash-loop during the pod readiness wait) and so MONGODB_ROOT_PASSWORD is
  # resolved before _write_bot_values builds the bot MONGODB_URI.
  _ensure_dynamic_agents_mongodb

  # When the RBAC runtime is enabled, the CAIPE chart itself renders the
  # AgentGateway proxy (Gateway, HTTPRoute, AgentgatewayBackend,
  # AgentgatewayPolicy). Helm validates those against installed CRDs at render
  # time, so the CRDs must exist BEFORE deploy_caipe. (The legacy non-RBAC
  # AgentGateway path installs them later inside deploy_agentgateway.)
  if $ENABLE_RBAC_RUNTIME; then
    step "Installing AgentGateway + Gateway API CRDs"
    _install_agentgateway_crds
  fi

  deploy_caipe
  post_deploy_patches

  # The legacy AgentGateway controller path runs after CAIPE so MCP services exist
  # for auto-discovery. The RBAC runtime path installs the standalone proxy as
  # part of the CAIPE Helm release.
  if $ENABLE_AGENTGATEWAY && ! $ENABLE_RBAC_RUNTIME; then
    deploy_agentgateway
  fi

  if [[ ${#INGEST_URLS[@]} -gt 0 ]]; then
    ingest_knowledge_base
  fi

  ensure_healthy
  monitor_port_forwards
}

# Re-print the default local Keycloak logins from the persisted Secrets. Lets an
# operator recover credentials any time after install without re-running setup or
# scrolling back through the install log (caipe-local-admin / caipe-local-user).
cmd_creds() {
  local ns="caipe"
  local domain admin_email admin_pw user_email user_pw
  domain=$(kubectl get ingress -n "$ns" -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || true)
  admin_email=$(kubectl get secret caipe-local-admin -n "$ns" -o jsonpath='{.data.email}' 2>/dev/null | base64 -d 2>/dev/null || true)
  admin_pw=$(kubectl get secret caipe-local-admin -n "$ns" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
  user_email=$(kubectl get secret caipe-local-user -n "$ns" -o jsonpath='{.data.email}' 2>/dev/null | base64 -d 2>/dev/null || true)
  user_pw=$(kubectl get secret caipe-local-user -n "$ns" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)

  if [[ -z "$admin_email" && -z "$user_email" ]]; then
    warn "No local login secrets found (caipe-local-admin / caipe-local-user) in namespace ${ns}."
    echo -e "  ${DIM}These are created by a default local-SSO install (RBAC + in-chart Keycloak, no upstream IdP).${NC}"
    echo -e "  ${DIM}If you signed in with an upstream IdP (Cisco SSO / GitHub social), use that login instead.${NC}"
    return 0
  fi

  header "CAIPE local logins (in-chart Keycloak)"
  [[ -n "$domain" ]] && echo -e "    URL                ${CYAN}https://${domain}${NC}" && echo ""
  if [[ -n "$admin_email" ]]; then
    echo -e "    ${BOLD}Admin${NC} (org-admin / admin UI)"
    echo -e "      Email            ${BOLD}${admin_email}${NC}"
    echo -e "      Password         ${BOLD}${admin_pw}${NC}"
  fi
  if [[ -n "$user_email" ]]; then
    echo ""
    echo -e "    ${BOLD}Standard${NC} (non-admin / chat only, no admin UI)"
    echo -e "      Email            ${BOLD}${user_email}${NC}"
    echo -e "      Password         ${BOLD}${user_pw}${NC}"
  fi
  echo ""
  echo -e "  ${DIM}Source: caipe-local-admin / caipe-local-user Secrets (namespace ${ns}).${NC}"
}

usage() {
  cat <<EOF

Usage: $(basename "$0") [COMMAND] [OPTIONS]

Commands:
  setup         Interactive setup: cluster, chart version, credentials,
                features (RAG, tracing), deploy to Kind/Kubernetes,
                port-forward (default)
  port-forward  Start port-forwarding, run validation + sanity tests,
                monitor with auto-restart and periodic health checks (5m)
  validate      Run validation and sanity tests (dynamic agents, agents, RAG, tracing)
  creds         Re-print the default local Keycloak logins (admin + standard
                user) from the persisted Secrets — run any time after install
  cleanup       Interactive teardown: uninstall releases, delete secrets,
                PVCs, namespaces, and optionally the Kind cluster
  nuke          Non-interactive cleanup (same as: cleanup --yes)
  status        Show pod status and Helm releases
  docker-compose
                Prepare .env, update IMAGE_TAG to the latest GitHub release,
                and start the OSS all-in-one Docker Compose stack from
                docker-compose.yaml
  update-compose-release
                Update IMAGE_TAG in .env (or --env-file=FILE) to the latest
                GitHub release using gh

Options:
  --non-interactive  Skip all prompts (use current context, latest chart,
                     defaults for endpoint/model, no RAG/tracing unless flagged)
  --docker-compose   Run the Docker Compose setup path instead of the default
                     Kind/Kubernetes setup path
  --load-config=FILE Load wizard config from FILE instead of the default
                     ~/.config/caipe/config.yaml (shows summary, asks confirmation)
  --create-cluster   Create a Kind cluster if no kubectl context exists
                     (default name: caipe, override with KIND_CLUSTER_NAME)
  --rag              Enable RAG stack (vector-only by default)
  --graph-rag        Enable Graph RAG (Neo4j + ontology agent; implies --rag)
  --corporate-ca     Apply corporate TLS proxy CA patch to pods (for networks
                     with TLS inspection, e.g. Cisco Secure Access, Zscaler)
  --tracing          Enable Langfuse tracing (with --non-interactive, or pre-selects in interactive)
  --agentgateway     Deploy AgentGateway to federate MCP servers behind a single endpoint — default ON
                     (allows Cursor/VS Code/Claude Code to connect to all MCP servers at once)
  --no-agentgateway  Skip AgentGateway (also disables --rbac-runtime, which depends on it)
  --rbac-runtime     Install in-chart RBAC runtime services: Keycloak, OpenFGA,
                     OpenFGA ext_authz bridge, and standalone AgentGateway — default ON
  --no-rbac-runtime  Skip the RBAC runtime services
  --shared-postgres     Deploy one shared Postgres backing Keycloak + OpenFGA (persistent RBAC) — default ON
  --no-shared-postgres  Use Keycloak embedded H2 + OpenFGA in-memory (ephemeral; state lost on restart)
  --litellm             Route chat (+ OpenAI/Azure embeddings) through an in-cluster LiteLLM proxy.
                        Agents talk to one OpenAI-compatible endpoint; upstream provider creds live
                        only in the proxy. Supports anthropic/openai/aws-bedrock/azure-openai. Default OFF.
  --litellm-db          Like --litellm, plus persist LiteLLM virtual keys/spend in the shared Postgres
  --persistence      Accepted for compatibility; dynamic-agent persistence uses MongoDB
  --no-persistence   Accepted for compatibility; dynamic-agent persistence uses MongoDB
  --slack-bot        Deploy the Slack bot surface (slack-bot subchart). Auto-enabled when
                     --env-file sets ENABLE_SLACK_BOT/ENABLE_SLACK; needs SLACK_BOT_TOKEN etc.
  --no-slack-bot     Skip the Slack bot surface (overrides the env-file value)
  --webex-bot        Deploy the Webex bot surface (webex-bot subchart). Auto-enabled when
                     --env-file sets ENABLE_WEBEX_BOT/ENABLE_WEBEX; needs WEBEX_INTEGRATION_BOT_ACCESS_TOKEN
  --no-webex-bot     Skip the Webex bot surface (overrides the env-file value)
  --metallb          Install MetalLB to give LoadBalancer services real IPs in kind clusters — default ON
  --no-metallb       Skip MetalLB (also disables --ingress, which depends on it)
  --ingress          Install nginx-ingress + MetalLB and expose UI via domain — default ON
                     If --domain is omitted, falls back to ${CAIPE_DOMAIN_DEFAULT} (resolves to 127.0.0.1 via *.local.me)
  --no-ingress       Skip nginx-ingress
  --domain=HOST      Hostname for the UI ingress (e.g. my-caipe.example.com)
                     Default when ingress is enabled and --domain is omitted: ${CAIPE_DOMAIN_DEFAULT}
  --tls-cert=FILE    Path to TLS certificate PEM file (default: auto-generate self-signed)
  --tls-key=FILE     Path to TLS private key PEM file (paired with --tls-cert)
  --github-social    Enable GitHub social login (Keycloak broker) for public users.
                     Needs a dedicated GitHub OAuth App; callback URL must be
                     https://<domain>/realms/caipe/broker/github/endpoint
                     (interactive runs prompt for this; do NOT reuse GITHUB_CLIENT_*).
  --no-github-social Skip GitHub social login (local Keycloak login only)
  --github-social-id=ID         GitHub OAuth App client ID (login broker)
  --github-social-secret=SECRET GitHub OAuth App client secret (login broker)
  --local-admin[=EMAIL]         Create a local Keycloak admin login (default ON for
                     in-chart Keycloak with a DNS domain and no upstream IdP) so RBAC/auth
                     work with zero external SSO. EMAIL defaults to admin@caipe.local.
  --no-local-admin   Skip the local admin user (use only with an upstream IdP / GitHub social)
  --local-admin-password=PW     Set the local admin password (default: generated, persisted
                     in the caipe-local-admin Secret)
  --local-user[=EMAIL]          Also create a non-admin local user (default ON alongside the
                     local admin) so both RBAC paths can be tested — a standard chat user that
                     is NOT in BOOTSTRAP_ADMIN_EMAILS (no admin UI). EMAIL defaults to user@caipe.local.
  --no-local-user    Skip the non-admin local user (provision the admin only)
  --local-user-password=PW      Set the non-admin user password (default: generated, persisted
                     in the caipe-local-user Secret)
  --env-file=FILE    Path to .env file with agent credentials (ENABLE_ARGOCD=true, ARGOCD_TOKEN=..., etc.)
                     Creates per-agent k8s secrets and enables corresponding agents in Helm.
                     For docker-compose/update-compose-release, selects the
                     Compose env file to update/use (default: .env).
  --compose-env-file=FILE
                     Alias for selecting the Docker Compose env file without
                     affecting Helm agent-secret provisioning.
                     Also honors feature toggles to mirror docker-compose.dev.yaml:
                     ENABLE_RAG, ENABLE_GRAPH_RAG, ENABLE_TRACING, ENABLE_SLACK(_BOT),
                     ENABLE_WEBEX(_BOT) (enable-only; CLI flags win). Supported agents:
                     argocd github gitlab jira confluence backstage slack pagerduty webex
                     komodor aws splunk. Values are never written to disk or logged.
  --ui-env-file=FILE Path to UI .env.local file (OIDC, MongoDB, NextAuth secrets).
                     Creates caipe-ui-secret and wires it into the caipe-ui chart.
  --ingest-url=URL   Ingest a URL into the RAG knowledge base after deploy
                     (implies --rag; repeatable for multiple URLs; uses sitemap crawl)
  --auto-heal        Enable auto-heal loop (default: on). Detects and fixes crashing pods,
                     broken PVCs, missing secrets, RAG misconfig (every 30s)
  --upgrade          Skip to upgrade path when CAIPE is already deployed
                     (re-collect credentials + re-deploy; skips interactive menu)
  --no-auto-heal     Disable the auto-heal loop
  --yes, -y          Auto-confirm cleanup prompts (requires typing 'yes')
  -h, --help         Show this help message

Re-run behavior:
  When CAIPE is already deployed, setup detects it and offers:
    1) Monitor only — port-forwarding + auto-heal (fastest, default)
    2) Upgrade — re-collect credentials, re-deploy charts
    3) Full re-install — run full setup from scratch
  Use --upgrade to auto-select option 2 without the interactive menu.

Environment variables (all optional):
  LLM_PROVIDER            LLM provider: anthropic-claude (default) | aws-bedrock | openai
  OPENAI_API_KEY          Pre-set OpenAI API key (skips prompt)
  OPENAI_MODEL_NAME       OpenAI model (default: gpt-5.2; used by LLMFactory)
  ANTHROPIC_API_KEY       Pre-set Anthropic API key (skips prompt)
  ANTHROPIC_MODEL_NAME    Anthropic model (default: claude-haiku-4-5)
  AWS_ACCESS_KEY_ID       AWS access key for Bedrock
  AWS_SECRET_ACCESS_KEY   AWS secret key for Bedrock
  AWS_PROFILE             AWS profile name (keys resolved from ~/.aws/credentials)
  AWS_REGION              AWS region (default: us-east-2)
  AWS_BEDROCK_MODEL_ID    Bedrock model (default: global.anthropic.claude-haiku-4-5-20251001-v1:0)
  CAIPE_CHART_VERSION     Pre-set chart version (skips version picker)
  EMBEDDINGS_MODEL        Embedding model (default: text-embedding-3-large)
  EMBEDDINGS_PROVIDER     Embedding provider (default: openai)
                          Supported: openai, azure-openai, aws-bedrock, cohere,
                                     huggingface, ollama, litellm
                          Note: Anthropic does NOT ship a native embeddings model;
                          their official recommendation is Voyage AI (use the
                          interactive menu's "Voyage AI" option which routes via
                          the litellm-compatible code path, or set
                          EMBEDDINGS_PROVIDER=litellm + VOYAGE_API_KEY directly).
                          See https://platform.claude.com/docs/en/build-with-claude/embeddings
  COHERE_API_KEY          Cohere API key (for EMBEDDINGS_PROVIDER=cohere)
  VOYAGE_API_KEY          Voyage AI API key (Anthropic-recommended embeddings)
  HUGGINGFACEHUB_API_TOKEN HuggingFace API token (only needed for gated models)
  EMBEDDINGS_DEVICE       HuggingFace device: cpu (default) | cuda | mps
  ENABLE_VLLM             Deploy vLLM + LiteLLM in-cluster (default: false, or select option 4)
  HF_TOKEN                HuggingFace token (for vLLM model download)
  VLLM_MODEL              vLLM model (default: openai/gpt-oss-20b)
  VLLM_GPU_COUNT          GPUs per vLLM replica (default: 1)
  ENABLE_AGENTGATEWAY     Enable AgentGateway (default: true; --no-agentgateway to skip)
  ENABLE_RBAC_RUNTIME     Enable in-chart RBAC runtime services — Keycloak, OpenFGA,
                          OpenFGA ext_authz bridge, AgentGateway (default: true;
                          --no-rbac-runtime to skip)
  ENABLE_SLACK_BOT        Deploy the Slack bot surface (default: false; --slack-bot,
                          or set ENABLE_SLACK in --env-file)
  ENABLE_WEBEX_BOT        Deploy the Webex bot surface (default: false; --webex-bot,
                          or set ENABLE_WEBEX in --env-file)
  AGENTGATEWAY_VERSION    AgentGateway Helm chart version (default: v2.2.1)

LLM provider credentials are read from (in order):
  OpenAI:    1) OPENAI_API_KEY env       2) ~/.config/openai.txt    3) prompt
  Anthropic: 1) ANTHROPIC_API_KEY env    2) ~/.config/claude.txt    3) prompt
  Bedrock:   1) AWS_ACCESS_KEY_ID env    2) ~/.config/bedrock.txt
             3) AWS_PROFILE env          4) ~/.aws/credentials [default]
             5) prompt

Embeddings provider credentials are read from (in order):
  OpenAI:    1) OPENAI_API_KEY env       2) ~/.config/openai.txt    3) prompt
  Cohere:    1) COHERE_API_KEY env       2) ~/.config/cohere.txt    3) prompt
  Voyage:    1) VOYAGE_API_KEY env       2) ~/.config/voyage.txt    3) prompt
  HF:        1) HUGGINGFACEHUB_API_TOKEN env or HF_TOKEN env        3) prompt (optional)
                2) ~/.config/huggingface.txt
  Bedrock:   Same as LLM Bedrock credentials (reused if both = aws-bedrock)
  Azure:     1) AZURE_OPENAI_API_KEY env + AZURE_OPENAI_ENDPOINT env  2) prompt

  ~/.config/bedrock.txt formats:
    .env style (KEY=VALUE per line, recommended):
      AWS_ACCESS_KEY_ID=AKIA...
      AWS_SECRET_ACCESS_KEY=...
      AWS_REGION=us-east-2
      AWS_BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0
    key-pair (single line):   ACCESS_KEY_ID:SECRET_ACCESS_KEY
    profile name (single line): my-profile-name

Supported providers (via cnoe-agent-utils LLMFactory):
  openai, anthropic-claude, azure-openai, aws-bedrock,
  google-gemini, gcp-vertexai, groq

Examples:
  $(basename "$0")                                        # interactive setup (default)
  $(basename "$0") --docker-compose                       # update .env IMAGE_TAG + start Docker Compose
  $(basename "$0") --non-interactive --create-cluster     # create Kind cluster + deploy Claude (default)
  $(basename "$0") --non-interactive --rag --tracing      # Claude + vector RAG + tracing
  $(basename "$0") --non-interactive --graph-rag --tracing # Claude + Graph RAG + tracing
  $(basename "$0") --corporate-ca --rag                   # RAG behind corporate TLS proxy
  $(basename "$0") --rag --tracing                        # full stack (auto-heal on by default)
  $(basename "$0") --non-interactive --rag --ingest-url=https://caipe.io/  # RAG + ingest CAIPE docs
  $(basename "$0") --upgrade                              # re-run: upgrade existing deployment
  $(basename "$0") --upgrade --non-interactive             # unattended upgrade (no prompts)
  $(basename "$0")                                        # re-run: offers monitor/upgrade/full menu
  $(basename "$0") cleanup                                # interactive teardown
  $(basename "$0") nuke                                   # teardown (confirm once with 'yes')
  $(basename "$0") docker-compose                         # update .env IMAGE_TAG + start Docker Compose
  $(basename "$0") update-compose-release                 # only update IMAGE_TAG in .env
  LLM_PROVIDER=openai $(basename "$0") --non-interactive  # OpenAI instead of Claude
  LLM_PROVIDER=aws-bedrock $(basename "$0") --non-interactive       # AWS Bedrock (uses profile)
  ENABLE_VLLM=true $(basename "$0") --non-interactive                    # vLLM + LiteLLM (gpt-oss-20B in-cluster)
  $(basename "$0") --non-interactive --agentgateway                     # deploy with AgentGateway for MCP access
  $(basename "$0") --non-interactive --rbac-runtime                     # deploy Keycloak + OpenFGA + bridge + AgentGateway
  $(basename "$0") --non-interactive --agentgateway --rag               # full stack with AgentGateway + RAG
  $(basename "$0") --non-interactive --persistence                      # accepted compatibility flag
  $(basename "$0") --non-interactive --rag --persistence                # RAG + compatibility flag
  $(basename "$0") --non-interactive --create-cluster --ingress --domain=my-caipe.example.com                   # kind + MetalLB + ingress + self-signed TLS
  $(basename "$0") --non-interactive --create-cluster --ingress --domain=my-caipe.example.com \
    --tls-cert=/path/to/cert.pem --tls-key=/path/to/key.pem            # kind + MetalLB + ingress + custom TLS
  $(basename "$0") --non-interactive --create-cluster --ingress --rbac-runtime \
    --domain=my-caipe.example.com                                      # INTEGRATION TEST: full RBAC stack, zero Cisco/SSO config,
                                                                        # in-chart Keycloak + auto local admin login (creds printed at end)

EOF
  exit 0
}

# Parse flags from any position
args=()
for arg in "$@"; do
  case "$arg" in
    --yes|-y)          AUTO_YES=true ;;
    --docker-compose)  USE_DOCKER_COMPOSE=true ;;
    --non-interactive) NON_INTERACTIVE=true ;;
    --create-cluster)  CREATE_CLUSTER=true ;;
    --rag)             ENABLE_RAG=true ;;
    --graph-rag)       ENABLE_GRAPH_RAG=true ;;
    --corporate-ca)    INJECT_CORPORATE_CA=true ;;
    --tracing)         ENABLE_TRACING=true ;;
    --agentgateway)    ENABLE_AGENTGATEWAY=true ;;
    --no-agentgateway) ENABLE_AGENTGATEWAY=false; ENABLE_RBAC_RUNTIME=false ;;
    --rbac-runtime)    ENABLE_RBAC_RUNTIME=true; ENABLE_AGENTGATEWAY=true ;;
    --no-rbac-runtime) ENABLE_RBAC_RUNTIME=false ;;
    --shared-postgres)    ENABLE_SHARED_POSTGRES=true ;;
    --no-shared-postgres) ENABLE_SHARED_POSTGRES=false ;;
    --litellm)            LLM_VIA_LITELLM=true ;;
    --no-litellm)         LLM_VIA_LITELLM=false ;;
    --litellm-db)         LLM_VIA_LITELLM=true; ENABLE_LITELLM_DB=true ;;
    --persistence)     ENABLE_PERSISTENCE=true ;;
    --no-persistence)  ENABLE_PERSISTENCE=false ;;
    --metallb)         ENABLE_METALLB=true ;;
    --no-metallb)      ENABLE_METALLB=false; ENABLE_INGRESS=false ;;
    --ingress)         ENABLE_INGRESS=true; ENABLE_METALLB=true ;;
    --no-ingress)      ENABLE_INGRESS=false ;;
    --domain=*)        CAIPE_DOMAIN="${arg#--domain=}" ;;
    --github-social)            ENABLE_GITHUB_SOCIAL=true ;;
    --no-github-social)         ENABLE_GITHUB_SOCIAL=false ;;
    --github-social-id=*)       GITHUB_SOCIAL_CLIENT_ID="${arg#--github-social-id=}" ;;
    --github-social-secret=*)   GITHUB_SOCIAL_CLIENT_SECRET="${arg#--github-social-secret=}" ;;
    --local-admin)              ENABLE_LOCAL_ADMIN=true ;;
    --local-admin=*)            ENABLE_LOCAL_ADMIN=true; LOCAL_ADMIN_EMAIL="${arg#--local-admin=}" ;;
    --no-local-admin)           ENABLE_LOCAL_ADMIN=false ;;
    --local-admin-password=*)   LOCAL_ADMIN_PASSWORD="${arg#--local-admin-password=}" ;;
    --local-user)               ENABLE_LOCAL_USER=true ;;
    --local-user=*)             ENABLE_LOCAL_USER=true; LOCAL_USER_EMAIL="${arg#--local-user=}" ;;
    --no-local-user)            ENABLE_LOCAL_USER=false ;;
    --local-user-password=*)    LOCAL_USER_PASSWORD="${arg#--local-user-password=}" ;;
    --tls-cert=*)      TLS_CERT_FILE="${arg#--tls-cert=}" ;;
    --tls-key=*)       TLS_KEY_FILE="${arg#--tls-key=}" ;;
    --env-file=*)      ENV_FILE="${arg#--env-file=}" ;;
    --compose-env-file=*) COMPOSE_ENV_FILE="${arg#--compose-env-file=}" ;;
    --ui-env-file=*)   UI_ENV_FILE="${arg#--ui-env-file=}" ;;
    --load-config=*)   CAIPE_CONFIG_FILE="${arg#--load-config=}" ;;
    --slack-bot)       ENABLE_SLACK_BOT=true;  _SLACK_BOT_FORCED=on ;;
    --no-slack-bot)    ENABLE_SLACK_BOT=false; _SLACK_BOT_FORCED=off ;;
    --webex-bot)       ENABLE_WEBEX_BOT=true;  _WEBEX_BOT_FORCED=on ;;
    --no-webex-bot)    ENABLE_WEBEX_BOT=false; _WEBEX_BOT_FORCED=off ;;
    --upgrade)         FORCE_UPGRADE=true ;;
    --auto-heal)       AUTOHEAL_ENABLED=true ;;
    --no-auto-heal)    AUTOHEAL_ENABLED=false ;;
    --ingest-url=*)    INGEST_URLS+=("${arg#--ingest-url=}") ;;
    *)                 args+=("$arg") ;;
  esac
done

if $USE_DOCKER_COMPOSE; then
  if [[ ${#args[@]} -gt 0 && "${args[0]}" != "setup" ]]; then
    err "--docker-compose cannot be combined with the '${args[0]}' command"
    usage
  fi
  args=(docker-compose)
fi

$ENABLE_RBAC_RUNTIME && ENABLE_AGENTGATEWAY=true
$ENABLE_GRAPH_RAG && ENABLE_RAG=true
[[ ${#INGEST_URLS[@]} -gt 0 ]] && ENABLE_RAG=true

case "${args[0]:-setup}" in
  setup)        cmd_setup ;;
  port-forward) cmd_port_forward ;;
  validate)     cmd_validate ;;
  creds)        cmd_creds ;;
  cleanup)      cmd_cleanup ;;
  nuke)         AUTO_YES=true; cmd_cleanup ;;
  status)       cmd_status ;;
  docker-compose|compose) cmd_docker_compose ;;
  update-compose-release) cmd_update_compose_release ;;
  -h|--help)    usage ;;
  *)            err "Unknown command: ${args[0]}"; usage ;;
esac
