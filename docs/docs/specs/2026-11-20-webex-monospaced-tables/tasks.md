# Tasks: Compact Webex Markdown Tables

**Input**: [plan.md](./plan.md) and [spec.md](./spec.md)  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md  
**Tests**: Required by the feature acceptance criteria and repository test-first quality gates.

## Phase 1: Formatter tests (US1)

- [X] T001 [P] [US1] Add focused tests in `ai_platform_engineering/integrations/webex_bot/tests/test_webex_markdown.py` for GFM table recognition, compact alignment, no final-column padding, plain link labels, Markdown preservation, escaped/code-span pipes, Unicode widths, malformed tables, and the 60-column fallback.
- [X] T002 [P] [US1] Add row-safe byte-boundary cases to `ai_platform_engineering/integrations/webex_bot/tests/test_message_limits.py` for whole rows/records, valid fence closure, UTF-8 safety, notice/footer preservation, and the configured byte cap.

## Phase 2: Formatter implementation (US1)

- [X] T003 [US1] Implement Webex-specific complete GFM table parsing and compact/narrow fenced text rendering in `ai_platform_engineering/integrations/webex_bot/utils/webex_markdown.py` without adding dependencies.
- [X] T004 [US1] Update `ai_platform_engineering/integrations/webex_bot/utils/message_limits.py` to cut bounded output on complete lines and preserve the existing byte cap and continuation semantics.

## Phase 3: Streaming and persistence integration (US2)

- [X] T005 [US2] Add dispatcher tests in `ai_platform_engineering/integrations/webex_bot/tests/test_webex_responder.py` for omitted incomplete table previews, stable completed table output, unchanged no-table streaming, and preservation of original stored Markdown.
- [X] T006 [US2] Apply preview-safe formatting and final formatting at the Webex outbound boundary in `ai_platform_engineering/integrations/webex_bot/webex_responder.py`; keep `_record_message_turns` input as the original response.

## Phase 4: Quality gates

- [X] T007 Run focused pytest and Ruff commands from [quickstart.md](./quickstart.md); record outcomes against SC-001 through SC-005. Focused pytest passed (97 tests), Ruff passed, and `git diff --check` passed. The Quickstart uses the Webex bot's isolated `uv` project and runs Ruff without resolving the root project's full dependency graph.
- [X] T008 Review the implementation against `.specify/memory/constitution.md` and confirm no external API, database, dependency, or configuration contract changed.

## Phase 5: Wide-table readability follow-up

- [X] T009 [US1] Replace the wide-table two-line fallback with labeled records, preserve field/value associations and complete records on truncation; update focused tests and Spec Kit acceptance criteria.
- [X] T010 Run Ruff checks after T009 using the isolated Ruff command from [quickstart.md](./quickstart.md). All checks passed.
- [X] T011 Preserve the first record boundary when that record alone exceeds the reply budget; add regression coverage for an oversized first record and retain the completed-first-record case.
- [X] T012 Require whitespace-only closing fences in the table formatter; cover fence-like content with info text and valid closers followed by whitespace.
- [X] T013 Choose a generated fence longer than any backtick run in compact and labeled output; verify bounded truncation closes the generated fence.
- [X] T014 Preserve and wrap headers for a wide header-only table; add a regression case with two 40-character column names.
- [X] T015 Keep complete lines from ordinary fenced code blocks while preserving labeled table records as complete blocks; add coverage for a large code-only Python response.
- [X] T016 Keep compact table fences on line-boundary truncation even when a cell contains `: `; distinguish them using the generated compact-table separator row.
- [X] T018 Skip four-space- and tab-indented code during table detection and stop table row collection before indented code; add preservation tests.
- [X] T019 Match complete inline-code backtick runs by exact length; preserve longer interior runs and refuse partial matches against longer closing runs.
- [X] T020 [US1] Treat unmatched backtick runs as literal text in table-row detection and cell splitting; only matching exact-length runs delimit inline code, with regression coverage for unmatched and balanced spans.
- [X] T021 [US1] Preserve parenthesized Markdown link destinations, HTML line-break boundaries, joined-emoji display widths, and quote/list context when formatting tables; add focused regression coverage.
- [X] T022 Run focused formatter, message-limit, and responder tests plus Ruff and `git diff --check`; 121 tests passed and all checks passed.
