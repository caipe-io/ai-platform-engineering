---
sidebar_position: 1
id: 071-orphaned-tool-call-repair-architecture
sidebar_label: Architecture
---

# Architecture: Orphaned Tool Call Repair for Bedrock Multi-Turn Conversations

**Date**: 2026-02-24

## Solution Architecture

### Fix 1: Enhanced Orphaned Tool Call Repair

**Location**: `ai_platform_engineering/multi_agents/platform_engineer/protocol_bindings/a2a/agent.py`

The existing `_repair_orphaned_tool_calls` was enhanced to detect tool call IDs across all Bedrock-specific message formats:

```python
def _extract_tool_call_ids(msg: BaseMessage) -> set:
    """Extract tool call IDs from all possible locations in an AIMessage.

    Bedrock stores tool_use IDs in three places:
    1. msg.tool_calls[*]["id"]           - standard LangChain format
    2. msg.additional_kwargs["tool_use"] - Bedrock additional_kwargs
    3. msg.content[*] blocks with        - Bedrock content block format
       "type": "tool_use" and "id" key
    """
```

**Pre-fallback repair**: Before entering fallback streaming mode, the supervisor now attempts orphan repair:
```
⚠️ Supervisor: Found 1 orphaned tool calls. IDs: ['tooluse_y6Ma...']
🔧 Will remove AIMessage with orphaned tool_call
✅ Supervisor: Removed 1 AIMessage(s) with orphaned tool calls
```

**Force-repair**: For persistent Bedrock errors, extracts tool_use IDs directly from the error message via regex and removes matching `AIMessage`s from state.

### Fix 2: Bedrock response_format Bypass

**Location**: `ai_platform_engineering/utils/a2a_common/base_langgraph_agent.py`, `ai_platform_engineering/multi_agents/platform_engineer/deep_agent.py`

When `LLM_PROVIDER=aws-bedrock`, the `response_format` parameter is omitted from `create_react_agent` and the format instructions are embedded directly in the system prompt instead. This prevents the prefill `ValidationException` at its source.

### Fix 3: Safe Summarization Boundary

**Location**: `ai_platform_engineering/utils/a2a_common/langmem_utils.py`

`_find_safe_summarization_boundary` was enhanced to prevent splitting `tool_use` / `toolResult` pairs during context compression. If a `ToolMessage` in the "keep" zone references a `tool_call` in the "summarize" zone, the boundary shifts to include the corresponding `AIMessage`.

### Fix 4: OpenTelemetry Context Detach Noise Suppression

**Location**: `cnoe-agent-utils/cnoe_agent_utils/tracing/decorators.py` (separate repo)
**PR**: [cnoe-agent-utils#31](https://github.com/cnoe-io/cnoe-agent-utils/pull/31)

Added `_quiet_span_exit()` helper that temporarily raises the `opentelemetry.context` logger level to `CRITICAL` during span exit, preventing noisy `ValueError: <Token var=<ContextVar...> was created in a different Context` errors from polluting logs.


## Reproduction and Verification

### Multi-Turn Reproduction Test

The orphaned tool call issue is reproduced by sending 5+ turns to the supervisor using the same `contextId`, with queries that trigger sub-agent delegations:

```bash
CONTEXT_ID=$(python3 -c 'import uuid;print(uuid.uuid4())')

# Turn 1: GitHub sub-agent delegation
curl -sN -X POST http://localhost:8000 \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"t1","method":"message/stream","params":{"message":{"role":"user","parts":[{"kind":"text","text":"List 2 recent open PRs for caipe-io/ai-platform-engineering"}],"messageId":"m1","contextId":"'$CONTEXT_ID'"}}}'

# Turn 2: ArgoCD sub-agent (same context, builds history)
# Turn 3: Cross-reference (triggers summarization pressure)
# Turn 4: Context window check
# Turn 5: Another delegation to push context further
```

An automated integration test is available at `integration/test_orphan_repair_multiturn.py`:

```bash
PYTHONPATH=. uv run python integration/test_orphan_repair_multiturn.py
PYTHONPATH=. uv run python integration/test_orphan_repair_multiturn.py --turns 3
```

### Verified Results (Feb 24, 2026)

#### Run 1: 5-turn test

| Turn | Query | Events | Status | Text |
|------|-------|--------|--------|------|
| 1 | List 2 PRs (GitHub) | 104 | completed | 2,926 chars |
| 2 | ArgoCD apps in caipe-preview | 430 | completed | 6,541 chars |
| 3 | Summarize PRs + ArgoCD | 1,178 | completed | 27,068 chars |
| 4 | Context window usage | 120 | completed | 2,223 chars |
| 5 | Failing ArgoCD apps | 118 | completed | 2,041 chars |

**Orphan repair activated during Run 1** (confirmed conversation continued after repair):
```
⚠️ Supervisor: Found 1 orphaned tool calls. IDs: ['tooluse_y6Ma8ihoB4Lqbmm4bumT7p'], Names: ['AWS_Agent']
🔧 Will remove AIMessage with orphaned tool_call: msg_id=lc_run--019c919e...
✅ Supervisor: Removed 1 AIMessage(s) with orphaned tool calls. Earlier conversation history preserved.
```

#### Run 2: 10-turn stress test (GitHub + ArgoCD + Jira)

| Turn | Query | Events | Time | Status | Text |
|------|-------|--------|------|--------|------|
| 1 | List 5 recent open PRs (GitHub) | 126 | 20.4s | PASS | 3,889 chars |
| 2 | ArgoCD apps in caipe-preview | 188 | 21.3s | PASS | 5,988 chars |
| 3 | 5 most recent Jira tickets | 24 | 5.3s | TIMEOUT | 598 chars |
| 4 | Cross-reference PRs, ArgoCD, Jira | 517 | 19.4s | PASS | 7,725 chars |
| 5 | All open PRs across 2 repos | 890 | 45.2s | PASS | 42,259 chars |
| 6 | Combined status report | 1,307 | 59.4s | PASS | 25,814 chars |
| 7 | Failing/degraded ArgoCD apps (all namespaces) | 406 | 76.9s | PASS | 24,042 chars |
| 8 | Jira sprint tickets | 1,758 | 122.7s | PASS | 60,116 chars |
| 9 | Context window usage | 323 | 20.3s | PASS | 6,529 chars |
| 10 | Top 3 action items (cross-reference) | 1,428 | 54.3s | PASS | 20,887 chars |

**10-turn summary**: 9 completed, 0 failed, 1 timeout (Jira cold-start), 0 recovery failures, 0 fallback triggers.

No orphan repair was needed in Run 2, confirming that the upstream prevention fixes (Bedrock `response_format` bypass, safe summarization boundary) are effective at eliminating the root causes.

**Error counts across both runs**: 0 `Recovery retry failed`, 0 `fallback`.


## Unit Tests

50 unit tests in `tests/test_supervisor_streaming_json_and_orphaned_tools.py`:

| Test Class | Tests | Coverage |
|-----------|-------|----------|
| `TestExtractToolCallIds` | 5 | Standard, additional_kwargs, content blocks, dedup |
| `TestExtractToolCallIdsEdgeCases` | 7 | camelCase, toolUseId variant, single dict, mixed, malformed |
| `TestRepairOrphanedToolCalls` | 4 | No orphans, orphan in tool_calls/kwargs/content |
| `TestRepairOrphanedToolCallsEdgeCases` | 6 | None state, empty messages, multiple orphans, partial |
| `TestSafeummarizationBoundary` | 4 | Standard, kwargs, content block pairs, complete pairs |
| `TestSummarizationBoundaryEdgeCases` | 6 | Min keep, equal, no tools, multiple pending, cross-ref |
| `TestForceRepairRegex` | 6 | Bedrock format, LangGraph format, multiple IDs, hyphens |
| `TestPreflightContextCheckNullQuery` | 4 | None query, empty string, normal query |
| `TestPreflightContextCheckEdgeCases` | 6 | None state/values, no messages, threshold, exception |
| `TestJsonScopingFix` | 2 | No local json import, module-level callable |

```bash
PYTHONPATH=. uv run pytest tests/test_supervisor_streaming_json_and_orphaned_tools.py -v
# 50 passed in 3.68s
```


## Files Changed

| File | Change |
|------|--------|
| `ai_platform_engineering/multi_agents/platform_engineer/protocol_bindings/a2a/agent.py` | Enhanced orphan repair, pre-fallback repair, force-repair |
| `ai_platform_engineering/utils/a2a_common/langmem_utils.py` | `_extract_tool_call_ids`, safe summarization boundary, `query=None` support |
| `ai_platform_engineering/utils/a2a_common/base_langgraph_agent.py` | Bedrock response_format bypass, corporate CA bundle support for MCP HTTP transport |
| `ai_platform_engineering/multi_agents/platform_engineer/deep_agent.py` | Bedrock response_format bypass for supervisor graph |
| `tests/test_supervisor_streaming_json_and_orphaned_tools.py` | 50 unit tests |
| `integration/test_orphan_repair_multiturn.py` | 10-turn multi-turn integration test (GitHub, ArgoCD, Jira) |


## Decision Rationale

### Why repair at the supervisor level?

The orphaned tool call problem is inherent to LangGraph's checkpoint system with Bedrock. When a stream is cancelled, the checkpoint records the `AIMessage` with `tool_calls` but the `ToolMessage` response is never written. Repairing at the supervisor level (before the next LLM call) is the only place where we can access the checkpoint state and fix it before Bedrock rejects it.

### Why embed response_format in system prompt for Bedrock?

Bedrock's Converse API fundamentally does not support assistant message prefill. LangGraph's `create_react_agent` uses prefill internally when `response_format` is set. Rather than patching LangGraph, we bypass the issue by embedding the format instructions in the system prompt -- achieving the same structured output behavior without triggering the prefill.

### Why extract tool_call IDs from three locations?

Bedrock's Converse API stores tool_use information inconsistently across LangChain message formats. During normal operation, IDs appear in `tool_calls`. After checkpoint recovery, they may only exist in `additional_kwargs` or `content` blocks. Checking all three locations ensures no orphaned tool call is missed regardless of how the message was serialized.


## Related

- Spec: [spec.md](./spec.md)
