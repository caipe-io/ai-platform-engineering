# Quickstart: Compact Webex Markdown Tables

## Validation scenarios

1. Format a representative five-column GFM table and verify all separators align, cell padding is minimal, the final column has no trailing padding, and Markdown links display only their labels.
2. Format a table whose natural width exceeds 60 display columns and verify it switches to labeled records, keeps each header with its value, separates records, and keeps every generated line within the target width.
3. Stream prose followed by a multi-row table. Verify previews retain preceding prose but omit the unfinished table; after the table closes, verify its rendered widths remain stable.
4. Stream a response without a table and verify existing preview content is unchanged.
5. Bound an oversized response containing a table. Verify complete records only, a closed code fence, the existing continuation notice, and the configured byte cap.
6. Verify the persisted assistant turn is byte-for-byte equal to the original GFM response.
7. Put a same-length fence marker with info text inside a fenced code block, then close the block with trailing whitespace. Verify only the valid closer ends the block and following tables remain eligible for formatting.
8. Put three backticks in a rendered table cell. Verify the generated fence is longer than the cell run, for both compact and labeled layouts, and remains correctly closed after truncation.
9. Format a wide header-only table with two long column names and verify every header appears within the line-width target.
10. Truncate a code-only Python fence containing many complete lines with block preservation enabled. Verify lines remain and the original fence is closed before the continuation notice.

## Focused checks

```bash
# From the repository root: install the Webex bot's test dependencies only.
cd ai_platform_engineering/integrations/webex_bot
uv sync --group unittest
cd ../../..

# Run the Webex bot tests in its isolated project environment.
uv run --project ai_platform_engineering/integrations/webex_bot pytest \
  ai_platform_engineering/integrations/webex_bot/tests/test_webex_markdown.py \
  ai_platform_engineering/integrations/webex_bot/tests/test_message_limits.py \
  ai_platform_engineering/integrations/webex_bot/tests/test_webex_responder.py

# Run Ruff without resolving the repository's full Python dependency graph.
uv run --no-project --with ruff==0.16.4 ruff check \
  ai_platform_engineering/integrations/webex_bot/utils/webex_markdown.py \
  ai_platform_engineering/integrations/webex_bot/utils/message_limits.py \
  ai_platform_engineering/integrations/webex_bot/webex_responder.py \
  ai_platform_engineering/integrations/webex_bot/tests/test_webex_markdown.py \
  ai_platform_engineering/integrations/webex_bot/tests/test_message_limits.py \
  ai_platform_engineering/integrations/webex_bot/tests/test_webex_responder.py
```

These checks use fake SSE and Webex API clients; no live Webex credentials are required.

## Recorded results

| Success criterion | Result | Evidence |
|---|---|---|
| SC-001 — Compact aligned tables | PASS | `test_compact_table_aligns_columns_without_final_padding` |
| SC-002 — Labeled wide-table records and line width | PASS | `test_wide_table_uses_labeled_records_within_width_limit`; `test_wide_subnet_table_keeps_each_value_with_its_header`; `test_overlong_cell_wraps_without_exceeding_width_target` |
| SC-003 — Stable previews and unchanged non-table streaming | PASS | `test_dispatcher_formats_complete_tables_but_persists_original_markdown`; existing preview coalescing tests |
| SC-004 — Bounded complete records and valid fences | PASS | `test_line_preserving_truncation_keeps_complete_rows_and_closes_fence`; `test_block_preserving_truncation_keeps_complete_labeled_records`; `test_block_preserving_truncation_drops_an_incomplete_first_record`; `test_block_preserving_truncation_keeps_complete_lines_in_python_fence`; message-limit boundary tests |
| SC-005 — Original stored response | PASS | `test_dispatcher_formats_complete_tables_but_persists_original_markdown` |
| SC-006 — Collision-free and bounded generated fences | PASS | `test_compact_table_uses_longer_fence_than_cell_backticks`; `test_labeled_records_use_longer_fence_than_cell_backticks`; `test_truncation_closes_a_generated_fence_longer_than_three_backticks` |
| SC-007 — Wide header-only tables retain every header | PASS | `test_wide_header_only_table_preserves_and_wraps_all_headers` |

**Focused pytest after the truncation refinement**: 108 passed across the formatter, message-limit, and responder test files. **Ruff**: all checks passed with `uv run --no-project --with ruff==0.16.4`. **`git diff --check`**: passed.
