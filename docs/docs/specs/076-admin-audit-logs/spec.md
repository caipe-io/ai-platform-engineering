---
sidebar_position: 2
sidebar_label: Specification
title: "2026-03-03: Admin Audit Logs — All-Chats Compliance View"
---

# Admin Audit Logs — All-Chats Compliance View

**Date**: 2026-03-03
**Status**: Implemented
**Type**: Feature Addition

## Overview

Added an optional admin-only feature that allows platform administrators to browse, search, and export all conversations and full message content across all users. The feature is gated by the `AUDIT_LOGS_ENABLED` environment variable and disabled by default.

## Motivation

Administrators had no way to review user conversations with AI agents for compliance, auditing, or support purposes. The existing admin dashboard provided aggregate statistics (total conversations, message counts, top users) but no ability to inspect individual conversation content across users.

## Related

- Spec: [admin-audit-logs](../089-admin-audit-logs/spec.md)
- PR: [#894](https://github.com/caipe-io/ai-platform-engineering/pull/894) (initial implementation)
- Tests: `ui/src/app/api/__tests__/admin-audit-logs.test.ts` (52 tests)
- Tests: `ui/src/app/api/__tests__/admin-audit-access.test.ts` (8 tests)
- Tests: `ui/src/lib/__tests__/config.test.ts` (4 `auditLogsEnabled` tests)
- Admin dashboard: `ui/src/app/(app)/admin/page.tsx`
- Config system: `ui/src/lib/config.ts`

- Architecture: [architecture.md](./architecture.md)
