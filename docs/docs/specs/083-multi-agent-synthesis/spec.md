---
sidebar_position: 1
sidebar_label: Specification
---

# Spec: Multi-Agent Response Synthesis

> **Status: ABANDONED** — This feature was implemented but the approach has been abandoned. The spec is retained for historical reference.

## Overview

Fix for the supervisor to properly synthesize results from all sub-agents in multi-agent queries, instead of only displaying the last agent's response.

## Motivation

When users issue queries that invoke multiple agents (e.g., "get apps for CAIPE, search for CAIPE in RAG, look for info for caipe-io/ai-platform-engineering"), the supervisor was only showing the last agent's response in the final answer. This was a critical usability issue as users lost visibility into the full workflow results.

**Root Cause**: The `sub_agent_complete` boolean flag blocked ALL streaming after the first sub-agent completed, preventing:
- Subsequent agents' streaming chunks
- Supervisor's synthesis of all results

## Scope

### In Scope
- Fix streaming continuation for multi-agent scenarios
- Prioritize supervisor synthesis when multiple agents respond
- Maintain existing single-agent behavior
- Add logging for multi-agent detection

### Out of Scope
- Persisting sub-agent responses to workspace files
- Parallel agent execution optimization
- UI changes for multi-agent visualization

## Design

### Architecture

The fix uses a counter-based approach instead of a boolean flag:

```
Before: sub_agent_complete: bool = False  (blocks all after first)
After:  sub_agents_completed: int = 0     (counts completions)
```

**Content Priority Logic**:
1. Sub-agent DataPart (structured data - e.g., Jarvis forms)
2. Supervisor content (synthesis from multiple agents) - when `sub_agents_completed > 1`
3. Sub-agent text content (single agent fallback)

### Components Affected
- [x] Multi-Agents (`ai_platform_engineering/multi_agents/`)
  - `platform_engineer/protocol_bindings/a2a/agent_executor.py`
- [ ] Agents (`ai_platform_engineering/agents/`)
- [ ] MCP Servers
- [ ] Knowledge Bases (`ai_platform_engineering/knowledge_bases/`)
- [ ] UI (`ui/`)
- [x] Documentation (`docs/`)
  - ADR: [2026-01-22-multi-agent-synthesis-fix](../044-multi-agent-synthesis-fix/architecture.md)
- [ ] Helm Charts (`charts/`)

## Acceptance Criteria

- [x] Single-agent queries work unchanged
- [x] Multi-agent queries show synthesized results from ALL agents
- [x] Logs show "Sending multi-agent synthesis (N agents)" for multi-agent scenarios
- [x] No regression in streaming performance
- [x] ADR documenting the fix
- [x] Tests pass

## Implementation Plan

### Phase 1: Core Fix ✅
- [x] Replace `sub_agent_complete: bool` with `sub_agents_completed: int`
- [x] Update `_handle_sub_agent_artifact()` to increment counter
- [x] Update `_get_final_content()` with multi-agent priority logic
- [x] Remove early return in `_handle_streaming_chunk()`
- [x] Update `_handle_stream_end()` for multi-agent detection

### Phase 2: Documentation ✅
- [x] Create ADR in `docs/docs/changes/`
- [x] Create spec in `.specify/specs/`

### Phase 3: Validation
- [ ] Manual testing with multi-agent query
- [ ] Integration test for multi-agent synthesis

## Testing Strategy

- Unit tests: N/A (logic is deeply integrated with streaming)
- Integration tests: Test multi-agent query produces synthesized result
- Manual verification:
  - Query: "get apps for CAIPE, search for CAIPE in RAG, look for info for caipe-io/ai-platform-engineering"
  - Verify: Final answer contains synthesis from all three agents

## Rollout Plan

1. Deploy via PR merge to main
2. Container restart to load new code
3. Verify logs show multi-agent detection

## Related

- ADR: [2026-01-22-multi-agent-synthesis-fix](../044-multi-agent-synthesis-fix/architecture.md)
- Issues: [#667](https://github.com/caipe-io/ai-platform-engineering/issues/667)
- PRs: [#669](https://github.com/caipe-io/ai-platform-engineering/pull/669)
