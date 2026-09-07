import pytest
from deepagents.middleware.memory import _strip_html_comments

from dynamic_agents.services.memory_codec import (
    DuplicateMemoryTitleError,
    MemoryFile,
    MemoryRecord,
    parse,
    promote_freeform_preamble,
    reconcile_after_agent_edit,
    render,
    require_unique_titles,
)
from dynamic_agents.services.memory_middleware import CaipeMemoryMiddleware
from dynamic_agents.services.memory_paths import SEED_STUB, global_source, seed_content


def _record(**overrides: str) -> MemoryRecord:
    values = {
        "memory_id": "mem_0123456789abcdefghij",
        "title": "Prefer concise answers",
        "body": "Keep answers short.",
        "source": "manual",
        "created_at": "2026-01-02T03:04:05Z",
        "updated_at": "2026-02-03T04:05:06Z",
    }
    values.update(overrides)
    return MemoryRecord(**values)


def test_round_trip_and_render_are_idempotent_for_adversarial_markdown() -> None:
    body = """literal <!-- and --> and \\
## body heading

```markdown
<!-- caipe-memory:rec v=1 id=mem_fake -->
---
```

CJK: 記憶; emoji: 🧠
"""
    original = MemoryFile(scope="global", records=[_record(body=body)], extra={"future": "a b"})

    rendered = render(original)
    parsed = parse(rendered)

    assert parsed.records[0].body == body.strip("\n")
    assert parsed.extra == {"future": "a b"}
    assert render(parsed) == rendered
    # The upstream formatter must not mistake adversarial body text for our
    # bookkeeping markers. CAIPE's formatter then restores it for the model.
    stripped = _strip_html_comments(rendered)
    assert original.records[0].memory_id not in stripped
    middleware = object.__new__(CaipeMemoryMiddleware)
    middleware._sources_provider = lambda: [global_source()]
    visible = middleware._format_agent_memory({global_source(): rendered})
    assert body.strip("\n") in visible


def test_lenient_plain_markdown_is_adopted_and_reconciled() -> None:
    parsed = parse("Preamble\r\n\r\n## A heading\r\nA body\r\n", actor_agent_id="agent-a", now="2026-01-01T00:00:00Z")

    assert parsed.needs_repair is True
    assert parsed.preamble == "Preamble"
    assert [(item.title, item.body) for item in parsed.records] == [("A heading", "A body")]

    repaired, changed, action = reconcile_after_agent_edit(
        MemoryFile(scope="global"),
        parsed,
        actor_agent_id="agent-a",
        now="2026-01-01T00:00:00Z",
    )
    assert action == "created"
    assert changed == [repaired.records[0].memory_id]
    assert repaired.records[0].source == "agent"


def test_headingless_markdown_is_promoted_without_losing_text() -> None:
    parsed = parse(
        '<!-- caipe-memory:file v=1 scope=agent -->\nAlways start with "Howdy" when replying.\n',
        default_scope="agent",
    )

    promote_freeform_preamble(
        parsed,
        source="manual",
        now="2026-08-06T00:00:00Z",
    )

    assert parsed.preamble == ""
    assert len(parsed.records) == 1
    assert parsed.records[0].title == "General memory"
    assert parsed.records[0].body == 'Always start with "Howdy" when replying.'
    assert parsed.records[0].source == "manual"
    assert parse(render(parsed), default_scope="agent").records[0].memory_id == parsed.records[0].memory_id


def test_duplicate_titles_are_rejected_instead_of_silently_merged() -> None:
    first = _record(title="Preferred greeting")
    duplicate = _record(
        memory_id="mem_abcdefghij0123456789",
        title=" preferred---GREETING! ",
    )

    with pytest.raises(DuplicateMemoryTitleError) as exc_info:
        require_unique_titles([first, duplicate])

    assert exc_info.value.existing_memory_id == first.memory_id


def test_duplicate_title_normalization_supports_unicode() -> None:
    first = _record(title="応答 スタイル")
    duplicate = _record(
        memory_id="mem_abcdefghij0123456789",
        title="応答—スタイル",
    )

    with pytest.raises(DuplicateMemoryTitleError):
        require_unique_titles([first, duplicate])


def test_markerless_agent_rewrite_preserves_stable_id_and_provenance() -> None:
    before = MemoryFile(scope="global", records=[_record(body="before", source="manual")])
    after = parse("## Prefer concise answers\nafter\n", actor_agent_id="agent-a")

    reconciled, changed, action = reconcile_after_agent_edit(
        before,
        after,
        actor_agent_id="agent-a",
        now="2026-03-01T00:00:00Z",
    )

    assert action == "updated"
    assert changed == [before.records[0].memory_id]
    assert reconciled.records[0].memory_id == before.records[0].memory_id
    assert reconciled.records[0].source == "manual"
    assert reconciled.records[0].updated_at == "2026-03-01T00:00:00Z"


def test_seed_and_clear_are_identical_and_visible() -> None:
    seed = seed_content(global_source())

    assert render(parse(seed)) == seed
    assert seed == f"<!-- caipe-memory:file v=1 scope=global -->\n{SEED_STUB}\n"
    assert not _strip_html_comments("<!-- only bookkeeping -->").strip()
    assert SEED_STUB in _strip_html_comments(seed)


def test_agent_edit_cannot_change_immutable_project_marker() -> None:
    before = MemoryFile(
        scope="project",
        records=[_record(body="before")],
        extra={"project_id": "project_a", "project_name": "Project A"},
    )
    after = MemoryFile(
        scope="global",
        records=[_record(body="after")],
        extra={"project_id": "other", "project_name": "Other"},
    )

    reconciled, _, _ = reconcile_after_agent_edit(
        before,
        after,
        actor_agent_id="agent-a",
        now="2026-08-13T00:00:00Z",
    )

    assert reconciled.scope == "project"
    assert reconciled.extra == {"project_id": "project_a", "project_name": "Project A"}
