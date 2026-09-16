#!/usr/bin/env bash
# Regression checks for stable-only changelog and prerelease release handling.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PREPARE_RELEASE="$ROOT_DIR/.github/actions/prepare-release/action.yml"
RELEASE_MANUAL="$ROOT_DIR/.github/workflows/release-manual.yml"
RELEASE_PRERELEASE="$ROOT_DIR/.github/workflows/release-prerelease.yml"
DOCS_RELEASE="$ROOT_DIR/.github/workflows/docs-release.yml"
CHANGELOG="$ROOT_DIR/CHANGELOG.md"

grep -Fq 'Skipping changelog generation for prerelease' "$PREPARE_RELEASE"
grep -Fq 'cz changelog --unreleased-version "$VERSION"' "$PREPARE_RELEASE"
grep -Fq 'RELEASE_FLAGS+=(--prerelease)' "$RELEASE_MANUAL"
grep -Fq 'does not update CHANGELOG.md or create a GitHub Release' "$RELEASE_PRERELEASE"
grep -Fq 'Release posts are only generated for stable versions' "$DOCS_RELEASE"

if grep -Eq '^## [0-9]+\.[0-9]+\.[0-9]+-(dev|rc)\.[0-9]+' "$CHANGELOG"; then
  echo "CHANGELOG.md contains a prerelease heading" >&2
  exit 1
fi

echo "Release workflow policy checks passed."
