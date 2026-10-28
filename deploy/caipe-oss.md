# CAIPE OSS Harness Engine Preview

`caipe-oss.outshift.io` is an isolated preview deployment of upstream CAIPE
with the Harness Engine branch applied. Dynamic Agents remains present and
unchanged so the two runtimes can be compared in one UI.

## Source policy

- Clone `https://github.com/cnoe-io/ai-platform-engineering` directly.
- Pin the deployed upstream commit and Harness Engine branch commit in the
  deployment record.
- Do not deploy from a downstream mirror.
- Build the UI and Harness Engine from the Harness Engine branch. All unchanged
  services retain their upstream source and configuration.

## Host prerequisites

- A dedicated Linux VM; do not share the `tome-sri` or `caipe-vanilla` host.
- Docker Engine with the Compose plugin.
- Ports 22, 80, and 443 allowed by the host security policy.
- An A record for `caipe-oss.outshift.io` targeting the VM.
- `/home/ubuntu/certs/fullchain.pem`, `/home/ubuntu/certs/privkey.pem`, and a
  `dashboard.htpasswd` file readable by Docker.
- At least 8 vCPU, 32 GiB memory, and 100 GiB storage for the full preview
  profile set.

## Required secrets

Create `.env` from the upstream `.env.example` and set at least:

```dotenv
NEXTAUTH_SECRET=<random-secret>
HARNESS_ENGINE_INTERNAL_TOKEN=<random-service-token>
MONGODB_ROOT_PASSWORD=<random-password>
```

Configure one execution provider before testing runs:

```dotenv
# Claude Agent SDK example
ANTHROPIC_API_KEY=<provider-secret>
HARNESS_ENGINE_CLAUDE_SDK_PROFILES_JSON={"primary":{"model":"<operator-approved-model>","cwd":"/tmp","permission_mode":"dontAsk","description":"CAIPE OSS preview"}}

# To use the host's AWS role instead of an Anthropic API key:
CLAUDE_CODE_USE_BEDROCK=1

# Or an operator-allowlisted managed AgentCore Harness (custom Runtime ARNs are also supported)
HARNESS_ENGINE_AGENTCORE_RUNTIMES_JSON={"primary":{"arn":"<harness-or-runtime-arn>","qualifier":"DEFAULT","region":"<aws-region>"}}
```

Prefer an instance role for AWS access. Do not place provider credentials in
agent blueprints or browser-visible configuration.

## Deploy

```bash
export COMPOSE_PROFILES="mcp-servers,caipe-ui-prod,rbac,dynamic-agents,rag,caipe-mongodb,web_ingestor"

docker compose --env-file .env \
  -f docker-compose.yaml \
  -f docker-compose.caipe-oss.yaml \
  config --quiet

docker compose --env-file .env \
  -f docker-compose.yaml \
  -f docker-compose.caipe-oss.yaml \
  up -d --build
```

## Acceptance checks

```bash
curl --fail https://caipe-oss.outshift.io/
curl --fail https://caipe-oss.outshift.io/realms/caipe/.well-known/openid-configuration
curl --fail https://caipe-oss.outshift.io/admin/people/users
curl --fail https://caipe-oss.outshift.io/admin/people/teams

docker compose --env-file .env \
  -f docker-compose.yaml \
  -f docker-compose.caipe-oss.yaml \
  ps
```

From the UI:

1. Confirm existing Dynamic Agents still list and run.
2. Open agent creation and select an available Harness Engine profile.
3. Save a Harness Engine agent and start a run.
4. Disconnect during streaming, reconnect by run ID/cursor, and verify replay.
5. Clear the session and verify a new binding epoch is used.

Harness Engine is intentionally not exposed directly through nginx. Browser
traffic goes through the authenticated Next.js BFF, which adds the internal
service token and caller subject.

## Readiness-gated replacements

First install can use the Compose command above. For later application container
replacements, use a planned maintenance gate instead of routing into starting
containers. This is a brief retryable interruption, not a zero-downtime rollout.

- The proxy needs the updated nginx configuration and a read-only bind mount of
  the host maintenance directory at `/run/caipe-maintenance`. The overlay supplies
  this mount. Create the host directory before starting the proxy.
- For host-managed nginx, point the configuration's flag path at the same absolute
  host directory supplied to `--gate-file`; omit `--proxy-container` below.
- Save the current Compose image pins and persistent-database backups first.
  Prepare configuration, build/pull images before opening the maintenance window.
- Probe every replaced application directly on its loopback port. Compose health
  alone is insufficient when a service has no healthcheck. Include an application's
  backend readiness URL when its UI health endpoint is only a liveness check.

```bash
mkdir -p .caipe-maintenance
python3 deploy/compose-safe-upgrade.py \
  --compose-file docker-compose.yaml \
  --compose-file docker-compose.caipe-oss.yaml \
  --env-file .env \
  --proxy-container caipe-oss-nginx \
  --gate-file "$PWD/.caipe-maintenance/active" \
  --public-url https://caipe-oss.outshift.io/ \
  --ready-url http://127.0.0.1:3000/api/health \
  --service caipe-ui
```

- The helper verifies the public proxy returns its maintenance marker before
  replacing anything. Users receive `503`, `Retry-After: 15`, and a clear message.
- It waits for Compose health and all direct readiness URLs, validates/reloads
  nginx to refresh upstream DNS, confirms a new worker is serving requests while
  the gate is still active, then clears maintenance.
- Authorization errors are never retried as another user or converted to success.
- A replacement/readiness/reload failure leaves maintenance enabled. Inspect logs,
  restore the saved image pins, and rerun with `--resume`. Do not clear the flag
  while services are starting or unhealthy. Database rollback requires a separate
  coordinated review if a migration has run.
- Use the helper only for the selected application services; database and proxy
  upgrades require a coordinated maintenance procedure of their own.
