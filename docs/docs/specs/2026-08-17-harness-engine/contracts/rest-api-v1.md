# REST API Contract: Harness Engine v1

> **Vertical-slice mapping:** The independent service currently exposes
> `/api/v1/harnesses`, `/api/v1/agent-drafts/validate`, `/api/v1/agents/{id}`,
> detached `/api/v1/runs` plus replay/event-stream routes, and
> `POST /api/v1/sessions/clear`. Harness Gateway now implements the existing
> BFF chat compatibility routes and selects this service only for agents with a
> non-default `execution_harness_id`; Dynamic Agents source remains unchanged.
> Full compatibility for resume, attachments, tools, and interrupts remains
> capability-gated as described below.

## Compatibility rule

Harness Engine serves the existing Dynamic Agents API unchanged. The implementation must freeze the current generated OpenAPI document and black-box behavior before refactoring. Existing fields remain optional/required exactly as today; additive fields and routes below do not change old clients.

Base runtime prefix: `/api/v1`
Streaming media type: `text/event-stream`

The detached `POST /api/v1/runs` request accepts the required `agent_id`,
`conversation_id`, and `message`, plus optional `client_request_id` and
`context`. `context` is bounded to 500,000 characters and augments the rendered
system prompt for that turn only; it is not written into the immutable agent
blueprint. This preserves the context contract used by CAIPE CLI.

## Preserved endpoints

| Method | Path | Contract |
|---|---|---|
| `GET` | `/` | Existing service metadata shape; service alias remains compatible. |
| `GET` | `/health` | Process liveness. |
| `GET` | `/healthz` | Existing dependency health response. |
| `GET` | `/readyz` | Existing readiness response and status behavior. |
| `GET` | `/debug/config` | Existing sanitized configuration diagnostics. |
| `GET` | `/debug/runtimes` | Existing cache diagnostics; additive harness breakdown allowed. |
| `GET` | `/metrics` | Existing Prometheus endpoint or dedicated metrics port. |
| `GET` | `/api/v1/builtin-tools` | Existing built-in tool definitions. |
| `GET` | `/api/v1/middleware` | Existing middleware definitions. |
| `POST` | `/api/v1/mcp-servers/{server_id}/probe` | Existing MCP discovery result. |
| `POST` | `/api/v1/assistant/suggest` | Existing stateless suggestion request/response. |
| `POST` | `/api/v1/chat/stream/start` | Existing `ChatRequest`; custom SSE or AG-UI output. |
| `POST` | `/api/v1/chat/stream/resume` | Existing resume request and stream behavior. |
| `POST` | `/api/v1/chat/stream/cancel` | Existing cancellation response. |
| `POST` | `/api/v1/chat/invoke` | Existing accumulated non-stream response and interrupt rejection. |
| `POST` | `/api/v1/chat/restart-runtime` | Existing invalidation response. |
| `GET` | `/api/v1/conversations/{conversation_id}/interrupt-state` | Existing interrupt-state response. |
| `POST` | `/api/v1/conversations/{conversation_id}/metadata` | Existing metadata upsert response. |
| `POST` | `/api/v1/conversations/{conversation_id}/clear` | Existing admin clear response, with additive adapter deletion counts allowed. |
| `GET` | `/api/v1/files/list` | Existing namespace file list. |
| `GET` | `/api/v1/files/content` | Existing file content response. |
| `PUT` | `/api/v1/files/content` | Existing file write response. |
| `DELETE` | `/api/v1/files/content` | Existing file delete response. |
| `DELETE` | `/api/v1/files/namespace` | Existing namespace delete response. |

### Preserved ChatRequest

```json
{
  "message": "string",
  "files": [
    {
      "mime_type": "text/plain",
      "data": "optional-base64",
      "uri": "optional-reference",
      "name": "optional-name.txt"
    }
  ],
  "conversation_id": "conversation-example",
  "agent_id": "agent-example",
  "protocol": "custom | agui",
  "trace_id": "optional",
  "client_context": {
    "source": "webui"
  },
  "config_override": {},
  "workflow_config_id": "optional"
}
```

`config_override` keeps its current allowlist. Harness identity, provider resource, execution mode, dependency source, and trust-boundary settings are forbidden overrides.

### Preserved invoke success

```json
{
  "success": true,
  "content": "accumulated text",
  "thinking": "optional accumulated reasoning",
  "agent_id": "agent-example",
  "conversation_id": "conversation-example",
  "trace_id": "optional"
}
```

### Preserved capacity failure

- Status: `503`
- Header: `Retry-After: 5` unless a provider supplies a safer longer interval
- Existing error category/message remains unchanged.
- An additive internal harness code may be logged or returned only in a backward-compatible optional field.

## Additive runtime endpoints

### GET `/api/v1/harnesses`

Returns the installed/known harness catalog. Static metadata is not authentication-gated unless deployment policy requires it. Secrets and raw health errors are never returned.

Response:

```json
{
  "success": true,
  "data": {
    "contract_version": 1,
    "catalog_revision": "sha256:opaque",
    "harnesses": [
      {
        "id": "deepagents",
        "display_name": "Deep Agents",
        "description": "Dynamic Agents compatibility harness",
        "adapter_version": "1.0.0",
        "contract_versions": [1],
        "execution_mode": "sandbox_pod",
        "sandbox_profile": "deepagents-standard-v1",
        "enabled": true,
        "availability": "available",
        "certification": "certified",
        "operator_action": null,
        "configuration_schema": {
          "type": "object",
          "additionalProperties": false
        },
        "capabilities": {
          "streaming": { "level": "native" },
          "human_input": { "level": "native" }
        }
      }
    ]
  }
}
```

Enums:

- `execution_mode`: `sandbox_pod`, `provider_managed`, or compatibility-only `in_process`
- `availability`: `available`, `disabled`, `dependency_missing`, `misconfigured`, `unhealthy`
- `certification`: `certified`, `experimental`, `blocked`
- capability `level`: `native`, `emulated`, `unsupported`, `unavailable`

`catalog_revision` changes whenever a descriptor, deployment policy, certification, availability, compatible-model projection, or option schema changes. Descriptions and operator actions are sanitized display text. The response never supplies executable UI content, component/module names, raw health errors, credentials, infrastructure manifests, or arbitrary links.

### POST `/api/v1/harnesses/validate`

Validates a proposed full agent configuration or a harness selection against installed adapters and deployment health. It does not write configuration or invoke a model/tool.

Request:

```json
{
  "agent_config": {
    "name": "Example agent",
    "system_prompt": "Example instructions",
    "model": { "provider": "example", "id": "example-model" },
    "allowed_tools": {},
    "subagents": [],
    "skills": [],
    "interrupt_on": {},
    "harness": {
      "id": "strands",
      "contract_version": 1,
      "conversation_policy": "pin",
      "options": {}
    },
    "memory": {
      "enabled": true,
      "read_scopes": ["user", "agent", "organization"],
      "write_scope": "user",
      "write_policy": "approval_for_sensitive",
      "kinds": ["semantic", "episodic_reference"],
      "retrieval": "on_demand",
      "max_results": 10,
      "retention_policy": "standard",
      "consolidation": "disabled"
    }
  },
  "validation_context": "create | update | override | run"
}
```

For an update, the request additionally includes the persisted agent ID, original harness ID, and an engine-derived active/persisted-conversation summary. The browser cannot assert that no conversations exist or authorize a transfer.

Success response, including an incompatible but well-formed configuration:

```json
{
  "success": true,
  "data": {
    "request_id": "validation-opaque",
    "valid": false,
    "harness_id": "strands",
    "certification": "experimental",
    "catalog_revision": "sha256:catalog-opaque",
    "config_fingerprint": "sha256:opaque",
    "capabilities": [
      {
        "name": "model_provider",
        "required": true,
        "level": "unsupported",
        "field_path": "model.provider",
        "step_id": "basic",
        "severity": "error",
        "constraints": {
          "allowed_provider_ids": ["example-provider"]
        },
        "message": "The selected harness does not support this model provider."
      }
    ],
    "errors": [
      {
        "code": "harness_capability_unsupported",
        "field_path": "model.provider",
        "step_id": "basic",
        "message": "The selected harness does not support this model provider."
      }
    ],
    "warnings": [],
    "allowed_fixes": [
      {
        "id": "select-compatible-model",
        "field_path": "model",
        "operation": "replace",
        "requires_confirmation": true
      }
    ],
    "conversation_impact": {
      "has_existing_bindings": false,
      "existing_policy": "pin",
      "new_conversations_use_selected_harness": true,
      "certified_transfer_paths": []
    }
  }
}
```

Use `422` only when the validation request itself is malformed. A valid request whose proposed configuration is incompatible returns `200` with `valid: false`, allowing the editor to render all field errors at once.

Validation requirements:

- `field_path` uses stable agent-document paths; `step_id` is one of `basic`, `instructions`, `tools`, `skills`, or `advanced`.
- A capability issue includes its effective level, severity, sanitized message, and bounded constraints needed to render the field.
- `allowed_fixes` contains data-only, deterministic operations. It never contains executable code, and the client must display each operation before applying it.
- The server computes `config_fingerprint` from the normalized allowlisted agent payload and computes `catalog_revision` from effective descriptors and policy.
- The client correlates `request_id`, `config_fingerprint`, and `catalog_revision` with its current draft; an old response cannot clear current blockers.
- Unknown or unavailable stored harnesses can be validated for inspection/migration without being represented as Deep Agents.

### GET `/api/v1/harnesses/{harness_id}/health`

Admin/debug endpoint returning one adapter's sanitized health and capacity.

```json
{
  "success": true,
  "data": {
    "id": "agentcore",
    "availability": "available",
    "certification": "experimental",
    "checked_at": "2026-08-17T00:00:00Z",
    "checks": [
      { "name": "dependency", "status": "pass" },
      { "name": "configuration", "status": "pass" },
      { "name": "provider", "status": "pass" }
    ],
    "capacity": {
      "active": 0,
      "limit": 10,
      "pending_initializations": 0
    }
  }
}
```

## BFF contract additions

The existing `/api/dynamic-agents` CRUD remains owned by Next.js and gains optional `harness` and portable `memory` fields matching [data-model.md](../data-model.md). The BFF:

1. preserves absence for legacy documents or writes the explicit default according to UI behavior;
2. calls runtime validation for the exact normalized payload before every create/update, including the default harness;
3. rejects unknown harness fields and unsafe options;
4. continues to own OpenFGA tuple updates and agent ownership;
5. proxies the harness catalog/validation through additive `/api/dynamic-agents/harnesses` routes;
6. treats any browser-supplied fingerprint/revision as an optimistic concurrency hint, never as proof of compatibility;
7. performs no MongoDB or OpenFGA mutation when validation is invalid, unavailable, mismatched, or stale.

Browser-facing routes:

| Method | Path | Contract |
|---|---|---|
| `GET` | `/api/dynamic-agents/harnesses` | Sanitized proxy of the effective catalog; preserves `catalog_revision`. |
| `POST` | `/api/dynamic-agents/harnesses/validate` | Authorized draft preflight; returns the field-addressable report and performs no write/provider call. |
| `GET` | `/api/dynamic-agents/models?harness_id={id}` | Existing model shape filtered or annotated by effective harness/model compatibility. |

Create/update ordering:

1. Authorize the caller for the requested create/update operation.
2. Strip non-mutable and unknown fields, validate strict `harness` and `memory` schemas, and normalize the payload.
3. Compare an optional browser catalog revision with the current revision; on mismatch return `409 HARNESS_VALIDATION_STALE` with a fresh report.
4. Validate the normalized payload through Harness Engine and locally recompute/compare its fingerprint.
5. If valid, write the agent and then reconcile OpenFGA using the existing compensating behavior. No validation failure reaches this step.

The BFF may cache catalog reads briefly by `catalog_revision`, but save validation is never satisfied from a browser cache. Model results retain an existing selected model as an explicitly incompatible item so edit forms never silently reset it.

## Error taxonomy

Existing errors retain status and message behavior. New machine-readable codes are additive:

| Code | HTTP | Meaning |
|---|---:|---|
| `harness_unknown` | 422/503 | Configuration names no registered adapter. |
| `harness_disabled` | 503 | Adapter is known but disabled. |
| `harness_unavailable` | 503 | Dependency, configuration, or health missing. |
| `harness_contract_incompatible` | 422/503 | Requested/stored contract version unsupported. |
| `harness_capability_unsupported` | 422/503 | Required agent behavior cannot be supplied. |
| `harness_session_conflict` | 409 | Conversation is bound to a different harness/epoch or concurrent mutation. |
| `harness_event_invalid` | stream error/500 | Adapter violated canonical lifecycle. |
| `thread_durability_uncertain` | stream error/503 | Output may have occurred, but the final thread state was not durably committed; no automatic replay. |
| `memory_revision_conflict` | `409` or canonical tool error | Memory changed since the expected revision; retry or approved consolidation required. |
| `harness_session_degraded` | stream warning/error/503 | Native state could not be durably persisted or restored. |
| `harness_validation_stale` | 409 | Draft/catalog/policy revision changed; response includes a fresh field-addressable report and no configuration/authz mutation occurred. |

On stream endpoints, new failures are encoded through the selected existing protocol. Raw provider errors, ARNs not already authorized for display, subprocess output, credentials, and stack traces are never sent to clients.

## Compatibility verification

- Freeze current OpenAPI before implementation.
- Compare method, path, parameters, requiredness, enums, response schema, headers, and security metadata.
- Replay golden custom SSE and AG-UI frames for current scenarios.
- Existing BFF/client tests run without fixture changes for the default harness.
- Additive endpoint tests prove disabled/unhealthy adapters do not alter global readiness unless the default compatibility adapter is unavailable.
