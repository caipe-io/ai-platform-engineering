# OpenFGA + AgentGateway `ext_authz` dev stack

This folder contains the OpenFGA seed model and gRPC bridge used by the
`docker-compose.dev.yaml` `rbac` profile. AgentGateway calls the bridge through
Envoy gRPC `ext_authz`; the bridge adapts that request to an OpenFGA `Check`.

## What runs

| Piece | Role |
|-------|------|
| `openfga-postgres` | Durable OpenFGA metadata |
| `openfga-migrate` | One-shot DB migration |
| `openfga` | OpenFGA API (HTTP `:8080`, gRPC `:8081`, Playground `:3000` **inside** the container) |
| `openfga-init` | Creates store `caipe-openfga`, writes authorization model, optional coarse AGW tuple |
| `openfga-authz-bridge` | Small Envoy gRPC `Authorization.Check` service — AGW calls `openfga-authz-bridge:9100`; bridge decodes JWT `sub` from request headers (unverified, **dev only**) and calls OpenFGA `Check` |

Published host ports are bound to localhost only: **18080** (OpenFGA HTTP),
**18081** (gRPC), **13002** (Playground), **9100** (bridge). Override them with
`OPENFGA_HTTP_PORT`, `OPENFGA_GRPC_PORT`, or `OPENFGA_PLAYGROUND_PORT` if needed.

## Important: gateway authorization

With the default `deploy/agentgateway/config.yaml`, **every** MCP request is
authorized by AgentGateway `extAuthz`:

1. `jwtAuth` validates the Keycloak-issued token.
2. `extAuthz` asks the bridge to run an OpenFGA `Check`.

The AgentGateway path no longer maintains CEL `mcpAuthorization` rules or a
Mongo-backed config bridge.

## ReBAC model

The model is intentionally richer than the current coarse AGW check:

| Object | Relation | Purpose |
|--------|----------|---------|
| `mcp_gateway:list` | `can_call: [user]` | Current route-level AGW `extAuthz` gate for MCP browse/list/init traffic. |
| `team:<slug>` | `member: [user]` | Team membership from Admin UI team members. |
| `agent:<agent_id>` | base `user`, `manager`; derived `can_use`, `can_manage` | Dynamic agent use/manage grants from Team Resources. |
| `tool:<server>/*` | base `caller`; derived `can_call` | AgentGateway runtime grant for every tool on a concrete MCP server. Team Resources expands "all MCP servers" into one tuple per registered server. |
| `knowledge_base:<id>` | base `reader`, `ingestor`, `manager`; derived `can_read`, `can_ingest`, `can_manage` | Reserved for the KB admin surface. |

When `OPENFGA_RECONCILE_ENABLED=true` on `caipe-ui`, saving
`Admin → Teams → Resources` writes the corresponding team/resource tuples before
persisting the Mongo team document. The writer checks tuples before writes/deletes
so repeated saves are idempotent.

Slack channel grants use OpenFGA-safe channel subject ids:
`slack_channel:<channel_id>`. Avoid embedding a second `:` in the
object id portion because OpenFGA treats `type:id` as a structured user string and
rejects malformed users.

## Migration and backfill

Existing Mongo team memberships, team resource assignments, and one-agent-per-channel
Slack mappings can be converted into ReBAC provenance records with:

```bash
MONGODB_URI='mongodb://...' MONGODB_DATABASE=caipe \
  npx ts-node -P tsconfig.scripts.json scripts/backfill-universal-rebac.ts

APPLY=true MONGODB_URI='mongodb://...' MONGODB_DATABASE=caipe \
  npx ts-node -P tsconfig.scripts.json scripts/backfill-universal-rebac.ts
```

The script defaults to dry-run and prints the number of membership source records,
relationship records, Slack channel grant records, and skipped Slack mappings it
would upsert. Slack mappings without a workspace id are skipped so they do not
collapse into a shared synthetic subject. Use `APPLY=true` only after reviewing
the counts. Roll back source-scoped membership sources, relationship records, and
Slack channel grant records with:

```bash
SOURCE_ID=backfill-universal-rebac MONGODB_URI='mongodb://...' MONGODB_DATABASE=caipe \
  npx ts-node -P tsconfig.scripts.json scripts/rollback-universal-rebac-tuples.ts

APPLY=true SOURCE_ID=backfill-universal-rebac MONGODB_URI='mongodb://...' MONGODB_DATABASE=caipe \
  npx ts-node -P tsconfig.scripts.json scripts/rollback-universal-rebac-tuples.ts
```

## Quick start

1. **Set your Keycloak user `sub`** (from any access token — jwt.io):

   ```bash
   export OPENFGA_SEED_SUB="<uuid-from-token-sub-claim>"
   ```

2. **Bring up** OpenFGA + bridge **with** the usual dev stack (`rbac` profile so `agentgateway` exists):

   ```bash
   docker compose -f docker-compose.dev.yaml --profile rbac up -d \
     openfga-postgres openfga-migrate openfga openfga-init \
     openfga-authz-bridge agentgateway
   ```

3. **Exercise MCP through AGW** as usual (`http://localhost:4000`). If OpenFGA denies, you get **403** before the request reaches the MCP backend.

## Escape hatch (bypass OpenFGA only)

If you need to prove the wire without tuples, set subs that always get an allow response from the bridge:

```bash
export OPENFGA_BYPASS_SUBS="<sub1>,<sub2>"
```

Restart `openfga-authz-bridge` with that env.

## Security warnings

- The bridge **does not verify JWT signatures** — it only base64-decodes the payload for `sub`. Acceptable **only** on a private Docker network where AGW has already enforced `jwtAuth: strict`. For production, pass verified claims from AGW gRPC `ext_authz` metadata or verify JWTs in the bridge with JWKS.
- **Do not** expose port `9100` to the public internet.

## Next steps (out of scope here)

- Map `jwt.active_team` into OpenFGA checks for team-scoped gateway decisions.
- Shadow mode (legacy vs OpenFGA disagree metric) — not implemented in this minimal stack.
