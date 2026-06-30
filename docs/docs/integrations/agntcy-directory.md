---
title: AGNTCY Directory
sidebar_position: 5
---

# AGNTCY Directory Integration

## Mental Model

The Directory is a **discovery catalog** — it tells CAIPE what agents exist and where they live. MongoDB remains the runtime config store (system prompts, credentials, RBAC, conversations), and AgentGateway remains the traffic layer (auth, routing, HMAC). Think of it like DNS: the Directory maps names to endpoints, but doesn't control how traffic flows once you know the address.

Two independent features use the Directory:

1. **Sync** (inbound) — periodically discovers external agents from a Directory instance and writes catalog entries into MongoDB.
2. **Self-registration** (outbound) — publishes CAIPE's own MCP servers to the Directory so other platforms can discover them.

## Architecture

```
┌──────────────────┐       sync (pull)        ┌──────────────────┐
│  AGNTCY          │ ──────────────────────── │  Dynamic Agents  │
│  Directory       │                          │  Service          │
│  (AI Finder)     │ ◄─────────────────────── │                  │
└──────────────────┘   self-register (push)   └────────┬─────────┘
                                                       │
                                                       ▼
                                               ┌──────────────────┐
                                               │     MongoDB      │
                                               │  (mcp_servers)   │
                                               └──────────────────┘
```

## Protocol Typing

Directory records are typed by their OASF modules:

| Module | ID | Behavior in CAIPE |
|--------|----|--------------------|
| `integration/mcp` | 202 | Catalog-only (`enabled=false`). Admin can enable directly — MCP endpoint is callable. |
| `integration/a2a` | 203 | Catalog-only (`enabled=false`). Requires admin activation + future A2A adapter. |
| Both | — | Prefers MCP metadata. A2A card is retained for reference. |
| MCP with only `stdio` connections | — | Falls through to A2A (stdio is not remotely callable). |

All Directory-discovered agents are **catalog-only until an admin explicitly activates them**. This ensures credentials are mapped, RBAC is granted, and AgentGateway routing is configured before any external agent becomes callable. Protocol typing helps the UI show admins which records can be enabled directly (MCP) vs which need additional configuration (A2A).

## Configuration

All configuration is via environment variables on the `dynamic-agents` service:

### Sync (Inbound Discovery)

| Variable | Default | Description |
|----------|---------|-------------|
| `DIRECTORY_ENABLED` | `false` | Enable periodic sync from Directory |
| `DIRECTORY_BASE_URL` | `http://dir-apiserver:8888` | AI Finder REST endpoint |
| `DIRECTORY_LABEL_FILTER` | _(empty)_ | Filter query (e.g., `platform=caipe`) |
| `DIRECTORY_SYNC_INTERVAL` | `300` | Seconds between sync cycles |
| `DIRECTORY_TIMEOUT` | `10.0` | HTTP request timeout in seconds |

### Self-Registration (Outbound Publishing)

| Variable | Default | Description |
|----------|---------|-------------|
| `DIRECTORY_SELF_REGISTER` | `false` | Publish built-in MCP servers to Directory on startup |
| `DIRECTORY_SERVER_ADDRESS` | `dir-apiserver:8888` | Directory gRPC server address |
| `DIRECTORY_REGISTER_LABELS` | _(empty)_ | Comma-separated `key=value` labels to attach |
| `DIRECTORY_REGISTER_INTERVAL` | `300` | Reconcile interval (seconds). 0 = one-shot on startup |
| `DIRECTORY_REGISTER_PUBLISH` | `true` | Also publish records for network routing |

Self-registration uses the `agntcy-dir` Python SDK to push OASF records directly via gRPC to the Directory Store service. No `dirctl` binary is required. Optionally, records are published to the routing layer for network-wide discovery by other Directory peers.

## Deployment

### Docker Compose (via deploy.sh)

Add the following to your `.env` file:

```bash
# Start the dir-apiserver container
ENABLE_DIRECTORY=true

# Enable DA ↔ Directory integration
DIRECTORY_ENABLED=true
DIRECTORY_SELF_REGISTER=true
```

Then deploy as usual:

```bash
./deploy.sh
```

The `deploy.sh` script reads `ENABLE_DIRECTORY` and adds the `directory` profile automatically.

### Helm (Kubernetes)

Enable the Directory subchart and configure the dynamic-agents service:

```bash
helm install caipe . \
  --set directory.enabled=true \
  --set dynamic-agents.config.DIRECTORY_ENABLED=true \
  --set dynamic-agents.config.DIRECTORY_SELF_REGISTER=true \
  --set dynamic-agents.config.DIRECTORY_BASE_URL=http://caipe-directory:8888 \
  --set dynamic-agents.config.DIRECTORY_SERVER_ADDRESS=caipe-directory:8888
```

Or in your `values.yaml`:

```yaml
directory:
  enabled: true

dynamic-agents:
  config:
    DIRECTORY_ENABLED: "true"
    DIRECTORY_SELF_REGISTER: "true"
    DIRECTORY_BASE_URL: "http://caipe-directory:8888"
    DIRECTORY_SERVER_ADDRESS: "caipe-directory:8888"
```

## Local Development

Directory is **optional** for local development. Without `ENABLE_DIRECTORY=true`, it is not started:

```bash
# Default local dev — no Directory needed
./deploy.sh

# With Directory — add to .env: ENABLE_DIRECTORY=true, DIRECTORY_ENABLED=true
./deploy.sh
```

To test Directory sync locally:

```bash
# Enable sync on the dynamic-agents service
export DIRECTORY_ENABLED=true
export DIRECTORY_BASE_URL=http://localhost:8888
```

To test self-registration:

```bash
export DIRECTORY_SELF_REGISTER=true
export DIRECTORY_REGISTER_LABELS=platform=caipe,env=local
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/directory/status` | User | Sync + registration status |
| POST | `/api/v1/directory/sync` | Admin | Trigger immediate sync |

## Design Decisions

1. **Additive, not a replacement** — seed config and AgentGateway discovery remain the bootstrap path. Directory adds cross-org discovery on top.
2. **MCP auto-enabled, A2A catalog-only** — MCP records are directly callable by the existing runtime. A2A records need an adapter (future work).
3. **No credentials in Directory** — credential sources stay CAIPE-local in MongoDB. Directory carries endpoint metadata only.
4. **Precedence: manual > AgentGateway/seed > Directory** — admin config always wins over automated discovery.
5. **Self-registration is separate from sync** — controlled by different env vars, can be enabled independently. Prevents circular registration (directory-sourced records are never re-published).

## Source Files

- `dynamic_agents/services/directory_source.py` — REST client for AI Finder API + OASF record parsing
- `dynamic_agents/services/directory_sync.py` — Periodic sync loop + MongoDB upsert
- `dynamic_agents/services/directory_register.py` — Self-registration on startup
- `dynamic_agents/routes/directory.py` — API endpoints
