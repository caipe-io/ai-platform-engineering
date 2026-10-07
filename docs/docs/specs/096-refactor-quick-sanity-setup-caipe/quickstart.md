# Quickstart: Testing the Refactored Workflows

**Date**: 2026-03-20

## Prerequisites

- Push access to the `caipe-io/ai-platform-engineering` repository
- GitHub Actions enabled on the repository
- The `caipe-integration-tests` self-hosted runner is online

## Testing the Release-Tag Workflow

### Via workflow_dispatch (manual trigger)

1. Go to Actions → `[Tests][Release Tag] Quick Sanity Integration`
2. Click "Run workflow"
3. Optionally provide a `chart_version` (e.g., `0.2.41`). If empty, the latest semver release tag is used.
4. Monitor the run. Expected steps:
   - Kind cluster created
   - Helm chart deployed with specified version
   - Supervisor, weather, netutils pods reach Running
   - Built-in validation and sanity tests pass
   - Kind cluster cleaned up

### Via tag push (automatic trigger)

1. Push a semver tag: `git tag 0.2.42 && git push origin 0.2.42`
2. The workflow triggers automatically and tests that chart version

## Testing the Dev Workflow

### Via workflow_dispatch (manual trigger)

1. Go to Actions → `[Tests][Dev] Quick Sanity Integration`
2. Click "Run workflow"
3. Monitor the run. Expected steps:
   - Docker compose starts all agents + RAG services
   - Services reach healthy state
   - `make quick-sanity` tests pass
   - Docker compose services torn down

### Via push to main (automatic trigger)

1. Merge a PR to `main`
2. The workflow triggers automatically

## Verifying Stable-Tag Removal

1. Confirm `.github/workflows/tests-quick-sanity-integration-on-stable-tag.yml` no longer exists
2. Confirm the latest-tag workflow has no `create-stable-tag-and-test` job
3. Confirm the `stable` tag is removed: `git ls-remote --tags origin | grep stable` should return empty

## Troubleshooting

- **Kind cluster leftover**: If a previous run failed, the pre-clean step deletes any existing `caipe` Kind cluster. If issues persist, SSH to the runner and run `kind delete cluster --name caipe`.
- **Port conflicts**: Concurrency groups prevent overlapping runs. If a port is still occupied, the workflow's cleanup step handles it.
- **Docker compose services not starting**: Check the compose-live.log artifact. Verify the `.env` file has required credentials.
