#!/bin/sh
# Preserve the image's normal command after loading the installation credential.
set -eu
if [ -z "${HARNESS_ENGINE_INTERNAL_TOKEN:-}" ]; then
  HARNESS_ENGINE_INTERNAL_TOKEN=$(cat /run/harness-engine/token)
fi
case "$HARNESS_ENGINE_INTERNAL_TOKEN" in
  local-development-only|*[![:graph:]]*) echo 'Invalid Harness Engine service credential' >&2; exit 1 ;;
esac
if [ "${#HARNESS_ENGINE_INTERNAL_TOKEN}" -lt 16 ]; then
  echo 'Harness Engine service credential must contain at least 16 characters' >&2
  exit 1
fi
export HARNESS_ENGINE_INTERNAL_TOKEN
exec "$@"
