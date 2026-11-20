# Compact Webex Markdown Tables Implementation Plan

**Branch**: `2026-11-20-webex-monospaced-tables` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification for compact, aligned Markdown tables in Webex agent replies.

## Summary

Convert complete GFM pipe tables at the Webex outbound boundary into compact fenced text tables. Compute alignment from the full table, use labeled record blocks above 60 display columns, withhold incomplete tables from streamed previews, and retain original Markdown in stored turns. No Webex API, database, or configuration contract changes are needed.

## Technical Context

**Language/Version**: Python 3.13  
**Primary Dependencies**: Existing Python standard library, `httpx`, `pytest`; no new dependencies  
**Storage**: N/A — conversation storage keeps the original response unchanged  
**Testing**: pytest  
**Target Platform**: Webex bot service  
**Project Type**: Python service integration  
**Performance Goals**: Linear processing in response characters; no added Webex API calls  
**Constraints**: Webex supports a limited Markdown subset including fenced code blocks; existing message byte cap and delivery/edit limits remain in effect  
**Scale/Scope**: Format agent response tables only in Webex outbound messages; leave non-table content unchanged

## Constitution Check

- **I. Worse is Better / II. YAGNI**: Implement a focused table renderer without a new Markdown framework, card system, or configuration surface.
- **III. Rule of Three**: Keep this Webex-specific until another integration needs the same behavior.
- **IV. Composition**: Keep table parsing/rendering in a small utility and call it from the existing responder.
- **V. Specs as Source of Truth**: This feature has a dated spec and traceable acceptance criteria.
- **VI. CI Gates**: Add unit and dispatcher tests derived from every acceptance scenario; run the relevant focused checks before completion.
- **VII. Security by Default**: Emit table cell contents as code text, strip link destinations and Markdown wrappers, and never interpret cell HTML.

**Gate result**: PASS. No exception or persistence migration is required.

## Project Structure

### Documentation

```text
docs/docs/specs/2026-11-20-webex-monospaced-tables/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
└── checklists/requirements.md
```

No public API contract or database migration is needed.

### Source Code

```text
ai_platform_engineering/integrations/webex_bot/
├── utils/webex_markdown.py                 # Table detection, cell normalization, compact rendering
├── utils/message_limits.py                 # Preserve whole lines/rows when bounding formatted output
├── webex_responder.py                       # Apply stable formatting to preview and final Webex bodies
└── tests/
    ├── test_webex_markdown.py               # Pure formatting and parsing behavior
    ├── test_message_limits.py               # Row-safe bounds and valid fence closure
    └── test_webex_responder.py              # Streaming integration and original-history preservation
```

**Structure Decision**: Keep the formatter Webex-specific under the existing integration utilities and integrate at the existing response delivery boundary. Do not change the agent runtime or UI renderer.

## Data and Interface Decisions

- No persisted schema or entities are added; the formatter output is a transient Webex presentation.
- The Webex Messages API payload remains the existing `markdown` field.
- Complete GFM tables at or below 60 display columns use aligned columns with one-space delimiter padding and no trailing padding after the final cell.
- Wider tables use labeled record blocks. Pack complete header-value fields onto lines within 60 display columns, avoid dangling separators, and separate records with a blank line.
- Preview generation omits an open trailing table block. A table is published only once its end is known, so widths do not shift as rows arrive.
- Bound formatted content at line boundaries so a table row stays whole; keep the existing byte cap, continuation notice, footer, and UTF-8 safety.
- Persist the original agent response before any Webex-only conversion.

## Validation

- Unit tests cover GFM detection, pipe/code-span escaping, links, inline code, Unicode display width, missing cells, malformed tables, narrow layout, and prose preservation.
- Dispatcher tests cover withheld previews, formatting after table completion, no-table streaming behavior, and byte-for-byte original message persistence.
- Boundary tests ensure truncation keeps whole rows and closes generated fences without exceeding `WEBEX_MESSAGE_MAX_BYTES`.
- Run focused pytest tests and Ruff for the touched Python files; no external Webex credentials are required.

## Database Migrations

N/A — no persisted schema changes.

## Complexity Tracking

No constitution violations.
