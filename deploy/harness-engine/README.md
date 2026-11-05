# Harness images and restricted workers

Engine and workers are built and released in the CAIPE repository.
SDK Local runs inside Engine. SDK Remote reuses the base Engine image with
`python -m harness_engine.claude_worker`.

| GHCR package (`ghcr.io/caipe-io/`) | Purpose |
|---|---|
| `caipe-harness-engine` | Provider Engine and remote SDK worker |
| `caipe-harness-engine-deep` | Engine with Deep Agents dependencies |
| `caipe-claude-acp-worker` | SDK ACP adapter and worker |
| `caipe-claude-cli-acp-worker` | Claude Code CLI ACP adapter and worker |
| `caipe-worker-egress` | Restricted TLS CONNECT proxy |

## Publishing

- `ci-harness-engine.yml` builds and smoke-tests all five images natively on
  AMD64 and ARM64 before publishing multi-architecture manifests.
- Fork/ordinary PRs test without publishing. Same-repository `prebuild/*` PRs
  publish the shared `<stable>-<branch>-<count>` prebuild tag.
- Main publishes `canary`; releases publish the exact version. Only final tag
  pushes update `latest`. Published builds also get `sha-<full-source-SHA>`.
- Release finalization waits for this workflow; release scanning includes these
  packages. No runtime credentials enter image builds.
- Source-tagged images are retained after PR closure for pinned deployments. The
  existing branch-cleanup action deletes whole versions, including their aliases,
  so these packages are excluded until [source-aware retention](https://github.com/caipe-io/ai-platform-engineering/issues/3236) is implemented.
- Set `HARNESS_IMAGE_TAG` to an exact release/prebuild/source tag. Override the
  individual `*_IMAGE` variables with digests for immutable deployments.

## Compose setup

Use Docker Compose 2.24.4 or newer (`!reset` merge support).

1. Configure profiles, MongoDB and distinct service tokens using the
   [Engine README](../../ai_platform_engineering/harness_engine/README.md).
2. Create a deployment-owned file of **exact public TLS model hostnames**, one per
   line. `worker-allowed-domains.example` shows the format. Set
   `CLAUDE_WORKER_ALLOWED_DOMAINS_FILE` to its absolute path. Missing files fail
   rather than being created as directories.
3. Layer required worker overlays after the base and Deep Agents files:

   ```bash
   docker compose --env-file .env -f docker-compose.yaml \
     -f deploy/harness-engine/compose.deep-agents.yaml \
     -f deploy/harness-engine/compose.claude-cli-acp.yaml \
     --profile harness-engine up -d
   ```

   Add `compose.claude-acp.yaml` or `compose.claude-sdk.yaml` for other workers.
   Published services use `pull_policy: always`; an unavailable image fails closed.
   Set `CAIPE_UI_IMAGE` when the UI prebuild uses a different tag from the workers.
   Release overlays reset inherited `build` definitions to prevent pull failures
   from executing checkout code. For source validation, build each image explicitly
   with `docker build -f <Dockerfile> -t <selected-image-ref> .`, then run
   `docker compose ... up --pull never --no-build` using the same overlays.
   Review CLI/provider distribution terms for your deployment.

## Enforced worker baseline

- Non-root UID/GID 65532, read-only root, no capabilities, no new privileges,
  init/reaping, CPU/memory/PID limits and bounded `noexec,nosuid,nodev` temp storage.
- Each worker type has its own persistent workspace volume. Engine attachments
  and workspace remain writable; executable application files remain read-only.
- Workers join only an **internal Docker network**. Engine, BFF and MongoDB attach
  for control, tool brokering and persistence. These peers remain reachable:
  this is service isolation, not per-session tenant isolation.
- A separate non-root, resource-limited Squid proxy joins the internal network
  and a separate egress network. No worker/proxy port is published to the host.
- Proxy allows only CONNECT on port 443 to approved hosts; private, loopback and
  link-local destinations, including cloud metadata, are rejected. TLS is not
  decrypted. Restrict the list to model endpoints; MCP calls use CAIPE's broker.
- Proxy variables reach ACP subprocesses. Loopback MCP and internal CAIPE requests
  bypass it. Removing proxy variables does not grant a direct external route.
  Instance metadata is disabled: supply narrow provider credentials/workload
  identity explicitly instead of relying on IMDS.
- Native tool lists default to empty. Operators may select exact tools; broad
  shell execution requires a separate workload-isolation decision.
- Docker bridge isolation must be enforced by the host. Embedded DNS and trusted
  BFF/database peers are outside the TLS hostname policy; add host/DNS controls
  where the required boundary includes them.

SDK Local and Deep Agents remain inside Engine's trust domain and require their
own deployment network/IAM policy. Shared workers are for controlled trusted use.
They do not isolate mutually untrusted native-code tenants. Per-conversation
executor separation and OpenShell/Kata remain follow-up work; see the
[threat model](../../docs/docs/security/claude-acp-threat-model.md).

## Verification and rollback

- CI runs `smoke-image.sh` with read-only root, no capabilities, resource limits
  and no network; it exercises ACP initialization and the installed CLI.
- Before admitting users, verify an approved model request, forbidden hostname,
  metadata/private address and direct-egress attempt in the deployment.
- Roll back previous image digests and overlay configuration; preserve volumes.
  Drain active runs and dispatched tools before replacing workers. Process exit
  alone does not confirm cancellation of an external tool.
