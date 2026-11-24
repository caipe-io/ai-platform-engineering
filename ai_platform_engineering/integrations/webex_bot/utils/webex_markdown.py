"""Webex-specific formatting for Markdown tables in agent replies."""

from __future__ import annotations

import html
import re
import unicodedata
from collections.abc import Sequence

_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_INDENTED_CODE_RE = re.compile(r"^(?: {4,}|\t)")
_SEPARATOR_CELL_RE = re.compile(r"^:?-+:?$")
_TAG_RE = re.compile(r"</?[A-Za-z][A-Za-z0-9]*(?:\s[^>]*)?\s*/?>")
_LINE_BREAK_TAG_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
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
            marker, trailing = fence_match.groups()
            if not fence_character:
                fence_character = marker[0]
                fence_length = len(marker)
            elif (
                marker[0] == fence_character
                and len(marker) >= fence_length
                and not trailing.strip()
            ):
                fence_character = ""
                fence_length = 0
            output.append(line)
            index += 1
            continue

        if fence_character:
            output.append(line)
            index += 1
            continue

        if _INDENTED_CODE_RE.match(line):
            output.append(line)
            index += 1
            continue

        parsed = _table_at(lines, index)
        if parsed is not None:
            headers, rows, end, container_prefix = parsed
            if preview and end == len(lines):
                break
            rendered = _render_table(headers, rows)
            if container_prefix:
                rendered = "\n".join(container_prefix + rendered_line for rendered_line in rendered.splitlines())
            output.append(rendered)
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


def _table_at(
    lines: Sequence[str], start: int
) -> tuple[list[str], list[list[str]], int, str] | None:
    if start + 1 >= len(lines):
        return None

    container_prefix = _table_container_prefix(lines[start])
    if container_prefix:
        normalized_lines = [
            _normalize_container_table_line(line, container_prefix) for line in lines[start:]
        ]
        parsed = _parse_table_at(normalized_lines, 0)
        if parsed is None:
            return None
        headers, rows, end = parsed
        return headers, rows, start + end, container_prefix

    parsed = _parse_table_at(lines, start)
    if parsed is None:
        return None
    headers, rows, end = parsed
    return headers, rows, end, ""


def _table_container_prefix(line: str) -> str:
    quote_prefix = re.match(r"^ {0,3}(?:> ?)+", line)
    if quote_prefix:
        return quote_prefix.group(0)

    indentation = re.match(r"^ {1,3}(?=\|)", line)
    return indentation.group(0) if indentation else ""


def _strip_table_container_prefix(line: str, prefix: str) -> str:
    return line[len(prefix) :] if line.startswith(prefix) else line


def _normalize_container_table_line(line: str, prefix: str) -> str:
    if line.startswith(prefix):
        return _strip_table_container_prefix(line, prefix)
    return line if not line.strip() else "container-boundary"


def _parse_table_at(
    lines: Sequence[str], start: int
) -> tuple[list[str], list[list[str]], int] | None:
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
    while (
        index < len(lines)
        and not _INDENTED_CODE_RE.match(lines[index])
        and _looks_like_pipe_row(lines[index])
    ):
        cells = _split_cells(lines[index])
        if len(cells) > len(headers):
            return None
        rows.append(cells + [""] * (len(headers) - len(cells)))
        index += 1
    return headers, rows, index


def _has_matching_code_ticks(line: str, start: int, run_length: int) -> bool:
    index = start + run_length
    while index < len(line):
        if line[index] != "`":
            index += 1
            continue

        run_end = index + 1
        while run_end < len(line) and line[run_end] == "`":
            run_end += 1
        if run_end - index == run_length and not _is_escaped(line, index):
            return True
        index = run_end
    return False


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
                if _has_matching_code_ticks(line, index, run_length):
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
                if _has_matching_code_ticks(line, index, run_length):
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
            while tick_end < len(line) and line[tick_end] == "`":
                tick_end += 1
            run_length = tick_end - index
            if not code_ticks:
                if _has_matching_code_ticks(line, index, run_length):
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
    value = _hold_inline_code_spans(value, code_spans)
    value = _strip_inline_links(value)
    value = _EMPHASIS_RE.sub(lambda match: match.group(2), value)
    value = _UNDERSCORE_EMPHASIS_RE.sub(lambda match: match.group(2), value)
    value = _LINE_BREAK_TAG_RE.sub(" ", value)
    value = _TAG_RE.sub("", value)
    value = html.unescape(value)
    value = re.sub(r"\x00CODE(\d+)\x00", lambda match: code_spans[int(match.group(1))], value)
    value = re.sub(r"\\\|", "|", value)
    return " ".join(value.split())


def _strip_inline_links(value: str) -> str:
    output: list[str] = []
    index = 0

    while index < len(value):
        image_start = value.startswith("![", index)
        bracket_start = index + 1 if image_start else index
        if value[bracket_start] != "[":
            output.append(value[index])
            index += 1
            continue

        label_end = _find_closing_bracket(value, bracket_start)
        if label_end < 0 or label_end + 1 >= len(value) or value[label_end + 1] != "(":
            output.append(value[index])
            index += 1
            continue

        link_end = _find_link_end(value, label_end + 2)
        if link_end < 0:
            output.append(value[index])
            index += 1
            continue

        output.append(value[bracket_start + 1 : label_end])
        index = link_end + 1

    return "".join(output)


def _find_closing_bracket(value: str, opening: int) -> int:
    depth = 0
    index = opening
    while index < len(value):
        if value[index] == "\\" and index + 1 < len(value):
            index += 2
            continue
        if value[index] == "[":
            depth += 1
        elif value[index] == "]":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return -1


def _find_link_end(value: str, index: int) -> int:
    depth = 0
    while index < len(value):
        character = value[index]
        if character == "\\" and index + 1 < len(value):
            index += 2
            continue
        if character.isspace():
            break
        if character == "<":
            close_angle = index + 1
            while close_angle < len(value):
                if value[close_angle] == "\\" and close_angle + 1 < len(value):
                    close_angle += 2
                    continue
                if value[close_angle] == ">":
                    index = close_angle + 1
                    break
                close_angle += 1
            else:
                return -1
            break
        if character == "(":
            depth += 1
        elif character == ")":
            if depth == 0:
                return index
            depth -= 1
        index += 1

    while index < len(value) and value[index].isspace():
        index += 1
    if index < len(value) and value[index] in {'"', "'", "("}:
        closing = ")" if value[index] == "(" else value[index]
        title_depth = 0
        index += 1
        while index < len(value):
            if value[index] == "\\" and index + 1 < len(value):
                index += 2
                continue
            if closing == ")" and value[index] == "(":
                title_depth += 1
            elif value[index] == closing:
                if title_depth == 0:
                    index += 1
                    break
                title_depth -= 1
            index += 1
        else:
            return -1
        while index < len(value) and value[index].isspace():
            index += 1

    return index if index < len(value) and value[index] == ")" else -1


def _hold_inline_code_spans(value: str, code_spans: list[str]) -> str:
    output: list[str] = []
    index = 0

    while index < len(value):
        if value[index] != "`":
            output.append(value[index])
            index += 1
            continue

        opening_end = index + 1
        while opening_end < len(value) and value[opening_end] == "`":
            opening_end += 1
        run_length = opening_end - index
        if _is_escaped(value, index):
            output.append(value[index:opening_end])
            index = opening_end
            continue

        closing_start = opening_end
        closing_end = opening_end
        while closing_start < len(value):
            if value[closing_start] != "`":
                closing_start += 1
                continue

            closing_end = closing_start + 1
            while closing_end < len(value) and value[closing_end] == "`":
                closing_end += 1
            if closing_end - closing_start == run_length and not _is_escaped(value, closing_start):
                break
            closing_start = closing_end

        if closing_start >= len(value):
            output.append(value[index:opening_end])
            index = opening_end
            continue

        code_spans.append(value[opening_end:closing_start])
        output.append(f"\x00CODE{len(code_spans) - 1}\x00")
        index = closing_end

    return "".join(output)


def _is_escaped(value: str, index: int) -> bool:
    backslash_count = 0
    previous = index - 1
    while previous >= 0 and value[previous] == "\\":
        backslash_count += 1
        previous -= 1
    return backslash_count % 2 == 1


def _display_width(value: str) -> int:
    """Approximate terminal display cells using Unicode combining/East Asian data."""
    width = 0
    joined_width = 0
    join_next = False
    for character in value:
        if character == "\u200d":
            join_next = True
            continue
        category = unicodedata.category(character)
        codepoint = ord(character)
        if (
            unicodedata.combining(character)
            or category in {"Cf", "Mn", "Me"}
            or 0x1F3FB <= codepoint <= 0x1F3FF
        ):
            continue
        character_width = 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1
        if join_next:
            joined_width = max(joined_width, character_width)
            join_next = False
        else:
            width += joined_width
            joined_width = character_width
    return width + joined_width


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
        return _fenced_text_block("\n".join([aligned[0], separator, *aligned[1:]]))

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
    if not rows:
        header_lines = ["Columns:"]
        for header in headers:
            header_lines.extend(
                _wrap_text(
                    header or "Item",
                    WEBEX_TABLE_MAX_COLUMNS,
                    initial_indent="  ",
                    subsequent_indent="  ",
                )
            )
        return _fenced_text_block("\n".join(header_lines))

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

    return _fenced_text_block("\n".join(output))


def _fenced_text_block(content: str) -> str:
    longest_backtick_run = max((len(run) for run in re.findall(r"`+", content)), default=0)
    fence = "`" * max(3, longest_backtick_run + 1)
    return f"{fence}text\n{content}\n{fence}"


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
