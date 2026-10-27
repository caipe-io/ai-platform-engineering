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
