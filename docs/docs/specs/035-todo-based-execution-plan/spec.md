---
sidebar_position: 2
sidebar_label: Specification
title: "2025-11-05: TODO-Based Execution Plan Architecture"
---

# TODO-Based Execution Plan Architecture

**Status**: 🟢 In-use
**Category**: Features & Enhancements
**Date**: November 5, 2025

## Overview

The Platform Engineer now uses **TODO lists as execution plans** instead of text-based execution plans with `⟦...⟧` markers. This solves the "execution plan without tool calls" problem and provides better UX.


## Benefits

### 1. **Forces Tool Execution**
- Agent MUST call `write_todos` first
- Can't complete without calling tools
- Eliminates "execution plan → completion without tools" bug

### 2. **Single Source of Truth**
- TODO list IS the execution plan
- No redundant content
- Clear, structured workflow

### 3. **Better UX**
- Interactive checklist with live status updates
- Clear icons (🔄 in-progress, ⏸️ pending, ✅ completed)
- Real-time progress tracking
- **Execution plan stays in dedicated pane** (not cluttering chat)
- **Status updates in-place** (no duplicate messages)
- **Clean separation**: Plan in one pane, results in another

### 4. **Clean Content Separation**
- **Execution Plan Pane**: Shows TODO list, updates in-place
- **Main Response Pane**: Shows actual agent work and results
- **No confusion**: User sees plan progress AND actual content clearly

### 5. **Backward Compatible**
- Clients receive `execution_plan_update` artifact (same as before)
- New `execution_plan_status_update` artifact for in-place updates
- agent-chat-cli updated to handle both
- agent-forge will need similar update (trivial)


## Testing Strategy

Restart the platform engineer and test with:
```bash
docker compose -f docker-compose.dev.yaml --profile p2p-no-rag restart platform-engineer-p2p
```

Try queries like:
- "show PRs in caipe-io/ai-platform-engineering"
- "check argocd version"
- "get recent alerts from komodor"

You should see:
1. TODO checklist appears immediately as execution plan
2. Agent executes tasks right away (no completion without tools)
3. TODO status updates as work progresses
4. Final synthesis with results



## Related

- Architecture: [architecture.md](./architecture.md)
