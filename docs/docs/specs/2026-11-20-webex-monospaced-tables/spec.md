# Feature Specification: Compact Webex Markdown Tables

**Feature Branch**: `2026-11-20-webex-monospaced-tables`  
**Created**: 2026-11-20  
**Status**: Labeled wide-table layout implemented; focused pytest and Ruff passed
**Input**: User request to format Dynamic Agent Markdown tables clearly in Webex, avoiding unsupported rendered tables and verbose row summaries.

## User Scenarios & Testing

### User Story 1 - Read Agent Tables in Webex (Priority: P1)

As a Webex user, I want tabular agent results displayed as compact aligned text, so I can compare values without seeing raw Markdown or verbose repeated labels.

**Why this priority**: Webex does not render the GFM tables used by agent responses, making table data difficult to scan.

**Independent Test**: Send an agent response containing a Markdown table to a Webex thread and inspect the final reply in a supported Webex client.

**Acceptance Scenarios**:

1. **Given** a complete GFM pipe table whose rendered width is at most 60 display columns, **When** the agent response is delivered, **Then** the table appears in a fenced monospaced block with compact, aligned columns.
2. **Given** a table wider than 60 display columns, **When** the final response is delivered, **Then** each row appears as a labeled record, complete header-value pairs stay together where possible, records are separated by a blank line, and every line is at most 60 display columns.
3. **Given** a table containing Markdown links, **When** it is rendered as code, **Then** users see the link label as plain text without the Markdown destination syntax.
4. **Given** ordinary prose and Markdown before or after a table, **When** the response is delivered, **Then** non-table content and its supported formatting are preserved.
5. **Given** a valid wide table with headers but no data rows, **When** the response is delivered, **Then** all headers appear in a wrapped monospaced representation within the 60-column limit.

### User Story 2 - Receive Stable Streaming Replies (Priority: P2)

As a Webex user, I want table previews to appear only after their rows and widths are stable, so streamed edits do not expose raw table syntax or repeatedly shift columns.

**Independent Test**: Stream a response containing prose followed by a multi-row table and verify intermediate edits omit the incomplete table, then show the aligned table after its ending is known.

**Acceptance Scenarios**:

1. **Given** a table is still being streamed, **When** a preview is published, **Then** the incomplete table block is withheld from that preview.
2. **Given** the table block is complete, **When** a subsequent preview or final reply is published, **Then** the whole table is rendered using widths computed from all of its rows.
3. **Given** a response contains no table, **When** it is streamed, **Then** existing Webex streaming behavior is unchanged.

## Edge Cases

- Escaped pipes, pipes inside code spans, fenced code blocks, and malformed table syntax must not be mistaken for table delimiters.
- Cells may contain links, inline code, HTML entities, Unicode, or missing values; rendered columns must remain aligned by display width.
- Rendered cell text may contain backtick runs; generated fences must be longer than every backtick run in the rendered block, and bounded replies must close that same fence.
- Oversized output must truncate at complete table rows or labeled records, close any generated code fence, and retain the existing continuation notice behavior.
- A labeled field whose value cannot fit within the width budget must wrap within the record while keeping its label visible and every generated line within the width target.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST convert complete GFM pipe tables in Webex agent replies to fenced monospaced text tables.
- **FR-002**: The system MUST calculate compact column widths from the table headers and all data rows, using rendered display width rather than raw string length.
- **FR-003**: The system MUST NOT add trailing padding after the final column and MUST use consistent single-space padding around column separators.
- **FR-004**: The system MUST convert Markdown links in table cells to their visible labels and preserve ordinary Markdown outside converted tables.
- **FR-005**: The system MUST use aligned columns when the complete table fits within 60 display columns and labeled record blocks otherwise. Wide-table wrapping MUST keep each field label associated with its value, MUST NOT leave a column separator at the end of a line, and MUST separate records clearly.
- **FR-006**: The system MUST withhold incomplete trailing table blocks from streaming previews until the block ends or the response completes.
- **FR-007**: The system MUST preserve complete table records, valid code fences, and the existing Webex byte limit and continuation behavior when replies are bounded.
- **FR-008**: The system MUST retain the original agent response when recording the conversation turn so the web UI can render its original GFM table.
- **FR-009**: The system MUST leave malformed or unsupported table-like content unchanged rather than corrupting the response.
- **FR-010**: The system MUST choose a generated backtick fence longer than every backtick run in the rendered table and preserve compatibility with bounded fence closure.
- **FR-011**: The system MUST preserve and wrap all headers when a valid table has no data rows and exceeds the 60-column limit.

### Key Entities

- **GFM table block**: A Markdown header, separator, and zero or more rows recognized as one complete table.
- **Rendered Webex table**: A presentation-only code block generated from a GFM table for the Webex message; it is not persisted as conversation content.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All valid fixtures up to 60 display columns produce aligned output with no trailing column padding.
- **SC-002**: All fixtures over 60 display columns use labeled records, preserve header-value associations, and remain within the 60-column target.
- **SC-003**: Streaming previews never contain a partial GFM table block, while non-table response previews retain existing behavior.
- **SC-004**: Bounded replies remain within the existing Webex byte cap, contain no partial generated row or record, and preserve the continuation notice.
- **SC-005**: Stored assistant content remains byte-for-byte equal to the original streamed response.
- **SC-006**: Compact and labeled tables containing backtick runs remain inside their generated code fences, including when the reply is truncated.
- **SC-007**: Wide header-only tables retain every header and keep each rendered line within 60 display columns.
