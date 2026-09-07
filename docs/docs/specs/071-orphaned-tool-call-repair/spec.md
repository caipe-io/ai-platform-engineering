---
sidebar_position: 2
sidebar_label: Specification
title: "2026-02-24: Orphaned Tool Call Repair for Bedrock Multi-Turn Conversations"
---

# Orphaned Tool Call Repair for Bedrock Multi-Turn Conversations

**Status**: Implemented
**Category**: Bug Fix / Resilience
**Date**: February 24, 2026
**PRs**: [#842](https://github.com/caipe-io/ai-platform-engineering/pull/842) (supervisor fixes), [#31](https://github.com/cnoe-io/cnoe-agent-utils/pull/31) (OTel fix)

## Overview

Fixes that improve supervisor resilience during multi-turn conversations with sub-agent delegations when using AWS Bedrock as the LLM provider. Addresses orphaned tool calls that permanently break conversations and a `response_format` incompatibility with Bedrock's Converse API.


## Motivation

### 1. Orphaned Tool Calls Break Multi-Turn Conversations

**Symptom**: After 2-3 turns involving sub-agent delegation, users see:
```
✅ I've recovered from an interrupted tool call. Let me continue processing your request...
❌ Recovery retry failed. Please ask your question again.
```

**Root Cause**: When a sub-agent call (e.g., `AWS_Agent`, `GitHub_Agent`) times out or the client disconnects mid-stream, LangGraph records an `AIMessage` with `tool_calls` but no corresponding `ToolMessage`. On the next turn, Bedrock's Converse API rejects the conversation with:
```
ValidationException: Expected toolResult blocks at messages.0.content
for the following Ids: tooluse_y6Ma8ihoB4Lqbmm4bumT7p
```

**Impact**: Conversation becomes permanently broken for that context. Users must start a new session.

**Frequency**: Common in multi-turn conversations with sub-agent delegations, especially when responses are large (ArgoCD listing 800+ apps, GitHub listing many PRs).

### 2. Bedrock `response_format` Causes Prefill ValidationException

**Symptom**: Sub-agents using `aws-bedrock` provider fail with:
```
ValidationException: This model does not support assistant message prefill.
The conversation must end with a user message.
```

**Root Cause**: LangGraph's `create_react_agent` with `response_format` appends a hidden `AIMessage` prefill. Bedrock's Converse API does not support assistant message prefill, causing every structured response attempt to fail.

**Impact**: Sub-agents fall back to error handling, producing `ResponseFormat` orphaned tool calls that cascade into the supervisor.


## Related

- Architecture: [architecture.md](./architecture.md)
