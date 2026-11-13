# Architecture: Directory as CAIPE's Internal Agent Registry

## Status: AGREED (Kiro, Codex, Claude, Cursor — 2026-06-30)

## Summary

Directory serves as CAIPE's **unified catalog mirror** — a single place where everything
that exists (MCP servers, agents, external services) is visible and discoverable.
MongoDB remains the operational authority for runtime state.

This is NOT "Directory-first" (where Directory is required for startup). It is
"Directory-as-mirror" (MongoDB bootstraps normally; Directory reflects what's active
and enables cross-boundary discovery).

## Architecture Principle

```
MongoDB = operational authority ("what's active here, with what config")
Directory = catalog mirror ("what exists, discoverable by others")
```

- MongoDB never depends on Directory for startup or liveness.
- Directory is populated BY MongoDB state (outbound mirror).
- External agents flow FROM Directory into MongoDB (inbound discovery, disabled until activated).

## Bootstrap Modes

| Mode | Env value | Behavior | Use case |
|------|-----------|----------|----------|
| Off | `DIRECTORY_BOOTSTRAP=off` | config.yaml → MongoDB only. No Directory interaction. | Local dev, contributors |
| Mirror | `DIRECTORY_BOOTSTRAP=mirror` | Seed MongoDB from config + self-register all enabled items to Directory + inbound sync for external agents. | Single enterprise instance |
| Primary | `DIRECTORY_BOOTSTRAP=primary` | Init job pushes OASF manifests → Directory → sync → MongoDB. config.yaml provides runtime activation only. | Multi-instance / federated (future) |

**Default: `off`.** Enterprise deployments use `mirror`.

## Data Ownership

### Directory owns (catalog facts):

- Agent/server identity: id, name, version, owner
- Protocol type: MCP, A2A, LangGraph
- Capability metadata: skills, modules, integrations
- Default endpoint hint (may differ from runtime endpoint)
- Trust metadata: signatures, verification status

### MongoDB owns (runtime state):

- `enabled`: bool (admin decision)
- `credential_sources`: deployment-specific auth config
- `endpoint`: actual runtime endpoint (may be AgentGateway route)
- RBAC bindings (OpenFGA tuples)
- AgentGateway route configuration
- User preferences, system prompts, allowed_tools
- Dynamic agent instances (user-created configs)
- Workflow configs
- LLM model runtime settings (API keys, endpoint overrides)

### Join key:

MongoDB records reference Directory entries via `directory_cid` (content-addressed ID)
and stable `server_id` / `agent_id`.

## Flows

### Outbound: MongoDB → Directory (self-registration mirror)

```
1. seed-config.ts applies config.yaml → MongoDB (unchanged)
2. DA starts, waits for seed completion
3. DirectoryRegisterService reads all enabled MCP servers from MongoDB
4. Builds OASF records (id, name, protocol, capabilities, endpoint hint)
5. SDK client.push(records) → Directory Store → CIDs
6. Optional: client.publish(cid) for DHT routing
7. Reconcile every 300s to pick up changes
```

What gets mirrored:
- All enabled MCP servers (config-seeded, admin-added, AgentGateway-discovered)
- LangGraph agent capability metadata (Phase 2)

What does NOT get mirrored:
- Credentials, RBAC, user-specific config
- Disabled/draft items
- Dynamic agent instances (unless admin explicitly publishes)

### Inbound: Directory → MongoDB (external discovery)

```
1. DA polls AI Finder REST (or SDK search) every 300s
2. For each CatalogEntry not already in MongoDB:
   - Resolve full OASF record
   - Detect protocol (MCP/A2A)
   - Write to MongoDB with enabled=False, source='directory'
3. Admin sees discovered agents in UI catalog
4. Admin activates: sets enabled=True, maps credentials, assigns RBAC
5. Subsequent syncs update only directory_* metadata fields
```

### Event-driven enhancement (Phase 2):

- `client.listen()` subscribes to RECORD_PUSHED/PUBLISHED/DELETED events
- Events trigger immediate sync for freshness
- Polling remains as correctness safety net if stream drops

## Entity Boundaries

| Entity | In Directory? | In MongoDB? | Notes |
|--------|:---:|:---:|-------|
| MCP servers (built-in) | ✅ mirrored | ✅ authority | Directory gets capability/protocol metadata |
| MCP servers (external) | ✅ source | ✅ runtime state | Flows in via sync, disabled until activated |
| LangGraph agents | ✅ capabilities (Phase 2) | ✅ full config | Directory holds skills/description, not prompts/tools |
| Dynamic agents (user) | ❌ (optional publish) | ✅ authority | Personal/team configs stay in MongoDB |
| LLM models | ❌ (Phase 3 optional) | ✅ authority | Models are RBAC-managed with API key refs |
| Workflow configs | ❌ (optional template publish) | ✅ authority | Runtime templates, not catalog entries |
| Credentials | ❌ never | ✅ always | Deployment-specific, secret-policy-specific |
| RBAC / OpenFGA tuples | ❌ never | ✅ always | Instance-specific access control |

## Failure Modes

| Scenario | Impact | Mitigation |
|----------|--------|-----------|
| Directory down on fresh deploy | None — MongoDB seeds from config.yaml as today | `mirror` mode is additive, not required for bootstrap |
| Directory down during operation | No new external discovery; self-registration pauses | MongoDB state serves users normally; retry on next interval |
| Directory data loss | Re-mirrors from MongoDB on next reconcile cycle | MongoDB is authoritative; Directory is reconstructible |
| MongoDB loss (PVC wipe) | Standard disaster: re-seed from config.yaml | Same as today — Directory does not help here |

## Developer Experience

### Adding a new MCP server (contributor workflow — unchanged):

1. Add entry to `config.yaml` (id, endpoint, transport, credential_sources)
2. Add service to docker-compose if needed
3. Restart — seed-config.ts upserts MongoDB, reconciles OpenFGA
4. If `DIRECTORY_BOOTSTRAP=mirror`, DA auto-publishes to Directory on next reconcile

### Local dev (default):

```bash
docker compose up  # No Directory needed. config.yaml → MongoDB as today.
```

### Testing Directory integration:

```bash
dirctl daemon start                    # Local Directory
docker compose --profile directory up  # With DIRECTORY_BOOTSTRAP=mirror
```

### Unit tests:

- Default test suite does NOT require Directory (env flags default to off)
- Directory-specific tests use mocked SDK client (existing pattern)
- Integration tests opt-in via `@pytest.mark.integration` + compose profile

## Implementation Phases

### Phase 1: Complete Mirror Mode (current + small additions)

- [x] SDK-based self-registration (push + publish)
- [x] Inbound sync for external discovery
- [x] Protocol detection (MCP/A2A)
- [x] Admin precedence (never overwrite enabled/transport/endpoint)
- [x] Reconcile loop
- [ ] `DIRECTORY_BOOTSTRAP=off|mirror` env flag
- [ ] Expand self-registration to ALL enabled MCP servers (not just built-ins)
- [ ] UI "source" badge (directory/config/manual/agentgateway)
- [ ] `make dir-local` Makefile target + documentation

### Phase 2: Rich Catalog + Trust

- [ ] LangGraph agent OASF capability records
- [ ] Signature verification (`client.verify()`) stored as `directory_verified`
- [ ] Event-driven sync (`client.listen()`) with polling fallback
- [ ] UI activation panel (trust status → enable → map credentials)
- [ ] SDK `search_records()` for richer filtering

### Phase 3: Federation + Advanced (future)

- [ ] `DIRECTORY_BOOTSTRAP=primary` mode for multi-instance deployments
- [ ] Runtime skill-based routing (Directory search during reasoning)
- [ ] Directory MCP server for admin/platform agents
- [ ] Name resolution (`client.resolve()`)
- [ ] Optional model/workflow template publishing
- [ ] "Publish to Directory" UI action for dynamic agent blueprints

## Design Decisions Log

| Decision | Agreed by | Rationale |
|----------|-----------|-----------|
| MongoDB stays operational authority | All | Directory-first adds failure surfaces without reducing complexity (Claude) |
| config.yaml remains authoring surface | Codex, Cursor | OASF-first authoring regresses contributor workflow (Cursor) |
| Credentials stay in MongoDB only | Codex | Deployment-specific, secret-policy-specific (Codex) |
| Dynamic agents not in Directory by default | Codex | Prompts/model config/permissions are runtime state (Codex) |
| Events augment polling, don't replace it | Codex | listen() can miss events; polling is correctness path (Codex) |
| LLM models are Phase 3 optional | Codex | RBAC-managed with API key refs — not catalog entities (Codex) |
| Three bootstrap modes (off/mirror/primary) | Cursor | Separates local dev (simple) from production (Directory-enabled) (Cursor) |
| No Directory dependency for default dev/test | Cursor | Contributors should not need dirctl installed (Cursor) |
| Mirror mode is the target for single enterprise | All | Gets unified catalog visibility without operational risk (Claude) |
