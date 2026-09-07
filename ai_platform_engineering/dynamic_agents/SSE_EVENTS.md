# Dynamic Agents SSE Events

Real-time streaming from backend to UI via `POST /api/dynamic-agents/chat/stream`.

## Event Types

| Event | When | Data |
|-------|------|------|
| `content` | LLM token | `{text, namespace}` |
| `tool_start` | Tool invoked | `{tool_name, tool_call_id, args, namespace}` |
| `tool_end` | Tool finished | `{tool_call_id, namespace}` |
| `input_required` | HITL needed | `{tool_call_id, tool_name, args}` |
| `memory_injected` | Memory supplied to the root model | `{memory_ids, namespace}` |
| `memory_update` | A mounted memory file changed | `{memory_ids, action, namespace}` |
| `done` | Stream ends | `{}` |

## Memory events

`memory_injected` contains stable record IDs only; memory bodies are never
copied into the event. `memory_update.action` is `created`, `updated`, or
`deleted`. Both events use the root namespace because subagents are denied all
memory paths.

The former `memory_context_used` event is no longer emitted. Clients should map
that name to `memory_injected` when replaying persisted legacy transcripts.

## Known Tools

| Tool | Behavior |
|------|----------|
| `write_todos` | UI extracts `args.todos` array and renders todo list |
| `task` | Spawns subagent; events from subagent have `namespace: [tool_call_id]` |
| `write_file` | File write; UI may show in files panel |
| `request_user_input` | Triggers `input_required` event for HITL form |
| `*` (other) | Rendered as generic tool call in events panel |

## Namespace & Subagent Correlation

**Problem**: When `task` spawns a subagent, LangGraph assigns an internal UUID (e.g., `tools:e3b034a3-...`) to namespace subagent events. Clients need to correlate these to the `tool_start` they already received.

**Solution**: Backend uses LangGraph's `tasks` stream mode which emits:
```python
{"id": "e3b034a3-...", "input": {"tool_call": {"id": "tooluse_XYZ", "name": "task", ...}}}
```

We build a mapping `{tools:e3b034a3-... → tooluse_XYZ}` and replace namespaces before emitting SSE events.

**Result**:
```
event: tool_start                                       ← subagent spawning
data: {"tool_name": "task", "tool_call_id": "tooluse_XYZ", ...}

event: content                                          ← subagent streaming
data: {"text": "Hello", "namespace": ["tooluse_XYZ"]}   ← UI matches to tool_start above
```

Empty `namespace: []` = parent agent. Non-empty = subagent (value matches parent's `tool_call_id`).

## Files

| File | Role |
|------|------|
| `stream_events.py` | `transform_stream_chunk()`, event builders, namespace correlation |
| `agent_runtime.py` | Calls transform, yields events, manages `namespace_mapping` |
| `routes/chat.py` | HTTP endpoint, SSE formatting |

## Adding Events

Keep events lean. Avoid bloat—only add fields clients actually need.

1. Add constant: `MY_EVENT = "my_event"` in `stream_events.py`
2. Add builder: `make_my_event(...)` returning `{"type": MY_EVENT, "data": {...}}`
3. Add detection in `_handle_updates_chunk()` or `_handle_messages_chunk()`
4. Add TypeScript type in `ui/src/components/dynamic-agents/sse-types.ts`

## Debug

```python
logging.getLogger("dynamic_agents.services.stream_events").setLevel(logging.DEBUG)
```

Logs: `[sse:tasks] Mapped tools:abc → tooluse_XYZ`, `[sse:correlate] tools:abc → tooluse_XYZ`
