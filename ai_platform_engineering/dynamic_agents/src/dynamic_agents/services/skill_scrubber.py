# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
#
# VENDORED COPY — source of truth lives at
#   ai_platform_engineering/utils/tracing/skill_scrubber.py
# Kept in-tree because ``dynamic_agents`` ships as its own deploy
# unit (separate Dockerfile + Helm chart) and does not depend on
# the shared ``ai_platform_engineering`` package. Keep this file byte-for-byte in sync
# with the source-of-truth except for this header. Unit tests for
# the scrubber live alongside the source-of-truth copy and cover
# both since the modules are identical.


"""Operator-content scrubber for OpenTelemetry spans.

Problem
-------
The dynamic-agents service emits OTel spans through the Traceloop
(``opentelemetry-instrumentation-{langchain,bedrock,anthropic,...}``)
instrumentors. By default, those instrumentors stamp full prompt /
completion / tool-I/O bodies onto every span. Two classes of
operator-authored content end up echoed onto **every** step's span
that we want to keep out of Langfuse:

* **Skill payloads** — ``SKILL.md`` bodies and ancillary files loaded
  by the deepagents ``SkillsMiddleware``. Surface points:

  1. The ``## Skills System`` block in the system prompt
     (``gen_ai.prompt.<n>.content``) — metadata only today, still
     redundant on every step.
  2. ``read_file`` tool-call results when the agent loads
     ``/skills/<source>/<name>/SKILL.md`` or any ancillary file —
     this is where the bulk volume lives.
  3. The ``skills_metadata`` graph-state channel that Traceloop's
     LangChain instrumentor stamps as ``traceloop.entity.input`` /
     ``...output`` on each node.

* **Self-service workflow prompts** — multi-paragraph operator
  instructions defined under ``workflow_configs`` in MongoDB.
  Surface points:

  4. The ``tasks`` / ``todos`` graph-state channels (each entry
     carries the rendered ``llm_prompt``) — stamped on every node
     span by the LangChain instrumentor for the duration of a
     workflow run.
  5. The ``get_workflow_definition`` tool result, which renders
     every step's ``llm_prompt`` inside a ``## Workflow:`` block.
  6. The ``invoke_self_service_task`` tool span input/output — the
     tool's state-update return carries the full ``tasks`` array.

Setting ``TRACELOOP_TRACE_CONTENT=false`` would fix this but it also
wipes every chat / tool body globally, which kills debuggability of
non-skill flows. This processor does a scoped redaction instead.

Design
------
Implemented as an OTel ``SpanProcessor`` so we can rewrite span
attributes during ``on_end`` (after the instrumentor populates
them, before the OTLP exporter ships them). The redaction is
defensive — unknown attribute shapes pass through untouched, so a
bug here can never break tracing, only fail to redact.

We register the processor by attaching it to the active
``TracerProvider``. ``cnoe_agent_utils.tracing.manager`` installs
its own ``BatchSpanProcessor`` first; we install ours alongside.
The OTel SDK fans every span through every registered processor in
registration order, so as long as we install before the first span
fires (i.e. immediately after tracing init at app startup) we're
good.

Configuration
-------------
``SKILL_TRACE_SCRUB_ENABLED=true`` (default) — turn the scrubber on.
``SKILL_TRACE_SCRUB_PLACEHOLDER`` — the string that replaces redacted
content (default ``"[redacted: skill payload]"``).

Defensive size cap (orthogonal to skill scrubbing — protects the
OTLP exporter from Langfuse's nginx 413 limit when *non*-skill
attributes blow up):

``SKILL_TRACE_MAX_ATTR_BYTES`` — any string attribute above this
size, after skill scrubbing, is truncated with a marker. Default
``262144`` (256 KiB). Set ``0`` to disable.

Set ``SKILL_TRACE_SCRUB_ENABLED=false`` for one debug session if you
need to read raw skill prompts in Langfuse.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

DEFAULT_PLACEHOLDER = "[redacted: skill payload]"

# Hard cap on the byte-length of any single string attribute we
# emit. Langfuse's ingest is fronted by nginx with a default
# ``client_max_body_size 1m``; a single agent span can blow
# past that with full multi-turn prompt history + tool definitions
# even when skill content has been scrubbed. Truncating per
# attribute is far less destructive than dropping the whole batch
# (which is what nginx 413 forces today).
DEFAULT_MAX_ATTR_BYTES = 256 * 1024  # 256 KiB

# Match deepagents skill paths in tool-call inputs. The middleware
# always uses absolute paths under ``/skills/<source>/<name>/...``
# (see ``deepagents.middleware.skills`` ``_format_skills_locations``).
# We match liberally so future source-name additions Just Work.
_SKILL_PATH_RE = re.compile(r"(?:^|[^a-zA-Z0-9_])/skills/[^\s\"',)]+", re.IGNORECASE)

# Boundary markers for the two operator-authored content blocks we
# strip from prompts: deepagents' SkillsMiddleware section and the
# self-service workflow listing.
_SKILLS_SECTION_HEADER = "## Skills System"
_WORKFLOW_SECTION_HEADER = "## Self-Service Workflows"
# Header rendered by ``get_workflow_definition`` tool output for
# each requested workflow (the bulk-payload case).
_WORKFLOW_DEFN_HEADER = "## Workflow:"

# Tool / entity names whose I/O we redact wholesale because they
# echo workflow llm_prompts directly. Defensive redaction allowlist
# for self-service workflow tooling.
_WORKFLOW_TOOL_NAMES = frozenset(
    {
        "get_workflow_definition",
        "invoke_self_service_task",
        # list_self_service_workflows returns names only — small —
        # so we deliberately leave it alone for trace clarity.
    }
)

# Attributes whose **value** should be inspected and rewritten.
# Listed by stable Traceloop / OTel-GenAI semantic-convention
# prefixes so future minor-version attribute additions are caught.
_PROMPT_ATTR_PREFIXES = (
    "gen_ai.prompt.",  # OTel GenAI semconv (any role)
    "gen_ai.completion.",  # rarely contains skill text but cheap to check
    "llm.prompts.",  # Traceloop legacy
    "llm.completions.",
)

# LangChain instrumentor attaches per-node input/output blobs here.
_LANGCHAIN_IO_ATTR_KEYS = (
    "traceloop.entity.input",
    "traceloop.entity.output",
    "langchain.task.input",
    "langchain.task.output",
)

# State channels we want to drop entirely when serialized into a
# JSON blob on an attribute. Both skill catalogs and self-service
# workflows live in the agent's graph state and therefore get
# stamped onto every node span by the LangChain instrumentor.
_SENSITIVE_STATE_CHANNELS = (
    "skills_metadata",
    "skills",  # alternate name some middlewares use
    "tasks",  # workflow plan: list of dicts with full llm_prompt
    "todos",  # mirrors `tasks` (display_text + status)
)


# ---------------------------------------------------------------------------
# Redaction primitives
# ---------------------------------------------------------------------------


def _strip_marker_section(text: str, header: str) -> str:
    """Remove a ``## <header>`` block from a markdown-shaped string.

    The block is bounded by ``header`` on one end and either the
    next top-level (``##`` / ``#``) header or end-of-string on the
    other. The rest of the message (operator instructions, tool
    docs, …) is preserved verbatim. Returns ``text`` unchanged when
    the header is absent.
    """
    if header not in text:
        return text
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    skipping = False
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith(header):
            skipping = True
            out.append(f"{header} [redacted from trace]\n")
            continue
        if skipping:
            # Only stop at top-level (## or #) headers so we don't
            # accidentally exit on bullet sub-headers nested in the
            # skills/workflows block.
            if stripped.startswith("## ") or stripped.startswith("# "):
                skipping = False
                out.append(line)
            # else: drop the line
        else:
            out.append(line)
    return "".join(out)


def _strip_known_sections(text: str) -> str:
    """Strip every operator-authored sensitive section we know about."""
    text = _strip_marker_section(text, _SKILLS_SECTION_HEADER)
    text = _strip_marker_section(text, _WORKFLOW_SECTION_HEADER)
    text = _strip_marker_section(text, _WORKFLOW_DEFN_HEADER)
    return text


def _looks_like_skill_read(value: str) -> bool:
    """True when a string mentions a ``/skills/...`` path.

    Used to detect tool-call inputs that are pulling skill files.
    Matching the path (rather than the result body) is more
    reliable than scanning the body itself because SKILL.md bodies
    can be arbitrary markdown that we can't fingerprint.
    """
    return bool(_SKILL_PATH_RE.search(value))


def _redact_value(value: Any, placeholder: str) -> Any:
    """Best-effort scrub of a single attribute value.

    We handle three shapes:

    * **JSON-encoded dict** (the most common Traceloop shape) — parse,
      walk, redact known keys, re-serialize.
    * **Plain string** — strip the ``## Skills System`` block; if the
      remainder still mentions a ``/skills/...`` read, replace whole.
    * **Anything else** (numbers, bools, sequences) — leave alone.

    Returns the original value when in doubt; never raises.
    """
    if not isinstance(value, str):
        return value

    # Try JSON first — covers traceloop.entity.input / .output and
    # most of the gen_ai.prompt.<n>.content shapes that LangChain
    # callbacks JSON-encode.
    stripped = value.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, ValueError):
            parsed = None
        if parsed is not None:
            scrubbed = _scrub_json(parsed, placeholder)
            try:
                return json.dumps(scrubbed, ensure_ascii=False)
            except (TypeError, ValueError):
                return placeholder
        # Fall through to plain-string handling on JSON parse failure.

    # Plain string path.
    redacted = _strip_known_sections(value)
    if _looks_like_skill_read(redacted):
        # The string is a tool-call result that loaded a skill file
        # (or a system message with embedded skill paths). Wholesale
        # replace — partial scrubbing of arbitrary markdown is too
        # fragile to be worth it.
        return placeholder
    return redacted


def _scrub_json(obj: Any, placeholder: str) -> Any:
    """Recursively walk a JSON-decoded structure and redact skill bits."""
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            # Drop entire sensitive state channels by key.
            if k in _SENSITIVE_STATE_CHANNELS:
                out[k] = placeholder
                continue
            # The deepagents ``files`` channel is a path -> body
            # mapping. When the path itself points at a skill
            # source, the body is a SKILL.md / ancillary file
            # payload regardless of what its own text contains.
            # Match by key here, not by value, because file bodies
            # are arbitrary user content with no reliable marker.
            if isinstance(k, str) and _looks_like_skill_read(k):
                out[k] = placeholder
                continue
            out[k] = _scrub_json(v, placeholder)
        return out
    if isinstance(obj, list):
        return [_scrub_json(v, placeholder) for v in obj]
    if isinstance(obj, str):
        # A short string is unlikely to be a skill body. The
        # 200-char threshold is a heuristic — empirically, skill
        # paths and short completions are below it; SKILL.md bodies
        # and ancillary file contents are well above. Tune if you
        # see noise either way.
        if len(obj) > 200 and _looks_like_skill_read(obj):
            return placeholder
        if len(obj) > 200 and (
            _SKILLS_SECTION_HEADER in obj or _WORKFLOW_SECTION_HEADER in obj or _WORKFLOW_DEFN_HEADER in obj
        ):
            return _strip_known_sections(obj)
    return obj


# ---------------------------------------------------------------------------
# SpanProcessor
# ---------------------------------------------------------------------------


class SkillContentScrubbingProcessor:
    """OpenTelemetry ``SpanProcessor`` that scrubs skill content.

    Implements the duck-typed ``SpanProcessor`` interface (importing
    the abstract base would force a hard dep on ``opentelemetry-sdk``
    at module-load time; we want this module importable in test
    environments that don't have the SDK installed).
    """

    def __init__(
        self,
        placeholder: str = DEFAULT_PLACEHOLDER,
        max_attr_bytes: int = DEFAULT_MAX_ATTR_BYTES,
    ) -> None:
        self._placeholder = placeholder
        # ``0`` disables the cap — useful when running against an
        # exporter without an nginx body limit (e.g. local stdout
        # exporter for debugging).
        self._max_attr_bytes = max_attr_bytes if max_attr_bytes > 0 else 0

    # The OTel SDK calls these four methods. on_start / shutdown /
    # force_flush are no-ops; the work happens in on_end where the
    # span attributes are mutable and the BatchSpanProcessor hasn't
    # serialized them yet.
    def on_start(self, span, parent_context=None) -> None:  # noqa: D401, ARG002
        return None

    def _on_ending(self, span) -> None:  # noqa: D401, ARG002
        """Called by OTel SDK _MultiSpanProcessor before on_end."""
        return None

    def on_end(self, span) -> None:  # noqa: D401
        try:
            attrs = getattr(span, "attributes", None)
            if not attrs:
                return

            # Tool-name short-circuit. The LangChain instrumentor
            # tags every tool span with ``traceloop.entity.name`` (and
            # mirrors it on the OTel ``span.name``). When the tool is
            # one of our self-service workflow tools we redact its
            # I/O wholesale — those payloads always carry llm_prompt
            # bodies regardless of any markdown markers.
            entity_name = attrs.get("traceloop.entity.name") or getattr(span, "name", None)
            workflow_tool = isinstance(entity_name, str) and entity_name in _WORKFLOW_TOOL_NAMES

            updates: dict[str, Any] = {}
            for key, value in attrs.items():
                if not isinstance(key, str):
                    continue
                in_io_attr = key in _LANGCHAIN_IO_ATTR_KEYS
                in_prompt_attr = any(key.startswith(p) for p in _PROMPT_ATTR_PREFIXES)
                # Skill / workflow scrubbing path — same as before.
                if in_io_attr or in_prompt_attr:
                    if workflow_tool and in_io_attr:
                        if value != self._placeholder:
                            updates[key] = self._placeholder
                    else:
                        new_value = _redact_value(value, self._placeholder)
                        if new_value is not value:
                            updates[key] = new_value

            # Defensive size cap. Runs over **all** string
            # attributes, not just the targeted ones, because the
            # 413-class whales (tool-definition JSON, multi-turn
            # message arrays, raw Bedrock response bodies) live on
            # attribute keys we don't enumerate. Using
            # ``updates.get(key, value)`` so we cap the
            # already-scrubbed value rather than re-checking the
            # raw skill payload (and so a truncated placeholder
            # itself never gets re-truncated below the marker).
            if self._max_attr_bytes:
                for key, value in attrs.items():
                    if not isinstance(key, str):
                        continue
                    candidate = updates.get(key, value)
                    if not isinstance(candidate, str):
                        continue
                    # ``len(str)`` is char-count, not byte-count;
                    # close enough for a cap (UTF-8 encoded length
                    # is at most 4× this). Avoid encoding every
                    # attribute on the hot path.
                    if len(candidate) > self._max_attr_bytes:
                        truncated = candidate[: self._max_attr_bytes]
                        marker = f"\n[truncated: original={len(candidate)} chars, cap={self._max_attr_bytes}]"
                        updates[key] = truncated + marker
            if updates:
                # We're inside ``on_end``: the span's ``_end_time``
                # is already set, which makes ``set_attribute`` a
                # documented no-op (it logs "Setting attribute on
                # ended span." and returns). The only way to mutate
                # span state at this point is to write straight to
                # the underlying ``_attributes`` dict (or its
                # backing ``BoundedAttributes`` mapping). Both shapes
                # support ``__setitem__``. We fall back to the test
                # ``set_attribute`` path only if the internals look
                # different from the OTel SDK we expect.
                raw = getattr(span, "_attributes", None)
                wrote = False
                if raw is not None:
                    try:
                        for k, v in updates.items():
                            raw[k] = v
                        wrote = True
                    except Exception:  # noqa: BLE001
                        pass
                if not wrote:
                    try:
                        for k, v in updates.items():
                            span.set_attribute(k, v)
                    except Exception:  # noqa: BLE001
                        # Lose this redaction rather than crash the
                        # exporter pipeline.
                        pass
        except Exception as exc:  # noqa: BLE001 — defense in depth
            logger.debug("[skill-scrubber] suppressed error on span end: %s", exc)

    def shutdown(self) -> None:  # noqa: D401
        return None

    def force_flush(self, timeout_millis: int | None = None) -> bool:  # noqa: ARG002
        return True


# ---------------------------------------------------------------------------
# Installer
# ---------------------------------------------------------------------------


def install_skill_content_scrubber() -> bool:
    """Attach the scrubber to the global TracerProvider.

    Idempotent — calling twice does not register two processors.

    Returns ``True`` if installed (or already installed), ``False``
    when disabled by env or when no usable TracerProvider is
    available (e.g. tracing was never initialised). Never raises.
    """
    if os.getenv("SKILL_TRACE_SCRUB_ENABLED", "true").lower() == "false":
        logger.info("[skill-scrubber] disabled via SKILL_TRACE_SCRUB_ENABLED=false")
        return False

    try:
        from opentelemetry import trace
    except ImportError:
        logger.info("[skill-scrubber] opentelemetry not installed; skipping")
        return False

    provider = trace.get_tracer_provider()
    add_processor = getattr(provider, "add_span_processor", None)
    if add_processor is None:
        # NoOpTracerProvider (tracing not initialized) returns None
        # here; nothing to attach to. The cnoe_agent_utils manager
        # logs its own "tracing disabled" line in that case.
        logger.info("[skill-scrubber] active TracerProvider has no add_span_processor; skipping")
        return False

    # Idempotency: stash a marker on the provider so re-imports of
    # this module (e.g. uvicorn auto-reload, test-suite reruns) don't
    # stack processors. The OTel SDK has no native lookup for
    # already-registered processors of a given type.
    if getattr(provider, "_skill_scrubber_installed", False):
        return True

    placeholder = os.getenv("SKILL_TRACE_SCRUB_PLACEHOLDER", DEFAULT_PLACEHOLDER)
    raw_cap = os.getenv("SKILL_TRACE_MAX_ATTR_BYTES")
    try:
        max_attr_bytes = int(raw_cap) if raw_cap is not None else DEFAULT_MAX_ATTR_BYTES
    except ValueError:
        logger.warning(
            "[skill-scrubber] SKILL_TRACE_MAX_ATTR_BYTES=%r is not an int; falling back to default %d",
            raw_cap,
            DEFAULT_MAX_ATTR_BYTES,
        )
        max_attr_bytes = DEFAULT_MAX_ATTR_BYTES
    processor = SkillContentScrubbingProcessor(
        placeholder=placeholder,
        max_attr_bytes=max_attr_bytes,
    )
    add_processor(processor)

    # Front-load the scrubber. The SDK fans every span through
    # processors **in registration order**; for any synchronous
    # exporter (``SimpleSpanProcessor``, custom direct exporters)
    # the exporter would otherwise see raw skill payloads if it
    # was registered before us. ``BatchSpanProcessor`` is async and
    # queues spans by reference, so the scrubber's mutation lands
    # before the worker thread exports — but we don't control which
    # processor type downstream code installs, so be safe and run
    # first either way. The OTel SDK has no public prepend API; the
    # underlying ``MultiSpanProcessor._span_processors`` is a tuple,
    # which we rebuild with the scrubber moved to the front. Falls
    # back silently when the internals don't match expectations.
    try:
        active = getattr(provider, "_active_span_processor", None)
        if active is not None:
            current = getattr(active, "_span_processors", None)
            if isinstance(current, tuple) and processor in current:
                others = tuple(p for p in current if p is not processor)
                active._span_processors = (processor,) + others  # type: ignore[attr-defined]
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "[skill-scrubber] could not front-load processor (%s); "
            "scrubber will still run but may follow other processors",
            exc,
        )

    try:
        provider._skill_scrubber_installed = True  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        # Some provider implementations forbid attribute writes.
        # Idempotency is best-effort.
        pass
    logger.info(
        "[skill-scrubber] installed (placeholder=%r, max_attr_bytes=%s)",
        placeholder,
        max_attr_bytes if max_attr_bytes else "disabled",
    )
    return True
