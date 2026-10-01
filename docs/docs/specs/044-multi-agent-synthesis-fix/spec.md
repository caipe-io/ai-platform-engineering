---
sidebar_position: 2
sidebar_label: Specification
title: "2026-01-22: Multi-Agent Synthesis Fix"
---

# Multi-Agent Synthesis Fix

**Date**: 2026-01-22
**Status**: 🟢 In-use
**Author**: Sri Aradhyula &lt;sraradhy@cisco.com&gt;

## Summary

Fixed an issue where the supervisor's final answer only contained the last sub-agent's response instead of a synthesized summary from all agents when multiple agents were invoked.


## Motivation

When a user query required multiple agents (e.g., "get apps for CAIPE, search for CAIPE in RAG, look for info for caipe-io/ai-platform-engineering"), the system would:

1. Stream content from ALL agents correctly (user sees all results)
2. But return only the LAST agent's response as the final answer

### Root Cause

The `sub_agent_complete` boolean flag in `StreamState` was blocking all streaming after the **first** sub-agent completed:

```python
# OLD CODE - PROBLEMATIC
if state.sub_agent_complete:
    logger.info("🛑 Skipping streaming chunk - sub-agent already sent complete_result")
    return  # Blocks ALL subsequent streaming!
```

This caused:
1. First agent completes → `sub_agent_complete = True`
2. Second agent's streaming chunks → **SKIPPED**
3. Third agent's streaming chunks → **SKIPPED**
4. Supervisor's synthesis → **SKIPPED**

The `_get_final_content()` method would then return only the first agent's content (from artifact-updates), not the supervisor's synthesis.


## Testing Strategy

Tested with query: "get apps for CAIPE, search for CAIPE in RAG, look for info for caipe-io/ai-platform-engineering"

Expected result: Final answer contains synthesized summary from all three agents (ArgoCD, RAG, GitHub).


## Related

- [2026-01-16-executor-simplification-refactor.md](../executor-simplification-refactor/spec) - Original executor refactor
- [2025-11-05-a2a-artifact-streaming-fix.md](../a2a-artifact-streaming-fix/spec) - Previous streaming fixes


- Architecture: [architecture.md](./architecture.md)
