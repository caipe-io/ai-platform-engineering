---
sidebar_position: 1
id: 075-openai-response-deduplication-fix-architecture
sidebar_label: Architecture
---

# Architecture: OpenAI Response Deduplication — Investigation & Fix

**Date**: 2026-02-28

## Duplicated Output Example

```text
## Current weather — Allen, Texas, US
| Temperature | 77.1 °F |
...
{"status":"completed","message":"## Current weather — Allen, Texas, US\n..."}

## Current weather — Allen, Texas, US
...
```

Anthropic Claude and AWS Bedrock do **not** exhibit this behavior.

---


## Fix Applied

**Location**: `agent.py`, `stream()` method — PRIORITY 2 and PRIORITY 3 paths.

**Change**: After `handle_structured_response()` successfully parses a
`PlatformEngineerResponse` (indicated by `is_task_complete` being non-None),
set `from_response_format_tool = True`:

```python
# PRIORITY 2 — using final AIMessage content
final_response = self.handle_structured_response(final_content)
if final_response.get('is_task_complete') is not None:
    final_response['from_response_format_tool'] = True

# PRIORITY 3 — using accumulated AI content (same fix)
final_response = self.handle_structured_response(accumulated_text)
if final_response.get('is_task_complete') is not None:
    final_response['from_response_format_tool'] = True
```

This directs `agent_executor.py` to use the clean parsed `.message` content
from the structured response instead of the raw `supervisor_content`
accumulation.

### Deployment method

The fix is deployed via a Kubernetes ConfigMap (`agent-fix`) that replaces
`agent.py` inside the supervisor pod:

```
ConfigMap: agent-fix  (from scripts/agent_fix.py)
Mount:     /app/ai_platform_engineering/multi_agents/platform_engineer/protocol_bindings/a2a/agent.py
Scope:     caipe-supervisor-agent deployment only
```

This is managed by `setup-caipe.sh` → `post_deploy_patches()` →
`_create_agent_fix_configmap()` + `_apply_agent_fix_volume()`.

### Backward compatibility

- **Bedrock**: Unaffected — uses PRIORITY 1 (tool-call) path; the fix code
  is never reached.
- **Claude**: Unaffected — same reason as Bedrock.
- **OpenAI**: Fixed — PRIORITY 2/3 paths now correctly set the flag.

---


## Approaches Considered and Rejected

### 1. Stripping JSON in `_get_final_content` (Option A)

Regex-based stripping of `PlatformEngineerResponse` JSON blobs from the
joined `supervisor_content`. Rejected as fragile "monkey patching" — it
treats symptoms rather than the root cause.

### 2. Filtering in `_handle_streaming_chunk` (Option B)

Skipping JSON blobs before appending to `supervisor_content`. Rejected for
the same reason — operates on symptoms and is hard to maintain.

### 3. `USE_STRUCTURED_RESPONSE=false` (Option C)

Disables structured output entirely. Rejected as it changes response quality
and removes a feature rather than fixing the integration.

### 4. Patching `_handle_task_complete` via `sitecustomize.py` (Fix 3)

The original `sitecustomize.py` approach patched `_handle_task_complete` to
extract `.message` when `from_response_format_tool=True`. This failed because
`from_response_format_tool` was never `True` for OpenAI — the exact root
cause this investigation identified.

---


## Current Patch State

| Patch | ConfigMap | Scope | Status |
|-------|-----------|-------|--------|
| Schema fix (`additionalProperties:false`) | `agent-patches` | All agents | Working |
| httpx redirect (`follow_redirects=True`) | `agent-patches` | All agents | Working |
| OpenAI response dedup (`from_response_format_tool=True`) | `agent-fix` | Supervisor | Working |

---


## File References

| File | Description |
|------|-------------|
| `scripts/agent_fix.py` | Patched `agent.py` with the two-line fix |
| `scripts/agent_executor_fix.py` | Original `agent_executor.py` (unmodified, for reference) |
| `setup-caipe.sh` (repo root) | Deployment script managing ConfigMaps and patches |
| Upstream repo | [ai-platform-engineering](https://github.com/caipe-io/ai-platform-engineering) |


## Related

- Spec: [spec.md](./spec.md)
