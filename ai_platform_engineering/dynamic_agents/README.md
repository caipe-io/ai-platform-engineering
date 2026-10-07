# Dynamic Agents

Dynamic Agents (also known as Custom Agents) is the FastAPI runtime service that enables users to create, configure, and run AI agents dynamically. Agents are configurable through the UI and can be equipped with specific MCP tools, custom system prompts, and other Dynamic Agents as subagents.

## Overview

Dynamic Agents provide a flexible way to create purpose-built AI assistants without code changes:

- **Admin-configurable**: Create and manage agents through the UI (admin role required)
- **MCP Tool Integration**: Connect agents to any MCP-compatible tool server
- **Subagent Delegation**: Agents can delegate tasks to other Dynamic Agents
- **Multi-LLM Support**: Choose from multiple LLM providers (Anthropic, OpenAI, Azure, Bedrock, etc.)
- **Visibility Controls**: Private, team, or global agent visibility
- **Built-in Tools**: Optional fetch_url tool with domain ACLs

## Features

### MCP Server Integration
- Support for **stdio**, **SSE**, and **HTTP** transport types
- Per-agent tool selection (choose specific tools or all tools from a server)
- Live tool probing to discover available tools from MCP servers
- Namespaced tool names to avoid conflicts across servers

### Subagent System
- Configure other Dynamic Agents as subagents for task delegation
- Automatic `task` tool injection for subagent invocation
- Circular reference detection to prevent infinite loops
- Visibility-based access control (global agents can only use global subagents)

### Built-in Tools
- **fetch_url**: Fetch web content with domain-based access control
  - Configurable allowed domains (wildcards supported)
  - Automatic HTML-to-text conversion
  - JSON passthrough for API responses

### Visibility Model
| Visibility | Who can see/use | Who can modify |
|------------|-----------------|----------------|
| `private`  | Owner only      | Owner, Admin   |
| `team`     | Team members    | Owner, Admin   |
| `global`   | All users       | Admin only     |

### Tracing & Observability
- Langfuse integration for LLM tracing
- Per-session trace grouping
- Prometheus metrics at `/metrics` for requests, turns, model calls, tools, and runtime saturation
- Model usage by configured model ID, including provider-reported input and output tokens
- Exactly one terminal outcome per turn: `success`, `error`, `interrupted`, or `cancelled`
- Time to first user-visible response and end-to-end turn latency histograms

## Running Locally

### Prerequisites

- Python 3.14
- [uv](https://docs.astral.sh/uv/) (recommended) or pip
- MongoDB (local or remote)
- At least one LLM provider configured

### Installation

```bash
cd ai_platform_engineering/dynamic_agents

# Create virtual environment and install dependencies
uv sync

# Or with pip
pip install -e .
```

### Configuration

Create a `.env` file in the `dynamic_agents` directory:

```bash
# Server
HOST=0.0.0.0
PORT=8001
DEBUG=false
# Serve /metrics on a dedicated port instead of PORT (default: unset, same port as PORT).
# Useful when the main API port is on strict mTLS but metrics scrapers need a permissive port.
# METRICS_PORT=9001

# MongoDB
MONGODB_URI=mongodb://localhost:27017
MONGODB_DATABASE=caipe

# Collections (defaults shown)
DYNAMIC_AGENTS_COLLECTION=dynamic_agents
MCP_SERVERS_COLLECTION=mcp_servers

# Authentication
# In production, the Next.js gateway injects X-User-Context headers.
# For local development, set DEBUG=true to bypass auth with a dev admin user.
DEBUG=true

# LLM Provider (configure at least one)
# For Anthropic:
ANTHROPIC_API_KEY=your-api-key

# For OpenAI:
# OPENAI_API_KEY=your-api-key

# For Azure OpenAI:
# AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
# AZURE_OPENAI_API_KEY=your-api-key
# AZURE_OPENAI_API_VERSION=2024-02-15-preview

# For AWS Bedrock:
# AWS_DEFAULT_REGION=us-west-2
# AWS_ACCESS_KEY_ID=your-key
# AWS_SECRET_ACCESS_KEY=your-secret

# Tracing (optional)
ENABLE_TRACING=false
# LANGFUSE_PUBLIC_KEY=pk-lf-xxx
# LANGFUSE_SECRET_KEY=sk-lf-xxx
# LANGFUSE_HOST=http://langfuse-web:3000

# Runtime
AGENT_RUNTIME_TTL_SECONDS=3600  # Cache TTL for agent runtimes

# CORS
CORS_ORIGINS=["*"]
```

### Running the Server

```bash
# With uv
uv run uvicorn dynamic_agents.main:app --reload --port 8001

# Or directly
python -m uvicorn dynamic_agents.main:app --reload --port 8001
```

The API documentation is available at:
- Swagger UI: http://localhost:8001/docs
- ReDoc: http://localhost:8001/redoc

## Configuration Reference

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HOST` | Server bind address | `0.0.0.0` |
| `PORT` | Server port | `8001` |
| `METRICS_PORT` | Dedicated port for `/metrics` (0 = same as `PORT`) | `0` |
| `DEBUG` | Enable debug mode / hot reload / dev auth bypass | `false` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `MONGODB_DATABASE` | Database name | `caipe` |
| `DYNAMIC_AGENTS_COLLECTION` | Agents collection name | `dynamic_agents` |
| `MCP_SERVERS_COLLECTION` | MCP servers collection name | `mcp_servers` |
| `AUTONOMOUS_TASKS_COLLECTION` | Shared Autonomous task collection, used to authorize manual follow-up chats | `autonomous_tasks` |
| `AUTONOMOUS_RUNS_COLLECTION` | Shared Autonomous run collection, used to select the completed run context | `autonomous_runs` |
| `AGENT_RUNTIME_TTL_SECONDS` | Cache TTL for agent runtimes | `3600` |
| `CORS_ORIGINS` | Allowed CORS origins | `["*"]` |

### Models Configuration

Available LLM models are configured in `src/dynamic_agents/services/config.yaml`:

```yaml
models:
  - model: claude-sonnet-4-20250514
    name: Claude Sonnet 4
    provider: anthropic-claude
    description: Latest Claude Sonnet model

  - model: gpt-4o
    name: GPT-4o
    provider: openai
    description: OpenAI's latest model

  - model: gpt-4o
    name: GPT-4o (Azure)
    provider: azure-openai
    description: GPT-4o via Azure OpenAI
```

### Reasoning effort

Each agent stores a portable default of `low`, `medium`, `high`, or `max`.
Chats can override that value without changing the agent. The runtime only
sends the translated provider parameter for model families that advertise
support; other models retain their provider default.

For a private deployment alias, configure both sides of discovery:

- `MODEL_CAPABILITIES_JSON` advertises the alias and its supported
  `reasoning_efforts` to the Dynamic Agents API and UI.
- `LLM_REASONING_EFFORT_MAP_JSON` maps each portable level to the provider's
  native string or thinking-token budget.

## API Reference

### Health Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/healthz` | GET | Health check with config info |
| `/readyz` | GET | Readiness check (MongoDB connectivity) |

### Agent Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/agents` | GET | User | List agents visible to current user |
| `/api/v1/agents` | POST | Admin | Create new agent |
| `/api/v1/agents/{id}` | GET | User | Get agent by ID |
| `/api/v1/agents/{id}` | PATCH | Admin | Update agent |
| `/api/v1/agents/{id}` | DELETE | Admin | Delete agent |
| `/api/v1/agents/{id}/available-subagents` | GET | Admin | List available subagents |
| `/api/v1/agents/models` | GET | User | List available LLM models |
| `/api/v1/model-capabilities` | POST | User | Resolve input and reasoning capabilities for a model |

### MCP Server Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/mcp-servers` | GET | Admin | List all MCP servers |
| `/api/v1/mcp-servers` | POST | Admin | Create new MCP server |
| `/api/v1/mcp-servers/{id}` | GET | Admin | Get server by ID |
| `/api/v1/mcp-servers/{id}` | PATCH | Admin | Update server |
| `/api/v1/mcp-servers/{id}` | DELETE | Admin | Delete server |
| `/api/v1/mcp-servers/{id}/probe` | POST | Admin | Probe server for available tools |

### Chat Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/chat/stream` | POST | User | Stream chat response (SSE) |
| `/api/v1/chat/invoke` | POST | User | Non-streaming chat (simple integrations) |
| `/api/v1/chat/restart-runtime` | POST | User | Restart agent runtime (reconnect MCP servers) |

### Autonomous Manual Follow-ups

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/autonomous/tasks/{task_id}/follow-up-chats` | GET | List the caller's existing manual follow-up links |
| `/api/v1/autonomous/tasks/{task_id}/runs/{run_id}/follow-up-chat` | POST | Create or reopen a private chat from the selected run's completed checkpoint |

- Requires Autonomous eligibility and task ownership (or admin); creation also requires agent-use permission.
- Follow-up identity comes from the validated user bearer, never `X-User-Context`. Tokens without email use the persisted subject-to-email directory; unresolved identities are denied. Admin access is checked through CAS's organization `manage` policy. Missing/invalid bearers and service-account tokens cannot create personal follow-ups.
- Reconstructs the completed run's checkpoint deltas (messages and in-checkpoint files) into a standalone snapshot, and copies available stored files into the independent context. No model execution occurs until the user sends a message in the new chat.
- Repeated clicks reuse the caller's chat while its saved context exists; they never overwrite it. After permanent deletion or context expiry, continuing creates a fresh copy from the original run, or returns `409` if that source has expired. Archived chats must be restored, not re-created.
- Requires the UI, Dynamic Agents, and Autonomous Agents to use the same MongoDB database for chat, task, and run records. Deploy both the UI and Dynamic Agents changes together.
- Missing snapshots, unfinished tool calls, and custom shared filesystem namespaces return `409`; they never fall back to an empty or shared context.
- Copy destinations are journaled before any private data is written. Failed attempts delete only their own checkpoints, writes, messages, and GridFS uploads (including incomplete chunks). Expired leases cannot publish or overwrite a successful chat.
- A background sweep runs at startup and every minute. It revokes expired five-minute copy leases, retries cleanup after outages, and finishes publication of completed copies. Recovery records remain when a writer was interrupted or a database write's outcome is unknown, so late writes can be cleaned again; these records contain copy coordinates, not chat content. Existing ready follow-ups remain reusable. Recovery covers new journaled attempts; old untracked copies are not bulk-deleted.
- Malformed recovery records are logged and deferred without blocking other attempts. Unexpected sweep errors are retried; cancellation still stops the worker, and shutdown closes the cache/database even if the worker failed.

Run the real-MongoDB copy/recovery tests against a disposable local MongoDB:

```bash
DEBUG=false FOLLOW_UP_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 \
  uv run --frozen --group dev pytest tests/test_autonomous_follow_up_mongodb.py
```

These tests create and remove their own randomly named databases.

### Request/Response Examples

#### Create Agent

```bash
POST /api/v1/agents
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "Code Reviewer",
  "description": "Reviews code for bugs and best practices",
  "system_prompt": "You are an expert code reviewer...",
  "model_id": "claude-sonnet-4-20250514",
  "model_provider": "anthropic-claude",
  "visibility": "global",
  "allowed_tools": {
    "github": ["get_file_contents", "search_code"]
  },
  "builtin_tools": {
    "fetch_url": {
      "enabled": true,
      "allowed_domains": "*.github.com,docs.python.org"
    }
  },
  "subagents": [
    {
      "agent_id": "dynamic-agent-123",
      "name": "test-runner",
      "description": "Runs tests and reports results"
    }
  ]
}
```

#### Chat Stream

```bash
POST /api/v1/chat/stream
Content-Type: application/json
Authorization: Bearer <token>

{
  "message": "Review this code for security issues",
  "conversation_id": "conv-uuid-123",
  "agent_id": "dynamic-agent-456"
}
```

Response (SSE):
```
event: content
data: Let me review

event: content
data:  the code...

event: tool_start
data: {"tool_name":"github_get_file_contents","tool_call_id":"tc-1","args":{"path":"src/auth.py"},"agent":"Code Reviewer","is_builtin":false}

event: tool_end
data: {"tool_name":"github_get_file_contents","tool_call_id":"tc-1","agent":"Code Reviewer","is_builtin":false}

event: content
data: I found several issues...

event: done
data: {}
```

## SSE Event Types

For detailed documentation of all SSE event types including JSON structures, field descriptions, and implementation details, see **[SSE_EVENTS.md](./SSE_EVENTS.md)**.

Quick reference:
- `content` - LLM token streaming
- `tool_start` / `tool_end` - Tool invocation lifecycle
- `todo_update` - Task list updates
- `subagent_start` / `subagent_end` - Subagent delegation lifecycle
- `warning` / `error` - Warnings and errors (rendered inline in chat)
- `done` - Stream complete

## Testing

```bash
cd ai_platform_engineering/dynamic_agents

# Run tests
uv run pytest

# With coverage
uv run pytest --cov=dynamic_agents --cov-report=html
```

## Docker

```bash
# Build
docker build -t dynamic-agents .

# Run
docker run -p 8001:8001 \
  -e MONGODB_URI=mongodb://host.docker.internal:27017 \
  -e DEBUG=true \
  -e ANTHROPIC_API_KEY=your-key \
  dynamic-agents
```

## Project Structure

```
dynamic_agents/
├── src/dynamic_agents/
│   ├── main.py              # FastAPI application entry point
│   ├── config.py            # Settings and configuration
│   ├── models.py            # Pydantic models
│   ├── logging.py           # Logging setup and request context
│   ├── auth/
│   │   ├── auth.py          # JWT authentication (authn)
│   │   └── access.py        # Access control checks (authz)
│   ├── routes/
│   │   ├── agents.py        # Agent CRUD endpoints
│   │   ├── mcp_servers.py   # MCP server endpoints
│   │   ├── chat.py          # Chat streaming endpoints
│   │   └── health.py        # Health check endpoints
│   └── services/
│       ├── agent_runtime.py # Agent execution and caching
│       ├── mongo.py         # MongoDB operations
│       ├── mcp_client.py    # MCP server connections
│       ├── builtin_tools.py # Built-in tool implementations
│       ├── stream_events.py # SSE event builders
│       ├── stream_trackers.py # SSE event emitters
│       └── models_config.py # LLM models configuration
├── tests/                   # Test files
├── pyproject.toml           # Project dependencies
└── README.md                # This file
```

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Detailed architecture documentation
- [SSE_EVENTS.md](./SSE_EVENTS.md) - SSE event types and streaming protocol
- [UI Integration](../../ui/src/components/dynamic-agents/) - Frontend components
- [MCP Protocol](https://modelcontextprotocol.io/) - Model Context Protocol specification

## Optional AGNTCY Agent Badges with Keycloak

Agent Badge publication is disabled by default. Enable it only after enrolling
an AGNTCY issuer and the agent's Keycloak service-account identity in Identity
Node. This is explicit publication of an approved public OASF definition;
existing runtime configuration and permissions remain in MongoDB.

Architecture and trust limits: [Keycloak Agent Badges](../../docs/docs/architecture/keycloak-agent-badges.md),
[Identity discussion #180](https://github.com/agntcy/identity/discussions/180).

### Operator enrollment

1. Create a dedicated Keycloak confidential client with service accounts enabled.
   Configure an access-token audience mapper for `identity-node`. Use a distinct
   service account for each dynamic agent; record its stable token `sub`.
2. Register the AGNTCY issuer using Node `POST /v1alpha1/issuer/register`, supplying
   the AGNTCY public signing JWK and an OIDC proof. The issuer's `commonName`
   must match Node's hostname mapping of the Keycloak issuer. Use
   `authType: ISSUER_AUTH_TYPE_IDP`; the Keycloak realm key signs the proof,
   while the registered AGNTCY key signs badges.
3. Generate agent metadata with `POST /v1alpha1/id/generate`, supplying that
   issuer and the **agent's** Keycloak client-credentials proof. The generic
   OIDC path produces `IDP-<sub>`. Save the returned exact identifier.
4. Use a Node release containing [the resolver-controller API fix #181](https://github.com/agntcy/identity/pull/181). The publisher rejects missing or mismatched controllers.
5. Mount operator bindings, client-secret files and the private signing PEM
   read-only. Keep them outside user-editable agent records and Git.

Bindings file example (paths are container paths):

```json
{
  "primary": {
    "subject": "IDP-primary-sub",
    "token_subject": "primary-sub",
    "client_id": "primary-client",
    "client_secret_file": "/run/agent-identity/primary-client-secret"
  }
}
```

Here `primary` is the existing Mongo agent ID. Replace example subjects with
actual stable Keycloak service-account UUIDs; a client display name is not its
JWT subject. The RSA signing key must be at least 2048 bits and match the Node's
assertion key, including `kid`.

### Runtime configuration

Set these variables on the **dynamic-agents container**, not only in the shell
or the UI container. For Compose, place them in an explicitly loaded override
and mount the secret directory read-only. The default Compose configuration
continues to run with the feature disabled.

```yaml
services:
  dynamic-agents:
    environment:
      AGNTCY_IDENTITY_ENABLED: "true"
      AGNTCY_IDENTITY_NODE_URL: https://node.example.com
      AGNTCY_IDENTITY_BINDINGS_FILE: /run/agent-identity/bindings.json
      AGNTCY_IDENTITY_ISSUER: issuer.example.com
      AGNTCY_IDENTITY_SIGNING_KEY_FILE: /run/agent-identity/signing.pem
      AGNTCY_IDENTITY_SIGNING_KEY_ID: primary-signing-key
      AGNTCY_IDENTITY_KEYCLOAK_ISSUER: https://issuer.example.com/realms/primary
      AGNTCY_IDENTITY_KEYCLOAK_TOKEN_URL: https://issuer.example.com/realms/primary/protocol/openid-connect/token
      AGNTCY_IDENTITY_KEYCLOAK_JWKS_URL: https://issuer.example.com/realms/primary/protocol/openid-connect/certs
      AGNTCY_IDENTITY_KEYCLOAK_AUDIENCE: identity-node
      AGNTCY_IDENTITY_BADGE_TTL_SECONDS: "900"
    volumes:
      - ./agent-identity-secrets:/run/agent-identity:ro
```

Load with `docker compose -f docker-compose.yaml -f compose.identity-badges.yaml up -d`.
TLS verification is enabled. `AGNTCY_IDENTITY_ALLOW_HTTP=true` is an explicit
exception for disposable local integration tests.

### Publish

A signed-in platform admin calls:

```http
POST /api/dynamic-agents/agents/primary/badge
Content-Type: application/json

{
  "name": "primary",
  "version": "1.0.0",
  "schema_version": "1.0.0",
  "description": "Example public agent definition",
  "authors": ["test-user@example.com"],
  "created_at": "2026-01-01T00:00:00Z",
  "annotations": {
    "agntcy.dir/identity": "agntcy://IDP-primary-sub"
  }
}
```

The name must match the existing agent. Submit a complete OASF definition
validated for your Directory schema version; the adapter checks the identity,
name, required version fields and size, and does not claim full OASF schema
validation. The exact definition is embedded in the signed badge. No prompt,
credential or tool configuration is automatically exported.

The response is a publication receipt: `agent_id`, `subject`, `credential_id`,
`issuer`, `expires_at`, `badges_url`, and `definition_sha256`. The BFF stores it in
`agent_identity_badges`. If receipt storage fails after successful publication,
the response includes `receipt_persisted: false`; retain that response for
recovery. The signed badge lives in Identity Node.

`definition_sha256` is not a Directory CID or a verification result. Publish the
same OASF object through the Directory publisher and sign its native IdentityClaim
before expecting verified identity search. This integration does not automatically
publish records to Directory or activate imported MCP servers.

Badges last at most 15 minutes. There is no automatic renewal or immediate
revocation guarantee. Disabling a Keycloak client prevents new publication; an
already-issued badge remains subject to its validity/status policy. Repeated
publication creates another bounded credential. A timeout can leave an unknown
remote outcome: inspect the Node's well-known badge list before retrying.

### Verification

```bash
cd ai_platform_engineering/dynamic_agents
uv run --extra dev ruff check src/dynamic_agents/services/agent_badges.py src/dynamic_agents/routes/agent_badges.py
uv run --extra dev pytest tests/test_agent_badges.py
```

An opt-in live test exercises the real backend route, Keycloak token/JWKS,
Node resolution, signature verification, publication and well-known retrieval.
It also checks rejection of a badge signed with an unauthorized key:

```bash
AGNTCY_BADGE_LIVE_SETTINGS=/absolute/path/to/disposable-settings.json \
  uv run --extra dev pytest tests/test_agent_badges_live.py
```

The settings JSON uses the lowercase `agntcy_identity_*` configuration fields
corresponding to the variables above and points at pre-enrolled **disposable**
services. The test uses the `primary` binding, issues a real credential and
leaves it in the disposable Node. It does not test the Directory reconciler or
CAIPE runtime identity enforcement.
