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

### Native ACP execution

Default and custom agent turns execute through one in-service Agent Client
Protocol (ACP) path while keeping their existing DeepAgents/LangGraph runtime.
The native ACP client and logical agent exchange JSON-RPC messages using the
pinned Python SDK 0.12.1, schema 1.19 and wire protocol 1.

- Existing chat endpoints, AG-UI/custom SSE, workflow/invoke behavior, native
  tools, logical files, subagent delegation and human input remain available.
- Capability negotiation uses `caipe.io/native-acp` metadata and acknowledged
  `_caipe/event` requests for validated native stream events. Standard ACP
  session loading, client filesystem and terminal capabilities are not
  advertised. This integration does not expose a public ACP server.
- `native_acp_sessions` stores effective agent configuration admissions and
  session bindings using `MONGODB_URI` and `MONGODB_DATABASE`, alongside existing
  CAIPE records and native checkpoints. Tokens and MCP credentials are excluded.
- `native_acp_runs` coordinates concurrent replicas using an owned 120-second
  turn lease with one-second heartbeat/cancellation polling. Expiry permits
  later checkpoint-based continuation; it does not restart crashed runs or
  guarantee exactly-once tool effects. Worker clocks must be synchronized.
- New turns refresh the effective configuration while preserving the first
  admitted backend/checkpoint/filesystem binding; human-input resume restores
  the last admitted snapshot after runtime-cache eviction, narrowed by the
  current validated tool scope.
- Conversation and execution-context IDs keep their original LangGraph thread
  IDs. Interactive transcripts still use the existing browser/BFF writer.
- Cached runtimes refresh their current caller, bearer and client context before
  execution. Include ACP bindings, coordination and native state in canonical
  database backups; restored leases do not trigger automatic execution.
- Ordinary `/invoke` retains its ephemeral checkpoint/history behavior unless
  `INVOKE_PERSIST_HISTORY` is enabled; transient turn coordination still uses
  MongoDB. Scheduler invocations retain their existing persistent execution.

The shared execution service owns admission, MCP resolution, runtime lifetime,
ACP dispatch and conversation-state operations. HTTP routes retain
authorization and request/response handling. LangGraph chunks become typed
events once; ACP publishes them directly and the client renders AG-UI or custom
SSE. Streaming, human-input resume and invoke all use this path; the native
runtime remains the execution implementation behind the logical ACP agent.
Runtime construction, saved bindings and state deletion share one storage
resolver. Deployment rollback uses the previous image pin and release values
through the normal deployment process.

This is the native-runtime stage of the
[metaharness proposal](https://github.com/orgs/caipe-io/discussions/2877), related
to the gateway and session foundation in the
[Harness Engine discussion](https://github.com/orgs/caipe-io/discussions/2405).
Remote transports, discovery, detached execution and sandbox runtimes are not
implemented. See the [architecture guide](../../docs/docs/architecture/native-acp-metaharness.md)
for session ownership and filesystem/network boundaries.

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
