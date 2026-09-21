#!/usr/bin/env bash
#
# Local dev loop for the kind cluster: rebuild a component's image from source,
# load it into the kind node, and restart its deployment so the new code runs.
#
# The published GHCR images lag the in-progress autonomous-agents work, so for
# local dev we run images built from this checkout. Use this after editing code.
#
# Usage:
#   scripts/dev-kind-reload.sh caipe-ui
#   scripts/dev-kind-reload.sh autonomous-agents
#   scripts/dev-kind-reload.sh caipe-ui autonomous-agents      # both
#
# Env overrides:
#   KIND_CLUSTER   kind cluster name        (default: kind)
#   RELEASE        helm release name        (default: caipe)
#
# First-time setup (secrets + install) is NOT done here — see
# charts/ai-platform-engineering/values-local-images.yaml for the install recipe.
set -euo pipefail

KIND_CLUSTER="${KIND_CLUSTER:-kind}"
RELEASE="${RELEASE:-caipe}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <component...>   (components: caipe-ui, autonomous-agents)" >&2
  exit 64
fi

build_one() {
  local component="$1" image deploy
  case "$component" in
    caipe-ui)
      image="caipe-ui:local"
      deploy="deploy/${RELEASE}-caipe-ui"
      echo "==> building $image"
      docker build -t "$image" \
        -f build/Dockerfile.caipe-ui \
        --build-arg CAIPE_URL=http://caipe-supervisor:8000 \
        .
      ;;
    autonomous-agents)
      image="caipe-autonomous-agents:local"
      deploy="deploy/${RELEASE}-autonomous-agents"
      echo "==> building $image"
      docker build -t "$image" \
        -f build/Dockerfile.autonomous-agents \
        ai_platform_engineering/autonomous_agents
      ;;
    *)
      echo "unknown component: $component (expected caipe-ui or autonomous-agents)" >&2
      return 2
      ;;
  esac

  echo "==> loading $image into kind cluster '$KIND_CLUSTER'"
  kind load docker-image "$image" --name "$KIND_CLUSTER"

  echo "==> restarting $deploy"
  kubectl rollout restart "$deploy"
  kubectl rollout status "$deploy" --timeout=180s
  echo "==> $component reloaded"
}

for c in "$@"; do
  build_one "$c"
done

echo "Done. If a port-forward to the restarted pod was open, restart it."
