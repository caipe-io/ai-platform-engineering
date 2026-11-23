"""Focused coverage for Webex-specific GFM table formatting."""

from __future__ import annotations

from ai_platform_engineering.integrations.webex_bot.utils.webex_markdown import (
    WEBEX_TABLE_MAX_COLUMNS,
    format_webex_markdown,
)


def test_compact_table_aligns_columns_without_final_padding() -> None:
    source = "| ID | Region | State |\n|---|---|---|\n| x1 | eu-central-1 | available |"

    formatted = format_webex_markdown(source)

    assert formatted == (
        "```text\n"
        "ID | Region       | State\n"
        "---+--------------+----------\n"
        "x1 | eu-central-1 | available\n"
        "```"
    )
    assert not formatted.splitlines()[-2].endswith(" ")


def test_compact_table_uses_longer_fence_than_cell_backticks() -> None:
    source = "| Value |\n|---|\n| &#96;&#96;&#96; |"

    formatted = format_webex_markdown(source)

    assert formatted == "````text\nValue\n-----\n```\n````"


def test_wide_table_uses_labeled_records_within_width_limit() -> None:
    source = (
        "| VPC ID | Region | Primary CIDR | Default | State |\n"
        "|---|---|---|---|---|\n"
        "| vpc-example-primary | region-a | 192.0.2.0/24 | No | available |\n"
        "| vpc-example-secondary | region-b | 198.51.100.0/24 | No | available |"
    )

    formatted = format_webex_markdown(source)
    lines = formatted.splitlines()[1:-1]

    assert formatted.startswith("```text\nVPC ID: vpc-example-primary")
    assert "Region: region-a" in formatted
    assert "Primary CIDR: 192.0.2.0/24" in formatted
    assert "Default: No" in formatted
    assert "State: available" in formatted
    assert "\n\nVPC ID: vpc-example-secondary" in formatted
    assert all(len(line) <= WEBEX_TABLE_MAX_COLUMNS for line in lines)
    assert all(not line.endswith(" ") for line in lines)
    assert all(not line.endswith("|") for line in lines)


def test_wide_header_only_table_preserves_and_wraps_all_headers() -> None:
    first_header = "first-column-" + "a" * 27
    second_header = "second-column-" + "b" * 26
    source = f"| {first_header} | {second_header} |\n|---|---|"

    formatted = format_webex_markdown(source)
    lines = formatted.splitlines()[1:-1]

    assert formatted.startswith("```text\nColumns:\n")
    assert first_header in formatted
    assert second_header in formatted
    assert all(len(line) <= WEBEX_TABLE_MAX_COLUMNS for line in lines)


def test_wide_subnet_table_keeps_each_value_with_its_header() -> None:
    source = (
        "| VPC ID | VPC CIDR | Region | SubnetId | SubnetCIDR | AvailabilityZone | Subnet name/tag |\n"
        "|---|---|---|---|---|---|---|\n"
        "| vpc-example-primary | 172.31.0.0/16 | us-east-1 | subnet-example-01 | "
        "172.31.0.0/20 | us-east-1a | default |\n"
        "| vpc-example-primary | 172.31.0.0/16 | us-east-1 | subnet-example-02 | "
        "172.31.80.0/20 | us-east-1b | application |"
    )

    formatted = format_webex_markdown(source)
    lines = formatted.splitlines()[1:-1]

    assert "VPC ID: vpc-example-primary" in formatted
    assert "VPC CIDR: 172.31.0.0/16" in formatted
    assert "SubnetId: subnet-example-01" in formatted
    assert "SubnetCIDR: 172.31.0.0/20" in formatted
    assert "AvailabilityZone: us-east-1a" in formatted
    assert "Subnet name/tag: default" in formatted
    assert "\n\nVPC ID: vpc-example-primary" in formatted
    assert all(len(line) <= WEBEX_TABLE_MAX_COLUMNS for line in lines)
    assert all(not line.endswith("|") for line in lines)


def test_labeled_records_use_longer_fence_than_cell_backticks() -> None:
    identifier = "x" * 55
    source = (
        "| ID | Value | Note |\n|---|---|---|\n"
        f"| {identifier} | &#96;&#96;&#96; | example |"
    )

    formatted = format_webex_markdown(source)

    assert formatted.startswith("````text\n")
    assert "Value: ```" in formatted
    assert formatted.endswith("\n````")


def test_table_links_show_labels_and_prose_is_preserved() -> None:
    source = (
        "Here are the results.\n\n"
        "| CIDR | State |\n|---|---|\n"
        "| [192.0.2.0/24](https://example.com/network) | **available** |\n\n"
        "The table is complete."
    )

    formatted = format_webex_markdown(source)

    assert formatted.startswith("Here are the results.\n\n```text\n")
    assert "192.0.2.0/24" in formatted
    assert "https://example.com/network" not in formatted
    assert "**available**" not in formatted
    assert formatted.endswith("```\n\nThe table is complete.")


def test_underscores_in_identifiers_are_preserved() -> None:
    source = "| VPC name | Status |\n|---|---|\n| vpc_example_metering_dev | _available_ |"

    formatted = format_webex_markdown(source)

    assert "vpc_example_metering_dev" in formatted
    assert "available" in formatted
    assert "_available_" not in formatted


def test_preview_withholds_incomplete_trailing_table() -> None:
    source = "The result follows.\n\n| ID | Region |\n|---|---|\n| x1 | eu-central-1 |"

    formatted = format_webex_markdown(source, preview=True)

    assert formatted == "The result follows."


def test_preview_withholds_possible_header_and_partial_separator() -> None:
    source = "The result follows.\n\n| ID | Region |\n|---|"

    formatted = format_webex_markdown(source, preview=True)

    assert formatted == "The result follows."


def test_preview_renders_table_after_a_non_table_line_closes_it() -> None:
    source = "| ID | State |\n|---|---|\n| x1 | available |\nDone"

    formatted = format_webex_markdown(source, preview=True)

    assert formatted.startswith("```text\nID | State\n---+----------\nx1 | available\n```\nDone")


def test_fenced_code_and_malformed_table_like_text_are_unchanged() -> None:
    source = "```md\n| A | B |\n|---|---|\n```\n\n| A | B |\n|---|---|\n| one | two | three |"

    formatted = format_webex_markdown(source)

    assert formatted == source


def test_fence_marker_with_info_text_inside_code_block_does_not_close_it() -> None:
    source = "```text\ninside\n```example\n| A | B |\n|---|---|\n| one | two |\n```"

    formatted = format_webex_markdown(source)

    assert formatted == source


def test_fence_with_trailing_whitespace_closes_code_block() -> None:
    source = "```md\n| A | B |\n|---|---|\n| one | two |\n``` \t\n\n| ID | State |\n|---|---|\n| x1 | ready |"

    formatted = format_webex_markdown(source)

    assert formatted == (
        "```md\n| A | B |\n|---|---|\n| one | two |\n``` \t\n\n"
        "```text\nID | State\n---+------\nx1 | ready\n```"
    )


def test_inline_code_pipes_do_not_split_cells() -> None:
    source = (
        "| Expr | State |\n|---|---|\n"
        "| `a|b` | available |\n"
        "| `[literal](https://example.com)` | available |"
    )

    formatted = format_webex_markdown(source)

    assert r"a\|b" in formatted
    assert "`a" not in formatted
    assert "[literal](https://example.com)" in formatted
    assert " | available" in formatted


def test_overlong_cell_wraps_without_exceeding_width_target() -> None:
    identifier = "vpc-" + "a" * 80
    source = f"| VPC ID | Region | State |\n|---|---|---|\n| {identifier} | eu-central-1 | available |"

    formatted = format_webex_markdown(source)
    lines = formatted.splitlines()[1:-1]

    assert all(len(line) <= WEBEX_TABLE_MAX_COLUMNS for line in lines)
    assert identifier in "".join(line for line in lines if line.startswith("vpc-") or line.startswith("a"))


def test_wide_unicode_values_use_display_width_for_column_alignment() -> None:
    source = "| Label | State |\n|---|---|\n| 界 | ready |\n| e\u0301 | ready |"

    formatted = format_webex_markdown(source)

    assert formatted == "```text\nLabel | State\n------+------\n界    | ready\né     | ready\n```"
