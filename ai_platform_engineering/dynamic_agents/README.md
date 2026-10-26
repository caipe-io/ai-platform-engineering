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

### ACP execution and runtime placement

Native start, human-input resume and invoke use one ACP execution service while
retaining DeepAgents/LangGraph and its logical filesystem. An opt-in Claude Code
profile uses that same service with a private real filesystem and canonical
native-state checkpoints. Existing agents and conversations keep their binding.
The native and sandbox additions are under review; source/prebuild tests do not
establish deployment-specific authentication, model, skills or policy readiness.

Default and custom agent turns execute through one in-service Agent Client
Protocol (ACP) path while keeping their existing DeepAgents/LangGraph runtime.
The native ACP client and logical agent exchange JSON-RPC messages using the
pinned Python SDK 0.12.1 and wire protocol 1, with released schema 1.26.0 as the feature-coverage reference.

| Runtime | Saved configuration | Session and files |
| --- | --- | --- |
| Managed Agent (default) | `execution.kind=native`; existing model, tools and skills | Original LangGraph thread, checkpoints and admitted logical filesystem. Interactive storage defaults to the conversation; existing workflow artifact scopes remain intact. |
| Private Coding Sandbox | `execution.kind=sandbox` and an operator-owned `profile_id` | Separate environment/HOME and native session per caller-owned conversation. Real working files restore from canonical native checkpoints; bounded artifacts use existing CAIPE storage. |

The authenticated runtime catalog exposes admitted profiles and descriptive
runtime/workspace/policy metadata. Only implemented runtime choices are listed.
Definitions save only the execution kind and profile reference; derived metadata
is not writable configuration or proof of live policy enforcement.
Legacy profile snapshots and durable binding shapes remain compatible. Provider
claims for shared/user-wide workspaces or unsupported runtimes are rejected.
Sharing an agent definition or transcript does not transfer its private native
session or shell ownership.

The [Harness Gateway](https://github.com/caipe-io/ai-platform-engineering/pull/2401)
is the canonical BFF front door for the
[metaharness proposal](https://github.com/orgs/caipe-io/discussions/2877).
It resolves the saved execution owner before consulting a mutable agent default.
Managed agents retain this native ACP execution service, coordinator and journal;
existing SDK/AgentCore descriptors route to Engine's provider coordinator. There
is one producer and authoritative journal per run, with both owners using
canonical CAIPE MongoDB. Engine does not wrap native detached execution or
replace native tools, checkpoint or approval handling.

| Contract | Behavior |
| --- | --- |
| ACP | Released Python SDK `0.12.1`, stable wire protocol `1`. Typed `caipe.io/native-acp` events retain native progress and checkpointed human input. Coding harnesses use standard new/load/prompt/update/permission/cancel. A validated form shim rejects unsupported schemas and URL elicitation. |
| Client APIs | Existing AG-UI/custom SSE, invoke and conversation writers remain shared. Native invoke retains persistent/ephemeral semantics; sandbox execution requires durable admission and provider binding. |
| Bindings and leases | `native_acp_sessions` stores admitted configuration/storage/placement. The existing `native_acp_runs` lease is 120 seconds with one-second heartbeat/cancellation polling. Workers require synchronized clocks. |
| Detached runs | Execution/event journals persist stable turn identity, sequenced frames and outcomes. Reconnect/reload does not repeat prompts or tools; subscriber loss is not cancellation. |
| Tools and decisions | A random run capability reaches the CAIPE MCP broker. Caller/downstream connector tokens remain in trusted service closures. Current tools, workflows, approvals and native children retain their owners and admission checks. |
| Continuation | Native sessions retain checkpoint/file coordinates. Sandbox sessions also pin caller, connection, profile revision, environment UID/cwd and provider session. Failed load cannot silently start another session or fall back to DeepAgents. |
| Clear/delete | Retire obsolete replay under admission, delete the exact remote generation, purge owned checkpoints and reset its references. Cleanup failures remain visible/retryable; retained provider backups follow operator policy. |
| Rewind/restart | Sandbox rewind restores the retained pre-prompt state and native-child checkpoints; a durable edit intent gates continuation until UI history is reconciled. Restart reloads the same native session/workspace without deletion or prompt replay. |

Managed logical files are not an OS sandbox. Private coding profiles require
enforced filesystem/network boundaries below the model. Codex admission,
cross-harness checkpoint migration and native-parent-to-sandbox-child delegation
are excluded. Configured native children of a sandbox parent remain available
through their own admitted execution contexts.

See the [architecture guide](../../docs/docs/architecture/native-acp-metaharness.md)
for the shared gateway, session ownership and environment policy contract.

#### Canonical native state and recovery

Claude Code keeps its native file layout while running. Before success, CAIPE
drains ACP, validates the complete bounded HOME/workspace archive and publishes
its head under the current lease. Every later native load restores that committed
head, even on a healthy provider volume. Storage failure is not a completed turn.

- Archives preserve native transcripts, child state, compaction, file history,
  workspace and local database/WAL files. Fixed scratch/locks and known native
  login files are excluded; deployment credentials are supplied again.
- A lost environment is recoverable only from committed state with its original
  caller/profile/native versions/session ID. Durable restore intent, exact
  receipts and lease-fenced rebinding prevent execution on a partial restore.
- Three recent recovery versions and restore provenance are retained. Turn edit
  boundaries pin additional state with conversation history; clear/delete and
  bounded orphan cleanup remove live records/blobs.
- Before the first settled prompt there may be no native checkpoint. Hard loss
  reports interruption and retains the last committed state. Uncertain external
  effects, prompts and approval callbacks are never automatically repeated.
- One consistent canonical MongoDB backup includes history, bindings, leases,
  execution/events, tool requests, manifests and complete GridFS buckets.
  Provider volumes are working copies. Restored leases expire instead of
  restarting work; a backup does not preserve a live process.

The [architecture guide](../../docs/docs/architecture/native-acp-metaharness.md)
covers the execution/state diagrams, prompt mapping, policy boundaries and
provider ownership. The [metaharness proposal](https://github.com/orgs/caipe-io/discussions/2877)
covers the wider design and relationship to the
[Harness Engine work](https://github.com/orgs/caipe-io/discussions/2405).

Run the native continuity, decisions, broker, artifacts and lifecycle tests on a
disposable MongoDB. Tests create/remove only their own randomly named databases:

```bash
PYTHONPATH=../.. \
NATIVE_ACP_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 \
FOLLOW_UP_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 \
uv run --extra dev pytest -q -rs
```

Deterministic provider/model fixtures exercise real ACP serialization and MongoDB
admission. They do not replace deployment acceptance against the actual provider.

### Optional app-context prompt adapter

- Structured `client_context` remains separate from the user's message.
- Off by default. Operators may opt in an agent through its deployment-owned YAML definition:

```yaml
app_context_prompt:
  app_ids: [example-app]
  fields: [title, selection.city, selection.forecast.temperature]
  max_bytes: 4096
```

- A chat `config_override` cannot enable or change this policy; the ordinary agent editor does not edit it.
- Send `source: agentic_app_context`, `trust: untrusted_user_visible_data`, the matching `appId`,
  and a timezone-qualified `expiresAt` in the next ten minutes. `selection` may be an object or JSON string.
- Only configured scalar paths are projected: `title`, `summary`, `route`, or dotted `selection.*` paths.
  Whole objects/arrays, credential-named paths, bearer/JWT-looking values and strings over 2,048 characters are omitted.
- Invalid/expired context, input over 16 KiB, or formatted output over the configured limit is omitted.
  Limits include the complete formatted reference block; oversize data is not silently truncated into invalid JSON.
  Expiration is rechecked when preparing model requests, including after a long-running tool.
- When PII middleware is enabled, the adapter omits the projection. PII middleware checks graph-state
  messages before this request-only block is added, so it cannot redact or block the projected data.
- The root agent receives a labelled, untrusted reference block in a copy of its current model request.
  The UI question, system instructions, attachments, and checkpoint messages are not rewritten.
  Subagents are not implicitly opted in. Context is task-local and reset on success, exception or cancellation.
- Streaming, invoke and resume use only the current request, including when the runtime is cached. Resume requires
  resending fresh context; no old snapshot is replayed. This adapter does not add snapshots to checkpoint state.
- App IDs, resource references and trust labels from the browser are not authorization evidence. Existing API/tool
  permissions remain authoritative. Delimiters and heuristics are not a prompt-injection defense or a secret scanner.
- Selected data reaches the model and may appear in provider traces/logs. Include only necessary, approved data.
  Existing raw-context tooling/templates and their telemetry are unchanged; this adapter is not a general DLP layer.

## Running Locally

### Prerequisites

- Python 3.14
- [uv](https://docs.astral.sh/uv/) (recommended) or pip
- MongoDB (local or remote)
- An LLM provider for native agents; sandbox model access is configured by its execution profile

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
# Use Keycloak for local development and production.
KEYCLOAK_URL=http://localhost:7080
KEYCLOAK_REALM=caipe
# Set OIDC_ISSUER when the browser-facing issuer differs from KEYCLOAK_URL.
DEBUG=false

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

## Tool call recovery

Every agent and subagent checks model output before executing tools:

- Output-limit stops (`length` / `max_tokens`), invalid tool-call JSON, and invalid
  Pydantic tool arguments trigger recovery. Remote JSON-schema tools are checked
  for missing required top-level arguments and malformed `required` metadata.
- The entire defective parallel batch is rejected, including otherwise complete
  calls. Rejected calls never run and raw tool-use blocks are removed from history.
- The model gets one repair attempt, with feedback to use smaller file edits.
  Consecutive failure counts belong to each invocation and reset after success.
- Exhaustion emits an actionable stream error for start/resume, or HTTP 422 for
  invoke. A later conversation turn can continue from the sanitized checkpoint.

This guard does not change context compaction thresholds or model output budgets.

## Configuration Reference

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HOST` | Server bind address | `0.0.0.0` |
| `PORT` | Server port | `8001` |
| `METRICS_PORT` | Dedicated port for `/metrics` (0 = same as `PORT`) | `0` |
| `DEBUG` | Enable debug mode / hot reload | `false` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `MONGODB_DATABASE` | Database name | `caipe` |
| `DYNAMIC_AGENTS_COLLECTION` | Agents collection name | `dynamic_agents` |
| `MCP_SERVERS_COLLECTION` | MCP servers collection name | `mcp_servers` |
| `AUTONOMOUS_TASKS_COLLECTION` | Shared Autonomous task collection, used to authorize manual follow-up chats | `autonomous_tasks` |
| `AUTONOMOUS_RUNS_COLLECTION` | Shared Autonomous run collection, used to select the completed run context | `autonomous_runs` |
| `AGENT_RUNTIME_TTL_SECONDS` | Cache TTL for agent runtimes | `3600` |
| `CORS_ORIGINS` | Allowed CORS origins | `["*"]` |
| `SANDBOX_SERVICE_URL` | Operator-owned provider base URL, optionally with an installed base path; the client appends `/api/caipe` | Empty |
| `HARNESS_TOOLS_PUBLIC_URL` | Sandbox-reachable CAIPE MCP base, normally `https://caipe.example.test/api/v1/harness-tools`; each run appends `/{run_id}/mcp` | Empty |
| `HARNESS_TOOLS_ALLOW_HTTP` | Explicit private/local exception for plaintext MCP broker transport | `false` |
| `SANDBOX_PROVISION_TIMEOUT_SECONDS` | Readiness wait; timeout retains idempotent provision intent for retry/cleanup | `600` (10–1800) |


### Sandbox runtime configuration

These settings expose configured profiles without changing existing agents or
deploying a provider. HTTPS, independent CAIPE issuer/audience/JWKS validation,
access restrictions, compatible model/skills/tools, enforced filesystem/egress
policy and recoverable native state are provider admission requirements.
Definitions contain no control-plane URL, image, command or model credential.

```json
{
  "name": "Example code agent",
  "system_prompt": "Work on the admitted workspace and use configured CAIPE tools.",
  "execution": {"kind": "sandbox", "profile_id": "primary-claude"},
  "allowed_tools": {}
}
```

The authenticated `/api/v1/runtime-profiles` endpoint discovers profiles using
the current caller. The editor checks declared MCP/skills/attachment capability
before accepting those resources. Profile capabilities are qualification
claims, not permission grants; a missing capability remains unavailable.
The profile owns the harness/model; native agents still require a model.

The fixed provider contract is relative to `SANDBOX_SERVICE_URL`:

| Operation | Request/result |
|---|---|
| `GET /api/caipe/profiles` | `{profiles:[{id,name,harness,revision,capabilities,...}]}`; `harness` is `claude-code`; the exact `state_contract` and pinned native versions are required. |
| `POST /api/caipe/sandboxes` | `{conversation_id:<UUID>,profile_id,revision}`; returns `id,uid,namespace,conversation_id,profile_id,revision,cwd,state,resource_version`. Creation retries must be idempotent. |
| `GET /api/caipe/sandboxes?conversation_id=...&profile_id=...` | Read-only owner-bound recovery lookup after an uncertain creation response; never creates an environment. |
| `GET /api/caipe/sandboxes/{id}` | Fresh allocation identity/version; retired profiles must retain metadata for safe cleanup without permitting execution. |
| `POST /api/caipe/sandboxes/{id}/execution-grant` | Fresh caller bearer plus `{conversation_id,uid,run_id}`; returns an opaque bounded capture token and its expiry. The token is held only for the admitted turn. |
| `DELETE /api/caipe/sandboxes/{id}/execution-grant` | Exact run identity and its capture token revoke that grant without revoking a newer run. |
| `POST .../{id}/resume` or `/suspend`; `DELETE .../{id}` | `{conversation_id,uid,resource_version}`; reject generation/version mismatches. Deletion follows provider retention policy. |
| `PUT .../{id}/workspace` | `{conversation_id,uid,files}`; one managed instructions/skills/`inputs/` snapshot, max128 files/1MiB total/256KiB each. |
| `GET .../{id}/workspace/files`; `GET .../content?path=...` | Owner/UID query binding; bounded relative regular-text listing/content. No credentials/private state/symlink traversal. |
| `PUT .../{id}/workspace/content` | `{conversation_id,uid,path,content}`; atomic ordinary UTF-8 write, max256KiB, returning `{path,bytes}`. |
| `POST .../{id}/state/export` | Owner/UID-bound quiescent export: bounded NDJSON header, base64 chunks and complete frame, with format, native versions, exclusions, hash and byte count. |
| `POST .../{id}/state/restore`; `GET .../{id}/state/receipt` | Restore a committed archive under a unique restore identity; verify the exact receipt before publishing a replacement binding. Interrupted restore blocks execution. |
| `WS .../{id}/acp?conversation_id=...&uid=...` | Non-TTY ACP JSON-RPC, one object/message, max8MiB, stderr excluded. |

Instruction/skill preparation locks against active execution. Ordinary artifact
reads/writes remain available during ACP. CAIPE snapshots only admitted
canonical text/binary input files into `inputs/` and publishes bounded ordinary output back
to the existing file store. Default bridge limits are 64 files, 512KiB total
inputs, 512KiB per readable output and 4MiB output export; omitted files produce
explicit warnings. Existing `format_file` mirrors the newly formatted copy into
the real workspace so the harness can read the tool's result.

Binary exchange uses strict base64 on the same workspace content endpoint, with
byte-count/SHA-256 receipts. Canonical binary records use `encoding=base64` in
the existing GridFS namespace; downloads decode the original bytes. Text
previews and `format_file` remain text-only. Credential, instruction and native
state paths are excluded from ordinary artifact publication.

The provider must support the exact versioned HOME/workspace state contract, pin image/command and
policy revision, isolate users and validate actual process environment identity.
Long-lived admitted execution may outlive its handshake bearer; reconnect must
reauthenticate and operator deadlines/revocation controls still apply. A CLI may
receive a scoped deployment-owned model credential; this is not out-of-process
credential isolation. The Linux supervisor reaps and stops detached descendants
as well as the original process group. Container policy remains the security
boundary against deliberately hostile same-UID code.

An admitted execution grant keeps workspace exchange and checkpoint capture
available after that bearer expires. `X-CAIPE-Execution-Grant` is accepted only
on the exact run's ordinary workspace list/content, state export and grant revoke
operations; never on creation, restore, ACP or lifecycle control. The provider
stores only the grant hash and rechecks its identity, policy and deadline.
CAIPE revokes it after capture; the agent never receives it. Tool authorization
still follows the existing caller/grant lifecycle.

Scheduled runs reuse CAIPE's existing real owner-token exchange. Other
unattended runs retain their verified service-account identity, admitted by an
explicit provider subject/client pair; CAIPE/CAS continues to authorize the run
and its tools. Email headers cannot impersonate a human.

Provider acceptance includes actual model/authentication and MCP reachability,
skills, cancellation, filesystem/network denial, native restore after process or
working-volume loss and backup/deletion behavior. A profile capability declaration
or successful ACP handshake alone establishes none of those properties.

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
| `/api/v1/runtime-profiles` | GET | User | Discover current caller's configured sandbox profiles and capability declarations |
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
| `/api/v1/chat/runs` | GET | User | Read latest authorized run for an agent/conversation |
| `/api/v1/chat/runs/{run_id}` | GET | User | Read an authorized run outcome |
| `/api/v1/chat/runs/{run_id}/stream` | GET | User | Replay persisted frames after a sequence cursor |
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

When using the local Compose Keycloak service, join its network so the
`keycloak` hostname resolves. The issuer must match the browser-facing URL
in the token.

```bash
# Build
docker build -t dynamic-agents .

# Run
COMPOSE_NETWORK=$(docker inspect keycloak --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}')
docker run --network "$COMPOSE_NETWORK" -p 8001:8001 \
  -e MONGODB_URI=mongodb://host.docker.internal:27017 \
  -e KEYCLOAK_URL=http://keycloak:7080 \
  -e OIDC_ISSUER=http://localhost:7080/realms/caipe \
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


## Remote A2A agents

- Register endpoints in **Agents > Advanced > Remote A2A Agents** as a platform admin.
- Select multiple registry entries for an agent or its subagents. Each entry becomes a callable tool.
- Configure an overall execution deadline (1–600 seconds); agent authors can override it per selection.
  The deadline includes credential resolution, Agent Card discovery, and execution; stream activity does not reset it.
- Check **Stream responses** when adding or editing a registry entry to opt into A2A streaming. It defaults to off and applies to callers of that entry.
- Streaming uses the official SDK and Agent Card capability negotiation. Endpoints without streaming support return complete responses.
- Remote text appears progressively in the running tool output panel, including calls from subagents. Artifact append/replacement semantics are preserved; the completed result is passed to the parent agent. Disconnected/failed streams surface errors rather than successful partial answers.
- Choose **User JWT**, **Saved secret**, or **Connected credential**, then set the header name.
- `Authorization` sends a Bearer token; other headers receive the value directly.
- Saved secrets require the invoking caller's use permission. Connected credentials resolve the invoking caller's own provider account.
- Set `CREDENTIAL_API_URL` to the UI credential API (for example `http://caipe-ui:3000/api/credentials`) for secrets and connected accounts. `CREDENTIAL_SERVICE_AUDIENCE` defaults to `caipe-credential-service`.
- Credentials resolve on every invocation. Registry edits invalidate cached runtimes on the next request.
- Agent Card discovery and calls use the official A2A SDK with JSON-RPC or HTTP+JSON negotiation.
- Calls use the registered endpoint. Register a gateway URL to gate A2A calls; `AGENT_GATEWAY_URL` configures MCP routing only.

### Standalone examples

- [sample_a2a_agents](https://github.com/caipe-io/sample_a2a_agents) owns the Netutils and Weather example servers, their SDK adapter, tests, Docker image, and Compose/gateway configuration.
- Follow that repository's setup guide to attach the examples to the running platform network. They are not bundled in the Dynamic Agents image or platform Compose files.
- Register Netutils for direct A2A calls or Weather through its Keycloak JWT gateway in **Advanced > Remote A2A Agents**. Select both, optionally enable **Stream responses**, and **Save Changes**.

### Authentication and destination policy

- Registry writes and Agent Card discovery require CAS `manage` permission on the configured organization.
  The backend probe repeats this check using the validated caller JWT; context flags do not grant access.
- Parent agent execution requires CAS `use` permission. Selected remote entries define its callable tools.
  The remote agent or its gateway enforces its own policies with the configured credential.
- `DEBUG` controls diagnostics/reload and never creates an administrator identity.
  Use the [Keycloak developer workflow](../../deploy/keycloak/README.md#developer-authentication)
  for local login; its Compose override disables anonymous authentication and RBAC bypass flags.
- A2A credentials are sent only to the registered origin. Agent Cards that advertise
  another origin are rejected; register the externally reachable gateway origin instead.
- HTTPS is required by default. For private/local Docker examples, set
  `REMOTE_A2A_ALLOWED_HTTP_ORIGINS=["http://netutils-agent:8120","http://weather-agentgateway:4000"]`
  in the DA deployment. Trusting HTTP permits plaintext credential transmission on
  that network; do not add public HTTP origins.

### A2A execution and response limits

- `REMOTE_A2A_MAX_OUTPUT_BYTES`: maximum accumulated UTF-8 text (messages, artifacts, and status), default **1 MiB**.
- `REMOTE_A2A_MAX_RESPONSE_BYTES`: total HTTP response bytes across discovery and execution in one call, default **8 MiB**. All response bytes count, including metadata, non-text payloads and SSE comments, before SDK parsing.
- Configure these positive integer settings on the Dynamic Agents service. They apply to parent and subagent tools. UI timeouts remain bounded to 1–600 seconds.
- Discovery probes use the response cap and a **10-second overall deadline**.
- Requests use `Accept-Encoding: identity`; compressed responses are rejected to keep decompression from bypassing the response budget.
- Exceeding a limit fails the tool call and closes the active response stream and SDK client. Oversized snapshots are not emitted; partial output is not returned as a successful answer. Closing a local stream does not guarantee cancellation of work already running on the remote service.
- Remote endpoints must be trusted and administrator-approved. Mandatory AgentGateway routing, verified calling-agent identity and CAS delegation authorization are tracked in [#2914](https://github.com/caipe-io/ai-platform-engineering/issues/2914).
