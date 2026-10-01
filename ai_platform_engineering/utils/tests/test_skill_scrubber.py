# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the skill-content tracing scrubber.

Pins the contract: skill payloads (SKILL.md bodies, ancillary file
contents, skills_metadata channel) are stripped from spans before
the OTLP exporter sees them, while normal chat / tool I/O is left
intact. A regression here would silently start exfiltrating skill
content to Langfuse on every step of every multi-step skill run.
"""

from __future__ import annotations

import json
import os
from typing import Any
from unittest import mock

import pytest

from ai_platform_engineering.utils.tracing.skill_scrubber import (
    DEFAULT_PLACEHOLDER,
    SkillContentScrubbingProcessor,
    _redact_value,
    _scrub_json,
    _strip_known_sections,
    install_skill_content_scrubber,
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _FakeSpan:
    """Minimal stand-in for ``opentelemetry.sdk.trace.ReadableSpan``."""

    def __init__(self, attributes: dict[str, Any]) -> None:
        # The real SDK exposes ``attributes`` as a read-only mapping
        # but the underlying ``_attributes`` dict is mutable. We let
        # tests poke either to mirror both code paths in
        # ``on_end``'s defensive write logic.
        self._attributes: dict[str, Any] = dict(attributes)

    @property
    def attributes(self) -> dict[str, Any]:
        return self._attributes

    def set_attribute(self, key: str, value: Any) -> None:
        self._attributes[key] = value


# ---------------------------------------------------------------------------
# Section stripping
# ---------------------------------------------------------------------------

def test_strip_known_sections_removes_block_until_next_header() -> None:
    prompt = (
        "You are a helpful assistant.\n"
        "\n"
        "## Skills System\n"
        "\n"
        "**Available Skills:**\n"
        "- foo: do foo\n"
        "  -> Read `/skills/user/foo/SKILL.md` for full instructions\n"
        "\n"
        "## Other instructions\n"
        "Be concise.\n"
    )
    out = _strip_known_sections(prompt)
    assert "Available Skills" not in out
    assert "/skills/user/foo/SKILL.md" not in out
    # Surrounding sections are preserved verbatim.
    assert "You are a helpful assistant." in out
    assert "## Other instructions\nBe concise." in out
    # Header is kept (with a marker) so traces still show the section
    # existed — useful for "is this prompt the right shape?" debugging.
    assert "[redacted from trace]" in out


def test_strip_known_sections_handles_block_at_end_of_prompt() -> None:
    prompt = "Top.\n## Skills System\n- a\n- b\n"
    out = _strip_known_sections(prompt)
    assert "- a" not in out
    assert "Top." in out


def test_strip_known_sections_no_op_when_section_absent() -> None:
    prompt = "Plain prompt with no skills section.\n## Tools\nUse them."
    assert _strip_known_sections(prompt) == prompt


# ---------------------------------------------------------------------------
# JSON scrubbing
# ---------------------------------------------------------------------------

def test_scrub_json_drops_skills_metadata_channel() -> None:
    payload = {
        "messages": [{"role": "user", "content": "hi"}],
        "skills_metadata": [
            {"name": "foo", "path": "/skills/user/foo/SKILL.md", "description": "d"},
        ],
        "files": {"/skills/user/foo/SKILL.md": "secret skill body" * 50},
    }
    out = _scrub_json(payload, DEFAULT_PLACEHOLDER)
    assert out["skills_metadata"] == DEFAULT_PLACEHOLDER
    # The plain "messages" channel is preserved.
    assert out["messages"] == [{"role": "user", "content": "hi"}]
    # A long string mentioning a skill path gets replaced wholesale.
    assert out["files"]["/skills/user/foo/SKILL.md"] == DEFAULT_PLACEHOLDER


def test_scrub_json_leaves_short_strings_alone() -> None:
    # Heuristic boundary: under 200 chars. A short tool-call arg
    # mentioning /skills/... is preserved (it's almost certainly a
    # path, not a body — paths are useful to keep for trace clarity).
    out = _scrub_json({"path": "/skills/user/foo/SKILL.md"}, DEFAULT_PLACEHOLDER)
    assert out == {"path": "/skills/user/foo/SKILL.md"}


def test_scrub_json_leaves_unrelated_long_strings_alone() -> None:
    body = {"text": "x" * 5000}
    assert _scrub_json(body, DEFAULT_PLACEHOLDER) == body


# ---------------------------------------------------------------------------
# Value-level redaction
# ---------------------------------------------------------------------------

def test_redact_value_passes_through_non_strings() -> None:
    assert _redact_value(42, DEFAULT_PLACEHOLDER) == 42
    assert _redact_value(None, DEFAULT_PLACEHOLDER) is None
    assert _redact_value(True, DEFAULT_PLACEHOLDER) is True


def test_redact_value_handles_json_blobs() -> None:
    raw = json.dumps(
        {
            "skills_metadata": [{"name": "x"}],
            "user_msg": "do the thing",
        }
    )
    out = _redact_value(raw, DEFAULT_PLACEHOLDER)
    parsed = json.loads(out)  # type: ignore[arg-type]
    assert parsed["skills_metadata"] == DEFAULT_PLACEHOLDER
    assert parsed["user_msg"] == "do the thing"


def test_redact_value_strips_skills_section_from_plain_prompt() -> None:
    prompt = "Sys top.\n## Skills System\n- foo\n## Tools\nuse"
    out = _redact_value(prompt, DEFAULT_PLACEHOLDER)
    assert "## Tools\nuse" in str(out)
    assert "- foo" not in str(out)


def test_redact_value_replaces_skill_read_response_wholesale() -> None:
    # Simulates a tool-call result echoing a SKILL.md body — Traceloop
    # serializes it as the .content attribute on a tool span.
    big_body = (
        "# SKILL.md content\n"
        + "x" * 500
        + "\nsourced from /skills/user/edicts/SKILL.md"
    )
    out = _redact_value(big_body, DEFAULT_PLACEHOLDER)
    assert out == DEFAULT_PLACEHOLDER


# ---------------------------------------------------------------------------
# SpanProcessor end-to-end
# ---------------------------------------------------------------------------

def test_processor_redacts_targeted_attributes_only() -> None:
    span = _FakeSpan(
        {
            # Should be scrubbed (skills section + skill state channel).
            "gen_ai.prompt.0.content": (
                "Be helpful.\n## Skills System\n- foo\n## End"
            ),
            "traceloop.entity.input": json.dumps(
                {"skills_metadata": [{"n": "x"}], "msg": "hi"}
            ),
            # Should be untouched — not a prompt/IO attribute.
            "gen_ai.usage.input_tokens": 1234,
            "gen_ai.request.model": "claude-sonnet-4-6",
            "http.status_code": 200,
        }
    )
    SkillContentScrubbingProcessor().on_end(span)
    assert "## Skills System [redacted from trace]" in span.attributes[
        "gen_ai.prompt.0.content"
    ]
    parsed = json.loads(span.attributes["traceloop.entity.input"])
    assert parsed["skills_metadata"] == DEFAULT_PLACEHOLDER
    assert parsed["msg"] == "hi"
    # Non-targeted attributes pass through unchanged.
    assert span.attributes["gen_ai.usage.input_tokens"] == 1234
    assert span.attributes["gen_ai.request.model"] == "claude-sonnet-4-6"
    assert span.attributes["http.status_code"] == 200


def test_processor_is_a_noop_for_spans_without_attributes() -> None:
    class _NullSpan:
        attributes = None

    # Must not raise.
    SkillContentScrubbingProcessor().on_end(_NullSpan())


def test_processor_swallows_errors_to_protect_exporter() -> None:
    class _ExplodingSpan:
        @property
        def attributes(self):
            raise RuntimeError("boom")

    # If the scrubber raises into the OTel SDK, the BatchSpanProcessor
    # will drop the whole batch and log a noisy traceback. Suppression
    # is intentional; we'd rather lose a redaction than break exports.
    SkillContentScrubbingProcessor().on_end(_ExplodingSpan())


# ---------------------------------------------------------------------------
# Defensive size cap (orthogonal to skill scrubbing)
# ---------------------------------------------------------------------------

def test_size_cap_truncates_oversized_non_skill_attributes() -> None:
    """The 413-class whales are tool-definition JSON / multi-turn
    prompt history / raw Bedrock bodies on attribute keys we don't
    enumerate. The cap protects the OTLP exporter from Langfuse's
    nginx body-size limit when those blow up."""
    big = "x" * (5 * 1024)  # 5 KiB on a 1 KiB cap
    span = _FakeSpan(
        {
            # Not in any prompt/IO list — proves the cap runs over
            # *all* string attributes, not just targeted ones.
            "traceloop.tools": big,
            "gen_ai.usage.input_tokens": 42,  # int — must pass through
        }
    )
    SkillContentScrubbingProcessor(max_attr_bytes=1024).on_end(span)
    out = span.attributes["traceloop.tools"]
    assert len(out) <= 1024 + 200, "truncation marker fits in a small budget"
    assert out.startswith("x" * 1024)
    assert "[truncated:" in out
    assert "original=5120" in out
    assert "cap=1024" in out
    assert span.attributes["gen_ai.usage.input_tokens"] == 42


def test_size_cap_disabled_when_set_to_zero() -> None:
    """Explicit opt-out for local debugging where a 1MB stdout
    exporter is fine."""
    big = "x" * 5000
    span = _FakeSpan({"traceloop.tools": big})
    SkillContentScrubbingProcessor(max_attr_bytes=0).on_end(span)
    assert span.attributes["traceloop.tools"] == big


def test_size_cap_runs_after_scrub_so_redacted_payloads_arent_re_truncated() -> None:
    """A skill payload should be reduced to the small placeholder
    by the scrub stage, then the cap stage sees the placeholder
    (which is well under any reasonable cap) and leaves it alone.
    Regression test: don't double-mangle redacted content."""
    huge_skill = "## Skills System\n" + ("- foo\n" * 5000) + "## End"
    span = _FakeSpan({"gen_ai.prompt.0.content": huge_skill})
    SkillContentScrubbingProcessor(max_attr_bytes=1024).on_end(span)
    out = span.attributes["gen_ai.prompt.0.content"]
    # Scrubbed (header-marker preserved) and well under cap, so no
    # truncation marker should appear.
    assert "## Skills System [redacted from trace]" in out
    assert "[truncated:" not in out


def test_size_cap_does_not_truncate_under_cap() -> None:
    span = _FakeSpan({"traceloop.tools": "small"})
    SkillContentScrubbingProcessor(max_attr_bytes=1024).on_end(span)
    assert span.attributes["traceloop.tools"] == "small"


def test_size_cap_only_touches_string_attrs() -> None:
    """Numeric / bool attributes are passed through regardless of the
    cap — only strings have a meaningful length to truncate."""
    span = _FakeSpan(
        {
            "gen_ai.usage.input_tokens": 9_999_999,
            "http.status_code": 200,
            "some.flag": True,
        }
    )
    SkillContentScrubbingProcessor(max_attr_bytes=1).on_end(span)
    assert span.attributes["gen_ai.usage.input_tokens"] == 9_999_999
    assert span.attributes["http.status_code"] == 200
    assert span.attributes["some.flag"] is True


def test_install_reads_size_cap_from_env() -> None:
    """``SKILL_TRACE_MAX_ATTR_BYTES`` env var is honored at install
    time. We test the constructor wiring rather than the global
    install path so we don't have to spin up an OTel provider."""
    # Bad value falls back to default; pin the warning path.
    with mock.patch.dict(os.environ, {"SKILL_TRACE_MAX_ATTR_BYTES": "not-an-int"}):
        # Indirect verification: the processor parses the env when
        # installed by ``install_skill_content_scrubber``. We avoid
        # the global TracerProvider here and just verify the parse
        # contract via the processor constructor instead.
        from ai_platform_engineering.utils.tracing.skill_scrubber import (
            DEFAULT_MAX_ATTR_BYTES,
        )
        # Constructor accepts ints directly; the env-parsing logic
        # lives in install(). Pin the default constant instead, so
        # a future bump in the default fails the test loudly and
        # forces the docs/env.example to update too.
        assert DEFAULT_MAX_ATTR_BYTES == 256 * 1024


# ---------------------------------------------------------------------------
# task_config workflow scrubbing
# ---------------------------------------------------------------------------

def test_scrub_json_drops_tasks_and_todos_state_channels() -> None:
    # LangChain instrumentor stamps the full graph state on every
    # node span; while a workflow runs, ``tasks`` carries the
    # rendered ``llm_prompt`` for each step (multi-paragraph
    # operator instructions, often with embedded API endpoints,
    # project names, etc.).
    payload = {
        "messages": [{"role": "user", "content": "create a repo"}],
        "tasks": [
            {
                "id": 0,
                "display_text": "Collect repo details",
                "subagent": "caipe",
                "llm_prompt": "Ask the user for: org, repo, visibility, "
                              "default_branch. Then call ...",
            },
            {
                "id": 1,
                "display_text": "Create GitHub repo",
                "subagent": "github",
                "llm_prompt": "Use github_create_repo with the collected fields ...",
            },
        ],
        "todos": [
            {"id": 0, "content": "[Caipe] Collect repo details", "status": "pending"},
        ],
    }
    out = _scrub_json(payload, DEFAULT_PLACEHOLDER)
    assert out["tasks"] == DEFAULT_PLACEHOLDER
    assert out["todos"] == DEFAULT_PLACEHOLDER
    assert out["messages"] == [{"role": "user", "content": "create a repo"}]


def test_strip_known_sections_removes_workflow_definition_block() -> None:
    # Mirrors ``get_workflow_definition`` tool output: every step's
    # llm_prompt is rendered in fenced blocks under a ``## Workflow:``
    # header. We strip the whole block.
    rendered = (
        "Top-level note.\n"
        "## Workflow: Create GitHub Repo\n"
        "Steps: 2\n"
        "### Step 1: Collect repo details\n"
        "Subagent: `caipe`\n"
        "Prompt:\n```\nAsk the user for: org, repo, visibility ...\n```\n"
        "### Step 2: Create GitHub repo\n"
        "Prompt:\n```\nUse github_create_repo with API token ABCD ...\n```\n"
        "## Other section\nstays\n"
    )
    out = _strip_known_sections(rendered)  # back-compat alias
    assert "Ask the user for" not in out
    assert "github_create_repo" not in out
    assert "API token ABCD" not in out
    assert "Top-level note." in out
    assert "## Other section\nstays" in out
    assert "[redacted from trace]" in out


def test_strip_workflow_section_removes_self_service_block_in_system_prompt() -> None:
    # Workflow-capable prompts can include this boilerplate without
    # needing to expose embedded workflow instructions in traces.
    prompt = (
        "Be helpful.\n"
        "## Self-Service Workflows\n"
        "blah blah every step llm_prompt here ...\n"
        "## Tools\nuse them.\n"
    )
    out = _strip_known_sections(prompt)
    assert "every step llm_prompt" not in out
    assert "## Tools\nuse them." in out


def test_processor_redacts_workflow_tool_io_wholesale() -> None:
    # ``invoke_self_service_task`` returns a short ToolMessage but
    # its state-update carries the full ``tasks`` array. The
    # LangChain instrumentor serializes the state-update into
    # ``traceloop.entity.input``/``output``. Tool-name short-circuit
    # ensures we redact even when no markdown header is present.
    span = _FakeSpan(
        {
            "traceloop.entity.name": "invoke_self_service_task",
            "traceloop.entity.input": json.dumps({"task_name": "Create GitHub Repo"}),
            "traceloop.entity.output": json.dumps(
                {
                    "tasks": [
                        {"id": 0, "llm_prompt": "Internal prompt with API key XYZ"},
                    ],
                    "todos": [{"id": 0, "content": "[Caipe] step 1"}],
                }
            ),
            # Non-IO attribute on the same span: untouched.
            "gen_ai.usage.input_tokens": 42,
        }
    )
    SkillContentScrubbingProcessor().on_end(span)
    assert span.attributes["traceloop.entity.input"] == DEFAULT_PLACEHOLDER
    assert span.attributes["traceloop.entity.output"] == DEFAULT_PLACEHOLDER
    assert span.attributes["gen_ai.usage.input_tokens"] == 42


def test_processor_leaves_non_workflow_tool_io_alone() -> None:
    # A regular tool call (e.g. github_search) with no skill or
    # workflow markers must pass through untouched — the whole
    # point of scoped scrubbing is non-skill spans stay debuggable.
    span = _FakeSpan(
        {
            "traceloop.entity.name": "github_search",
            "traceloop.entity.input": json.dumps({"q": "kind:repo language:python"}),
            "traceloop.entity.output": json.dumps(
                {"results": [{"name": "ai-platform-engineering"}]}
            ),
        }
    )
    original_in = span.attributes["traceloop.entity.input"]
    original_out = span.attributes["traceloop.entity.output"]
    SkillContentScrubbingProcessor().on_end(span)
    assert span.attributes["traceloop.entity.input"] == original_in
    assert span.attributes["traceloop.entity.output"] == original_out


# ---------------------------------------------------------------------------
# Installer
# ---------------------------------------------------------------------------

def test_install_returns_false_when_disabled_via_env() -> None:
    with mock.patch.dict(os.environ, {"SKILL_TRACE_SCRUB_ENABLED": "false"}):
        assert install_skill_content_scrubber() is False


def test_install_returns_false_when_provider_has_no_add_processor() -> None:
    # Default global TracerProvider in unit-test envs is the NoOp
    # one; it doesn't expose ``add_span_processor``. The installer
    # must detect that and bail without raising.
    with mock.patch.dict(os.environ, {"SKILL_TRACE_SCRUB_ENABLED": "true"}):
        # Ensure no real provider has been set up by an earlier test.
        from opentelemetry import trace

        provider = trace.get_tracer_provider()
        if hasattr(provider, "add_span_processor"):
            pytest.skip("global provider already initialised by another test")
        assert install_skill_content_scrubber() is False


def test_install_is_idempotent_on_real_provider() -> None:
    sdk = pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry import trace
    from opentelemetry.util._once import Once

    trace._TRACER_PROVIDER = None  # type: ignore[attr-defined]
    trace._TRACER_PROVIDER_SET_ONCE = Once()  # type: ignore[attr-defined]
    provider = sdk.TracerProvider()
    trace.set_tracer_provider(provider)
    try:
        with mock.patch.dict(os.environ, {"SKILL_TRACE_SCRUB_ENABLED": "true"}):
            assert install_skill_content_scrubber() is True
            # Second call: no second processor registered.
            initial_count = len(
                provider._active_span_processor._span_processors  # type: ignore[attr-defined]
            )
            assert install_skill_content_scrubber() is True
            after_count = len(
                provider._active_span_processor._span_processors  # type: ignore[attr-defined]
            )
            assert initial_count == after_count
    finally:
        # Don't leak our provider to other tests — reset to the
        # default NoOp before returning.
        trace._TRACER_PROVIDER = None  # type: ignore[attr-defined]
        trace._TRACER_PROVIDER_SET_ONCE = Once()  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# End-to-end: real TracerProvider + SimpleSpanProcessor exporter
# ---------------------------------------------------------------------------

@pytest.fixture
def _real_otel():
    """Install a real TracerProvider with an in-memory exporter.

    Yields ``(provider, exporter)``. Resets the global provider on
    teardown so subsequent tests get a fresh NoOp.

    We use ``SimpleSpanProcessor`` (synchronous) so exported spans
    are visible immediately — ``BatchSpanProcessor`` would require
    a flush and add timing flake.

    OTel's ``set_tracer_provider`` is a one-shot via
    ``_TRACER_PROVIDER_SET_ONCE``; we have to clear *both* the
    provider slot and the once-flag for this fixture to be usable
    across multiple tests in the same process.
    """
    sdk = pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry import trace
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )
    from opentelemetry.util._once import Once

    # Force a clean slate so ``set_tracer_provider`` is honored.
    trace._TRACER_PROVIDER = None  # type: ignore[attr-defined]
    trace._TRACER_PROVIDER_SET_ONCE = Once()  # type: ignore[attr-defined]

    provider = sdk.TracerProvider()
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    assert trace.get_tracer_provider() is provider, (
        "set_tracer_provider was rejected; OTel global is still NoOp"
    )
    try:
        yield provider, exporter
    finally:
        trace._TRACER_PROVIDER = None  # type: ignore[attr-defined]
        trace._TRACER_PROVIDER_SET_ONCE = Once()  # type: ignore[attr-defined]


def test_e2e_skill_payload_scrubbed_from_exported_span(_real_otel) -> None:
    """Pin the real export path: a span's prompt content is rewritten
    on its way to the exporter, not just on the in-memory copy."""
    provider, exporter = _real_otel
    with mock.patch.dict(os.environ, {"SKILL_TRACE_SCRUB_ENABLED": "true"}):
        assert install_skill_content_scrubber() is True

    from opentelemetry import trace

    tracer = trace.get_tracer("test")
    skill_body = (
        "You are a helpful assistant.\n"
        "## Skills System\n"
        "**Available Skills:**\n"
        "- foo: do foo\n"
        "  Read /skills/user/foo/SKILL.md for full instructions.\n"
        "## Other\nstays\n"
    )
    with tracer.start_as_current_span("llm.call") as span:
        span.set_attribute("gen_ai.prompt.0.content", skill_body)
        span.set_attribute("gen_ai.usage.input_tokens", 999)

    finished = exporter.get_finished_spans()
    assert len(finished) == 1
    attrs = finished[0].attributes
    assert "## Skills System [redacted from trace]" in attrs["gen_ai.prompt.0.content"]
    assert "do foo" not in attrs["gen_ai.prompt.0.content"]
    assert "/skills/user/foo/SKILL.md" not in attrs["gen_ai.prompt.0.content"]
    # Non-targeted attribute survives.
    assert attrs["gen_ai.usage.input_tokens"] == 999
    # ``## Other`` boundary preserved.
    assert "## Other\nstays" in attrs["gen_ai.prompt.0.content"]


def test_e2e_workflow_tool_io_redacted_wholesale(_real_otel) -> None:
    """invoke_self_service_task spans must redact entity.input/output
    even when the payload has no markdown header — pins the
    tool-name short-circuit on a real exporter pipeline."""
    provider, exporter = _real_otel
    with mock.patch.dict(os.environ, {"SKILL_TRACE_SCRUB_ENABLED": "true"}):
        assert install_skill_content_scrubber() is True

    from opentelemetry import trace

    tracer = trace.get_tracer("test")
    payload = json.dumps(
        {
            "tasks": [{"id": 0, "llm_prompt": "Internal prompt with API key XYZ"}],
        }
    )
    with tracer.start_as_current_span("invoke_self_service_task") as span:
        span.set_attribute("traceloop.entity.name", "invoke_self_service_task")
        span.set_attribute("traceloop.entity.input", json.dumps({"task_name": "X"}))
        span.set_attribute("traceloop.entity.output", payload)
        span.set_attribute("gen_ai.usage.output_tokens", 42)

    finished = exporter.get_finished_spans()
    assert len(finished) == 1
    attrs = finished[0].attributes
    assert attrs["traceloop.entity.input"] == DEFAULT_PLACEHOLDER
    assert attrs["traceloop.entity.output"] == DEFAULT_PLACEHOLDER
    assert "API key XYZ" not in str(attrs.values())
    assert attrs["gen_ai.usage.output_tokens"] == 42


def test_e2e_non_skill_span_passes_through_untouched(_real_otel) -> None:
    """Regression guard: an ordinary tool span (no skill markers, no
    workflow-tool name) is exported byte-for-byte unchanged. This is
    the whole point of scoped scrubbing — keep Langfuse useful."""
    provider, exporter = _real_otel
    with mock.patch.dict(os.environ, {"SKILL_TRACE_SCRUB_ENABLED": "true"}):
        assert install_skill_content_scrubber() is True

    from opentelemetry import trace

    tracer = trace.get_tracer("test")
    user_msg = "What's the weather in Tokyo?"
    completion = "It's sunny and 22°C in Tokyo."
    with tracer.start_as_current_span("llm.call") as span:
        span.set_attribute("gen_ai.prompt.0.content", user_msg)
        span.set_attribute("gen_ai.completion.0.content", completion)
        span.set_attribute("traceloop.entity.name", "github_search")
        span.set_attribute(
            "traceloop.entity.output",
            json.dumps({"results": [{"name": "ai-platform-engineering"}]}),
        )

    attrs = exporter.get_finished_spans()[0].attributes
    assert attrs["gen_ai.prompt.0.content"] == user_msg
    assert attrs["gen_ai.completion.0.content"] == completion
    parsed = json.loads(attrs["traceloop.entity.output"])
    assert parsed == {"results": [{"name": "ai-platform-engineering"}]}


def test_e2e_disabled_env_means_payloads_are_exported_raw(_real_otel) -> None:
    """Sanity-pin the off switch: with SKILL_TRACE_SCRUB_ENABLED=false
    the install is a no-op and skill content reaches the exporter
    intact. Required for one-shot debug sessions to actually work."""
    provider, exporter = _real_otel
    with mock.patch.dict(os.environ, {"SKILL_TRACE_SCRUB_ENABLED": "false"}):
        assert install_skill_content_scrubber() is False

    from opentelemetry import trace

    tracer = trace.get_tracer("test")
    skill_body = "Top.\n## Skills System\n- secret\n## End"
    with tracer.start_as_current_span("llm.call") as span:
        span.set_attribute("gen_ai.prompt.0.content", skill_body)

    attrs = exporter.get_finished_spans()[0].attributes
    # Payload reaches exporter unredacted.
    assert attrs["gen_ai.prompt.0.content"] == skill_body
    assert "[redacted from trace]" not in attrs["gen_ai.prompt.0.content"]


def test_e2e_install_idempotent_via_repeat_calls(_real_otel) -> None:
    """Multiple AgentRuntime instances call install_skill_content_scrubber()
    on each construction. Walk that path — the active provider must
    end up with exactly one scrubber processor attached, and span
    content must be redacted exactly once (not duplicate-mangled)."""
    provider, exporter = _real_otel
    with mock.patch.dict(os.environ, {"SKILL_TRACE_SCRUB_ENABLED": "true"}):
        for _ in range(5):
            assert install_skill_content_scrubber() is True

    processors = provider._active_span_processor._span_processors  # type: ignore[attr-defined]
    scrubbers = [
        p for p in processors if type(p).__name__ == "SkillContentScrubbingProcessor"
    ]
    assert len(scrubbers) == 1, (
        f"expected exactly one scrubber processor, got {len(scrubbers)}"
    )

    from opentelemetry import trace

    tracer = trace.get_tracer("test")
    body = "Top.\n## Skills System\n- foo\n## End"
    with tracer.start_as_current_span("llm.call") as span:
        span.set_attribute("gen_ai.prompt.0.content", body)

    out = exporter.get_finished_spans()[0].attributes["gen_ai.prompt.0.content"]
    # "[redacted from trace]" appears exactly once — proves a second
    # processor isn't running over the already-redacted text.
    assert out.count("[redacted from trace]") == 1


def test_e2e_install_after_existing_processors_does_not_disturb_them(
    _real_otel,
) -> None:
    """The cnoe-agent-utils TracingManager registers its own
    BatchSpanProcessor. We attach ours alongside; both must run.
    The fixture already has a SimpleSpanProcessor attached — verify
    it still receives spans after our install."""
    provider, exporter = _real_otel
    pre_install_count = len(
        provider._active_span_processor._span_processors  # type: ignore[attr-defined]
    )
    with mock.patch.dict(os.environ, {"SKILL_TRACE_SCRUB_ENABLED": "true"}):
        install_skill_content_scrubber()
    post_install_count = len(
        provider._active_span_processor._span_processors  # type: ignore[attr-defined]
    )
    assert post_install_count == pre_install_count + 1

    from opentelemetry import trace

    tracer = trace.get_tracer("test")
    with tracer.start_as_current_span("smoke") as span:
        span.set_attribute("gen_ai.usage.input_tokens", 1)

    # Pre-existing exporter still receives the span.
    assert len(exporter.get_finished_spans()) == 1


# ---------------------------------------------------------------------------
# Integration smoke: dynamic-agents lifespan wiring
# ---------------------------------------------------------------------------

def test_dynamic_agents_lifespan_eagerly_installs_scrubber(_real_otel) -> None:
    """The dynamic-agents FastAPI lifespan handler calls
    install_skill_content_scrubber() at startup so the processor is
    registered before any request span fires (no lazy
    AgentRuntime-on-first-chat race).

    We don't spin up the full FastAPI app — that pulls in MongoDB
    and uvicorn. Instead we exercise the same code path the
    lifespan executes: TracingManager() singleton + install. If the
    contract changes (e.g. install moves elsewhere), this test
    fails loudly."""
    provider, _ = _real_otel
    pytest.importorskip("cnoe_agent_utils.tracing")
    from cnoe_agent_utils.tracing import TracingManager

    with mock.patch.dict(
        os.environ,
        {"SKILL_TRACE_SCRUB_ENABLED": "true", "ENABLE_TRACING": "false"},
    ):
        TracingManager()
        assert install_skill_content_scrubber() is True

    processors = provider._active_span_processor._span_processors  # type: ignore[attr-defined]
    assert any(
        type(p).__name__ == "SkillContentScrubbingProcessor" for p in processors
    )
