---
name: docker-compose-first-install
description: >
  Validate and repair the OSS first-install Docker Compose path. Use when
  editing docker-compose.yaml, docker-compose.dev.yaml, .env.example,
  release image tags, Compose profiles, Keycloak/OpenFGA/RAG defaults, or
  first-launch UI behavior for local all-in-one installs.
---

# Docker Compose First Install

Protect the plain OSS setup path:

```bash
cp .env.example .env
COMPOSE_PROFILES="mcp-servers,caipe-ui-prod,rbac,caipe-supervisor,dynamic-agents,rag,caipe-documentdb,web_ingestor" \
docker compose --env-file .env -f docker-compose.yaml up -d
```

This flow must work without Cisco-only systems, Slack/Webex bots, local image
suffix overrides, or hidden operator knowledge.

## When This Skill Applies

Use this skill when a task touches:

- `docker-compose.yaml`
- `docker-compose.dev.yaml`
- `.env.example`
- release image tags or image suffixes
- first-install docs or launch commands
- Keycloak, OpenFGA, RBAC, RAG, MongoDB, supervisor, dynamic agents, web ingestor
- first-launch UI alerts, release prompts, migrations, or Keycloak health

## Required Defaults

The minimal first-install profile set is:

```bash
mcp-servers,caipe-ui-prod,rbac,caipe-supervisor,dynamic-agents,rag,caipe-documentdb,web_ingestor
```

Do not add `slack-bot` or `webex-bot` to the default all-in-one path.

Required local Docker defaults:

- `IMAGE_TAG` points at the latest supported stable release.
- `caipe-ui` in `docker-compose.yaml` uses the published release tag, without a local-only `-prod` suffix.
- `caipe-ui` has `OPENFGA_HTTP=http://openfga:8080`.
- `caipe-ui` has `OPENFGA_STORE_NAME=caipe-openfga`.
- `dynamic-agents` has `AUTHZ_SERVICE_URL=http://caipe-ui:3000` so agent-use
  decisions can reach the UI BFF/CAS.
- `caipe-ui` has Keycloak admin-client values that match the local realm seed:
  - `KEYCLOAK_URL=http://keycloak:7080`
  - `KEYCLOAK_REALM=caipe`
  - `KEYCLOAK_RESOURCE_SERVER_ID=caipe-platform`
  - `KEYCLOAK_CLIENT_SECRET=caipe-platform-dev-secret`
  - `KEYCLOAK_ADMIN_CLIENT_ID=caipe-platform`
  - `KEYCLOAK_ADMIN_CLIENT_SECRET=caipe-platform-dev-secret`
- `keycloak-init` receives matching `KEYCLOAK_UI_CLIENT_SECRET` and `KEYCLOAK_PLATFORM_CLIENT_SECRET`.
- UI healthchecks inside containers use `127.0.0.1`, not `localhost`, when probing the local Next.js listener.

## Validation Commands

Run these before committing Compose/env changes:

```bash
COMPOSE_PROFILES="mcp-servers,caipe-ui-prod,rbac,caipe-supervisor,dynamic-agents,rag,caipe-documentdb,web_ingestor" \
NEXTAUTH_SECRET=test \
docker compose --env-file .env.example -f docker-compose.yaml config --quiet
```

Inspect the rendered UI env:

```bash
COMPOSE_PROFILES="mcp-servers,caipe-ui-prod,rbac,caipe-supervisor,dynamic-agents,rag,caipe-documentdb,web_ingestor" \
NEXTAUTH_SECRET=test \
docker compose --env-file .env.example -f docker-compose.yaml config --format json \
| jq '.services["caipe-ui"].environment
  | {
      OPENFGA_HTTP,
      OPENFGA_STORE_NAME,
      KEYCLOAK_URL,
      KEYCLOAK_REALM,
      KEYCLOAK_RESOURCE_SERVER_ID,
      KEYCLOAK_CLIENT_SECRET,
      KEYCLOAK_ADMIN_CLIENT_ID,
      KEYCLOAK_ADMIN_CLIENT_SECRET
    }'
```

Inspect the rendered Dynamic Agents env:

```bash
COMPOSE_PROFILES="mcp-servers,caipe-ui-prod,rbac,caipe-supervisor,dynamic-agents,rag,caipe-documentdb,web_ingestor" \
NEXTAUTH_SECRET=test \
docker compose --env-file .env.example -f docker-compose.yaml config --format json \
| jq '.services["dynamic-agents"].environment | {AUTHZ_SERVICE_URL}'
```

Inspect Keycloak init secrets:

```bash
COMPOSE_PROFILES="mcp-servers,caipe-ui-prod,rbac,caipe-supervisor,dynamic-agents,rag,caipe-documentdb,web_ingestor" \
NEXTAUTH_SECRET=test \
docker compose --env-file .env.example -f docker-compose.yaml config --format json \
| jq '.services["keycloak-init"].environment
  | {KEYCLOAK_UI_CLIENT_SECRET, KEYCLOAK_PLATFORM_CLIENT_SECRET}'
```

Check rendered images:

```bash
COMPOSE_PROFILES="mcp-servers,caipe-ui-prod,rbac,caipe-supervisor,dynamic-agents,rag,caipe-documentdb,web_ingestor" \
NEXTAUTH_SECRET=test \
docker compose --env-file .env.example -f docker-compose.yaml config --images \
| sort
```

The UI image should be `ghcr.io/cnoe-io/caipe-ui:<version>`, not
`ghcr.io/cnoe-io/caipe-ui:<version>-prod`, unless that suffixed image is known
to be published for the release.

DocumentDB is the default persistence provider. To test the MongoDB provider,
replace `caipe-documentdb` with `caipe-mongodb` in the profile list and set
`DATABASE_PROVIDER=mongodb` with a MongoDB-compatible `MONGODB_URI`.

## Recovery Commands For Local Testing

Use non-destructive recovery first:

```bash
COMPOSE_PROFILES="mcp-servers,caipe-ui-prod,rbac,caipe-supervisor,dynamic-agents,rag,caipe-documentdb,web_ingestor" \
docker compose --env-file .env -f docker-compose.yaml up -d --force-recreate caipe-ui dynamic-agents web_ingestor keycloak-init
```

If Keycloak or OpenFGA state was seeded with bad env, reset only the local auth
data volumes:

```bash
docker compose --env-file .env -f docker-compose.yaml down
docker volume rm docker-compose-fixes_keycloak_postgres_data docker-compose-fixes_openfga_postgres_data
COMPOSE_PROFILES="mcp-servers,caipe-ui-prod,rbac,caipe-supervisor,dynamic-agents,rag,caipe-documentdb,web_ingestor" \
docker compose --env-file .env -f docker-compose.yaml up -d
```

Only reset MongoDB when the user explicitly accepts losing local CAIPE data:

```bash
docker volume rm docker-compose-fixes_mongodb_data docker-compose-fixes_mongodb_config
```

## Guardrails

- Do not add AI attribution comments or examples.
- Use conventional commit titles.
- Use only an explicitly provided human DCO trailer.
- Keep `.env.example` runnable for a first-time local OSS user.
- Keep Docker Compose first install independent of proprietary providers.
