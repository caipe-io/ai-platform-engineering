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

- Python 3.13+
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
AGENT_RUNTIME_TTL_SECONDS=300  # Cache TTL for agent runtimes

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
| `AGENT_RUNTIME_TTL_SECONDS` | Cache TTL for agent runtimes | `300` |
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
