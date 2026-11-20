"""Deterministic, UTF-8-safe bounds for Webex Markdown replies."""

from __future__ import annotations

import re

WEBEX_MESSAGE_MAX_BYTES = 7439
WEBEX_LINK_RESERVE_BYTES = 100


def _utf8_prefix(
    text: str,
    budget: int,
    *,
    preserve_lines: bool = False,
    preserve_blocks: bool = False,
) -> str:
    prefix = text.encode("utf-8")[: max(0, budget)].decode("utf-8", errors="ignore")
    if preserve_lines and len(prefix) < len(text):
        if preserve_blocks:
            last_block_boundary = prefix.rfind("\n\n")
            if last_block_boundary >= 0:
                return prefix[:last_block_boundary]
        last_newline = prefix.rfind("\n")
        if last_newline >= 0:
            prefix = prefix[:last_newline]
    return prefix


def _code_closure(text: str) -> str:
    """Keep the continuation link outside a truncated Markdown code block/span."""
    fence = ""
    inline = ""
    for line in text.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if marker:
            run, rest = marker.groups()
            if not fence and not inline:
                fence = run
            elif fence and run[0] == fence[0] and len(run) >= len(fence) and not rest.strip():
                fence = ""
        elif not fence:
            for run in re.findall(r"`+", line):
                if run == inline:
                    inline = ""
                elif not inline:
                    inline = run
    closing = fence or inline
    return f"\n{closing}\n" if closing else ""


def bounded_markdown(
    body: str,
    *,
    footer: str,
    notice: str,
    preserve_line_boundaries: bool = False,
    preserve_block_boundaries: bool = False,
) -> str:
    """Keep the original prefix, reserving at least 100 bytes for continuation."""
    content = body.strip() or "Done."
    if len((content + footer).encode("utf-8")) <= WEBEX_MESSAGE_MAX_BYTES:
        return content + footer

    budget = (
        WEBEX_MESSAGE_MAX_BYTES
        - len(footer.encode("utf-8"))
        - max(WEBEX_LINK_RESERVE_BYTES, len(notice.encode("utf-8")))
    )
    if budget < 0:
        raise ValueError("Webex reply footer and continuation exceed the message limit")
    prefix = _utf8_prefix(
        content,
        budget,
        preserve_lines=preserve_line_boundaries,
        preserve_blocks=preserve_block_boundaries,
    )
    closing = _code_closure(prefix)
    while len((prefix + closing).encode("utf-8")) > budget:
        prefix = _utf8_prefix(
            prefix,
            budget - len(closing.encode("utf-8")),
            preserve_lines=preserve_line_boundaries,
            preserve_blocks=preserve_block_boundaries,
        )
        closing = _code_closure(prefix)
    return prefix + closing + notice + footer
