---
sidebar_position: 2
sidebar_label: Specification
id: 089-admin-audit-logs-spec
---

# Spec: Admin Audit Logs

## Overview

Admin-only feature that allows administrators to browse, search, and export all conversations and full message content across all users, gated by the `AUDIT_LOGS_ENABLED` environment variable (disabled by default).

## Motivation

Platform administrators need visibility into all chat conversations for compliance, auditing, and support purposes. Without this, there is no way for admins to review what users are discussing with the AI agents, investigate issues reported by users, or audit platform usage at the conversation level.

## Scope

### In Scope
- Environment variable toggle (`AUDIT_LOGS_ENABLED=true`) to enable the feature
- Admin API endpoints for listing conversations, reading messages, exporting to CSV, and searching owners
- Admin UI tab with search, filtering, and pagination
- Searchable owner email dropdown with typeahead autocomplete
- Conversation detail dialog showing full message content with scrollable layout
- Conversation UUID display with direct chat link and copy-to-clipboard
- CSV export of audit logs (respects active filters, up to 10,000 rows)
- Server-side enforcement of the feature flag (API returns 403 when disabled)

### Out of Scope
- Exporting to external SIEM systems
- Real-time streaming of new conversations/messages
- Editing or deleting conversations from the audit view
- Per-message audit trail (who viewed what)
- Retention policies for audit data

## Design

### Architecture

The feature adds a new "Audit Logs" tab to the existing admin dashboard, backed by four API endpoints that query the existing MongoDB `conversations` and `messages` collections. No new collections or data models are introduced — the feature provides a read-only cross-user view over existing data.

The feature is double-gated:
1. `AUDIT_LOGS_ENABLED=true` env var must be set (disabled by default)
2. User must be a full admin (`requireAdmin`) — read-only admin viewers cannot access audit logs

### Data Models

The feature introduces two types in `ui/src/types/mongodb.ts`:

- **`AuditConversation`** — extends `Conversation` with `message_count`, `last_message_at`, and `status` (derived via aggregation pipeline)
- **`AuditLogFilters`** — describes the filter parameters: `owner_email`, `search`, `date_from`, `date_to`, `include_deleted`, `status`

### API Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/admin/audit-logs` | GET | `requireAdmin` | List all conversations with filters and pagination |
| `/api/admin/audit-logs/[id]/messages` | GET | `requireAdmin` | Get paginated messages for a specific conversation |
| `/api/admin/audit-logs/export` | GET | `requireAdmin` | Download filtered conversations as CSV (up to 10,000 rows) |
| `/api/admin/audit-logs/owners` | GET | `requireAdmin` | Search distinct conversation owner emails (typeahead) |

### List Endpoint Filters

| Parameter | Type | Description |
|---|---|---|
| `owner_email` | string | Filter by conversation owner (case-insensitive substring) |
| `search` | string | Search in conversation titles (case-insensitive substring) |
| `date_from` | ISO date | Conversations created on or after this date |
| `date_to` | ISO date | Conversations created on or before this date |
| `status` | enum | `active`, `archived`, or `deleted` |
| `include_deleted` | boolean | Include soft-deleted conversations (default: false) |
| `page` | number | Page number (default: 1) |
| `page_size` | number | Items per page (default: 20, max: 100) |

### Components Affected
- [ ] Agents (`ai_platform_engineering/agents/`)
- [ ] Multi-Agents (`ai_platform_engineering/multi_agents/`)
- [ ] MCP Servers
- [ ] Knowledge Bases (`ai_platform_engineering/knowledge_bases/`)
- [x] UI (`ui/`)
  - `ui/src/lib/config.ts` — `auditLogsEnabled` config flag
  - `ui/src/types/mongodb.ts` — `AuditConversation`, `AuditLogFilters` types
  - `ui/src/app/api/admin/audit-logs/route.ts` — list conversations endpoint
  - `ui/src/app/api/admin/audit-logs/[id]/messages/route.ts` — conversation messages endpoint
  - `ui/src/app/api/admin/audit-logs/export/route.ts` — CSV export endpoint
  - `ui/src/app/api/admin/audit-logs/owners/route.ts` — searchable owners endpoint
  - `ui/src/app/(app)/admin/page.tsx` — conditional Audit Logs tab
  - `ui/src/components/admin/AuditLogsTab.tsx` — filter/search/table component with export and owner search
  - `ui/src/components/admin/ConversationDetailDialog.tsx` — message viewer dialog with scrolling
  - `ui/.env.example` — documented `AUDIT_LOGS_ENABLED` env var
- [x] Documentation (`docs/`)
  - ADR: [2026-03-03-admin-audit-logs](../076-admin-audit-logs/architecture.md)
- [x] Tests (`ui/src/`)
  - `ui/src/app/api/__tests__/admin-audit-logs.test.ts` — 52 tests covering all 4 endpoints
  - `ui/src/app/api/__tests__/admin-audit-access.test.ts` — 8 tests for `requireConversationAccess` admin audit access
  - `ui/src/lib/__tests__/config.test.ts` — 4 tests for `auditLogsEnabled` env-var behavior
- [ ] Helm Charts (`charts/`)

## Acceptance Criteria

- [x] Feature is disabled by default (no env var = tab hidden, API returns 403)
- [x] Setting `AUDIT_LOGS_ENABLED=true` shows the Audit Logs tab in admin dashboard
- [x] Admins can search conversations by owner email, title, date range, and status
- [x] Owner email field provides searchable autocomplete with typeahead
- [x] Admins can view full message content for any conversation
- [x] Conversation detail dialog has proper scrolling for long conversations
- [x] Conversation UUID is visible with copy-to-clipboard and direct chat link
- [x] Admins can download filtered audit logs as CSV
- [x] API enforces `requireAdmin` authorization on all endpoints (full admin only, not read-only viewers)
- [x] API enforces feature flag server-side (not just UI hiding)
- [x] Pagination works for both conversation list and message detail
- [x] No write operations are exposed (read-only audit view)
- [x] CSV export includes proper headers, escaping, and `Cache-Control: no-store`
- [x] All 52 unit tests pass (API endpoints)
- [x] All 4 config env-var tests pass (`auditLogsEnabled`)
- [x] All 8 admin audit access tests pass
- [x] `AUDIT_LOGS_ENABLED` documented in `ui/.env.example`
- [x] Documentation updated (spec + ADR)

## Implementation Plan

### Phase 1: Core Feature
- [x] Add `auditLogsEnabled` to Config interface, DEFAULT_CONFIG, and getServerConfig()
- [x] Add `AuditConversation` and `AuditLogFilters` types
- [x] Create `GET /api/admin/audit-logs` with aggregation pipeline
- [x] Create `GET /api/admin/audit-logs/[id]/messages` for conversation detail
- [x] Create `AuditLogsTab` component with filters and results table
- [x] Create `ConversationDetailDialog` component for message viewing
- [x] Add conditional tab to admin page

### Phase 2: Enhancements
- [x] Add CSV export endpoint (`GET /api/admin/audit-logs/export`)
- [x] Add Download CSV button to AuditLogsTab UI
- [x] Add searchable owner email dropdown with `GET /api/admin/audit-logs/owners`
- [x] Add conversation UUID display, copy-to-clipboard, and direct chat link
- [x] Implement scrollable message content in ConversationDetailDialog

### Phase 3: Quality & Documentation
- [x] Create comprehensive test suite (52 API tests + 4 config tests + 8 access tests = 64 total)
- [x] Add `AUDIT_LOGS_ENABLED` to `ui/.env.example`
- [x] Create spec in `.specify/specs/`
- [x] Create ADR in `docs/docs/changes/`

## Testing Strategy

- Config tests (4 tests in `config.test.ts`):
  - Default false when unset
  - `true` when `AUDIT_LOGS_ENABLED=true`
  - `false` when `AUDIT_LOGS_ENABLED=false`
  - `false` for non-`"true"` values (`"1"`, `"banana"`, `"TRUE"`)
- API tests (52 tests in `admin-audit-logs.test.ts`):
  - Auth: 401 unauthenticated, 403 non-admin, 403 readonly admin, 503 MongoDB not configured
  - Feature flag: 403 when `auditLogsEnabled` is false (all 4 endpoints)
  - List: filter propagation (owner, search, date range, status), pagination, aggregation pipeline
  - List edge cases: archived filter, include_deleted, date-only filters, combined filters, default pagination, sort order
  - Messages: 404 not found, conversation metadata, paginated messages, empty conversations, has_more pagination
  - Export: CSV headers, Content-Type/Content-Disposition, data rows, CSV escaping, filter propagation
  - Export edge cases: no tags, empty results, status filters
  - Owners: distinct owners, search query, `$group` aggregation, result limit, null filtering
- Access tests (8 tests in `admin-audit-access.test.ts`):
  - `requireConversationAccess` returns `admin_audit` access level for admin sessions
  - Non-admin/non-owner users get 403
  - Conversation not found returns 404
- Manual verification:
  - Set `AUDIT_LOGS_ENABLED=true`, verify tab appears
  - Unset env var, verify tab is hidden and API returns 403
  - Search by owner email using autocomplete dropdown
  - Click conversation to view full messages with scrolling
  - Download CSV and verify contents
  - Copy conversation UUID and open direct chat link

## Rollout Plan

1. Merge PR to main
2. Feature is off by default — no impact on existing deployments
3. Operators enable via `AUDIT_LOGS_ENABLED=true` in their environment
4. Document env var in deployment guides

## Related

- ADR: [2026-03-03-admin-audit-logs](../076-admin-audit-logs/architecture.md)
- PR: [#894](https://github.com/caipe-io/ai-platform-engineering/pull/894) (initial implementation)
- Tests: `ui/src/app/api/__tests__/admin-audit-logs.test.ts` (52 tests)
- Tests: `ui/src/app/api/__tests__/admin-audit-access.test.ts` (8 tests)
- Tests: `ui/src/lib/__tests__/config.test.ts` (4 `auditLogsEnabled` tests)
- Existing admin dashboard: `ui/src/app/(app)/admin/page.tsx`
- Config system: `ui/src/lib/config.ts`
