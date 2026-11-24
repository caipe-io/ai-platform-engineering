# Research: Compact Webex Markdown Tables

**Date**: 2026-11-20  
**Spec**: [spec.md](./spec.md)

## Decisions

### Use fenced monospaced text tables

- **Decision**: Replace complete GFM pipe-table blocks with fenced text blocks only in Webex outbound bodies.
- **Rationale**: Webex documents fenced code blocks as supported Markdown, while its Markdown subset does not include GFM table rendering. Code fences preserve a predictable monospaced surface without Adaptive Card payloads.
- **Alternatives considered**: Row-summary bullets were rejected because repeated field labels make larger tables verbose. Adaptive Cards were rejected for this feature because of delivery/update and payload complexity.
- **Source**: [Webex REST API Basics — Formatting Messages](https://developer.webex.com/docs/rest-api-basics)

### Avoid fence collisions with cell content

- **Decision**: Use a backtick fence longer than the longest backtick run in the rendered table, for both compact tables and labeled records.
- **Rationale**: Cell content must not accidentally close the outer code block. `message_limits.py` already detects the opening fence length and uses it when closing a truncated reply.
- **Alternatives considered**: A fixed three-backtick fence collides with cells containing three backticks; switching to tildes can collide with cell text and complicates the existing closure logic.

### Measure full tables and choose a narrow layout

- **Decision**: Compute widths from the entire complete table. Use aligned columns up to 60 display columns; above that, render labeled record blocks, packing complete header-value fields onto lines up to the width limit and separating records with a blank line.
- **Rationale**: Data-derived widths avoid arbitrary padding. Labeled fields remain unambiguous when a wide table cannot fit as aligned columns, and blank lines make multi-line records easier to scan.
- **Alternatives considered**: Always keep wide columns (wraps on narrow clients); put the first cell on one line and join all remaining columns (can split headers and leave dangling separators on narrow clients).

### Withhold unfinished table blocks in previews

- **Decision**: Derive streaming previews from the accumulated response but omit an open trailing table block. Render the block once a non-row line closes it or the stream ends.
- **Rationale**: Column widths need the full row set; otherwise new values shift columns on each edit. The responder already coalesces edits and can continue streaming preceding prose.

### Preserve original agent content

- **Decision**: Format only the body passed to Webex delivery; store the original response unchanged.
- **Rationale**: The web UI uses a GFM-capable Markdown renderer and should retain its original rich table.

### Keep truncation line-safe

- **Decision**: When the existing byte cap is exceeded, truncate wide-table output at complete record boundaries, close any open code fence, and append the existing continuation notice and footer.
- **Rationale**: The bounded formatter closes code fences and keeps the configured byte cap. A cut at a blank record boundary prevents partial field sets from being presented as complete rows.

## Repository Findings

- `webex_responder.py` accumulates `TEXT_MESSAGE_CONTENT`, sends coalesced previews, and records the original final response separately from the outbound message body.
- `utils/message_limits.py` enforces a 7,439-byte Webex message cap and already closes Markdown code fences after truncation.
- The UI's shared `MarkdownRenderer` enables GFM, so persisted source tables can remain unchanged.

## Risks and Limits

- Webex documents code fences, but does not promise that every client viewport will avoid wrapping. The 60-column fallback reduces line width; very narrow clients can still wrap individual long values.
- Markdown table parsing must ignore pipes in escaped text, inline code, and fenced code blocks. Malformed table-like text must be preserved as-is.
- Webex code blocks do not retain clickable Markdown links; the visible link label is retained as plain text.
