# Dynamic Agents Architecture

This document provides detailed architecture documentation for the Dynamic Agents service, including agent runtime mechanics, data flow, MongoDB storage, and UI integration.

## Design Philosophy

This codebase follows the ["Worse is Better"](https://en.wikipedia.org/wiki/Worse_is_better) (New Jersey) philosophy: favor simple implementations over complex abstractions. Prefer straightforward code that's easy to understand and debug over elegant but opaque solutions.

### Guidelines

- **Duplicate code over wrong abstraction** - It's okay to have similar code in two places if a shared abstraction would be forced or confusing
  - *Example: Visibility filtering logic exists in both UI API routes and Python backend rather than a shared library*

- **Direct queries over ORMs** - Use simple MongoDB/PyMongo queries with Pydantic models rather than heavy abstraction layers
  - *Example: `collection.find_one({"_id": id})` + `DynamicAgentConfig(**doc)` instead of an ORM*

- **Flat file structure over deep nesting** - Keep directory structure shallow and predictable
  - *Example: Max 3 levels (`src/dynamic_agents/services/`), no `services/agents/runtime/cache/` hierarchies*

- **SSE as triggers, API as source of truth** - For agent state (checkpoints, history, todos), use SSE to signal changes, then fetch from API
  - *Exception: Chat token streaming uses inline SSE payloads for latency*

## Table of Contents

- [System Overview](#system-overview)
- [Code Structure](#code-structure)
- [Application Startup](#application-startup)
- [Message Flow](#message-flow)
- [Agent Runtime Architecture](#agent-runtime-architecture)
- [Data Flow](#data-flow)
- [MongoDB Storage](#mongodb-storage)
- [Config-Driven Seeding](#config-driven-seeding)
- [UI Integration](#ui-integration)
- [API Flow](#api-flow)
- [Session-Based Logging](#session-based-logging)

---

## System Overview

Dynamic Agents is the FastAPI runtime service for CAIPE agents. It uses the `deepagents` library to create AI agents configured through the UI.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  Browser                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         Next.js UI                                   │    │
│  │  ┌─────────────────┐    ┌─────────────────┐    ┌────────────────┐   │    │
│  │  │  ChatPanel      │    │ DynamicAgent    │    │  AgentEditor   │   │    │
│  │  │  (unified)      │    │ ChatView        │    │  (admin)       │   │    │
│  │  └────────┬────────┘    └────────┬────────┘    └───────┬────────┘   │    │
│  └───────────┼──────────────────────┼─────────────────────┼────────────┘    │
└──────────────┼──────────────────────┼─────────────────────┼─────────────────┘
               │                      │                     │
               │ SSE Stream           │ SSE Stream          │ REST API
               ▼                      ▼                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Next.js API Routes (Proxy)                          │
│   /api/dynamic-agents/chat/stream    /api/dynamic-agents/*   /api/mcp-servers│
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Dynamic Agents Service (FastAPI)                       │
│                               Port 8001/8100                                  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                            Routes                                       │  │
│  │  /api/v1/agents/*    /api/v1/mcp-servers/*    /api/v1/chat/*           │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                          │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐   │
│  │  AgentRuntime   │    │  MongoService   │    │  MCPClient              │   │
│  │  (cached)       │    │                 │    │  (MultiServer)          │   │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────────────┘   │
│           │                      │                      │                     │
│           ▼                      ▼                      ▼                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐   │
│  │  deepagents     │    │    MongoDB      │    │  MCP Servers            │   │
│  │  (LangGraph)    │    │                 │    │  (stdio/sse/http)       │   │
│  └────────┬────────┘    └─────────────────┘    └─────────────────────────┘   │
│           │                                                                   │
│           ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  LLM Providers (Anthropic, OpenAI, Azure, Bedrock, etc.)                │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Code Structure

The Dynamic Agents service is organized as follows:

```
src/dynamic_agents/
├── main.py                 # FastAPI application entry point
├── config.py               # Settings (env vars, defaults)
├── models.py               # Pydantic models (request/response schemas)
├── models_config.yaml      # LLM model definitions
│
├── routes/                 # API endpoints
│   ├── health.py           # GET /health, /ready
│   ├── agents.py           # CRUD for /api/v1/agents/*
│   ├── mcp_servers.py      # CRUD for /api/v1/mcp-servers/*
│   └── chat.py             # POST /api/v1/chat/stream, /invoke, /restart-runtime
│
├── services/               # Business logic
│   ├── agent_runtime.py    # AgentRuntime class, AgentRuntimeCache
│   ├── mongo.py            # MongoDBService (CRUD operations)
│   ├── mcp_client.py       # MCP server connections, tool filtering
│   ├── builtin_tools.py    # Built-in tools (fetch_url)
│   ├── stream_events.py    # SSE event builders (make_*_event)
│   ├── stream_trackers.py  # ToolTracker, TodoTracker, SubagentTracker
│   └── seed_config.py      # Config-driven agent/server seeding
│
└── middleware/
    └── auth.py             # JWT authentication, UserContext
```

### Key Files

| File | Purpose |
|------|---------|
| `main.py` | Application entry point. Creates FastAPI app, sets up logging, registers routes, handles startup/shutdown lifecycle |
| `config.py` | `Settings` class with environment variables (MongoDB, auth, CORS, runtime TTL) |
| `routes/chat.py` | Chat endpoint that receives messages and streams SSE responses |
| `services/agent_runtime.py` | Core runtime logic: builds agents, manages cache, streams responses |
| `services/stream_events.py` | Creates structured SSE events (`content`, `tool_start`, etc.) |
| `services/stream_trackers.py` | Tracks tool calls, todos, and subagent invocations during streaming |

---

## Application Startup

When the service starts, the following sequence occurs:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Application Startup Flow                             │
└─────────────────────────────────────────────────────────────────────────────┘

1. main.py executed (via uvicorn or __main__)
        │
        ▼
2. _setup_logging()
   • Creates 'dynamic_agents' logger
   • Adds SessionContextFilter for request tracing
   • Disables propagation to root logger (isolates from cnoe-agent-utils)
        │
        ▼
3. create_app()
   • Creates FastAPI instance with lifespan handler
   • Adds CORS middleware
   • Mounts route modules:
     - health.router → /health, /ready
     - agents.router → /api/v1/agents/*
     - mcp_servers.router → /api/v1/mcp-servers/*
     - chat.router → /api/v1/chat/*
        │
        ▼
4. lifespan() startup
   • Loads settings from environment
   • Connects to MongoDB (get_mongo_service())
   • Applies seed configuration (agents/servers from config.yaml)
        │
        ▼
5. Server ready, listening on port 8001 (default)
        │
        ▼
    ... handles requests ...
        │
        ▼
6. lifespan() shutdown
   • Clears agent runtime cache
   • Disconnects MongoDB
```

**Startup command:**
```bash
# Direct execution
python -m dynamic_agents.main

# Or via uvicorn
uvicorn dynamic_agents.main:app --host 0.0.0.0 --port 8001
```

---

## Message Flow

When a user sends a chat message, here's what happens step by step:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Message Flow (Detailed)                              │
└─────────────────────────────────────────────────────────────────────────────┘

Browser sends: POST /api/dynamic-agents/chat/stream
               Body: { agent_id, message, conversation_id, trace_id? }
               Headers: Authorization: Bearer <jwt>
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Next.js API Route: /api/dynamic-agents/chat/stream                          │
│  Proxies request to Dynamic Agents service                                   │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  routes/chat.py: chat_stream()                                               │
│                                                                              │
│  1. Set session_id_var for logging context                                   │
│  2. Extract user from JWT via get_current_user()                             │
│  3. Load agent config from MongoDB: mongo.get_agent(agent_id)                │
│  4. Check access: _can_use_agent(agent, user)                                │
│  5. Load MCP server configs: mongo.get_servers_by_ids(server_ids)            │
│  6. Return StreamingResponse with _generate_sse_events()                     │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  routes/chat.py: _generate_sse_events()                                      │
│                                                                              │
│  1. Get AgentRuntimeCache singleton                                          │
│  2. Get or create runtime: cache.get_or_create(agent_config, mcp_servers)    │
│  3. Stream response: runtime.stream(message, session_id, user_id)            │
│  4. Format each event as SSE: "event: {type}\ndata: {json}\n\n"              │
│  5. Yield "event: done\ndata: {}\n\n" when complete                          │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  services/agent_runtime.py: AgentRuntimeCache.get_or_create()                │
│                                                                              │
│  Cache key: "{agent_id}:{session_id}"                                        │
│                                                                              │
│  1. Check if runtime exists in cache                                         │
│  2. If exists, check is_stale() (config or MCP server changed?)              │
│  3. If stale or missing, create new AgentRuntime                             │
│  4. Return runtime                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  services/agent_runtime.py: AgentRuntime.initialize()                        │
│  (Called automatically on first stream() if not initialized)                 │
│                                                                              │
│  1. Build MCP connections: mcp_client.build_mcp_connections()                │
│  2. Get tools with resilience: mcp_client.get_tools_with_resilience()        │
│     → Connects to each MCP server independently                              │
│     → Failed servers tracked in self._failed_servers                         │
│  3. Filter tools: mcp_client.filter_tools_by_allowed()                       │
│     → Only include tools in agent's allowed_tools config                     │
│     → Missing tools tracked in self._missing_tools                           │
│  4. Build system prompt from config + extension prompt                       │
│  5. Create LLM via LLMFactory(provider).get_llm(model)                       │
│  6. Resolve subagents (load from MongoDB, recursively build tools)           │
│  7. Create graph: create_deep_agent(model, tools, system_prompt, ...)        │
│     → Uses deepagents library with InMemorySaver for checkpointing           │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  services/agent_runtime.py: AgentRuntime.stream()                            │
│                                                                              │
│  1. Create tracing config (Langfuse integration)                             │
│  2. Set thread_id = session_id for conversation checkpointing                │
│  3. Initialize trackers: ToolTracker, TodoTracker, SubagentTracker           │
│  4. Call self._graph.astream() with stream_mode=["messages", "updates"]      │
│  5. For each chunk, call _transform_stream_chunk() to emit events:           │
│                                                                              │
│     "messages" mode chunks:                                                  │
│       → AIMessageChunk with content → emit "content" event                   │
│       → Skip ToolMessage (internal results, not for user)                    │
│                                                                              │
│     "updates" mode chunks:                                                   │
│       → AIMessage with tool_calls → emit "tool_start" events                 │
│       → ToolMessage (tool result) → emit "tool_end" events                   │
│       → write_todos result → emit "todo_update" event                        │
│       → task tool call → emit "subagent_start" event                         │
│       → task tool result → emit "subagent_end" event                         │
│                                                                              │
│  6. Emit "done" event when stream ends                                       │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  SSE Events sent to browser (via StreamingResponse)                          │
│                                                                              │
│  event: content                                                              │
│  data: I found several issues...                                             │
│                                                                              │
│  event: done                                                                 │
│  data: {}                                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Error Handling

If an error occurs during streaming:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Error during stream (in _generate_sse_events)                               │
│                                                                              │
│  1. Exception caught in try/except                                           │
│  2. Check if LLM-related (deployment, model, auth keywords)                  │
│  3. Build error message with context (provider, model)                       │
│  4. Yield: event: error                                                      │
│           data: {"error": "LLM Connection Error (provider: azure): ..."}     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Agent Runtime Architecture

### How Agents Are Created

When a chat request is received, the Dynamic Agents service:

1. **Loads agent configuration** from MongoDB
2. **Gets or creates an AgentRuntime** from the cache
3. **Initializes the runtime** if needed (builds LLM, tools, graph)
4. **Streams the response** back to the client

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Agent Runtime Creation Flow                          │
└─────────────────────────────────────────────────────────────────────────────┘

    Chat Request
         │
         ▼
┌─────────────────────┐
│  Load agent config  │ ◄── MongoDB: dynamic_agents collection
│  from MongoDB       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐     ┌───────────────────────────────────────┐
│  AgentRuntimeCache  │     │  Cache Key: "{agent_id}:{session_id}" │
│  get_or_create()    │────►│  TTL: AGENT_RUNTIME_TTL_SECONDS       │
└─────────┬───────────┘     │  Invalidation: config change or TTL   │
          │                 └───────────────────────────────────────┘
          │
    ┌─────┴─────┐
    │  Cached?  │
    └─────┬─────┘
          │
    ┌─────┴─────────────────────────┐
    │                               │
    ▼ NO                            ▼ YES (and not stale)
┌─────────────────────┐     ┌─────────────────────┐
│  Create new         │     │  Return cached      │
│  AgentRuntime       │     │  AgentRuntime       │
└─────────┬───────────┘     └─────────────────────┘
          │
          ▼
┌─────────────────────┐
│  Initialize:        │
│  1. Build MCP tools │
│  2. Add built-ins   │
│  3. Build prompt    │
│  4. Create LLM      │
│  5. Resolve subagnts│
│  6. Create graph    │
└─────────────────────┘
```

### Agent Runtime Lifecycle

The `AgentRuntime` class is the core execution unit for a dynamic agent. Each runtime instance is bound to a specific **agent configuration** and **conversation**, maintaining state across multiple messages within that conversation.

#### AgentRuntime Instance Contents

```python
class AgentRuntime:
    """Runtime for a single dynamic agent instance."""
    
    # ═══════════════════════════════════════════════════════════════
    # Core Configuration (immutable for lifetime of runtime)
    # ═══════════════════════════════════════════════════════════════
    config: DynamicAgentConfig      # Agent config from MongoDB
    mcp_servers: list[MCPServerConfig]  # MCP server configurations
    settings: Settings              # App settings (env vars)
    
    # ═══════════════════════════════════════════════════════════════
    # User Context (set at creation time)
    # ═══════════════════════════════════════════════════════════════
    _user_email: str | None         # User's email (for user_info tool)
    _user_name: str | None          # User's display name
    _user_groups: list[str]         # User's group memberships
    
    # ═══════════════════════════════════════════════════════════════
    # Runtime Components (built during initialize())
    # ═══════════════════════════════════════════════════════════════
    _graph: CompiledGraph | None    # LangGraph agent (deepagents)
    _mcp_client: MultiServerMCPClient | None  # MCP connections
    _initialized: bool              # Whether initialize() has been called
    
    # ═══════════════════════════════════════════════════════════════
    # Tracing & Observability
    # ═══════════════════════════════════════════════════════════════
    tracing: TracingManager         # Langfuse integration
    _current_trace_id: str | None   # Current request's trace ID
    
    # ═══════════════════════════════════════════════════════════════
    # Error Tracking (populated during MCP connection)
    # ═══════════════════════════════════════════════════════════════
    _failed_servers: list[str]      # Server IDs that failed to connect
    _failed_servers_error: str      # Formatted error message for UI
    _missing_tools: list[str]       # Tools configured but not available
    
    # ═══════════════════════════════════════════════════════════════
    # Cache Invalidation Timestamps
    # ═══════════════════════════════════════════════════════════════
    _created_at: float              # Unix timestamp of creation
    _config_updated_at: datetime    # Agent config's updated_at
    _mcp_servers_updated_at: datetime  # Latest MCP server updated_at
```

#### What Gets Built During initialize()

When `AgentRuntime.initialize()` is called (automatically on first `stream()` call):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      AgentRuntime.initialize() Steps                         │
└─────────────────────────────────────────────────────────────────────────────┘

1. BUILD MCP CONNECTIONS
   ┌─────────────────────────────────────────────────────────────────────┐
   │  For each server in config.allowed_tools:                           │
   │  • Look up MCPServerConfig from mcp_servers list                    │
   │  • Build connection dict: {server_id: {transport, command/url}}     │
   │  • Connect to servers concurrently (resilient - failures isolated)  │
   │  • Track failed_servers and collect available tools                 │
   └─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
2. FILTER & NAMESPACE TOOLS
   ┌─────────────────────────────────────────────────────────────────────┐
   │  • Tools namespaced as: "{server_id}_{tool_name}"                   │
   │  • Filter to only tools in config.allowed_tools                     │
   │  • Track missing_tools for UI warnings                              │
   └─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
3. ADD BUILT-IN TOOLS (based on config.builtin_tools)
   ┌─────────────────────────────────────────────────────────────────────┐
   │  • fetch_url: HTTP fetching with domain ACL (disabled by default)  │
   │  • current_datetime: Returns current date/time (enabled by default)│
   │  • user_info: Returns user email/name/groups (enabled by default)  │
   │  • sleep: Async sleep for rate limiting (enabled by default)       │
   └─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
4. BUILD SYSTEM PROMPT
   ┌─────────────────────────────────────────────────────────────────────┐
   │  Final prompt = config.system_prompt + "\n\n" + extension_prompt    │
   │                                                                     │
   │  Extension prompt includes:                                         │
   │  • write_todos tool usage instructions                              │
   │  • Formatting guidelines                                            │
   └─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
5. CREATE LLM INSTANCE
   ┌─────────────────────────────────────────────────────────────────────┐
   │  llm = LLMFactory(config.model_provider).get_llm(config.model_id)   │
   │                                                                     │
   │  Supported providers:                                               │
   │  • anthropic-claude    • azure-openai    • bedrock                  │
   │  • openai              • google-genai    • ollama                   │
   └─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
6. RESOLVE SUBAGENTS (if configured)
   ┌─────────────────────────────────────────────────────────────────────┐
   │  For each SubAgentRef in config.subagents:                          │
   │  • Load subagent config from MongoDB                                │
   │  • Recursively build its tools (with cycle detection)               │
   │  • Create SubAgent dict: {name, description, system_prompt, tools}  │
   └─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
7. CREATE LANGGRAPH AGENT
   ┌─────────────────────────────────────────────────────────────────────┐
   │  _graph = create_deep_agent(                                        │
   │      model=llm,                                                     │
   │      tools=tools,                                                   │
   │      system_prompt=full_prompt,                                     │
   │      checkpointer=InMemorySaver(),  # Conversation memory           │
   │      subagents=resolved_subagents,                                  │
   │  )                                                                  │
   └─────────────────────────────────────────────────────────────────────┘
```

#### Conversation State & Checkpointing

Each `AgentRuntime` maintains conversation history via LangGraph's checkpointing:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Conversation Checkpointing                            │
└─────────────────────────────────────────────────────────────────────────────┘

    Cache Key: "{agent_id}:{conversation_id}"
                      │
                      ▼
    ┌─────────────────────────────────────────────────────────────────────┐
    │  AgentRuntime instance                                              │
    │  ├── _graph (LangGraph CompiledGraph)                               │
    │  │   └── checkpointer: InMemorySaver()                              │
    │  │       └── thread_id = conversation_id                            │
    │  │           └── Messages: [user1, ai1, user2, ai2, ...]            │
    │  │                                                                  │
    │  └── Persists across multiple stream() calls for same conversation │
    └─────────────────────────────────────────────────────────────────────┘

    Message 1: "Hello"
         │
         ▼ stream(message, conversation_id="conv-123")
    ┌─────────────────────────────────────────────────────────────────────┐
    │  config["configurable"]["thread_id"] = "conv-123"                   │
    │  → LangGraph loads checkpoint for thread "conv-123"                 │
    │  → Appends user message, runs agent, saves checkpoint               │
    └─────────────────────────────────────────────────────────────────────┘
         │
         ▼
    Message 2: "What did I just say?"
         │
         ▼ stream(message, conversation_id="conv-123")
    ┌─────────────────────────────────────────────────────────────────────┐
    │  → LangGraph loads checkpoint (includes Message 1 + response)       │
    │  → Agent has full conversation context                              │
    │  → Can reference previous messages                                  │
    └─────────────────────────────────────────────────────────────────────┘
```

**Important:** The checkpointer is **in-memory** (`InMemorySaver`). Conversation state is lost when:
- The runtime is evicted from cache (TTL expiration)
- The runtime is manually invalidated (Restart Agent Session)
- The service restarts

The UI stores chat history separately in the browser's zustand store for display purposes.

#### Runtime vs Conversation Relationship

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Runtime vs Conversation Relationship                      │
└─────────────────────────────────────────────────────────────────────────────┘

    User "alice@example.com" has 3 conversations with Agent "code-helper":

    Conversation 1 (conv-aaa)     Conversation 2 (conv-bbb)     Conversation 3 (conv-ccc)
           │                             │                             │
           ▼                             ▼                             ▼
    ┌─────────────────┐           ┌─────────────────┐           ┌─────────────────┐
    │  AgentRuntime   │           │  AgentRuntime   │           │  AgentRuntime   │
    │  cache key:     │           │  cache key:     │           │  cache key:     │
    │  "agent1:aaa"   │           │  "agent1:bbb"   │           │  "agent1:ccc"   │
    │                 │           │                 │           │                 │
    │  Own checkpoint │           │  Own checkpoint │           │  Own checkpoint │
    │  Own MCP conns  │           │  Own MCP conns  │           │  Own MCP conns  │
    └─────────────────┘           └─────────────────┘           └─────────────────┘

    Each conversation has its OWN AgentRuntime instance with:
    • Isolated conversation history (checkpointer)
    • Shared agent config (but separate runtime state)
    • Independent MCP connections
    
    "Restart Agent Session" only affects ONE conversation's runtime.
```

### Caching Strategy

The `AgentRuntimeCache` maintains agent instances with:

| Aspect | Behavior |
|--------|----------|
| **Cache Key** | `{agent_id}:{session_id}` |
| **TTL** | Configurable via `AGENT_RUNTIME_TTL_SECONDS` (default: 300s / 5 minutes) |
| **Invalidation** | Config change detection via `updated_at` timestamps |
| **Manual Invalidation** | `POST /api/v1/chat/restart-runtime` endpoint |
| **Memory Management** | Automatic cleanup of expired runtimes |
| **Checkpointing** | In-memory checkpointer per session for conversation state |

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Cache Invalidation Flow                              │
└─────────────────────────────────────────────────────────────────────────────┘

    get_or_create(agent_config, mcp_servers, session_id)
                        │
                        ▼
              ┌─────────────────┐
              │  Cache lookup   │
              │  by key         │
              └────────┬────────┘
                       │
                 ┌─────┴─────┐
                 │  Found?   │
                 └─────┬─────┘
                       │
         ┌─────────────┴─────────────┐
         │ YES                       │ NO
         ▼                           ▼
┌─────────────────┐         ┌─────────────────┐
│  Check staleness│         │  Create new     │
│  1. TTL expired?│         │  runtime        │
│  2. Config chgd?│         └─────────────────┘
│  3. MCP chgd?   │
└────────┬────────┘
         │
   ┌─────┴─────┐
   │  Stale?   │
   └─────┬─────┘
         │
    ┌────┴────┐
    │         │
    ▼ YES     ▼ NO
┌───────────┐ ┌───────────┐
│ Cleanup & │ │ Return    │
│ recreate  │ │ cached    │
└───────────┘ └───────────┘
```

### Manual Runtime Restart

Users can manually invalidate a cached runtime via the "Restart Agent Session" button in the UI. This is useful when:

- MCP servers that failed at startup have come back online
- The user wants to refresh connections without waiting for TTL expiration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Manual Runtime Restart Flow                             │
└─────────────────────────────────────────────────────────────────────────────┘

    User clicks "Restart Agent Session" button in UI
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        UI: DynamicAgentContext                               │
│                                                                              │
│  POST /api/dynamic-agents/chat/restart-runtime                              │
│  { agent_id, session_id }                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Next.js API Route (Proxy)                             │
│                                                                              │
│  POST → Dynamic Agents Service                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Dynamic Agents: /api/v1/chat/restart-runtime              │
│                                                                              │
│  1. Validate JWT token                                                       │
│  2. Build cache key: "{agent_id}:{session_id}"                              │
│  3. Call cache.invalidate(key)                                              │
│     → Removes runtime from cache                                             │
│     → Closes MCP connections                                                 │
│  4. Return { success: true }                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
    Next chat message → Creates fresh AgentRuntime with new MCP connections
```

### Tool Resolution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Tool Resolution Flow                               │
└─────────────────────────────────────────────────────────────────────────────┘

    Agent Config
    allowed_tools: {
      "github": ["get_file", "search"],
      "rag": []  ← Empty = all tools
    }
         │
         ▼
┌─────────────────────┐
│  build_mcp_         │
│  connections()      │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐     ┌─────────────────────────────────────┐
│  MultiServerMCP     │────►│  Connect to each MCP server         │
│  Client             │     │  - stdio: spawn process             │
│  (tool_name_prefix  │     │  - sse: HTTP SSE connection         │
│   = True)           │     │  - http: HTTP streamable connection │
└─────────┬───────────┘     └─────────────────────────────────────┘
          │
          ▼
┌─────────────────────┐
│  get_tools()        │ ◄── Returns tools with namespaced names:
│                     │     "github_get_file", "rag_search", etc.
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  filter_tools_by_   │ ◄── Filter to only allowed tools
│  allowed()          │     Track missing tools for warnings
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Add built-in tools │ ◄── fetch_url (with domain ACL)
│  if configured      │
└─────────────────────┘
```

### Resilient MCP Server Connections

MCP server connections are designed to be resilient - if one server fails to connect, the agent continues with the remaining servers:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Resilient MCP Connection Flow                             │
└─────────────────────────────────────────────────────────────────────────────┘

    Agent has 3 MCP servers configured:
    [github, rag, slack]
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  get_tools_with_resilience()                                                 │
│                                                                              │
│  1. Connect to each server CONCURRENTLY using asyncio.gather()              │
│  2. Each connection wrapped in try/except                                    │
│  3. Failed servers tracked separately from successful ones                   │
└─────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
    ┌─────────────────────────────────────────────────────────────────────┐
    │  Results:                                                            │
    │  • github: ✓ Connected - 5 tools                                    │
    │  • rag:    ✓ Connected - 3 tools                                    │
    │  • slack:  ✗ Failed - "Connection refused"                          │
    └─────────────────────────────────────────────────────────────────────┘
              │
              ▼
    Returns: (all_tools=[8 tools], failed_servers=["slack"], 
              failed_errors=["slack: Connection refused"])
              │
              ▼
    ┌─────────────────────────────────────────────────────────────────────┐
    │  AgentRuntime stores:                                                │
    │  • _failed_servers: ["slack"]  ← Just names for filtering           │
    │  • _failed_servers_error: ["slack: Connection refused"]  ← For UI   │
    └─────────────────────────────────────────────────────────────────────┘
              │
              ▼
    ┌─────────────────────────────────────────────────────────────────────┐
    │  On first chat message, emit SSE warning event:                      │
    │  {                                                                   │
    │    "type": "warning",                                                │
    │    "data": {                                                         │
    │      "message": "Some MCP servers failed to connect",                │
    │      "failed_servers": ["slack: Connection refused"]                 │
    │    }                                                                 │
    │  }                                                                   │
    └─────────────────────────────────────────────────────────────────────┘
              │
              ▼
    Agent continues with available tools (github + rag)
```

**Key Design Decisions:**

| Aspect | Behavior |
|--------|----------|
| **Concurrency** | All servers connect in parallel using `asyncio.gather()` |
| **Isolation** | One server's failure doesn't block others |
| **Tracking** | Failed servers tracked in `_failed_servers` (names) and `_failed_servers_error` (formatted messages) |
| **Tool Filtering** | Missing tools from failed servers are excluded from warnings |
| **UI Feedback** | Warning SSE event with `failed_servers` array shows server status in sidebar |

### Subagent Resolution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Subagent Resolution Flow                             │
└─────────────────────────────────────────────────────────────────────────────┘

    Parent Agent Config
    subagents: [
      {agent_id: "...", name: "reviewer", description: "..."},
      {agent_id: "...", name: "tester", description: "..."}
    ]
         │
         ▼
┌─────────────────────┐
│  _resolve_subagents │
│  (with cycle        │
│   detection)        │
└─────────┬───────────┘
          │
          │  For each SubAgentRef:
          ▼
┌─────────────────────┐
│  1. Check cycle:    │
│     agent_id in     │
│     visited set?    │ ──► YES: Skip (log warning)
└─────────┬───────────┘
          │ NO
          ▼
┌─────────────────────┐
│  2. Load subagent   │ ◄── MongoDB lookup
│     config          │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  3. Build subagent  │
│     tools (MCP)     │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  4. Build subagent  │
│     prompt          │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  5. Create SubAgent │ ──► {name, description, system_prompt, tools}
│     dict            │
└─────────────────────┘
          │
          ▼
    Pass to create_deep_agent(subagents=[...])
    
    → deepagents auto-creates "task" tool for delegation
```

---

## Data Flow

### Chat Request Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Chat Request Flow                                 │
└─────────────────────────────────────────────────────────────────────────────┘

Browser                     Next.js                    Dynamic Agents
   │                           │                             │
   │  POST /api/dynamic-       │                             │
   │  agents/chat/stream       │                             │
   │  {message, conv_id,       │                             │
   │   agent_id}               │                             │
   │ ─────────────────────────►│                             │
   │                           │  POST /api/v1/chat/stream   │
   │                           │  + Authorization header     │
   │                           │ ───────────────────────────►│
   │                           │                             │
   │                           │                             │ ┌──────────────┐
   │                           │                             │ │ Validate     │
   │                           │                             │ │ JWT token    │
   │                           │                             │ └──────────────┘
   │                           │                             │
   │                           │                             │ ┌──────────────┐
   │                           │                             │ │ Load agent   │
   │                           │                             │ │ from MongoDB │
   │                           │                             │ └──────────────┘
   │                           │                             │
   │                           │                             │ ┌──────────────┐
   │                           │                             │ │ Check access │
   │                           │                             │ │ (visibility) │
   │                           │                             │ └──────────────┘
   │                           │                             │
   │                           │                             │ ┌──────────────┐
   │                           │                             │ │ Get/create   │
   │                           │                             │ │ AgentRuntime │
   │                           │                             │ └──────────────┘
   │                           │                             │
   │                           │        SSE: event: content  │
   │                           │◄───────────────────────────│
   │        SSE: event: content│                             │
   │◄──────────────────────────│                             │
   │                           │                             │
   │                           │      SSE: event: tool_start │
   │                           │◄───────────────────────────│
   │     SSE: event: tool_start│                             │
   │◄──────────────────────────│                             │
   │                           │                             │ ┌──────────────┐
   │                           │                             │ │ Execute MCP  │
   │                           │                             │ │ tool call    │
   │                           │                             │ └──────────────┘
   │                           │                             │
   │                           │        SSE: event: tool_end │
   │                           │◄───────────────────────────│
   │       SSE: event: tool_end│                             │
   │◄──────────────────────────│                             │
   │                           │                             │
   │                           │        SSE: event: content  │
   │                           │◄───────────────────────────│
   │        SSE: event: content│                             │
   │◄──────────────────────────│                             │
   │                           │                             │
   │                           │     SSE: event: final_result│
   │                           │◄───────────────────────────│
   │    SSE: event: final_result                             │
   │◄──────────────────────────│                             │
   │                           │                             │
   │                           │          SSE: event: done   │
   │                           │◄───────────────────────────│
   │          SSE: event: done │                             │
   │◄──────────────────────────│                             │
```

### Streaming Event Transformation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Stream Event Transformation                             │
└─────────────────────────────────────────────────────────────────────────────┘

    LangGraph astream() Output
    (raw LangChain events)
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     _transform_stream_chunk()                                │
│                                                                              │
│  Input: (namespace, mode, data) tuples from astream()                       │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Mode: "messages"                                                    │    │
│  │  - AIMessageChunk with content → emit "content" event               │    │
│  │  - Skip ToolMessage content (internal results)                      │    │
│  │  - Skip AIMessageChunk with tool_calls (tool invocation, not text)  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Mode: "updates"                                                     │    │
│  │  - AIMessage with tool_calls → emit "tool_start" event              │    │
│  │    - If tool_name == "task" → emit "subagent_start" instead         │    │
│  │    - If tool_name == "write_todos" → also emit "todo_update"        │    │
│  │  - ToolMessage (result) → emit "tool_end" event                     │    │
│  │    - If subagent result → emit "subagent_end" instead               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Trackers:                                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                 │
│  │  ToolTracker   │  │  TodoTracker   │  │ SubagentTracker│                 │
│  │  (start/end)   │  │  (parse todos) │  │  (task tool)   │                 │
│  └────────────────┘  └────────────────┘  └────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
    Structured SSE Events
    (content, tool_start, tool_end, todo_update, 
     subagent_start, subagent_end, final_result)
```

---

## MongoDB Storage

### Collections

The Dynamic Agents service uses two MongoDB collections:

#### `dynamic_agents` Collection

Stores agent configurations.

```javascript
{
  "_id": "dynamic-agent-1709123456789",  // Generated ID with timestamp
  "name": "Code Reviewer",
  "description": "Reviews code for bugs and best practices",
  "system_prompt": "You are an expert code reviewer...",
  "allowed_tools": {
    "github": ["get_file_contents", "search_code"],
    "rag": []  // Empty array = all tools from this server
  },
  "builtin_tools": {
    "fetch_url": {
      "enabled": true,
      "allowed_domains": "*.github.com,docs.python.org"
    }
  },
  "model_id": "claude-sonnet-4-20250514",
  "model_provider": "anthropic-claude",
  "visibility": "global",  // "private" | "team" | "global"
  "shared_with_teams": [],  // Team IDs when visibility="team"
  "subagents": [
    {
      "agent_id": "dynamic-agent-1709000000000",
      "name": "test-runner",
      "description": "Runs tests and reports results"
    }
  ],
  "enabled": true,
  "owner_id": "admin@example.com",
  "is_system": false,  // System agents cannot be deleted
  "config_driven": false,  // If true, loaded from config.yaml (not editable via UI)
  "created_at": ISODate("2024-02-28T12:00:00Z"),
  "updated_at": ISODate("2024-02-28T12:00:00Z")
}
```

**Indexes:**
- `owner_id` (ascending)
- `visibility` (ascending)
- `enabled` (ascending)
- `name` (ascending)

#### `mcp_servers` Collection

Stores MCP server configurations.

```javascript
{
  "_id": "github",  // User-provided slug ID
  "name": "GitHub MCP",
  "description": "GitHub API tools via MCP",
  "transport": "sse",  // "stdio" | "sse" | "http"
  "endpoint": "http://github-mcp:8080/sse",  // For sse/http
  // For stdio transport:
  // "command": "npx",
  // "args": ["-y", "@modelcontextprotocol/server-github"],
  // "env": {"GITHUB_TOKEN": "..."},
  "enabled": true,
  "config_driven": false,  // If true, loaded from config.yaml (not editable via UI)
  "created_at": ISODate("2024-02-28T12:00:00Z"),
  "updated_at": ISODate("2024-02-28T12:00:00Z")
}
```

**Indexes:**
- `enabled` (ascending)

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MongoDB Data Flow                                    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐                          ┌─────────────────────────────────┐
│   UI Admin      │                          │         MongoDB                 │
│   Interface     │                          │                                 │
└────────┬────────┘                          │  ┌─────────────────────────┐   │
         │                                    │  │   dynamic_agents        │   │
         │ CRUD Operations                    │  │                         │   │
         ▼                                    │  │  • Agent configs        │   │
┌─────────────────┐   GET (reads)            │  │  • Owner tracking       │   │
│  Next.js API    │ ──────────────────────► │  │  • Visibility rules     │   │
│  Routes         │                          │  │  • Subagent refs        │   │
└────────┬────────┘                          │  └─────────────────────────┘   │
         │                                    │                                 │
         │ POST/PUT/DELETE (writes)          │  ┌─────────────────────────┐   │
         ▼                                    │  │   mcp_servers           │   │
┌─────────────────┐                          │  │                         │   │
│  Dynamic Agents │   Writes to MongoDB      │  │  • Connection configs   │   │
│  Backend (proxy)│ ──────────────────────► │  │  • Transport types      │   │
└────────┬────────┘                          │  │  • Enabled status       │   │
         │                                    │  └─────────────────────────┘   │
         │                                    │                                 │
         │ Read on chat                       │  ┌─────────────────────────┐   │
         │ request                            │  │   conversations         │   │
         │                                    │  │   (UI's MongoDB)        │   │
         ▼                                    │  │                         │   │
┌─────────────────┐                          │  │  • agent_id reference   │   │
│  AgentRuntime   │                          │  │  • Messages             │   │
│  (in-memory)    │                          │  │  • SSE events           │   │
└─────────────────┘                          │  └─────────────────────────┘   │
                                              └─────────────────────────────────┘

Note: The UI stores conversations in MongoDB with an `agent_id` field
that references the Dynamic Agent used for that conversation. This is stored
by the UI, not the Dynamic Agents service.

Write operations (POST/PUT/DELETE) go through the Dynamic Agents backend to ensure:
• Consistent datetime handling (timezone-aware)
• Proper validation and business logic
• Config-driven entity protection (403 on edit/delete)
```

---

## Persistent Chat History

Dynamic Agents support persistent chat history that survives pod restarts. This is implemented using LangGraph's `MongoDBSaver` checkpointer along with the UI's existing `conversations` collection.

### Storage Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Persistent Chat History Storage                           │
└─────────────────────────────────────────────────────────────────────────────┘

                              MongoDB (caipe database)
    ┌─────────────────────────────────────────────────────────────────────────┐
    │                                                                          │
    │  ┌───────────────────────────────────────────────────────────────────┐  │
    │  │  conversations                   (UI-managed)                      │  │
    │  │  ─────────────                                                     │  │
    │  │  • _id: conversation UUID                                          │  │
    │  │  • title: "Chat with Code Reviewer"                                │  │
    │  │  • owner_id: user email                                            │  │
    │  │  • agent_id: dynamic agent ID (for Dynamic Agent conversations)    │  │
    │  │  • sharing: {is_public, shared_with, shared_with_teams}            │  │
    │  │  • created_at, updated_at                                          │  │
    │  │                                                                     │  │
    │  │  Purpose: Sidebar listing, ownership/sharing, conversation metadata │  │
    │  └───────────────────────────────────────────────────────────────────┘  │
    │                                                                          │
    │  ┌───────────────────────────────────────────────────────────────────┐  │
    │  │  checkpoints_conversation       (LangGraph MongoDBSaver)           │  │
    │  │  ──────────────────────────                                        │  │
    │  │  • thread_id: conversation UUID (same as conversations._id)        │  │
    │  │  • checkpoint: serialized LangGraph state                          │  │
    │  │  • channel_values: {messages: [HumanMessage, AIMessage, ...]}      │  │
    │  │                                                                     │  │
    │  │  Purpose: Full message history for conversation continuity          │  │
    │  └───────────────────────────────────────────────────────────────────┘  │
    │                                                                          │
    │  ┌───────────────────────────────────────────────────────────────────┐  │
    │  │  checkpoint_writes_conversation (LangGraph MongoDBSaver)           │  │
    │  │  ────────────────────────────────                                  │  │
    │  │  • thread_id: conversation UUID                                    │  │
    │  │  • task_id, idx: write ordering                                    │  │
    │  │  • channel, type, value: pending writes                            │  │
    │  │                                                                     │  │
    │  │  Purpose: Atomic checkpoint writes, interrupt recovery              │  │
    │  └───────────────────────────────────────────────────────────────────┘  │
    │                                                                          │
    └─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Chat History Data Flow                                  │
└─────────────────────────────────────────────────────────────────────────────┘

     SEND MESSAGE                          LOAD CONVERSATION
     ────────────                          ─────────────────
         │                                        │
         ▼                                        ▼
┌─────────────────┐                    ┌─────────────────┐
│  UI ChatPanel   │                    │  UI ChatPanel   │
│  submitMessage()│                    │  useEffect()    │
└────────┬────────┘                    └────────┬────────┘
         │                                      │
         ▼                                      ▼
┌─────────────────┐                    ┌─────────────────┐
│ POST /api/      │                    │ GET /api/       │
│ dynamic-agents/ │                    │ dynamic-agents/ │
│ chat/stream     │                    │ conversations/  │
└────────┬────────┘                    │ {id}/messages   │
         │                             └────────┬────────┘
         ▼                                      │
┌─────────────────┐                             │
│ AgentRuntime    │                             ▼
│ .stream()       │                    ┌─────────────────┐
│                 │                    │ conversations   │
│ Writes to:      │                    │ .py endpoint    │
│ • checkpoint    │                    │                 │
│   collections   │                    │ Reads from:     │
│ (MongoDBSaver)  │                    │ • conversations │
└─────────────────┘                    │   (ownership)   │
                                       │ • checkpointer  │
                                       │   (messages)    │
                                       └─────────────────┘
```

### Key Points

| Aspect | Behavior |
|--------|----------|
| **Messages Source** | LangGraph checkpointer (not `messages` collection) |
| **Metadata Source** | UI's `conversations` collection |
| **thread_id** | Equals `conversation_id` - no mapping needed |
| **Ownership Check** | Backend reads `conversations.owner_id` for RBAC |
| **Message Types** | Only `HumanMessage` and `AIMessage` returned (tool messages filtered) |
| **Interrupt State** | Pending HITL interrupts restored when loading history |

### Loading Conversation History

When a user opens an existing Dynamic Agent conversation:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Loading Conversation History Flow                          │
└─────────────────────────────────────────────────────────────────────────────┘

1. UI mounts DynamicAgentChatPanel with conversationId + agentId
         │
         ▼
2. useEffect triggers loadHistory() if:
   • conversationId is provided (not new conversation)
   • Not already loaded (tracked in historyLoadedRef)
   • No messages in store yet (avoid overwriting live session)
         │
         ▼
3. Fetch: GET /api/dynamic-agents/conversations/{id}/messages?agent_id=X
         │
         ▼
4. Backend (conversations.py):
   a. Verify agent exists
   b. Check ownership via conversations collection
   c. Get AgentRuntime (creates if needed)
   d. Load state: runtime._graph.aget_state({"thread_id": conv_id})
   e. Extract messages from state.values.get("messages", [])
   f. Filter to HumanMessage/AIMessage only
   g. Check for pending interrupt
         │
         ▼
5. Response: { conversation_id, agent_id, messages, has_pending_interrupt, interrupt_data }
         │
         ▼
6. UI populates messages into zustand store:
   • addMessage() for each message (preserving IDs)
   • setPendingUserInput() if interrupt data present
```

### API Endpoint

**GET `/api/v1/conversations/{conversation_id}/messages`**

Query Parameters:
- `agent_id` (required): Dynamic agent ID

Response:
```json
{
  "conversation_id": "abc-123",
  "agent_id": "code-reviewer",
  "messages": [
    {"id": "msg-1", "role": "user", "content": "Hello", "timestamp": "..."},
    {"id": "msg-2", "role": "assistant", "content": "Hi!", "timestamp": "..."}
  ],
  "has_pending_interrupt": false,
  "interrupt_data": null
}
```

If `has_pending_interrupt` is `true`, `interrupt_data` contains:
```json
{
  "interrupt_id": "...",
  "prompt": "Please select an option:",
  "fields": [
    {"field_name": "choice", "field_type": "select", "field_values": ["A", "B", "C"]}
  ]
}
```

---

## Config-Driven Seeding

Agents and MCP servers can be pre-configured in `config.yaml` and loaded at server startup. These "config-driven" entities are managed as infrastructure rather than through the UI.

### How It Works

1. **Startup**: `apply_seed_config()` reads `config.yaml` and upserts agents/servers to MongoDB
2. **Upsert**: Existing entities with the same ID are overwritten; `created_at` is preserved
3. **Protection**: Config-driven entities have `config_driven: true` and cannot be edited/deleted via API (returns 403)
4. **UI**: Shows a "Config" badge and hides edit/delete buttons for these entities

### Config Format

```yaml
# config.yaml
mcp_servers:
  - id: "github"                    # Required: unique ID
    name: "GitHub"
    transport: "stdio"
    command: "uvx"
    args: ["mcp-server-github"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"  # Env var expansion supported
    enabled: true

agents:
  - id: "code-reviewer"             # Required: unique ID
    name: "Code Reviewer"
    system_prompt: |
      You are an expert code reviewer...
    model_id: "claude-sonnet-4-20250514"
    model_provider: "anthropic-claude"
    visibility: "global"
    allowed_tools:
      github: []                    # Empty = all tools from server
    enabled: true
```

### Environment Variable Expansion

Config values support `${VAR}` and `${VAR:-default}` syntax for environment variable substitution at startup.

---

## UI Integration

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         UI Component Architecture                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              App Layout                                      │
│  ┌─────────────┐  ┌─────────────────────────────────────────────────────┐   │
│  │   Sidebar   │  │                    Main Content                      │   │
│  │             │  │                                                      │   │
│  │ • Chat list │  │   ┌─────────────────────────────────────────────┐   │   │
│  │ • Agent     │  │   │              Route: /chat/[uuid]             │   │   │
│  │   selector  │  │   │                                              │   │   │
│  │             │  │   │   ┌─────────────────────────────────────┐   │   │   │
│  └─────────────┘  │   │   │  DynamicAgentChatView               │   │   │   │
│                   │   │   │       └── ChatPanel                 │   │   │   │
│                   │   │   │           └── DynamicAgentClient    │   │   │   │
│                   │   │   └─────────────────────────────────────┘   │   │   │
│                   │   └─────────────────────────────────────────────┘   │   │
│                   │                                                      │   │
│                   │   ┌─────────────────────────────────────────────┐   │   │
│                   │   │              Route: /dynamic-agents          │   │   │
│                   │   │                                              │   │   │
│                   │   │   ┌─────────────────────────────────────┐   │   │   │
│                   │   │   │  DynamicAgentsTab    MCPServersTab  │   │   │   │
│                   │   │   │       │                   │          │   │   │   │
│                   │   │   │       ▼                   ▼          │   │   │   │
│                   │   │   │  DynamicAgentEditor  MCPServerEditor │   │   │   │
│                   │   │   └─────────────────────────────────────┘   │   │   │
│                   │   └─────────────────────────────────────────────┘   │   │
│                   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Chat Client Flow

The UI uses a unified `ChatPanel` component with a Dynamic Agents streaming client:

```
    ChatPanel receives:
    - endpoint: Backend URL
    - conversationId: MongoDB conversation UUID
    - selectedAgentId: Dynamic agent ID
              │
              ▼
┌────────────────┐
│ DynamicAgent   │
│ Client         │
└───────┬────────┘
        │
        ▼
┌────────────────┐
│ POST /api/     │
│ dynamic-agents │
│ /chat/stream   │
└───────┬────────┘
        │
        ▼
┌────────────────┐
│ SSE Events:    │
│ • content      │
│ • tool_start   │
│ • tool_end     │
│ • todo_update  │
│ • final_result │
└───────┬────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Unified Event Processing                            │
│                                                                              │
│  • Accumulate content into message                                          │
│  • Track tool calls for UI display                                          │
│  • Store events in Zustand                                                  │
│  • Update message when final_result received                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### SSE Event Types (Frontend)

For detailed documentation of all SSE event types, JSON structures, and implementation details, see **[SSE_EVENTS.md](./SSE_EVENTS.md)**.

The frontend TypeScript types are defined in `ui/src/components/dynamic-agents/sse-types.ts`.

### State Management (Zustand)

```typescript
// From: ui/src/store/chat-store.ts

interface ChatStore {
  conversations: Conversation[];
  
  // Dynamic Agent stream events
  addSSEEvent: (event: SSEAgentEvent, conversationId: string) => void;
  clearSSEEvents: (conversationId: string) => void;
  
  // Conversation has agent_id for Dynamic Agent association
  // agent_id?: string;
}

interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  sseEvents: SSEAgentEvent[]; // Dynamic Agent events
  agent_id?: string;          // Dynamic Agent ID
}
```

---

## API Flow

### UI API Route Pattern

The Next.js UI routes follow a hybrid pattern for interacting with Dynamic Agents data:

- **Reads (GET)**: Direct MongoDB access for fast queries with visibility filtering
- **Writes (POST, PUT, DELETE)**: Proxy to Dynamic Agents Python backend for consistent data handling

This architecture ensures:
1. **Data consistency**: The Python backend handles datetime serialization, validation, and defaults
2. **Single source of truth**: All write operations go through the backend's business logic
3. **Performance**: Read operations remain fast with direct MongoDB queries

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         UI API Route Pattern                                 │
└─────────────────────────────────────────────────────────────────────────────┘

    Browser
       │
       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Next.js API Routes                                   │
│                                                                              │
│  /api/dynamic-agents          /api/mcp-servers                               │
│  ┌─────────────────────────┐  ┌─────────────────────────┐                   │
│  │ GET  → Direct MongoDB   │  │ GET  → Direct MongoDB   │                   │
│  │ POST → Proxy to backend │  │ POST → Proxy to backend │                   │
│  │ PUT  → Proxy to backend │  │ PUT  → Proxy to backend │                   │
│  │ DELETE→ Proxy to backend│  │ DELETE→ Proxy to backend│                   │
│  └────────────┬────────────┘  └────────────┬────────────┘                   │
│               │                            │                                 │
└───────────────┼────────────────────────────┼────────────────────────────────┘
                │ Writes                     │ Reads
                ▼                            ▼
┌───────────────────────────────┐   ┌─────────────────────────────────────────┐
│   Dynamic Agents Backend      │   │              MongoDB                    │
│   (Python FastAPI)            │   │                                         │
│                               │   │  ┌─────────────────────────┐           │
│   /api/v1/agents/*            │   │  │   dynamic_agents        │           │
│   /api/v1/mcp-servers/*       │   │  └─────────────────────────┘           │
│              │                │   │                                         │
│              ▼                │   │  ┌─────────────────────────┐           │
│         MongoDB writes ───────┼───┼─►│   mcp_servers           │           │
│                               │   │  └─────────────────────────┘           │
└───────────────────────────────┘   └─────────────────────────────────────────┘
```

### Admin Operations Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Admin Operations Flow                                │
└─────────────────────────────────────────────────────────────────────────────┘

                        Admin User
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      /dynamic-agents Page                                    │
│                                                                              │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐           │
│  │    Dynamic Agents Tab       │  │    MCP Servers Tab          │           │
│  │                             │  │                              │           │
│  │  • List agents              │  │  • List servers              │           │
│  │  • Create/Edit/Delete       │  │  • Create/Edit/Delete        │           │
│  │  • Configure tools          │  │  • Probe for tools           │           │
│  │  • Set visibility           │  │  • Test connection           │           │
│  │  • Add subagents            │  │                              │           │
│  └──────────────┬──────────────┘  └──────────────┬──────────────┘           │
│                 │                                │                           │
└─────────────────┼────────────────────────────────┼───────────────────────────┘
                  │                                │
                  ▼                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Next.js API Routes                                      │
│                                                                              │
│  /api/dynamic-agents                    /api/mcp-servers                     │
│  • GET: List agents (Direct MongoDB)    • GET: List servers (Direct MongoDB) │
│  • POST: Create → Backend proxy         • POST: Create → Backend proxy       │
│  • PUT: Update → Backend proxy          • PUT: Update → Backend proxy        │
│  • DELETE: Remove → Backend proxy       • DELETE: Remove → Backend proxy     │
│                                                                              │
│  /api/mcp-servers/probe                                                      │
│  • POST: Probe server → Backend proxy                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                  │                                │
          ┌───────┴────────┐              ┌────────┴───────┐
          │ Reads          │              │ Writes         │
          ▼                │              ▼                │
┌─────────────────────┐    │   ┌─────────────────────────┐ │
│     MongoDB         │    │   │  Dynamic Agents Backend │ │
│                     │    │   │  (Python FastAPI)       │ │
│ • dynamic_agents    │    │   │                         │ │
│ • mcp_servers       │◄───┼───│  Writes to MongoDB      │ │
└─────────────────────┘    │   └─────────────────────────┘ │
                           │                               │
                           └───────────────────────────────┘

### Visibility Access Control

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Visibility Access Control                              │
└─────────────────────────────────────────────────────────────────────────────┘

    User Request for Agent
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         _can_view_agent()                                    │
│                                                                              │
│    ┌─────────────┐                                                          │
│    │  Is Admin?  │───► YES ───► ✓ Access Granted                            │
│    └──────┬──────┘                                                          │
│           │ NO                                                               │
│           ▼                                                                  │
│    ┌─────────────┐                                                          │
│    │  Is Owner?  │───► YES ───► ✓ Access Granted                            │
│    └──────┬──────┘                                                          │
│           │ NO                                                               │
│           ▼                                                                  │
│    ┌─────────────┐                                                          │
│    │ visibility  │                                                          │
│    │ == global?  │───► YES ───► ✓ Access Granted                            │
│    └──────┬──────┘                                                          │
│           │ NO                                                               │
│           ▼                                                                  │
│    ┌─────────────┐                                                          │
│    │ visibility  │      ┌───────────────────────────┐                       │
│    │ == team?    │─YES─►│ User in shared_with_teams?│─YES─► ✓ Access        │
│    └──────┬──────┘      └───────────────────────────┘                       │
│           │ NO                      │ NO                                     │
│           │◄────────────────────────┘                                        │
│           ▼                                                                  │
│    ✗ Access Denied                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Subagent Visibility Validation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Subagent Visibility Validation                            │
└─────────────────────────────────────────────────────────────────────────────┘

    When creating/updating an agent with subagents:

    Parent Agent Visibility    Allowed Subagent Visibility
    ─────────────────────────────────────────────────────
    private                    private, team, global (any)
    team                       team, global
    global                     global only

    Rationale: A globally-visible agent cannot depend on
    private subagents that some users cannot access.

    ┌────────────┐        ┌────────────┐
    │   Global   │───────►│   Global   │  ✓ OK
    │   Parent   │        │  Subagent  │
    └────────────┘        └────────────┘

    ┌────────────┐        ┌────────────┐
    │   Global   │───X───►│   Private  │  ✗ REJECTED
    │   Parent   │        │  Subagent  │
    └────────────┘        └────────────┘

    ┌────────────┐        ┌────────────┐
    │   Private  │───────►│   Global   │  ✓ OK
    │   Parent   │        │  Subagent  │
    └────────────┘        └────────────┘
```

---

## Sequence Diagrams

### Full Chat Sequence

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Full Chat Sequence                                  │
└─────────────────────────────────────────────────────────────────────────────┘

Browser          Next.js Proxy       Dynamic Agents      MCP Server    LLM
   │                  │                    │                 │          │
   │ POST /api/       │                    │                 │          │
   │ dynamic-agents/  │                    │                 │          │
   │ chat/stream      │                    │                 │          │
   │─────────────────►│                    │                 │          │
   │                  │ POST /api/v1/      │                 │          │
   │                  │ chat/stream        │                 │          │
   │                  │───────────────────►│                 │          │
   │                  │                    │                 │          │
   │                  │                    │ Validate JWT    │          │
   │                  │                    │ Load agent cfg  │          │
   │                  │                    │ Get/create      │          │
   │                  │                    │ AgentRuntime    │          │
   │                  │                    │                 │          │
   │                  │                    │────────────────────────────►│
   │                  │                    │  LLM request                │
   │                  │                    │◄────────────────────────────│
   │                  │ SSE: content       │  Token stream               │
   │◄─────────────────│◄───────────────────│                 │          │
   │                  │                    │                 │          │
   │                  │                    │────────────────────────────►│
   │                  │                    │  "Call tool X"              │
   │                  │                    │◄────────────────────────────│
   │                  │ SSE: tool_start    │                 │          │
   │◄─────────────────│◄───────────────────│                 │          │
   │                  │                    │                 │          │
   │                  │                    │─────────────────►          │
   │                  │                    │   MCP tool call │          │
   │                  │                    │◄─────────────────          │
   │                  │                    │   Tool result   │          │
   │                  │ SSE: tool_end      │                 │          │
   │◄─────────────────│◄───────────────────│                 │          │
   │                  │                    │                 │          │
   │                  │                    │────────────────────────────►│
   │                  │                    │  Continue with result       │
   │                  │                    │◄────────────────────────────│
   │                  │ SSE: content       │  Final response             │
   │◄─────────────────│◄───────────────────│                 │          │
   │                  │                    │                 │          │
   │                  │ SSE: final_result  │                 │          │
   │◄─────────────────│◄───────────────────│                 │          │
   │                  │                    │                 │          │
   │                  │ SSE: done          │                 │          │
   │◄─────────────────│◄───────────────────│                 │          │
```

### Agent Configuration Sync

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Agent Configuration Sync                                 │
└─────────────────────────────────────────────────────────────────────────────┘

    Admin updates agent config via UI
                   │
                   ▼
    MongoDB: dynamic_agents.update()
    → updated_at = now()
                   │
                   ▼
    Next chat request for this agent
                   │
                   ▼
    AgentRuntimeCache.get_or_create()
                   │
                   ▼
    ┌────────────────────────────────────────────────────────────────────┐
    │  is_stale() check:                                                  │
    │                                                                     │
    │  if agent_config.updated_at != runtime._config_updated_at:         │
    │      return True  # Config changed, need new runtime               │
    │                                                                     │
    │  if max(mcp_servers.updated_at) != runtime._mcp_servers_updated_at:│
    │      return True  # MCP server changed, need new runtime           │
    │                                                                     │
    │  return False                                                       │
    └────────────────────────────────────────────────────────────────────┘
                   │
            ┌──────┴──────┐
            │ Stale?      │
            └──────┬──────┘
                   │
         ┌─────────┴─────────┐
         │ YES               │ NO
         ▼                   ▼
    ┌────────────┐    ┌────────────┐
    │ Cleanup old│    │ Return     │
    │ runtime &  │    │ cached     │
    │ create new │    │ runtime    │
    └────────────┘    └────────────┘
```

---

## Session-Based Logging

All log messages include a session ID for LMA (Logging, Monitoring, Alerting) traceability. This enables filtering logs by session to trace a user's complete interaction flow.

### Log Format

```
%(asctime)s | %(levelname)-8s | session=%(session_id)s | %(name)s | %(message)s
```

Example output:
```
2024-03-15 10:23:45 | INFO     | session=abc123-def456 | dynamic_agents.routes.chat | Starting chat stream
2024-03-15 10:23:45 | INFO     | session=abc123-def456 | dynamic_agents.services.agent_runtime | Initializing runtime
2024-03-15 10:23:46 | WARNING  | session=abc123-def456 | dynamic_agents.services.mcp_client | Server 'slack' failed to connect
```

When no session is active (e.g., during startup), logs show `session=-`.

### Implementation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Session Context Propagation                              │
└─────────────────────────────────────────────────────────────────────────────┘

    Chat Request arrives
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  chat.py endpoint:                                                           │
│                                                                              │
│  session_id_var.set(request.session_id or "-")                              │
│  ← Sets ContextVar for this async context                                    │
└─────────────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  SessionContextFilter (logging.Filter):                                      │
│                                                                              │
│  def filter(self, record):                                                   │
│      record.session_id = session_id_var.get()                               │
│      return True                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
           │
           ▼
    All log calls in this async context include session ID
```

**Key Details:**

| Component | Description |
|-----------|-------------|
| `session_id_var` | `contextvars.ContextVar[str]` with default `"-"` |
| `SessionContextFilter` | Logging filter that injects `session_id` into log records |
| Propagation | Works across async boundaries (async functions, callbacks) |

---

## Summary

Dynamic Agents provides a flexible, admin-configurable agent system that:

1. **Streams through the UI/BFF**: Uses structured SSE events for chat, tool calls, todos, and subagent updates
2. **Caches efficiently**: Per-session agent runtimes with config-aware invalidation
3. **Integrates MCP tools**: Multi-server support with tool filtering and namespacing
4. **Supports hierarchy**: Subagent delegation with cycle detection and visibility rules
5. **Stores persistently**: MongoDB for configurations, in-memory checkpointing for conversation state
6. **Streams responsively**: Structured SSE events for real-time UI updates

---

## Related Documentation

- [SSE_EVENTS.md](./SSE_EVENTS.md) - Detailed SSE event types and streaming protocol
- [README.md](./README.md) - Quick start and API reference
- [UI Architecture](../../ui/src/components/dynamic-agents/ARCHITECTURE.md) - Frontend component architecture and event handling
