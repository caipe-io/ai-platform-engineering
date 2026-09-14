#!/usr/bin/env bash
# Run locally with: bash tests/integration/test_setup_caipe_sudo_consent.sh
# Exercise production code in isolated subshells; never run the full installer.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SOURCE="$ROOT/setup-caipe.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Top-level functions end with an unindented brace. Fail if extraction breaks.
extract_function() {
  awk -v name="$1" '
    $0 == name "() {" { found=1 }
    found { print }
    found && /^}$/ { complete=1; exit }
    END { if (!complete) exit 1 }
  ' "$SOURCE"
}
for name in ask_yn _sudo_consent _ensure_local_bin _install_kubectl_linux \
  _install_kind_linux _install_kind_macos _install_helm_linux \
  _install_docker_linux _install_docker_macos install_nginx_ingress \
  _persist_iptables check_prerequisites; do
  extract_function "$name" >> "$WORK/functions.sh"
done
awk '
  /^case "\$\{CAIPE_ALLOW_SUDO:-\}" in$/ { found=1 }
  found { print }
  found && /^esac$/ { complete=1; exit }
  END { if (!complete) exit 1 }
' "$SOURCE" > "$WORK/policy.sh"
awk '
  /^args=\(\)$/ { found=1 }
  found { print }
  found && /^done$/ { complete=1; exit }
  END { if (!complete) exit 1 }
' "$SOURCE" > "$WORK/flags.sh"
bash -n "$WORK/functions.sh"
source "$WORK/functions.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
equal() { [[ "$1" == "$2" ]] || fail "expected '$2', got '$1'"; }
contains() { grep -Fq -- "$1" "$WORK/calls" || fail "missing call: $1"; }
empty_calls() { [[ ! -s "$WORK/calls" ]] || fail "unexpected external command"; }
log() { :; }
warn() { :; }
err() { :; }
step() { :; }
prompt() { PROMPTS=$((PROMPTS + 1)); }
tty_read() { read "$@" <&3; }

# All privileged calls are recorded, never executed, even in approval tests.
sudo() { echo "sudo $*" >> "$WORK/calls"; cat >/dev/null; return "$SUDO_RESULT"; }
brew() { echo "brew $*" >> "$WORK/calls"; }
docker() { echo "docker $*" >> "$WORK/calls"; }
helm() { :; }
kubectl() { if [[ "$1" == get ]]; then echo '192.0.2.10'; fi; }
uname() { echo Linux; }
hostname() { echo '192.0.2.20'; }
open() { fail 'unexpected desktop launch'; }
sleep() { fail 'unexpected wait'; }
# Never create the installer's fixed /tmp downloads or contact a server.
curl() {
  case "$*" in
    *get-helm-3*) echo 'printf "%s %s\n" "$USE_SUDO" "$HELM_INSTALL_DIR" > "$HELM_RESULT"' ;;
    *stable.txt*) echo v1.0.0 ;;
    *releases/latest*) echo '"tag_name": "v1.0.0"' ;;
    *-sLo*) : ;;
    *) fail "unexpected download: $*" ;;
  esac
}
chmod() { :; }
mv() {
  case "$2" in
    "$WORK"/*) printf '#!/bin/sh\nexit 0\n' > "$2"; command chmod +x "$2" ;;
    *) fail "unexpected move: $*" ;;
  esac
}

run() {
  local title="$1"
  shift
  # A fresh process scope resets policy, mocks, and PATH for every scenario.
  (
    set -euo pipefail
    ALLOW_SUDO=''; SUDO_CONSENT=''; AUTO_YES=false; NON_INTERACTIVE=false
    CYAN=''; NC=''; BOLD=''; PROMPTS=0; SUDO_RESULT=0
    export HELM_RESULT="$WORK/helm-result"
    : > "$WORK/calls"
    exec 3</dev/null
    "$@"
  ) </dev/null
  echo "PASS: $title"
}

policy_case() {
  local value="$1" expected="$2"
  shift 2
  if [[ "$value" == unset ]]; then unset CAIPE_ALLOW_SUDO; else CAIPE_ALLOW_SUDO="$value"; fi
  source "$WORK/policy.sh"
  source "$WORK/flags.sh"
  local result=no
  if _sudo_consent test; then result=yes; fi
  equal "$result" "$expected"
  equal "$PROMPTS" 0
}
invalid_policy() {
  local value="$1"
  if (CAIPE_ALLOW_SUDO="$value"; source "$WORK/policy.sh"; source "$WORK/flags.sh" --allow-sudo --yes); then
    fail 'invalid policy accepted'
  fi 2> "$WORK/error"
  grep -q 'CAIPE_ALLOW_SUDO must be' "$WORK/error" || fail 'missing validation message'
}
for value in unset '' 0 false FALSE FaLsE; do
  run "policy '$value' denies unattended sudo" policy_case "$value" no --non-interactive
done
for value in 1 true TRUE TrUe; do
  run "policy '$value' permits sudo" policy_case "$value" yes
done
for value in 0 false; do
  run "environment denial beats approval: $value" policy_case "$value" no --allow-sudo --yes
done
run 'CLI denial wins when last' policy_case 1 no --allow-sudo --no-sudo --yes
run 'CLI denial wins when first' policy_case 1 no --no-sudo --allow-sudo --yes
run '--yes permits sudo' policy_case unset yes --yes
for value in yes no 2 ' true' 'false '; do
  run "invalid policy '$value' is rejected" invalid_policy "$value"
done

prompt_case() {
  local answer="$1" expected="$2" result=no
  printf '%s' "$answer" > "$WORK/input"
  exec 3< "$WORK/input"
  if _sudo_consent test; then result=yes; fi
  equal "$result" "$expected"
  result=no
  if _sudo_consent again; then result=yes; fi
  equal "$result" "$expected"
  equal "$PROMPTS" 1
  ALLOW_SUDO=0
  if _sudo_consent denied; then fail 'cached approval overrode denial'; fi
}
run 'EOF denies and caches consent' prompt_case '' no
run 'interactive no is cached' prompt_case $'n\n' no
run 'interactive yes is cached; explicit denial overrides it' prompt_case $'y\n' yes
run 'interactive Enter uses the default' prompt_case $'\n' yes

binary_case() {
  local installer="$1" policy="$2" sudo_result="$3"
  ALLOW_SUDO="$policy"; SUDO_RESULT="$sudo_result"
  unset -f kubectl
  # Override HOME only in this child environment; the real home is untouched.
  export HOME="$WORK/home-$installer-$policy-$sudo_result"
  command() {
    if [[ "$*" == '-v brew' ]]; then return 1; fi
    builtin command "$@"
  }
  "$installer"
  if [[ "$policy" == 0 || "$sudo_result" != 0 ]]; then
    local binary=kind
    [[ "$installer" != _install_kubectl_linux ]] || binary=kubectl
    equal "$(command -v "$binary")" "$HOME/.local/bin/$binary"
    local old_path="$PATH"
    _ensure_local_bin
    equal "$PATH" "$old_path"
  fi
  if [[ "$policy" == 0 ]]; then empty_calls; else contains 'sudo mv /tmp/'; fi
}
for installer in _install_kubectl_linux _install_kind_linux _install_kind_macos; do
  run "$installer denied: local fallback" binary_case "$installer" 0 0
  run "$installer approved: system placement" binary_case "$installer" 1 0
  run "$installer sudo fails: local fallback" binary_case "$installer" 1 1
done
helm_case() {
  ALLOW_SUDO="$1"
  export HOME="$WORK/helm-home"
  _install_helm_linux
  if [[ "$1" == 0 ]]; then
    equal "$(cat "$HELM_RESULT")" "false $HOME/.local/bin"
  else
    equal "$(cat "$HELM_RESULT")" 'true /usr/local/bin'
  fi
  empty_calls
}
run 'Helm denial selects local installation' helm_case 0
run 'Helm approval selects system installation' helm_case 1

denied_install() {
  ALLOW_SUDO=0
  if ("$1"); then fail 'installation unexpectedly succeeded'; fi
  empty_calls
}
run 'Linux Docker denial prevents installation' denied_install _install_docker_linux
# Docker.app existence is host-dependent; replace only that filesystem probe.
sed "s|/Applications/Docker.app|$WORK/absent-desktop|g" "$WORK/functions.sh" > "$WORK/desktop.sh"
source "$WORK/desktop.sh"
run 'macOS Docker denial prevents Homebrew installation' denied_install _install_docker_macos
macos_approved() {
  ALLOW_SUDO=1
  (_install_docker_macos)
  contains 'brew install --cask docker'
}
run 'macOS Docker approval permits Homebrew installation' macos_approved
prerequisites_denied() {
  _check_kubeconfig() { :; }
  command() {
    if [[ "$*" == '-v jq' ]]; then return 1; fi
    builtin command "$@"
  }
  denied_install check_prerequisites
}
run 'missing jq requires consent before package installation' prerequisites_denied
network_case() {
  ALLOW_SUDO="$1"; ENABLE_METALLB=true; CAIPE_DOMAIN=example.test
  "$2" '192.0.2.10'
  if [[ "$1" == 0 ]]; then
    empty_calls
  else
    contains 'sudo mkdir -p /etc/iptables'
    if [[ "$2" == install_nginx_ingress ]]; then
      contains 'sudo iptables -t nat -C PREROUTING'
      contains 'sudo tee -a /etc/hosts'
    fi
  fi
}
for operation in install_nginx_ingress _persist_iptables; do
  run "$operation denial prevents host changes" network_case 0 "$operation"
  run "$operation approval permits host changes" network_case 1 "$operation"
done
