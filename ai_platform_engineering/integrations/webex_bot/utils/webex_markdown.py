"""Webex-specific formatting for Markdown tables in agent replies."""

from __future__ import annotations

import html
import re
import unicodedata
from collections.abc import Sequence

_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_SEPARATOR_CELL_RE = re.compile(r"^:?-+:?$")
_LINK_RE = re.compile(r"!?\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+\"[^\"]*\")?\)")
_TAG_RE = re.compile(r"</?[A-Za-z][A-Za-z0-9]*(?:\s[^>]*)?\s*/?>")
_INLINE_CODE_RE = re.compile(r"(`+)(.*?)\1")
_EMPHASIS_RE = re.compile(r"(?<!\\)(\*\*|~~|\*)(.+?)\1")
_UNDERSCORE_EMPHASIS_RE = re.compile(r"(?<!\w)(__|_)(.+?)\1(?!\w)")

WEBEX_TABLE_MAX_COLUMNS = 60


def format_webex_markdown(content: str, *, preview: bool = False) -> str:
    """Render complete GFM pipe tables as compact monospaced blocks.

    In preview mode, an unfinished trailing table is withheld so column widths
    are not exposed before the full table is available.
    """
    lines = content.splitlines()
    output: list[str] = []
    index = 0
    fence_character = ""
    fence_length = 0

    while index < len(lines):
        line = lines[index]
        fence_match = _FENCE_RE.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if not fence_character:
                fence_character = marker[0]
                fence_length = len(marker)
            elif marker[0] == fence_character and len(marker) >= fence_length:
                fence_character = ""
                fence_length = 0
            output.append(line)
            index += 1
            continue

        if fence_character:
            output.append(line)
            index += 1
            continue

        parsed = _table_at(lines, index)
        if parsed is not None:
            headers, rows, end = parsed
            if preview and end == len(lines):
                break
            output.append(_render_table(headers, rows))
            index = end
            continue

        if preview and index == len(lines) - 1 and _looks_like_pipe_row(line):
            # A streamed header or separator may not be complete yet. Keep it
            # out of the preview until the following line disambiguates it.
            if index > 0 and _looks_like_pipe_row(lines[index - 1]):
                if output and output[-1] == lines[index - 1]:
                    output.pop()
            break

        output.append(line)
        index += 1

    result = "\n".join(output)
    return result.rstrip() if preview else result


def _table_at(lines: Sequence[str], start: int) -> tuple[list[str], list[list[str]], int] | None:
    if start + 1 >= len(lines) or not _looks_like_pipe_row(lines[start]):
        return None

    headers = _split_cells(lines[start])
    separators = _split_cells(lines[start + 1])
    if not headers or len(headers) != len(separators):
        return None
    if not all(_SEPARATOR_CELL_RE.fullmatch(cell) for cell in separators):
        return None

    rows: list[list[str]] = []
    index = start + 2
    while index < len(lines) and _looks_like_pipe_row(lines[index]):
        cells = _split_cells(lines[index])
        if len(cells) > len(headers):
            return None
        rows.append(cells + [""] * (len(headers) - len(cells)))
        index += 1
    return headers, rows, index


def _looks_like_pipe_row(line: str) -> bool:
    code_ticks = 0
    index = 0
    while index < len(line):
        if line[index] == "\\" and index + 1 < len(line):
            index += 2
            continue
        if line[index] == "`":
            tick_end = index + 1
            while tick_end < len(line) and line[tick_end] == "`":
                tick_end += 1
            run_length = tick_end - index
            if not code_ticks:
                code_ticks = run_length
            elif code_ticks == run_length:
                code_ticks = 0
            index = tick_end
            continue
        if line[index] == "|" and not code_ticks:
            return True
        index += 1
    return False


def _split_cells(line: str) -> list[str]:
    """Split a pipe row while respecting escapes and inline code spans."""
    cells: list[str] = []
    current: list[str] = []
    code_ticks = 0
    index = 0

    while index < len(line):
        character = line[index]
        if character == "\\" and index + 1 < len(line):
            current.extend((character, line[index + 1]))
            index += 2
            continue
        if character == "`":
            tick_end = index + 1
            while tick_end < len(line) and line[tick_end] == "`":
                tick_end += 1
            run_length = tick_end - index
            if not code_ticks:
                code_ticks = run_length
            elif code_ticks == run_length:
                code_ticks = 0
            current.extend(line[index:tick_end])
            index = tick_end
            continue
        if character == "|" and not code_ticks:
            cells.append("".join(current).strip())
            current.clear()
        else:
            current.append(character)
        index += 1

    cells.append("".join(current).strip())
    first_non_space = len(line) - len(line.lstrip())
    if first_non_space < len(line) and line[first_non_space] == "|":
        cells = cells[1:]
    last_non_space = len(line.rstrip()) - 1
    if (
        last_non_space >= 0
        and line[last_non_space] == "|"
        and _pipe_is_outside_code(line, last_non_space)
        and cells
    ):
        cells = cells[:-1]
    return cells


def _pipe_is_outside_code(line: str, position: int) -> bool:
    code_ticks = 0
    index = 0
    while index < position:
        if line[index] == "\\" and index + 1 < position:
            index += 2
            continue
        if line[index] == "`":
            tick_end = index + 1
            while tick_end < position and line[tick_end] == "`":
                tick_end += 1
            run_length = tick_end - index
            if not code_ticks:
                code_ticks = run_length
            elif code_ticks == run_length:
                code_ticks = 0
            index = tick_end
            continue
        index += 1
    backslashes = 0
    index = position - 1
    while index >= 0 and line[index] == "\\":
        backslashes += 1
        index -= 1
    return not code_ticks and backslashes % 2 == 0


def _plain_cell(value: str) -> str:
    """Keep visible cell text while removing Markdown presentation syntax."""
    code_spans: list[str] = []

    def hold_code_span(match: re.Match[str]) -> str:
        code_spans.append(match.group(2))
        return f"\x00CODE{len(code_spans) - 1}\x00"

    value = _INLINE_CODE_RE.sub(hold_code_span, value)
    value = _LINK_RE.sub(lambda match: match.group(1), value)
    value = _EMPHASIS_RE.sub(lambda match: match.group(2), value)
    value = _UNDERSCORE_EMPHASIS_RE.sub(lambda match: match.group(2), value)
    value = _TAG_RE.sub("", value)
    value = html.unescape(value)
    value = re.sub(r"\x00CODE(\d+)\x00", lambda match: code_spans[int(match.group(1))], value)
    value = re.sub(r"\\\|", "|", value)
    return " ".join(value.split())


def _display_width(value: str) -> int:
    """Approximate terminal display cells using Unicode combining/East Asian data."""
    width = 0
    for character in value:
        category = unicodedata.category(character)
        if unicodedata.combining(character) or category in {"Cf", "Mn", "Me"}:
            continue
        width += 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1
    return width


def _escape_cell_pipes(value: str) -> str:
    return value.replace("|", r"\|")


def _render_table(headers: list[str], rows: list[list[str]]) -> str:
    display_headers = [_escape_cell_pipes(_plain_cell(value)) for value in headers]
    display_rows = [[_escape_cell_pipes(_plain_cell(value)) for value in row] for row in rows]
    widths = [
        max((_display_width(row[column]) for row in [display_headers, *display_rows]), default=0)
        for column in range(len(display_headers))
    ]
    aligned = [_aligned_row(row, widths) for row in [display_headers, *display_rows]]
    total_width = max((_display_width(row) for row in aligned), default=0)

    if total_width <= WEBEX_TABLE_MAX_COLUMNS:
        separator = "-+-".join("-" * width for width in widths)
        return "```text\n" + "\n".join([aligned[0], separator, *aligned[1:]]) + "\n```"

    return _render_narrow_table(display_headers, display_rows)


def _aligned_row(row: Sequence[str], widths: Sequence[int]) -> str:
    padded = [
        value + " " * max(0, widths[index] - _display_width(value))
        if index < len(widths) - 1
        else value
        for index, value in enumerate(row)
    ]
    return " | ".join(padded)


def _render_narrow_table(headers: list[str], rows: list[list[str]]) -> str:
    output: list[str] = []
    for row in rows:
        current_line = ""
        for index, (header, value) in enumerate(zip(headers, row, strict=False)):
            field = f"{header or 'Item'}: {value}"
            indent = "" if index == 0 else "  "
            candidate = f"{current_line} | {field}" if current_line else f"{indent}{field}"
            if _display_width(candidate) <= WEBEX_TABLE_MAX_COLUMNS:
                current_line = candidate
                continue

            if current_line:
                output.append(current_line)
                current_line = ""

            field_lines = _wrap_text(
                field,
                WEBEX_TABLE_MAX_COLUMNS,
                initial_indent=indent,
                subsequent_indent=indent,
            )
            if len(field_lines) == 1:
                current_line = field_lines[0]
            else:
                output.extend(field_lines)

        if current_line:
            output.append(current_line)
        output.append("")

    if output and not output[-1]:
        output.pop()

    return "```text\n" + "\n".join(output) + "\n```"


def _wrap_text(value: str, width: int, *, initial_indent: str = "", subsequent_indent: str = "") -> list[str]:
    """Wrap text on spaces and split overlong tokens by display cells."""
    words = value.split()
    if not words:
        return [initial_indent.rstrip()]
    output: list[str] = []
    current = initial_indent
    for word in words:
        separator = " " if current.strip() else ""
        candidate = current + separator + word
        if _display_width(candidate) > width and current.strip():
            output.append(current.rstrip())
            current = subsequent_indent
        elif _display_width(candidate) <= width:
            current = candidate
            continue

        chunks = _split_wide_token(word, max(1, width - _display_width(current)))
        if len(chunks) > 1:
            for chunk in chunks[:-1]:
                output.append((current + chunk).rstrip())
                current = subsequent_indent
            current += chunks[-1]
        else:
            current += chunks[0]
    output.append(current.rstrip())
    return output


def _split_wide_token(value: str, width: int) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_width = 0
    for character in value:
        character_width = _display_width(character)
        if current and current_width + character_width > width:
            chunks.append("".join(current))
            current = []
            current_width = 0
        current.append(character)
        current_width += character_width
    if current:
        chunks.append("".join(current))
    return chunks or [""]
