"""Canonical Markdown codec for deepagents-backed user memory files.

The bookkeeping delimiter is an HTML marker. Record bodies therefore remain
ordinary Markdown and may contain headings, horizontal rules, and fenced code.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable
from urllib.parse import quote, unquote
from uuid import uuid4

from dynamic_agents.services.memory_paths import SEED_STUB

_FILE_MARKER_RE = re.compile(r"^<!-- caipe-memory:file (?P<meta>[^>]*) -->\n?", re.MULTILINE)
_RECORD_START_RE = re.compile(
    r"(?m)^## (?P<heading>[^\r\n]+)\r?\n"
    r"<!-- caipe-memory:rec (?P<meta>[^>\r\n]*) -->\r?\n?"
)
_PLAIN_HEADING_RE = re.compile(r"(?m)^## (?P<heading>[^\r\n]+)\r?\n")
_META_PART_RE = re.compile(r"(?P<key>[A-Za-z][A-Za-z0-9_-]*)=(?P<value>[^ ]*)")
_VALID_MEMORY_ID_RE = re.compile(r"^mem_[a-z0-9]{20}$")


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_memory_id() -> str:
    return f"mem_{uuid4().hex[:20]}"


def normalize_title(title: str) -> str:
    normalized = unicodedata.normalize("NFKC", title).casefold()
    return re.sub(r"[\W_]+", " ", normalized, flags=re.UNICODE).strip()


class DuplicateMemoryTitleError(ValueError):
    """Raised when two records in one file have the same normalized title."""

    def __init__(self, title: str, existing_memory_id: str) -> None:
        self.title = title
        self.existing_memory_id = existing_memory_id
        super().__init__(f'A memory titled "{title}" already exists in this scope')


class GeneralMemoryAgentEditError(ValueError):
    """Raised when an agent tries to reuse the freeform-import fallback record."""


@dataclass(slots=True)
class MemoryRecord:
    memory_id: str
    title: str
    body: str
    source: str = "agent"
    created_by_agent_id: str | None = None
    created_at: str = field(default_factory=utc_timestamp)
    updated_at: str = field(default_factory=utc_timestamp)
    extra: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, object]:
        return {
            "memory_id": self.memory_id,
            "title": self.title,
            "value": self.body,
            "source": self.source,
            "created_by_agent_id": self.created_by_agent_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "extra": dict(self.extra),
        }


@dataclass(slots=True)
class MemoryFile:
    scope: str
    records: list[MemoryRecord] = field(default_factory=list)
    preamble: str = ""
    extra: dict[str, str] = field(default_factory=dict)
    needs_repair: bool = False


def parse(
    text: str,
    *,
    default_scope: str = "global",
    actor_agent_id: str | None = None,
    now: str | None = None,
) -> MemoryFile:
    """Parse canonical or lenient Markdown into a structured memory file."""

    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    timestamp = now or utc_timestamp()
    scope = default_scope
    file_extra: dict[str, str] = {}
    needs_repair = normalized != text

    file_match = _FILE_MARKER_RE.search(normalized)
    content_start = 0
    if file_match:
        file_meta = _parse_meta(file_match.group("meta"))
        scope = unquote(file_meta.pop("scope", default_scope)) or default_scope
        file_meta.pop("v", None)
        file_extra = {key: unquote(value) for key, value in file_meta.items()}
        content_start = file_match.end()
    else:
        needs_repair = True

    matches = list(_RECORD_START_RE.finditer(normalized, content_start))
    if not matches:
        return _parse_plain_file(
            normalized[content_start:],
            scope=scope,
            file_extra=file_extra,
            actor_agent_id=actor_agent_id,
            timestamp=timestamp,
            needs_repair=needs_repair,
        )

    preamble = normalized[content_start : matches[0].start()].strip("\n")
    if preamble == SEED_STUB:
        preamble = ""
        needs_repair = True

    records: list[MemoryRecord] = []
    seen_ids: set[str] = set()
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(normalized)
        body = _unescape_body(normalized[match.end() : end].strip("\n"))
        meta = _parse_meta(match.group("meta"))
        meta.pop("v", None)
        memory_id = unquote(meta.pop("id", ""))
        if not _VALID_MEMORY_ID_RE.fullmatch(memory_id) or memory_id in seen_ids:
            memory_id = new_memory_id()
            needs_repair = True
        seen_ids.add(memory_id)
        marker_title = unquote(meta.pop("title", ""))
        heading = match.group("heading").strip()
        title = marker_title or heading or "Untitled memory"
        if heading != title:
            needs_repair = True
        source = unquote(meta.pop("src", "agent")) or "agent"
        created_by = unquote(meta.pop("by", "")) or None
        created = unquote(meta.pop("created", "")) or timestamp
        updated = unquote(meta.pop("updated", "")) or created
        records.append(
            MemoryRecord(
                memory_id=memory_id,
                title=title,
                body=body,
                source=source,
                created_by_agent_id=created_by,
                created_at=created,
                updated_at=updated,
                extra={key: unquote(value) for key, value in meta.items()},
            )
        )

    return MemoryFile(
        scope=scope,
        records=records,
        preamble=preamble,
        extra=file_extra,
        needs_repair=needs_repair,
    )


def render(memory_file: MemoryFile) -> str:
    """Render a memory file in the canonical, idempotent format."""

    file_meta = {"v": "1", "scope": memory_file.scope, **memory_file.extra}
    parts = [f"<!-- caipe-memory:file {_render_meta(file_meta)} -->"]
    preamble = memory_file.preamble.strip("\n")
    if preamble:
        parts.append(preamble)
    if not memory_file.records:
        if not preamble:
            parts.append(SEED_STUB)
        return "\n".join(parts).rstrip() + "\n"

    for record in memory_file.records:
        title = _canonical_title(record.title)
        metadata = {
            "v": "1",
            "id": record.memory_id,
            "title": title,
            "src": record.source or "agent",
            "by": record.created_by_agent_id or "",
            "created": record.created_at,
            "updated": record.updated_at,
            **record.extra,
        }
        section = f"## {title}\n<!-- caipe-memory:rec {_render_meta(metadata)} -->"
        body = _escape_body(record.body.strip("\n"))
        if body:
            section += f"\n\n{body}"
        parts.append(section)
    return "\n\n".join(parts).rstrip() + "\n"


def find_title_conflict(
    records: Iterable[MemoryRecord],
    title: str,
    *,
    exclude_memory_id: str | None = None,
) -> MemoryRecord | None:
    """Find another record with the same normalized title."""

    wanted = normalize_title(title)
    if not wanted:
        return None
    return next(
        (
            record
            for record in records
            if record.memory_id != exclude_memory_id and normalize_title(record.title) == wanted
        ),
        None,
    )


def require_unique_titles(records: Iterable[MemoryRecord]) -> None:
    """Reject duplicate titles instead of silently choosing one record."""

    seen: dict[str, MemoryRecord] = {}
    for record in records:
        key = normalize_title(record.title)
        if not key:
            continue
        existing = seen.get(key)
        if existing is not None:
            raise DuplicateMemoryTitleError(record.title, existing.memory_id)
        seen[key] = record


def promote_freeform_preamble(
    memory_file: MemoryFile,
    *,
    source: str,
    actor_agent_id: str | None = None,
    now: str | None = None,
) -> MemoryFile:
    """Promote a heading-less memory file into one addressable record.

    Deepagents accepts arbitrary Markdown, so a user can reasonably save a
    plain instruction without adding a ``##`` heading.  Leaving that text as
    preamble injects it into the model while exposing zero records (and thus no
    injection badge or deep-link) to the UI.  Canonicalising it as one record
    keeps the text intact and gives the injected content a stable ID.
    """

    body = memory_file.preamble.strip("\n")
    if memory_file.records or not body:
        return memory_file

    timestamp = now or utc_timestamp()
    memory_file.records = [
        MemoryRecord(
            memory_id=new_memory_id(),
            title="General memory",
            body=body,
            source=source,
            created_by_agent_id=actor_agent_id,
            created_at=timestamp,
            updated_at=timestamp,
        )
    ]
    memory_file.preamble = ""
    memory_file.needs_repair = True
    return memory_file


def reconcile_after_agent_edit(
    before: MemoryFile,
    after: MemoryFile,
    *,
    actor_agent_id: str,
    now: str | None = None,
) -> tuple[MemoryFile, list[str], str | None]:
    """Repair metadata after an agent edit and describe the actual change."""

    timestamp = now or utc_timestamp()
    promote_freeform_preamble(
        after,
        source="agent",
        actor_agent_id=actor_agent_id,
        now=timestamp,
    )
    require_unique_titles(after.records)
    previous = {record.memory_id: record for record in before.records}
    previous_by_title = {
        normalize_title(record.title): record
        for record in before.records
        if normalize_title(record.title)
    }
    matched_previous_ids: set[str] = set()
    reconciled: list[MemoryRecord] = []
    for record in after.records:
        old = previous.get(record.memory_id)
        if old is None:
            candidate = previous_by_title.get(normalize_title(record.title))
            if candidate and candidate.memory_id not in matched_previous_ids:
                old = candidate
                record.memory_id = old.memory_id
        if old is None:
            record.source = "agent"
            record.created_by_agent_id = actor_agent_id
            record.created_at = timestamp
            record.updated_at = timestamp
        else:
            matched_previous_ids.add(old.memory_id)
            changed = (record.title, record.body) != (old.title, old.body)
            if changed and normalize_title(old.title) == normalize_title("General memory"):
                raise GeneralMemoryAgentEditError(
                    "General memory is an imported fallback and cannot be changed by the agent"
                )
            record.source = old.source
            record.created_by_agent_id = old.created_by_agent_id
            record.created_at = old.created_at
            record.updated_at = timestamp if changed else old.updated_at
            record.extra = dict(old.extra)
        reconciled.append(record)

    before_ids = set(previous)
    after_ids = {record.memory_id for record in reconciled}
    deleted = sorted(before_ids - after_ids)
    created = sorted(after_ids - before_ids)
    final_by_id = {record.memory_id: record for record in reconciled}
    updated = sorted(
        memory_id
        for memory_id in before_ids & after_ids
        if (final_by_id[memory_id].title, final_by_id[memory_id].body)
        != (previous[memory_id].title, previous[memory_id].body)
    )
    if deleted:
        action = "deleted"
        changed_ids = [*deleted, *created, *updated]
    elif created:
        action = "created"
        changed_ids = [*created, *updated]
    elif updated:
        action = "updated"
        changed_ids = updated
    else:
        action = None
        changed_ids = []

    after.records = reconciled
    # File-level identity is owned by the platform. In particular, an agent
    # edit must never rename or retarget an immutable Project marker.
    after.scope = before.scope
    after.extra = dict(before.extra)
    after.needs_repair = False
    return after, list(dict.fromkeys(changed_ids)), action


def _parse_plain_file(
    content: str,
    *,
    scope: str,
    file_extra: dict[str, str],
    actor_agent_id: str | None,
    timestamp: str,
    needs_repair: bool,
) -> MemoryFile:
    headings = list(_PLAIN_HEADING_RE.finditer(content))
    if not headings:
        preamble = content.strip("\n")
        if preamble == SEED_STUB:
            preamble = ""
        return MemoryFile(
            scope=scope,
            preamble=preamble,
            extra=file_extra,
            needs_repair=needs_repair,
        )

    preamble = content[: headings[0].start()].strip("\n")
    if preamble == SEED_STUB:
        preamble = ""
    records: list[MemoryRecord] = []
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(content)
        records.append(
            MemoryRecord(
                memory_id=new_memory_id(),
                title=heading.group("heading").strip() or "Untitled memory",
                body=_unescape_body(content[heading.end() : end].strip("\n")),
                source="agent",
                created_by_agent_id=actor_agent_id,
                created_at=timestamp,
                updated_at=timestamp,
            )
        )
    return MemoryFile(
        scope=scope,
        records=records,
        preamble=preamble,
        extra=file_extra,
        needs_repair=True,
    )


def _parse_meta(raw: str) -> dict[str, str]:
    return {match.group("key"): match.group("value") for match in _META_PART_RE.finditer(raw)}


def _render_meta(values: dict[str, str]) -> str:
    return " ".join(f"{key}={quote(str(value), safe='')}" for key, value in values.items())


def _canonical_title(title: str) -> str:
    return " ".join(title.replace("\r", " ").replace("\n", " ").split()) or "Untitled memory"


def _escape_body(body: str) -> str:
    # Put the escape inside each HTML-comment delimiter. A prefix backslash
    # would still leave a literal ``<!--`` for deepagents' regex to consume.
    return body.replace("\\", "\\\\").replace("<!--", "<\\!--").replace("-->", "--\\>")


def _unescape_body(body: str) -> str:
    result: list[str] = []
    index = 0
    while index < len(body):
        if body.startswith("\\\\", index):
            result.append("\\")
            index += 2
        elif body.startswith("<\\!--", index):
            result.append("<!--")
            index += 5
        elif body.startswith("--\\>", index):
            result.append("-->")
            index += 4
        else:
            result.append(body[index])
            index += 1
    return "".join(result)
