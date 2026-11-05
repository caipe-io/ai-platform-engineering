"""Deterministic, UTF-8-safe bounds for Webex Markdown replies."""

from __future__ import annotations

import re

WEBEX_MESSAGE_MAX_BYTES = 7439
WEBEX_LINK_RESERVE_BYTES = 100


def _utf8_prefix(text: str, budget: int) -> str:
    return text.encode("utf-8")[: max(0, budget)].decode("utf-8", errors="ignore")


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


def bounded_markdown(body: str, *, footer: str, notice: str) -> str:
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
    prefix = _utf8_prefix(content, budget)
    closing = _code_closure(prefix)
    while len((prefix + closing).encode("utf-8")) > budget:
        prefix = _utf8_prefix(prefix, budget - len(closing.encode("utf-8")))
        closing = _code_closure(prefix)
    return prefix + closing + notice + footer
