# Canonical Lifecycle Events v1

## Envelope

Every adapter event uses this envelope:

```json
{
  "version": 1,
  "type": "text.delta",
  "run_id": "run-opaque",
  "conversation_id": "conversation-example",
  "sequence": 3,
  "timestamp": "2026-08-17T00:00:00Z",
  "namespace": [],
  "data": {}
}
```

| Field | Rule |
|---|---|
| `version` | Integer `1`. |
| `type` | One event type from this contract. |
| `run_id` | Stable for the run; opaque and bounded. |
| `conversation_id` | Matches authorized request/binding. |
| `sequence` | Strictly increasing integer per run, starting at `0`. |
| `timestamp` | Engine clock or normalized provider timestamp; never used for ordering. |
| `namespace` | Ordered subagent path; empty for root. |
| `data` | Type-specific validated payload. |

Unknown fields are rejected inside the adapter boundary for v1. Provider-native metadata is allowed only in the bounded `provider.metadata` event or approved metadata field.

## Event types

### Run lifecycle

#### `run.started`

```json
{
  "message_id": "optional-root-assistant-message",
  "harness_id": "deepagents",
  "adapter_version": "1.0.0",
  "provider_run_id": "optional-opaque"
}
```

First event for every stream.

#### `run.finished`

```json
{
  "outcome": "success",
  "stop_reason": "end_turn",
  "thread_state": {
    "durability": "committed",
    "durable_revision": 8,
    "head_ref": "opaque"
  }
}
```

Terminal. `outcome` is `success`; other terminal outcomes have dedicated types. The control plane adds the opaque thread-state projection only after the final native state/head commit. Existing public encoders may omit these internal fields while preserving current bytes.

#### `run.interrupted`

```json
{
  "interrupt_id": "interrupt-opaque",
  "reason": "human_input | tool_approval"
}
```

Terminal for the current HTTP stream but resumable in the session state.

The interrupt snapshot and native resume state must be committed before this terminal event is accepted.

#### `run.cancelled`

```json
{
  "reason": "client_request | disconnect | shutdown | deadline",
  "side_effect_status": "none | possible | known"
}
```

Terminal. Existing custom protocol may preserve its current silent-close behavior; audit and internal metrics still consume the event.

#### `run.error`

```json
{
  "code": "safe_machine_code",
  "message": "Sanitized user-facing message",
  "retryable": false,
  "retry_after_seconds": null,
  "side_effect_status": "none | possible | known"
}
```

Terminal. No stack, credential, raw SDK stderr, or unbounded provider payload.

`thread_durability_uncertain` is used when output or side effects may have occurred but the final thread-state head could not be committed. It is never automatically retried or converted to `run.finished`.

### Text and reasoning

#### `text.started`

```json
{ "message_id": "message-opaque", "role": "assistant" }
```

#### `text.delta`

```json
{ "message_id": "message-opaque", "delta": "text" }
```

#### `text.finished`

```json
{ "message_id": "message-opaque" }
```

Reasoning uses `reasoning.started`, `reasoning.delta`, and `reasoning.finished` with the same ID discipline. Reasoning may be absent. Empty deltas are dropped.

### Tools

#### `tool.started`

```json
{
  "tool_call_id": "tool-call-opaque",
  "tool_name": "server_tool",
  "arguments": {},
  "parent_message_id": "optional"
}
```

`arguments` may be empty when a provider streams arguments later.

#### `tool.arguments.delta`

```json
{
  "tool_call_id": "tool-call-opaque",
  "delta": "json-fragment"
}
```

The validator bounds aggregate arguments and validates final JSON against the ToolBroker schema before invocation.

#### `tool.finished`

```json
{
  "tool_call_id": "tool-call-opaque",
  "result": "bounded display projection",
  "result_ref": "optional-engine-reference"
}
```

#### `tool.error`

```json
{
  "tool_call_id": "tool-call-opaque",
  "code": "tool_error",
  "message": "bounded sanitized error",
  "retryable": false
}
```

Reject/edit decisions do not fabricate successful `tool.finished` events. Protocol-specific compatibility logic may suppress duplicate pre-interrupt tool events exactly as Dynamic Agents does today.

### Interrupts

#### `interrupt.requested`

Form input:

```json
{
  "interrupt_id": "interrupt-opaque",
  "interrupt_type": "form_input",
  "agent_id": "agent-example",
  "prompt": "Provide values",
  "fields": [
    {
      "field_name": "example_value",
      "field_type": "text",
      "required": true
    }
  ]
}
```

Tool approval:

```json
{
  "interrupt_id": "interrupt-opaque",
  "interrupt_type": "tool_approval",
  "agent_id": "agent-example",
  "tool_approvals": [
    {
      "tool_call_id": "tool-call-opaque",
      "tool_name": "server_tool",
      "tool_args": {},
      "allowed_decisions": ["approve", "edit", "reject"]
    }
  ]
}
```

`interrupt.requested` must be followed by `run.interrupted` and no other terminal/output event.

### Namespace and subagents

#### `namespace.entered`

```json
{
  "agent_id": "child-agent",
  "agent_name": "Child agent",
  "parent_tool_call_id": "delegation-call-id"
}
```

#### `namespace.exited`

```json
{
  "agent_id": "child-agent",
  "parent_tool_call_id": "delegation-call-id",
  "outcome": "success | interrupted | cancelled | error"
}
```

Nested events carry the full namespace. Namespace IDs, not display names, drive correlation.

### Warning and usage

#### `warning`

```json
{
  "code": "mcp_server_unavailable",
  "message": "Sanitized user-facing warning",
  "details": {}
}
```

Details are optional, bounded, and schema-specific.

#### `usage.updated`

```json
{
  "input_tokens": 10,
  "output_tokens": 5,
  "cached_input_tokens": 0,
  "cost": null,
  "currency": null,
  "final": false
}
```

Missing provider metrics remain null/absent; the adapter never invents zero except for known zero.

#### `provider.metadata`

```json
{
  "provider": "example",
  "model": "example-model",
  "metadata": {}
}
```

Internal/observability event only by default. Metadata is allowlisted, scalar/bounded, and excluded from public wire encoders unless a field is explicitly contracted.

## State-machine rules

1. `sequence` strictly increases with no duplicates.
2. `run.started` is sequence `0` and appears once.
3. Exactly one run terminal appears.
4. No event follows a run terminal.
5. Text/reasoning IDs start before delta and finish at most once.
6. Tool IDs start before argument/result/error and terminate at most once.
7. A tool cannot both finish and error.
8. An interrupt is unique and immediately precedes `run.interrupted` except for required text/tool close events.
9. Namespace enter/exit pairs are balanced; root namespace is never explicitly exited.
10. Child events reference an active namespace and parent delegation call.
11. Aggregate event/payload/tool-result limits use existing service settings or stricter adapter limits.
12. Provider stream closure without a terminal is converted to `run.error` by the adapter/coordinator.
13. `run.finished` requires `thread_state.durability=committed` for every non-ephemeral interactive harness.
14. `run.interrupted` requires a committed pending interrupt and resumable native state revision.
15. A failed final state commit produces `run.error(code=thread_durability_uncertain)`; the prior durable head remains authoritative.

## Encoding mappings

### Existing custom SSE

| Canonical event | Existing frame |
|---|---|
| `text.delta` | `content` |
| `tool.started` | `tool_start` |
| `tool.finished` / `tool.error` | `tool_end` |
| `warning` | `warning` |
| `interrupt.requested` | `input_required` |
| `run.error` | `error` |
| `run.finished` | `done` |

Start/finish events not currently visible are retained internally and may produce no custom frame. Existing namespace arrays and accumulated content behavior remain unchanged.

### Existing AG-UI SSE

| Canonical event | AG-UI frame |
|---|---|
| `run.started` | `RUN_STARTED` |
| `text.started` | `TEXT_MESSAGE_START` |
| `text.delta` | `TEXT_MESSAGE_CONTENT` |
| `text.finished` | `TEXT_MESSAGE_END` |
| `tool.started` | `TOOL_CALL_START` plus `TOOL_CALL_ARGS` |
| `tool.finished` / `tool.error` | `TOOL_CALL_END` plus existing result/error extension behavior |
| namespace change | `CUSTOM` / `NAMESPACE_CONTEXT` |
| `warning` | `CUSTOM` / `WARNING` |
| `run.interrupted` | `RUN_FINISHED` with `outcome: interrupt` and established payload |
| `run.finished` | `RUN_FINISHED` with `outcome: success` |
| `run.error` | `RUN_ERROR` |

The encoder owns wire-generated message IDs only when the adapter cannot provide a stable canonical ID. Golden tests decide exact pairing and suppression behavior.

## Validation and sanitation

- Validate events at adapter yield time and again at the coordinator boundary.
- Replace raw provider errors with typed adapter errors; never serialize arbitrary exception objects.
- Bound IDs, strings, metadata depth/count, tool arguments, tool results, and warning details.
- Reject NaN/infinity, non-JSON values, control-character abuse, and invalid UTF-8 projections.
- Log only safe summaries and correlation IDs for rejected events.
