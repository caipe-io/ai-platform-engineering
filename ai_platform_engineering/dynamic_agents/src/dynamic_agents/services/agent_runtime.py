"""Agent Runtime service for Dynamic Agents.

Creates and manages DeepAgent instances with MCP tools.

This module contains the core ``AgentRuntime`` class.  Sibling modules:

- ``skills.py``         — ``load_skills()`` / ``extract_llm_prompt()``
- ``runtime_cache.py``  — ``AgentRuntimeCache`` / ``get_runtime_cache()``
"""

import asyncio
import base64
import json
import logging
import os
import re
import time
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, NamedTuple
from uuid import uuid4

from cnoe_agent_utils.llm_factory import resolve_bedrock_client
from cnoe_agent_utils.tracing import TracingManager
from deepagents import create_deep_agent
from deepagents.backends.state import StateBackend
from deepagents.backends.store import StoreBackend
from deepagents.middleware.skills import SkillsMiddleware
from deepagents.middleware.subagents import GENERAL_PURPOSE_SUBAGENT
from jinja2 import ChainableUndefined, TemplateSyntaxError
from jinja2.sandbox import ImmutableSandboxedEnvironment, SecurityError
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.mongodb.saver import MongoDBSaver
from langgraph.store.memory import InMemoryStore
from langgraph.types import Command
from pymongo import MongoClient

from dynamic_agents.config import Settings, get_settings
from dynamic_agents.metrics import metrics as prom_metrics
from dynamic_agents.models import (
    BACKEND_STORE,
    AgentContext,
    ClientContext,
    DynamicAgentConfig,
    InputFile,
    InterruptConfig,
    MCPServerConfig,
    SubAgentRef,
    UserContext,
)
from dynamic_agents.services.attachment_store import (
    AttachmentStore,
    build_attachment_store,
)
from dynamic_agents.services.builtin_tools import (
    WorkflowApiClient,
    create_curl_tool,
    create_current_datetime_tool,
    create_fetch_url_tool,
    create_format_file_tool,
    create_request_user_input_tool,
    create_self_identity_tool,
    create_user_info_tool,
    create_wait_tool,
    create_workflow_tools,
)
from dynamic_agents.services.credential_exchange import CredentialExchangeClient
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.llm_clients import get_llm
from dynamic_agents.services.mcp_client import (
    McpCredentialUnavailableError,
    build_mcp_connections,
    filter_tools_by_allowed,
    get_tools_with_resilience,
    mcp_credential_connect_warning,
    pin_datasource_filters,
    resolve_mcp_connections_credential_refs,
    wrap_tools_with_error_handling,
)
from dynamic_agents.services.middleware import (
    TEXT_DOCUMENT_MIME_TYPES,
    ToolResultInvariantMiddleware,
    anthropic_text_document_block,
    build_middleware,
)
from dynamic_agents.services.model_capabilities import (
    ModelCapabilities,
    get_model_capabilities,
)
from dynamic_agents.services.skills import build_skills_files, detect_missing_skills, load_skills

if TYPE_CHECKING:
    from dynamic_agents.services.mongo import MongoDBService
    from dynamic_agents.services.stream_encoders import StreamEncoder

logger = logging.getLogger(__name__)


@dataclass
class _TurnObservation:
    """Mutable state shared by a public turn wrapper and its implementation."""

    started_at: float
    turn_type: str
    status: str = "success"
    first_response_recorded: bool = False


def _sanitize_agent_name(name: str) -> str:
    """Sanitize an agent name for use as a LangChain/OpenAI message ``name`` field.

    OpenAI requires message ``name`` fields to match the pattern ``^[^\\s<|\\\\/>]+$``
    (no whitespace, ``<``, ``|``, ``\\``, ``/``, or ``>``).  deepagents propagates
    the agent ``name`` into message ``name`` fields via its middleware, so we must
    ensure it conforms.

    We replace disallowed characters with underscores.
    """
    return re.sub(r"[\s<|\\/>]+", "_", name)


def _with_general_purpose_tool_result_recovery(
    subagents: list[dict[str, Any]],
    *,
    model: Any,
    tools: list[Any],
    interrupt_on: dict[str, Any],
) -> list[dict[str, Any]]:
    """Override Deep Agents' built-in subagent with request-time history repair.

    Deep Agents does not apply the parent agent's custom middleware to its
    built-in ``general-purpose`` subagent. An explicit same-name specification
    suppresses that default while preserving the public ``task`` tool contract.
    """
    recovered_general_purpose = {
        **GENERAL_PURPOSE_SUBAGENT,
        "tools": tools,
        "model": model,
        "interrupt_on": interrupt_on,
        "middleware": [ToolResultInvariantMiddleware()],
    }
    configured_subagents = [
        subagent
        for subagent in subagents
        if subagent.get("name") != GENERAL_PURPOSE_SUBAGENT["name"]
    ]
    return [*configured_subagents, recovered_general_purpose]


# Module-level restricted Jinja2 sandbox for system prompt rendering.
# - ChainableUndefined: missing/nested keys return "" instead of raising.
# - Built-in globals stripped: agent prompts only need conditionals and
#   variable interpolation, not lipsum(), cycler(), namespace(), etc.
_jinja_env = ImmutableSandboxedEnvironment(undefined=ChainableUndefined)
_jinja_env.globals = {}


class SystemPromptRenderError(Exception):
    """Raised when a system prompt Jinja2 template fails to render.

    Wraps TemplateSyntaxError, SecurityError, and other Jinja2 failures
    with a user-facing message so the caller can surface it cleanly.
    """


def _render_system_prompt(
    template_str: str,
    client_context: ClientContext | None,
    user: UserContext | None = None,
) -> str:
    """Render a system prompt template with client and user context via Jinja2.

    Uses a restricted ``SandboxedEnvironment`` to prevent code execution
    in templates.  All built-in globals (``lipsum``, ``range``, ``cycler``,
    etc.) are stripped — only variable interpolation and control flow
    (``if``/``for``) are available.

    ``ChainableUndefined`` ensures missing keys evaluate to falsy empty
    strings instead of raising errors — agent creators can safely write
    ``{%% if client_context.overthink %%}`` or ``{%% if user.is_admin %%}``
    without worrying about KeyError.

    Template variables:
        - ``client_context``: dict with ``source`` and any extra client fields
        - ``user``: dict with ``email`` and any extra auth fields (``name``,
          ``is_admin``, ``groups``, etc.)

    Args:
        template_str: The system prompt, possibly containing Jinja2 syntax.
        client_context: ClientContext from ChatRequest, or None.
        user: UserContext for the current user, or None.

    Returns:
        Rendered system prompt string.

    Raises:
        SystemPromptRenderError: If the template has syntax errors,
            attempts unsafe attribute access, or otherwise fails to render.
    """
    ctx = client_context.model_dump() if client_context else {}
    user_ctx = user.model_dump(exclude={"raw_claims"}) if user else {}
    try:
        template = _jinja_env.from_string(template_str)
        return template.render(client_context=ctx, user=user_ctx)
    except TemplateSyntaxError as exc:
        raise SystemPromptRenderError(f"Invalid system prompt template syntax: {exc}") from exc
    except SecurityError as exc:
        raise SystemPromptRenderError(f"System prompt template blocked unsafe operation: {exc}") from exc
    except Exception as exc:
        raise SystemPromptRenderError(f"System prompt template rendering failed: {exc}") from exc


def _build_mcp_warning_lines(
    permanent: list[str], permanent_error: str, transient: list[str]
) -> list[str]:
    """Build system-prompt warning lines for failed MCP servers, split by class.

    Permanent failures keep the actionable "needs attention" framing with their
    error detail; transient (still-warming) servers read as "starting up" and are
    being retried. A genuine denial flows through the permanent path's error
    string and is never relabeled as transient.
    """
    lines: list[str] = []
    if permanent:
        lines.append(
            "**MCP servers that failed to load (tools unavailable — needs attention):**"
        )
        lines.append(f"  {permanent_error}")
    if transient:
        lines.append(
            "**MCP servers still starting up (will be retried; tools may appear shortly):** "
            + ", ".join(transient)
        )
    return lines


def _mcp_warning_events(permanent: list[str], transient: list[str]) -> list[str]:
    """Build streamed warning messages for failed MCP servers, split by class.

    Permanent failures keep the "Tools from this server will not work." wording;
    transient servers get a "starting up ... will be retried" message instead.
    """
    messages: list[str] = []
    for server_name in permanent:
        messages.append(
            f"MCP server '{server_name}' is unavailable. Tools from this server will not work."
        )
    for server_name in transient:
        messages.append(
            f"MCP server '{server_name}' is starting up and not ready yet — it will be retried."
        )
    return messages


# MIME types the Bedrock Converse API can ingest, split by the LangChain
# content-block type each maps to. Images become ``image`` blocks; everything
# else becomes a ``document`` (``file``) block. Anything not listed here is
# rejected by the langchain_aws adapter (raising ValueError), so we skip such
# files with a warning rather than let them break the whole request.
# Source: langchain_aws.chat_models.bedrock_converse.MIME_TO_FORMAT.
_SUPPORTED_IMAGE_MIME_TYPES = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp"}
)
_SUPPORTED_DOC_MIME_TYPES = frozenset(
    {
        "application/pdf",
        "text/csv",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/html",
        "text/plain",
        "text/markdown",
    }
)
# Document types only the Anthropic Messages API client can ingest. Bedrock
# Converse has no document format for XML (``_mime_type_to_format`` raises), but
# the Anthropic client accepts it as a *text* document source. So these are kept
# only when the resolved client is ``anthropic`` (see ``_build_user_content``);
# on Converse/legacy they're skipped as unsupported rather than breaking the turn.
_ANTHROPIC_ONLY_DOC_MIME_TYPES = frozenset({"text/xml", "application/xml"})


# Reasons a file was dropped from the user turn, in machine-readable form so
# the caller can build the right user-facing degradation message.
SKIP_UNSUPPORTED_BY_PROVIDER = "unsupported_by_provider"
SKIP_NOT_ACCEPTED_BY_MODEL = "not_accepted_by_model"
# Guardrail drops: the file itself is fine, but accepting it would breach an
# input limit (too many files this turn, or the file/turn is too large).
SKIP_TOO_MANY_FILES = "too_many_files"
SKIP_FILE_TOO_LARGE = "file_too_large"
SKIP_TURN_TOO_LARGE = "turn_too_large"


class SkippedFile(NamedTuple):
    """A file that was attached but not sent to the model, and why.

    ``reason`` is one of:

    - ``SKIP_UNSUPPORTED_BY_PROVIDER`` — Bedrock/the adapter cannot ingest this
      MIME type at all.
    - ``SKIP_NOT_ACCEPTED_BY_MODEL`` — the provider supports it, but this agent's
      model declared it does not accept that modality (e.g. a text-only model
      handed an image).
    - ``SKIP_TOO_MANY_FILES`` / ``SKIP_FILE_TOO_LARGE`` / ``SKIP_TURN_TOO_LARGE``
      — the file is otherwise fine but accepting it would breach an input
      guardrail (see ``config.Settings.max_input_*``).
    """

    name: str | None
    mime_type: str
    reason: str


def _mb(num_bytes: int) -> str:
    """Render a byte count as a compact MB string for user/model copy."""
    mb = num_bytes / (1024 * 1024)
    # Drop a trailing .0 so "5MB" reads cleaner than "5.0MB".
    return f"{mb:.0f}MB" if mb == int(mb) else f"{mb:.1f}MB"


def _skip_phrase(
    skip: SkippedFile,
    model_id: str | None = None,
    max_file_bytes: int = 0,
    max_turn_bytes: int = 0,
) -> str:
    """The reason clause shared by the user warning and the model-facing notice.

    Returns just the "why" (no "Attached … wasn't read" framing) so both the
    user warning and the ``_skipped_files_notice`` can reuse identical wording.
    """
    if skip.reason == SKIP_NOT_ACCEPTED_BY_MODEL:
        kind = "image" if skip.mime_type in _SUPPORTED_IMAGE_MIME_TYPES else "document"
        model = f" ({model_id})" if model_id else ""
        return f"this agent's model{model} doesn't accept {kind} input"
    if skip.reason == SKIP_TOO_MANY_FILES:
        return "too many files were attached this turn"
    if skip.reason == SKIP_FILE_TOO_LARGE:
        limit = f" ({_mb(max_file_bytes)} max)" if max_file_bytes else ""
        return f"it exceeds the per-file size limit{limit}"
    if skip.reason == SKIP_TURN_TOO_LARGE:
        limit = f" ({_mb(max_turn_bytes)} max)" if max_turn_bytes else ""
        return f"the attachments exceed the per-message size limit{limit}"
    # SKIP_UNSUPPORTED_BY_PROVIDER (default)
    return f"its file type ({skip.mime_type}) isn't supported for model input"


def _skipped_file_warning(
    skip: SkippedFile,
    model_id: str | None = None,
    max_file_bytes: int = 0,
    max_turn_bytes: int = 0,
) -> str:
    """User-facing copy explaining why an attached file was not sent to the model."""
    label = f"'{skip.name}'" if skip.name else f"a {skip.mime_type} file"
    why = _skip_phrase(skip, model_id, max_file_bytes, max_turn_bytes)
    return f"Attached {label} wasn't read: {why} — answering from your text only."


def _skipped_files_notice(
    skipped: "list[SkippedFile]",
    model_id: str | None = None,
    max_file_bytes: int = 0,
    max_turn_bytes: int = 0,
) -> str:
    """A single system-note, injected into the user turn, so the *model* knows a
    file was dropped.

    The user-facing ``on_warning`` frame is suppressed on some channels (e.g.
    Slack, to avoid noise), which would otherwise leave the model answering as
    if no file were attached — a silent failure. This note travels in the turn
    content itself, so the model can acknowledge it couldn't read the file
    regardless of channel.
    """
    if not skipped:
        return ""
    parts = []
    for skip in skipped:
        label = f"'{skip.name}'" if skip.name else f"a {skip.mime_type} file"
        parts.append(f"{label} ({_skip_phrase(skip, model_id, max_file_bytes, max_turn_bytes)})")
    listing = "; ".join(parts)
    return (
        f"[System note: {len(skipped)} attached file(s) could not be read and were "
        f"not included: {listing}. Answer from the text. If a file was essential to "
        f"the request, tell the user you could not read it and why.]"
    )


def _estimated_bytes(f: "InputFile") -> int:
    """Best-effort decoded size of an inline attachment, in bytes.

    Estimated from the base64 length (``≈ len(data) * 3 / 4``) so we never
    decode a large payload into memory just to measure it. URI-referenced files
    carry no inline bytes, so they measure 0 and are exempt from size guards
    (only the count guard applies to them)."""
    if not f.data:
        return 0
    n = len(f.data.rstrip("="))
    return n * 3 // 4


def _inline_document_block(
    block: dict[str, Any], f: "InputFile", needs_text_source: bool
) -> dict[str, Any]:
    """Attach inline file bytes to ``block`` in the shape the adapter expects.

    For most files that's ``base64``. For text-family documents on the Anthropic
    client (``needs_text_source``) it's a text source carrying the decoded UTF-8
    text, because Anthropic rejects non-PDF base64 document sources.
    """
    if needs_text_source and f.data:
        try:
            text = base64.b64decode(f.data).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            text = base64.b64decode(f.data).decode("utf-8", errors="replace")
        return anthropic_text_document_block(block, text)
    block["base64"] = f.data
    return block


def _build_user_content(
    message: str,
    files: "list[InputFile] | None",
    capabilities: "ModelCapabilities | None" = None,
    *,
    model_id: str | None = None,
    max_files: int = 0,
    max_file_bytes: int = 0,
    max_turn_bytes: int = 0,
    store: "AttachmentStore | None" = None,
) -> "tuple[str | list[dict[str, Any]], list[SkippedFile]]":
    """Build the user-turn content for the agent's message list.

    Without files, returns ``(message, [])`` (the fast path). With one or more
    attachable files, returns ``(content_list, skipped)`` where ``content_list``
    is a multimodal list — a text block followed by one block per surviving
    file. Images become ``image`` blocks and documents (PDF, CSV, Office, HTML,
    txt, md) become ``file`` blocks, so the model reads every supported file —
    not just images. Both use LangChain's standard shape (``{"type": ...,
    "mime_type": ..., "base64"|"url": ...}``), which the langchain_aws Bedrock
    converse adapter converts natively.

    A file is dropped (and recorded in ``skipped``) when any of:

    - the provider cannot ingest its MIME type at all;
    - ``capabilities`` declares this agent's model does not accept that modality
      (so a no-vision model degrades cleanly to text instead of erroring);
    - it would breach an input guardrail — ``max_files`` (per turn),
      ``max_file_bytes`` (per file), or ``max_turn_bytes`` (aggregate of the
      files kept this turn). Each guard is disabled when its value is ``0``.

    ``capabilities=None`` means "accept everything the provider supports"
    (unchanged legacy behavior). If no file survives, the plain string is
    returned unchanged so the model still answers from the text.

    When ``store`` is provided, a surviving file's bytes are uploaded to the
    blob store and its block carries a ``source: {"store_key": ...}`` reference
    instead of inline base64 — so the persisted checkpoint stays small and the
    rehydration middleware re-inflates the bytes into the model request at
    inference time. When ``store`` is None (legacy path / no store configured),
    blocks keep inline base64 exactly as before.
    """
    if not files:
        return message, []

    caps = capabilities or ModelCapabilities()  # permissive default
    # The Anthropic Messages API client needs text-family docs as text sources
    # (base64 doc sources there are PDF-only) and is the only client that can
    # take XML at all. Resolve once; None model_id (unit tests) means "not
    # anthropic", preserving the legacy inline-base64 shape.
    is_anthropic = bool(model_id) and resolve_bedrock_client(model_id) == "anthropic"
    blocks: list[dict[str, Any]] = [{"type": "text", "text": message}]
    skipped: list[SkippedFile] = []
    kept_files = 0
    turn_bytes = 0
    for f in files:
        # ── Guardrails (checked before type/modality): the file is fine, but
        # accepting it would breach an input limit. Drop the overflow so a huge
        # or unbounded attachment set can't inflate the checkpoint / breach
        # Mongo's 16MB document cap. A limit of 0 disables that guard.
        if max_files and kept_files >= max_files:
            skipped.append(SkippedFile(f.name, f.mime_type, SKIP_TOO_MANY_FILES))
            continue
        size = _estimated_bytes(f)
        if max_file_bytes and size > max_file_bytes:
            logger.info(
                f"[stream] Skipping file '{f.name!r}' ({f.mime_type}): ~{size} bytes "
                f"exceeds per-file limit {max_file_bytes}"
            )
            skipped.append(SkippedFile(f.name, f.mime_type, SKIP_FILE_TOO_LARGE))
            continue
        if max_turn_bytes and turn_bytes + size > max_turn_bytes:
            logger.info(
                f"[stream] Skipping file '{f.name!r}' ({f.mime_type}): would push turn "
                f"to ~{turn_bytes + size} bytes, over limit {max_turn_bytes}"
            )
            skipped.append(SkippedFile(f.name, f.mime_type, SKIP_TURN_TOO_LARGE))
            continue

        if f.mime_type in _SUPPORTED_IMAGE_MIME_TYPES:
            block_type = "image"
        elif f.mime_type in _SUPPORTED_DOC_MIME_TYPES:
            block_type = "file"
        elif is_anthropic and f.mime_type in _ANTHROPIC_ONLY_DOC_MIME_TYPES:
            # XML: no Bedrock Converse document format exists, but the Anthropic
            # client reads it as a text document source.
            block_type = "file"
        else:
            logger.warning(
                f"[stream] Skipping file with unsupported type '{f.mime_type}' "
                f"(name={f.name!r}); Bedrock cannot ingest it"
            )
            skipped.append(SkippedFile(f.name, f.mime_type, SKIP_UNSUPPORTED_BY_PROVIDER))
            continue

        # Provider supports the type, but the selected model may not accept the
        # modality — degrade cleanly rather than let it error downstream.
        accepted = caps.accepts_images if block_type == "image" else caps.accepts_documents
        if not accepted:
            logger.info(
                f"[stream] Skipping {block_type} '{f.name!r}' ({f.mime_type}): "
                f"the agent's model does not accept this input modality"
            )
            skipped.append(SkippedFile(f.name, f.mime_type, SKIP_NOT_ACCEPTED_BY_MODEL))
            continue

        block: dict[str, Any] = {"type": block_type, "mime_type": f.mime_type}
        # Text-family documents on the Anthropic client can't ride as base64
        # document sources (PDF-only there) — they need a text source carrying
        # the decoded content. When a store is configured the shaping happens at
        # rehydration (bytes stay out of the checkpoint); here we handle the
        # inline paths (no store, or a store put that fell back to inline).
        needs_text_source = (
            is_anthropic and block_type == "file" and f.mime_type in TEXT_DOCUMENT_MIME_TYPES
        )
        if store is not None and f.data:
            # Reference form: upload bytes once (content-addressed) and persist
            # only the key. The rehydration middleware turns this back into the
            # right inline block (base64, or a text source for text docs on the
            # Anthropic client) before the model call — bytes never enter the
            # checkpoint. On any store failure, fall back to inline so a storage
            # hiccup degrades to today's behavior instead of dropping the file.
            try:
                raw = base64.b64decode(f.data)
                key = store.put(raw, content_type=f.mime_type)
                block["source"] = {"store_key": key}
            except Exception as exc:  # noqa: BLE001 — never fail the turn on storage
                logger.warning(
                    f"[stream] Attachment store put failed for '{f.name!r}' "
                    f"({f.mime_type}); falling back to inline: {exc}"
                )
                block = _inline_document_block(block, f, needs_text_source)
        elif f.data:
            block = _inline_document_block(block, f, needs_text_source)
        else:
            block["url"] = f.uri
        # Document blocks carry a filename; the adapter warns without one.
        # (Text-source blocks keep it too — harmless and preserves provenance.)
        if block_type == "file" and f.name:
            block["name"] = f.name
        blocks.append(block)
        kept_files += 1
        turn_bytes += size

    # Only switch to multimodal if at least one file survived filtering.
    content = blocks if len(blocks) > 1 else message
    return content, skipped


class AgentRuntime:
    """Runtime for a single dynamic agent instance."""

    # Class-level defaults so the lazy attachment-store accessor is safe even
    # when an instance is constructed without __init__ (e.g. object.__new__ in
    # unit tests that exercise _resolve_subagents in isolation). __init__ sets
    # the per-instance values; these are the fall-through.
    _attachment_store: "AttachmentStore | None" = None
    _attachment_store_built: bool = False

    def __init__(
        self,
        config: DynamicAgentConfig,
        mcp_servers: list[MCPServerConfig],
        settings: Settings | None = None,
        mongo_service: "MongoDBService | None" = None,
        user: UserContext | None = None,
        client_context: ClientContext | None = None,
        session_id: str | None = None,
        mongo_client: MongoClient | None = None,
        ephemeral: bool = False,
    ):
        self.config = config
        self.mcp_servers = mcp_servers
        self.settings = settings or get_settings()
        self._mongo_service = mongo_service
        self._user = user
        self._client_context = client_context
        # Spec 102 Phase 8 / T107: prefer the per-request bearer from
        # current_user_token (set by JwtAuthMiddleware) so the same token
        # the BFF authenticated us with is forwarded to MCP servers.
        # Fall back to UserContext-attached fields for backward compat
        # with the X-User-Context legacy path.
        from dynamic_agents.auth.token_context import current_user_token as _ctx_tok

        ctx_token = _ctx_tok.get()
        legacy_token = (user.obo_jwt or user.access_token) if user else None
        self._auth_bearer: str | None = ctx_token or legacy_token
        # Spec 104: never silently substitute the dynamic-agents service
        # account token here — the runtime must run with the user's OBO
        # token so AgentGateway/OpenFGA can evaluate the signed active-team
        # context. If we have nothing, log loudly and let the
        # downstream call 401; we'd rather fail closed than show the user
        # tools that belong to the SA.
        if self._auth_bearer is None:
            logger.warning(
                "AgentRuntime for '%s' has no user JWT (ctx_token + legacy both empty); "
                "outbound MCP calls will be unauthenticated and AgentGateway will reject them. "
                "This usually means JwtAuthMiddleware was bypassed or the BFF stripped the "
                "Authorization header.",
                config.name,
            )
        self._session_id = session_id

        self._graph = None
        # Attachment blob store, built lazily on first use (see
        # ``attachment_store``). Shared between the write path (upload bytes,
        # persist a reference) and the rehydration middleware (fetch bytes back
        # into the model request). None if construction fails, in which case the
        # write path falls back to inline base64 (today's behavior).
        self._attachment_store: AttachmentStore | None = None
        self._attachment_store_built = False

        if ephemeral:
            # In-memory only — no MongoDB writes, GC'd with the runtime
            self._owns_mongo_client = False
            self._mongo_client = None
            self._checkpointer = MemorySaver()
            self._store = InMemoryStore()
        else:
            # Use shared MongoClient if provided; otherwise create our own
            self._owns_mongo_client = mongo_client is None
            self._mongo_client = mongo_client or MongoClient(self.settings.mongodb_uri, tz_aware=True)
            # Resolve checkpoint collection — allows override via backend.config.checkpoint_collection
            checkpoint_coll = self.settings.checkpoint_collection
            writes_coll = self.settings.checkpoint_writes_collection
            checkpoint_ttl = None
            if config.backend and config.backend.config:
                if config.backend.config.checkpoint_collection:
                    checkpoint_coll = config.backend.config.checkpoint_collection
                    writes_coll = f"{config.backend.config.checkpoint_collection}_writes"
                if config.backend.config.checkpoint_ttl is not None:
                    checkpoint_ttl = config.backend.config.checkpoint_ttl
            # Use MongoDBSaver from langgraph-checkpoint-mongodb for persistent chat history
            self._checkpointer = MongoDBSaver(
                self._mongo_client,
                db_name=self.settings.mongodb_database,
                checkpoint_collection_name=checkpoint_coll,
                writes_collection_name=writes_coll,
                ttl=checkpoint_ttl,
            )
            # GridFS-backed store for large file content (avoids 16MB checkpoint limit)
            fs_ttl = self._resolve_fs_ttl()
            self._store = MongoDBGridFSStore(
                db=self._mongo_client[self.settings.mongodb_database],
                bucket_name=self.settings.gridfs_bucket_name,
                ttl_seconds=fs_ttl,
            )
        self._initialized = False
        self._active_stream_count = 0
        self._is_streaming = False  # guards LRU eviction — never evict mid-stream
        self._created_at = time.time()
        self._last_interaction = time.time()
        self.tracing = TracingManager()
        # Scrub skill payloads (SKILL.md bodies, ancillary file
        # contents, skills_metadata channel) from spans before they
        # leave the process. Must run after TracingManager() (which
        # sets up the TracerProvider) and is idempotent so multiple
        # AgentRuntime instances all share the same processor.
        try:
            # Vendored — see skill_scrubber.py header for the
            # source-of-truth path under ai_platform_engineering/.
            from dynamic_agents.services.skill_scrubber import (
                install_skill_content_scrubber,
            )

            install_skill_content_scrubber()
        except Exception as exc:  # noqa: BLE001 — tracing is best-effort
            import logging as _logging

            _logging.getLogger(__name__).warning(
                "Skill-trace scrubber install failed: %s",
                exc,
            )
        self._current_trace_id: str | None = None
        self._missing_tools: list[str] = []
        self._failed_servers: list[str] = []  # Just server names
        self._failed_servers_error: str = ""  # Error message for display
        # Failed servers split by classification (see classify_load_error):
        # transient = still warming up / retryable; permanent = needs attention.
        self._failed_servers_transient: list[str] = []
        self._failed_servers_permanent: list[str] = []
        self._failed_servers_permanent_error: str = ""  # "id: error; ..." for permanent only
        self._failed_skills: list[str] = []  # Skill IDs that failed to load
        self._failed_skills_error: str = ""  # Error message for display
        self._failed_workflows: list[str] = []  # Workflow config IDs not found
        self._failed_workflows_error: str = ""  # Error message for display
        self._mcp_credential_warnings: list[str] = []
        self._mcp_credential_failed_server_ids: set[str] = set()
        self._valid_workflow_configs: list[str] = []  # Validated workflow config IDs
        self._workflow_prompt_addendum: str = ""  # System prompt addendum with workflow info
        # Track config timestamps for cache invalidation
        self._config_updated_at: datetime = config.updated_at
        self._mcp_servers_updated_at: datetime = max(
            (s.updated_at for s in mcp_servers), default=datetime.min.replace(tzinfo=timezone.utc)
        )
        # Cancellation flag for graceful stream termination
        self._cancelled: bool = False

    def _rag_datasource_provider(
        self,
        config: DynamicAgentConfig,
    ) -> Callable[[], list[str]] | None:
        """Return a fail-closed live collection-membership resolver."""
        if not config.rag_collection_ids:
            return None
        if not self._mongo_service:
            logger.warning(
                "Agent '%s' has RAG collections but no MongoDB service; "
                "only explicit datasource pins will be available",
                config.name,
            )
            return lambda: list(config.datasource_ids or [])
        return lambda: self._mongo_service.resolve_rag_datasource_ids(
            config.rag_collection_ids or [],
            config.datasource_ids,
        )

    @staticmethod
    def _prompt_cache_enabled() -> bool:
        """Whether Bedrock prompt caching is on for this deployment.

        Reads the Bedrock-scoped ``AWS_BEDROCK_ENABLE_PROMPT_CACHE`` flag. When
        set, ``build_middleware`` attaches the native langchain caching
        middleware matching the resolved Bedrock client (Anthropic or Converse);
        see ``middleware._build_prompt_cache_middleware``.
        """
        return os.getenv("AWS_BEDROCK_ENABLE_PROMPT_CACHE", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }

    def _get_attachment_store(self) -> AttachmentStore | None:
        """Return the shared attachment store, building it once on first use.

        Returns None (and logs) if construction fails — the write path then
        falls back to inline base64, so a misconfigured store degrades to
        today's behavior instead of dropping attachments.
        """
        if not self._attachment_store_built:
            self._attachment_store_built = True
            try:
                self._attachment_store = build_attachment_store(self.settings)
                logger.info(
                    "Agent '%s': attachment store backend=%s",
                    self.config.name,
                    self._attachment_store.backend_name,
                )
            except Exception as exc:  # noqa: BLE001 — never fail a turn on store init
                logger.warning(
                    "Agent '%s': attachment store unavailable (%s); "
                    "attachments will ride inline as base64",
                    self.config.name,
                    exc,
                )
                self._attachment_store = None
        return self._attachment_store

    def _resolve_backend_type(self) -> str:
        """Resolve effective backend type from agent config or server default."""
        if self.config.backend and self.config.backend.type:
            return self.config.backend.type
        return self.settings.default_runtime_backend

    def _resolve_fs_namespace(self) -> tuple[str, str, str]:
        """Resolve filesystem namespace from config override or default.

        Returns a 3-tuple used as the GridFS store namespace key.
        Default: (agent_id, session_id, "filesystem")
        Override: from backend.config.fs_namespace (list of 3 strings)
        """
        if self.config.backend and self.config.backend.config and self.config.backend.config.fs_namespace:
            ns = self.config.backend.config.fs_namespace
            return (ns[0], ns[1], ns[2])
        return (self.config.id, self._session_id, "filesystem")

    def _resolve_fs_ttl(self) -> int:
        """Resolve filesystem TTL from agent config or server default.

        Returns 0 for infinite. Validates against max_fs_ttl_seconds.
        """
        ttl = None
        if self.config.backend and self.config.backend.config:
            ttl = self.config.backend.config.fs_ttl_seconds
        if ttl is None:
            ttl = self.settings.default_fs_ttl_seconds

        max_ttl = self.settings.max_fs_ttl_seconds
        if max_ttl != 0 and ttl != 0 and ttl > max_ttl:
            logger.warning(
                f"Agent '{self.config.name}': fs_ttl_seconds={ttl} exceeds max_fs_ttl_seconds={max_ttl}, capping to max"
            )
            ttl = max_ttl
        return ttl

    def _credential_exchange_client(self) -> CredentialExchangeClient | None:
        """Create a credential API client when impersonation token resolution is configured."""

        if not self.settings.credential_api_url or not self._auth_bearer:
            return None
        return CredentialExchangeClient(
            base_url=self.settings.credential_api_url,
            audience=self.settings.credential_service_audience,
            token_provider=lambda: self._auth_bearer or "",
        )

    def _record_mcp_credential_failures(
        self, failures: dict[str, McpCredentialUnavailableError]
    ) -> None:
        """Track MCP servers that failed credential resolution at startup."""
        if not failures:
            return
        error_parts: list[str] = []
        for server_id, exc in failures.items():
            self._mcp_credential_failed_server_ids.add(server_id)
            self._mcp_credential_warnings.append(mcp_credential_connect_warning(exc))
            self._failed_servers.append(server_id)
            self._failed_servers_permanent.append(server_id)
            error_parts.append(f"{server_id}: {exc.reason}")
        detail = "; ".join(error_parts)
        self._failed_servers_error = (
            f"{self._failed_servers_error}; {detail}" if self._failed_servers_error else detail
        )
        self._failed_servers_permanent_error = (
            f"{self._failed_servers_permanent_error}; {detail}"
            if self._failed_servers_permanent_error
            else detail
        )

    async def initialize(self) -> None:
        """Build the DeepAgent graph with tools and instructions."""
        if self._initialized:
            return

        t_start = time.monotonic()

        # ─────────────────────────────────────────────────────────────────
        # Tools
        # ─────────────────────────────────────────────────────────────────

        # 1. Attach MCP servers and tools
        server_ids = [sid for sid, val in self.config.allowed_tools.items() if val is not False]
        if not server_ids:
            logger.info(f"Agent '{self.config.name}' has no MCP tools configured")
            tools = []
        else:
            connections = build_mcp_connections(
                self.mcp_servers,
                server_ids,
                agent_gateway_url=self.settings.agent_gateway_url,
                auth_bearer=self._auth_bearer,
                agent_id=self.config.id,
            )
            cred_result = await resolve_mcp_connections_credential_refs(
                self.mcp_servers,
                connections,
                credential_client=self._credential_exchange_client(),
                caller_token=self._auth_bearer,
            )
            connections = cred_result.connections
            self._record_mcp_credential_failures(cred_result.failures)

            if not connections:
                logger.warning(f"Agent '{self.config.name}': no valid MCP connections found")
                tools = []
            else:
                # This connects to each server independently so one failure doesn't affect others
                t_mcp = time.monotonic()
                all_tools, failed_servers, failed_errors, failed_status = await get_tools_with_resilience(
                    connections
                )
                logger.info(
                    f"[init] MCP tools fetched in {time.monotonic() - t_mcp:.2f}s "
                    f"(agent='{self.config.name}', servers={len(connections)}, "
                    f"failed={len(failed_servers)})"
                )

                # Store failed servers for warning events, split by classification
                # so transient (still-warming) servers read as "starting up" while
                # permanent failures read as "needs attention". A genuine denial is
                # surfaced through the existing diagnostic message, never relabeled.
                if failed_servers:
                    self._failed_servers = failed_servers
                    self._failed_servers_transient = [
                        s for s in failed_servers if failed_status.get(s) == "transient"
                    ]
                    self._failed_servers_permanent = [
                        s for s in failed_servers if failed_status.get(s) != "transient"
                    ]
                    # Combine error messages for display (all + per-class)
                    error_parts = [f"{s}: {failed_errors.get(s, 'Unknown error')}" for s in failed_servers]
                    self._failed_servers_error = "; ".join(error_parts)
                    self._failed_servers_permanent_error = "; ".join(
                        f"{s}: {failed_errors.get(s, 'Unknown error')}"
                        for s in self._failed_servers_permanent
                    )

                # 1b. Filter MCP tools by allowlist
                tools, missing = filter_tools_by_allowed(all_tools, self.config.allowed_tools)

                # 1c. Pin RAG search-style tools to the agent's configured datasources.
                #     The server independently intersects with the caller's RBAC-accessible
                #     datasources, so this only narrows — it never grants access on its own.
                datasource_provider = self._rag_datasource_provider(self.config)
                static_datasource_ids = self.config.datasource_ids
                if static_datasource_ids is None and self.config.rag_collection_ids is not None:
                    static_datasource_ids = []
                if static_datasource_ids is not None or datasource_provider is not None:
                    tools = pin_datasource_filters(
                        tools,
                        static_datasource_ids,
                        agent_name=self.config.name,
                        datasource_ids_provider=datasource_provider,
                    )

                # Only report missing tools for servers that connected successfully
                # (tools from failed servers are expected to be missing)
                if missing:
                    # Filter out tools from failed servers
                    missing_from_connected = [
                        t for t in missing if not any(t.startswith(f"{s}_") for s in failed_servers)
                    ]
                    if missing_from_connected:
                        logger.warning(f"Agent '{self.config.name}': tools not found: {missing_from_connected}")
                        self._missing_tools = missing_from_connected

                connected_count = len(connections) - len(failed_servers)
                logger.info(
                    f"Agent '{self.config.name}': loaded {len(tools)} tools from {connected_count}/{len(connections)} MCP servers"
                )

        # 2. Add built-in tools
        client_ctx = self._client_context.model_dump() if self._client_context else None
        builtin_tools = self._build_builtin_tools(self._user, client_context=client_ctx)
        builtin_tool_names = {t.name for t in builtin_tools}
        if builtin_tools:
            tools = tools + builtin_tools

        # 3. Wrap all tools with error handling
        #    Exceptions become LLM-visible "ERROR: ..." strings instead of crashing the agent loop.
        if tools:
            tools = wrap_tools_with_error_handling(tools, agent_name=self.config.name)

        # ─────────────────────────────────────────────────────────────────
        # Prompt & LLM
        # ─────────────────────────────────────────────────────────────────

        # 4. Render system prompt with templating
        try:
            system_prompt = _render_system_prompt(self.config.system_prompt, self._client_context, self._user)
        except SystemPromptRenderError as exc:
            logger.error(f"Agent '{self.config.name}' failed to initialize: {exc}")
            raise RuntimeError(f"Agent '{self.config.name}' failed to initialize: {exc}") from exc

        # 5. Instantiate LLM
        logger.info(
            f"[llm] Instantiating LLM for agent '{self.config.name}': "
            f"provider={self.config.model.provider}, model={self.config.model.id}"
        )
        llm = get_llm(self.config.model.provider, self.config.model.id)
        logger.info(f"[llm] LLM instantiated for agent '{self.config.name}': type={type(llm).__name__}")

        # ─────────────────────────────────────────────────────────────────
        # Extensions
        # ─────────────────────────────────────────────────────────────────

        # 6. Subagents
        subagents = await self._resolve_subagents(self.config.subagents)
        if subagents:
            logger.info(
                f"Agent '{self.config.name}': resolved {len(subagents)} subagents: {[s['name'] for s in subagents]}"
            )

        # 7. Skills
        self._skills_files: dict[str, Any] = {}
        skills_middleware = None

        # Always clear stale skill files from the shared filesystem when using
        # StoreBackend.  This is critical for workflows where multiple agents
        # share the same fs_namespace — without this, Agent B would inherit
        # Agent A's skill files if Agent B has no skills of its own (because
        # the seeding block below is skipped when self.config.skills is empty).
        if self._resolve_backend_type() == BACKEND_STORE and self._store:
            if hasattr(self._store, "delete_by_key_prefix"):
                fs_ns = self._resolve_fs_namespace()
                self._store.delete_by_key_prefix(fs_ns, "/skills/")

        if self.config.skills:
            try:
                skills_data = load_skills(
                    self.config.skills,
                    mongodb_uri=self.settings.mongodb_uri,
                    mongodb_database=self.settings.mongodb_database,
                )

                self._failed_skills, self._failed_skills_error = detect_missing_skills(self.config.skills, skills_data)

                if skills_data:
                    self._skills_files, skills_sources = build_skills_files(skills_data)
                    if skills_sources:
                        # Backend for SkillsMiddleware: use StoreBackend (GridFS) when
                        # enabled so skills are read from the same store as read_file;
                        # otherwise fall back to StateBackend (reads from state["files"]).
                        if self._resolve_backend_type() == BACKEND_STORE:
                            fs_ns = self._resolve_fs_namespace()

                            skills_backend = StoreBackend(
                                store=self._store,
                                namespace=lambda runtime: fs_ns,
                            )

                            # Seed skill files into GridFS so SkillsMiddleware and
                            # read_file can find them via StoreBackend.
                            # Note: stale skills were already cleared above.
                            if self._store:
                                namespace = fs_ns
                                for path, file_data in self._skills_files.items():
                                    self._store.put(namespace, path, file_data)
                                logger.info(
                                    f"Agent '{self.config.name}': seeded "
                                    f"{len(self._skills_files)} skill files in GridFS"
                                )
                        else:
                            skills_backend = StateBackend()
                        skills_middleware = SkillsMiddleware(backend=skills_backend, sources=skills_sources)
                        logger.info(
                            f"Agent '{self.config.name}': loaded {len(skills_data)} skills "
                            f"({len(self._skills_files)} files, {len(skills_sources)} sources)"
                        )
            except Exception as e:
                logger.warning(f"Agent '{self.config.name}': failed to load skills: {e}", exc_info=True)
                self._failed_skills = list(self.config.skills)
                self._failed_skills_error = f"Skills loading failed: {e}"

        # 8. Workflows — validate configured workflow IDs against MongoDB
        if self.config.builtin_tools and self.config.builtin_tools.workflows:
            try:
                mongo_client = self._mongo_client or MongoClient(self.settings.mongodb_uri, tz_aware=True)
                db = mongo_client[self.settings.mongodb_database]
                wf_col = db["workflow_configs"]
                requested_ids = list(self.config.builtin_tools.workflows)
                found_docs = list(
                    wf_col.find({"_id": {"$in": requested_ids}}, {"_id": 1, "name": 1, "description": 1, "steps": 1})
                )
                found_ids = {doc["_id"] for doc in found_docs}
                missing = [wid for wid in requested_ids if wid not in found_ids]
                if missing:
                    self._failed_workflows = missing
                    self._failed_workflows_error = f"Workflow config IDs not found in database: {', '.join(missing)}"
                    logger.warning(f"Agent '{self.config.name}': {self._failed_workflows_error}")
                self._valid_workflow_configs = [wid for wid in requested_ids if wid in found_ids]
                workflow_labels = {
                    str(doc["_id"]): str(doc.get("name") or doc["_id"]) for doc in found_docs
                }
                self._workflow_labels = workflow_labels
                # Build system prompt addendum with workflow details
                if found_docs:
                    lines = ["\n\n## Available Workflows\n"]
                    lines.append("You have access to workflow tools. The following workflows are available:\n")
                    for doc in found_docs:
                        name = doc.get("name", doc["_id"])
                        desc = doc.get("description", "No description")
                        steps = doc.get("steps", [])
                        step_summary = ", ".join(
                            f"{i + 1}. {s.get('agent_name', 'unknown agent')}" for i, s in enumerate(steps)
                        )
                        lines.append(f"- **{name}** (`{doc['_id']}`): {desc}")
                        if step_summary:
                            lines.append(f"  Steps: {step_summary}")
                    lines.append(
                        "\nWorkflow rules:\n"
                        "- When the user names a workflow, match it to the list above by **exact name** "
                        "(case-insensitive) and pass that entry's `workflow_config_id` to `start_workflow_run`.\n"
                        "- After starting a run, remember the returned `run_id` for this conversation.\n"
                        "- When the user asks for status, progress, summary, or output, **always** call "
                        "`get_workflow_run_status` again (even if you checked earlier in this thread). Use "
                        "`wait_for_completion=true` (up to 120s) and summarize the fresh result in plain language. "
                        "Include `final_output_summary` and per-step `output` when present. Share "
                        "`run_url` when present so the user can open the run in Grid. Never claim outputs "
                        "are unavailable without a fresh tool result. Never describe API limitations — call the tool. "
                        "Never tell the user to call tools themselves.\n"
                        "- Do not report a workflow as completed until `status` is `completed`, `failed`, or "
                        "`cancelled` in the status tool result.\n"
                        "- Report the `workflow_name` from tool results, not a different workflow."
                    )
                    self._workflow_prompt_addendum = "\n".join(lines)
            except Exception as e:
                logger.warning(f"Agent '{self.config.name}': failed to validate workflow configs: {e}", exc_info=True)
                self._failed_workflows = list(self.config.builtin_tools.workflows)
                self._failed_workflows_error = f"Workflow validation failed: {e}"

        # 8b. Add workflow tools (must be after validation populates _valid_workflow_configs)
        if self._valid_workflow_configs:
            client = WorkflowApiClient(
                base_url=self.settings.caipe_api_url,
                token_url=self.settings.oauth2_token_url,
                client_id=self.settings.oauth2_client_id,
                client_secret=self.settings.oauth2_client_secret,
                scope=self.settings.oauth2_scope,
                audience=self.settings.oauth2_audience,
                user_bearer=self._auth_bearer,
            )
            wf_tools = create_workflow_tools(
                client,
                self._valid_workflow_configs,
                trigger_context={
                    "agent_name": self.config.name,
                    "agent_id": self.config.id,
                    "conv_id": self._session_id,
                    "user_context": self._user.model_dump(exclude={"raw_claims"}) if self._user else None,
                    "client_context": self._client_context.model_dump() if self._client_context else None,
                },
                workflow_labels=getattr(self, "_workflow_labels", None),
            )
            tools.extend(wf_tools)
            logger.info(
                f"Agent '{self.config.name}': added {len(wf_tools)} workflow tools "
                f"for workflows: {self._valid_workflow_configs}"
            )

        # 9. Build middleware stack
        middleware_stack = build_middleware(
            self.config.features,
            self._session_id,
            agent_name=self.config.name,
            model_id=self.config.model.id,
            model_provider=self.config.model.provider,
            attachment_store=self._get_attachment_store(),
            enable_prompt_cache=self._prompt_cache_enabled(),
        )
        # Prepend skills middleware so it runs before other middleware
        if skills_middleware:
            middleware_stack = [skills_middleware] + middleware_stack

        # 10. Interrupt config
        interrupt_config = self._build_interrupt_config(tools, builtin_tool_names)

        # 10b. Append workflow details to system prompt (after section 8 validates workflows)
        if self._workflow_prompt_addendum:
            system_prompt += self._workflow_prompt_addendum

        # 10c. Append warnings about failed resources so the agent is aware of limitations
        warning_lines: list[str] = []
        warning_lines.extend(
            _build_mcp_warning_lines(
                self._failed_servers_permanent,
                self._failed_servers_permanent_error,
                self._failed_servers_transient,
            )
        )
        if self._failed_skills:
            warning_lines.append(f"**Skills that failed to load:** {', '.join(self._failed_skills)}")
            warning_lines.append(f"  Reason: {self._failed_skills_error}")
        if self._failed_workflows:
            warning_lines.append(f"**Workflows that failed to load:** {', '.join(self._failed_workflows)}")
            warning_lines.append(f"  Reason: {self._failed_workflows_error}")
        if warning_lines:
            system_prompt += "\n\n## Warning: Unavailable Resources\n"
            system_prompt += (
                "The following resources were configured but failed to load. Do not attempt to use them.\n\n"
            )
            system_prompt += "\n".join(warning_lines)

        # 11. Create agent graph
        # Sanitize agent name for use as OpenAI message `name` field.
        # deepagents middleware (subagents.py) propagates this into message
        # name fields, which OpenAI validates against ^[^\s<|\\/>]+$.
        safe_name = _sanitize_agent_name(self.config.name)

        # Namespace factory for StoreBackend — scopes files to this agent+conversation
        fs_ns = self._resolve_fs_namespace()

        # Backend selection: GridFS-backed StoreBackend or in-checkpoint StateBackend
        backend_type = self._resolve_backend_type()
        logger.info(f"resolved backend_type={backend_type}")
        if backend_type == BACKEND_STORE:
            backend = StoreBackend(
                store=self._store,
                namespace=lambda runtime: fs_ns,
            )
        else:
            backend = None  # defaults to StateBackend

        deep_agent_subagents = _with_general_purpose_tool_result_recovery(
            subagents,
            model=llm,
            tools=tools,
            interrupt_on=interrupt_config,
        )

        self._graph = create_deep_agent(
            model=llm,
            tools=tools,
            system_prompt=system_prompt,
            context_schema=AgentContext,
            checkpointer=self._checkpointer,
            store=self._store,
            backend=backend,
            name=safe_name,
            subagents=deep_agent_subagents,
            interrupt_on=interrupt_config,
            middleware=middleware_stack,
        )

        self._initialized = True
        init_duration = time.monotonic() - t_start
        prom_metrics.runtime_init_duration_seconds.labels(agent_name=self.config.name).observe(init_duration)
        prom_metrics.runtime_init_duration_summary.labels(agent_name=self.config.name).observe(init_duration)
        logger.info(
            f"[agent] Agent '{self.config.name}' initialized in {init_duration:.2f}s: "
            f"tools={len(tools)}, subagents={len(subagents) if subagents else 0}"
        )

    def _build_builtin_tools(
        self,
        user: UserContext | None = None,
        agent_config: DynamicAgentConfig | None = None,
        client_context: dict | None = None,
    ) -> list:
        """Build list of built-in tools based on agent config.

        Args:
            user: User context for tools that need user info
            agent_config: Agent config to use. Defaults to self.config (parent agent).
                          Pass subagent config to build tools for a subagent.
            client_context: Optional client context dict for the user_info tool.

        Returns:
            List of LangChain tools to add to the agent.
        """
        config = agent_config or self.config
        tools = []
        config_summary: dict[str, Any] = {}

        if not config.builtin_tools:
            return tools

        # fetch_url tool (disabled by default)
        fetch_url_config = config.builtin_tools.fetch_url
        if fetch_url_config and fetch_url_config.enabled:
            allowed_domains = fetch_url_config.allowed_domains or "*"
            tools.append(create_fetch_url_tool(allowed_domains=allowed_domains))
            config_summary["fetch_url"] = {"allowed_domains": allowed_domains}

        # curl tool (disabled by default) — supports PUT/POST/PATCH/DELETE
        curl_config = config.builtin_tools.curl
        if curl_config and curl_config.enabled:
            allowed_domains = curl_config.allowed_domains or "*"
            https_only = curl_config.https_only if curl_config.https_only is not None else True
            allow_non_public_urls = curl_config.allow_non_public_urls if curl_config.allow_non_public_urls is not None else False
            tools.append(create_curl_tool(allowed_domains=allowed_domains, https_only=https_only, allow_non_public_urls=allow_non_public_urls))
            config_summary["curl"] = {"allowed_domains": allowed_domains, "https_only": https_only, "allow_non_public_urls": allow_non_public_urls}

        # current_datetime tool (enabled by default)
        current_datetime_config = config.builtin_tools.current_datetime
        if current_datetime_config and current_datetime_config.enabled:
            tools.append(create_current_datetime_tool())
            config_summary["current_datetime"] = {}

        # user_info tool (enabled by default)
        user_info_config = config.builtin_tools.user_info
        if user_info_config and user_info_config.enabled:
            if user:
                tools.append(create_user_info_tool(user, client_context=client_context))
                config_summary["user_info"] = {"user": user.email}
            else:
                logger.warning(f"Agent '{config.name}': user_info enabled but no user context available")

        # wait tool (enabled by default)
        wait_config = config.builtin_tools.wait
        if wait_config and wait_config.enabled:
            max_seconds = wait_config.max_seconds or 300
            tools.append(create_wait_tool(max_seconds=max_seconds))
            config_summary["wait"] = {"max_seconds": max_seconds}

        # request_user_input tool (enabled by default)
        request_user_input_config = config.builtin_tools.request_user_input
        if request_user_input_config and request_user_input_config.enabled:
            tools.append(create_request_user_input_tool())
            config_summary["request_user_input"] = {}

        # self_identity tool (enabled by default)
        self_identity_config = config.builtin_tools.self_identity
        if self_identity_config and self_identity_config.enabled:
            gradient_theme = config.ui.gradient_theme if config.ui else None
            tools.append(
                create_self_identity_tool(
                    agent_id=config.id,
                    name=config.name,
                    description=config.description,
                    model_id=config.model.id,
                    model_provider=config.model.provider,
                    gradient_theme=gradient_theme,
                )
            )
            config_summary["self_identity"] = {}

        # format_file tool — always available when using GridFS backend
        if self._resolve_backend_type() == BACKEND_STORE and self._store:
            fs_ns = self._resolve_fs_namespace()
            tools.append(
                create_format_file_tool(
                    store=self._store,
                    namespace_factory=lambda: fs_ns,
                )
            )
            config_summary["format_file"] = {}

        if tools:
            logger.info(f"Agent '{config.name}': added built-in tools: {config_summary}")

        return tools

    def _build_interrupt_config(
        self,
        tools: list,
        builtin_tool_names: set[str],
        agent_config: DynamicAgentConfig | None = None,
    ) -> dict[str, Any]:
        """Build flattened interrupt_on config for deepagents.

        Converts the namespaced storage format (server_id -> {tool: config})
        into the flat format deepagents expects ({namespaced_tool: config}).

        Supports "*" wildcard to gate all tools in a namespace.
        "builtin" is the reserved namespace for non-MCP tools (no prefix).

        Args:
            tools: Tools available to the agent whose interrupt config is built.
            builtin_tool_names: Names of built-in tools in ``tools``.
            agent_config: Agent config that owns the tools. Defaults to the
                parent runtime config; subagents must pass their own config.
        """
        config = agent_config or self.config
        interrupt_config: dict[str, Any] = {}
        for server_id, tools_map in (config.interrupt_on or {}).items():
            for tool_name, cfg in tools_map.items():
                resolved_cfg = cfg.model_dump() if isinstance(cfg, InterruptConfig) else cfg
                if tool_name == "*":
                    if server_id == "builtin":
                        for t in tools:
                            if t.name in builtin_tool_names:
                                interrupt_config[t.name] = resolved_cfg
                    else:
                        prefix = f"{server_id}_"
                        for t in tools:
                            if t.name not in builtin_tool_names and t.name.startswith(prefix):
                                interrupt_config[t.name] = resolved_cfg
                else:
                    full_name = tool_name if server_id == "builtin" else f"{server_id}_{tool_name}"
                    interrupt_config[full_name] = resolved_cfg
        return interrupt_config

    async def _resolve_subagents(
        self,
        refs: list[SubAgentRef],
        visited: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Resolve SubAgentRef list into deepagents SubAgent dicts.

        Loads each referenced dynamic agent from MongoDB and converts it to
        the SubAgent dict format expected by create_deep_agent().

        Args:
            refs: List of subagent references from parent agent config
            visited: Set of agent IDs already in the call chain (for cycle detection)

        Returns:
            List of SubAgent dicts with name, description, prompt, tools
        """
        if not refs:
            return []

        if not self._mongo_service:
            logger.warning(f"Agent '{self.config.name}': Cannot resolve subagents - no MongoDB service available")
            return []

        # Initialize visited set for cycle detection
        if visited is None:
            visited = set()
        visited.add(self.config.id)

        subagents: list[dict[str, Any]] = []

        for ref in refs:
            # Cycle detection: skip if this agent is already in the call chain
            if ref.agent_id in visited:
                logger.warning(
                    f"Agent '{self.config.name}': Skipping subagent '{ref.name}' (agent_id={ref.agent_id}) "
                    f"- circular reference detected"
                )
                continue

            # Load subagent config from MongoDB
            subagent_config = self._mongo_service.get_agent(ref.agent_id)
            if not subagent_config:
                logger.warning(f"Agent '{self.config.name}': Subagent '{ref.name}' not found (agent_id={ref.agent_id})")
                continue

            if not subagent_config.enabled:
                logger.warning(f"Agent '{self.config.name}': Subagent '{ref.name}' is disabled, skipping")
                continue

            # Build MCP tools for subagent
            subagent_tools, builtin_tool_names = await self._build_subagent_tools(subagent_config)
            interrupt_config = self._build_interrupt_config(
                subagent_tools,
                builtin_tool_names,
                agent_config=subagent_config,
            )

            # System prompt from subagent config
            subagent_prompt = subagent_config.system_prompt

            # Instantiate subagent LLM (uses its own configured model)
            subagent_llm = get_llm(subagent_config.model.provider, subagent_config.model.id)

            # Create SubAgent dict in deepagents format
            # Use agent_id as the name - this ensures namespace[0] from LangGraph
            # matches the MongoDB agent_id exactly
            subagent_dict: dict[str, Any] = {
                "name": ref.agent_id,
                "description": ref.description,
                "system_prompt": subagent_prompt,
                "tools": subagent_tools,
                "model": subagent_llm,
                "interrupt_on": interrupt_config,
                "middleware": build_middleware(
                    subagent_config.features,
                    self._session_id,
                    agent_name=subagent_config.name,
                    model_id=subagent_config.model.id,
                    model_provider=subagent_config.model.provider,
                    attachment_store=self._get_attachment_store(),
                    enable_prompt_cache=self._prompt_cache_enabled(),
                ),
            }

            # Note: Nested subagents (subagent of subagent) are not supported in this MVP.
            # If needed in the future, we could recursively resolve subagent_config.subagents
            # by passing the updated visited set.

            subagents.append(subagent_dict)
            logger.info(
                f"Agent '{self.config.name}': Resolved subagent '{ref.name}' with {len(subagent_tools)} tools, "
                f"model={subagent_config.model.provider}/{subagent_config.model.id}"
            )

        return subagents

    async def _build_subagent_tools(
        self,
        subagent_config: DynamicAgentConfig,
    ) -> tuple[list, set[str]]:
        """Build tools for a subagent (MCP tools + built-in tools).

        Args:
            subagent_config: The subagent's configuration

        Returns:
            Tuple containing the LangChain tools and the names of built-in tools.
        """
        tools: list = []

        # 1. Build MCP tools from subagent's allowed_tools config
        #    Inherit parent's AG routing and auth (FR-038f)
        server_ids = list(subagent_config.allowed_tools.keys())
        if server_ids:
            connections = build_mcp_connections(
                self.mcp_servers,
                server_ids,
                agent_gateway_url=self.settings.agent_gateway_url,
                auth_bearer=self._auth_bearer,
                agent_id=subagent_config.id,
            )
            cred_result = await resolve_mcp_connections_credential_refs(
                self.mcp_servers,
                connections,
                credential_client=self._credential_exchange_client(),
                caller_token=self._auth_bearer,
            )
            connections = cred_result.connections
            if cred_result.failures:
                for server_id, exc in cred_result.failures.items():
                    logger.warning(
                        "Subagent '%s': MCP server '%s' credential unavailable (%s)",
                        subagent_config.name,
                        server_id,
                        exc.reason,
                    )
            if connections:
                # Use resilient connection so one failing server doesn't break the subagent
                all_tools, failed, failed_errors, failed_status = await get_tools_with_resilience(
                    connections
                )
                if failed:
                    error_parts = [
                        f"{s}: {failed_errors.get(s, 'Unknown error')} [{failed_status.get(s, 'unknown')}]"
                        for s in failed
                    ]
                    logger.warning(f"Subagent '{subagent_config.name}': failed MCP servers: {'; '.join(error_parts)}")
                mcp_tools, _ = filter_tools_by_allowed(all_tools, subagent_config.allowed_tools)
                datasource_provider = self._rag_datasource_provider(subagent_config)
                static_datasource_ids = subagent_config.datasource_ids
                if static_datasource_ids is None and subagent_config.rag_collection_ids is not None:
                    static_datasource_ids = []
                if static_datasource_ids is not None or datasource_provider is not None:
                    mcp_tools = pin_datasource_filters(
                        mcp_tools,
                        static_datasource_ids,
                        agent_name=subagent_config.name,
                        datasource_ids_provider=datasource_provider,
                    )
                tools.extend(mcp_tools)

        # 2. Add built-in tools based on subagent's config
        client_ctx = self._client_context.model_dump() if self._client_context else None
        builtin_tools = self._build_builtin_tools(self._user, subagent_config, client_context=client_ctx)
        builtin_tool_names = {tool.name for tool in builtin_tools}
        if builtin_tools:
            tools.extend(builtin_tools)

        # 3. Wrap all subagent tools with error handling
        if tools:
            tools = wrap_tools_with_error_handling(tools, agent_name=subagent_config.name)

        return tools, builtin_tool_names

    async def cleanup(self) -> None:
        """Cleanup all resources held by this runtime.

        Releases MCP client, checkpointer, graph, and MongoClient (if owned).
        After cleanup, this runtime instance should not be reused.
        """
        # 1. Checkpointer — do NOT call .close() as it closes the underlying
        #    MongoClient (which may be shared). Just release the reference.
        self._checkpointer = None

        # 2. MongoClient — only close if we created it ourselves
        if self._owns_mongo_client and self._mongo_client:
            self._mongo_client.close()
            logger.info("Closed owned MongoClient for agent '%s'", self.config.name)
        self._mongo_client = None

        # 3. Graph — release compiled LangGraph to free tool references
        self._graph = None

        self._initialized = False
        self._active_stream_count = 0
        self._is_streaming = False

    def cancel(self) -> bool:
        """Request cancellation of the active stream.

        This sets a flag that will be checked between LangGraph chunks,
        causing the stream to exit gracefully at the next opportunity.

        Returns:
            True if cancellation was requested, False if already cancelled.
        """
        if not self._cancelled:
            self._cancelled = True
            logger.info(f"[cancel] Cancellation requested for agent '{self.config.name}'")
            return True
        return False

    @property
    def idle_seconds(self) -> float:
        """Get seconds since the last interaction with this runtime."""
        return time.time() - self._last_interaction

    def touch(self) -> None:
        """Reset the inactivity timer."""
        self._last_interaction = time.time()

    @property
    def age_seconds(self) -> float:
        """Get the age of this runtime in seconds."""
        return time.time() - self._created_at

    def is_stale(
        self,
        agent_config: DynamicAgentConfig,
        mcp_servers: list[MCPServerConfig],
    ) -> bool:
        """Check if cached runtime is stale due to config changes.

        Returns True if either the agent config or any MCP server has been
        updated since this runtime was created.
        """
        if agent_config.updated_at != self._config_updated_at:
            return True
        current_mcp_max = max((s.updated_at for s in mcp_servers), default=datetime.min.replace(tzinfo=timezone.utc))
        if current_mcp_max != self._mcp_servers_updated_at:
            return True
        return False

    # ─────────────────────────────────────────────────────────────────────
    # Streaming / Resume / Interrupt
    # ─────────────────────────────────────────────────────────────────────

    def _build_stream_config(self, session_id: str, user_id: str, trace_id: str | None) -> dict[str, Any]:
        """Build config dict for stream/resume operations.

        Creates the LangGraph config with:
        - thread_id for conversation persistence (checkpointer)
        - AgentContext for tools that need user/session info
        - metadata for Langfuse tracing
        """
        config = self.tracing.create_config(session_id)

        if "configurable" not in config:
            config["configurable"] = {}
        config["configurable"]["thread_id"] = session_id

        config["context"] = AgentContext(
            user_id=user_id,
            agent_config_id=self.config.id,
            session_id=session_id,
        )

        if "metadata" not in config:
            config["metadata"] = {}
        config["metadata"]["user_id"] = user_id
        config["metadata"]["agent_config_id"] = self.config.id
        config["metadata"]["agent_name"] = self.config.name

        # Derive Langfuse session_id: group workflow steps by run_id, normal chats by conversation_id
        workflow_match = re.match(r"^(workflow-.+)-step-\d+$", session_id)
        langfuse_session_id = workflow_match.group(1) if workflow_match else session_id
        config["metadata"]["langfuse_session_id"] = langfuse_session_id

        if trace_id:
            config["metadata"]["trace_id"] = trace_id
        else:
            current_trace_id = self.tracing.get_trace_id()
            if current_trace_id:
                config["metadata"]["trace_id"] = current_trace_id

        self._current_trace_id = config.get("metadata", {}).get("trace_id")

        return config

    async def stream(
        self,
        message: str,
        session_id: str,
        user_id: str,
        trace_id: str | None = None,
        encoder: "StreamEncoder | None" = None,
        files: list[InputFile] | None = None,
    ) -> AsyncGenerator[str, None]:
        """Stream agent response for a user message.

        When ``files`` are provided, the user turn is sent as a multimodal
        content list (text block + one block per supported file — image or
        document) instead of a plain string, so the model receives the file
        bytes.

        Yields SSE frame strings produced by the encoder.
        """
        observation = _TurnObservation(started_at=time.monotonic(), turn_type="stream")
        implementation = self._stream_impl(
            message,
            session_id,
            user_id,
            trace_id,
            encoder,
            observation,
            files,
        )
        async for frame in self._observe_turn(implementation, observation):
            yield frame

    async def _observe_turn(
        self,
        implementation: AsyncGenerator[str, None],
        observation: _TurnObservation,
    ) -> AsyncGenerator[str, None]:
        """Record one terminal outcome and saturation state for a turn."""
        self._active_stream_count += 1
        self._is_streaming = True
        prom_metrics.active_streams.inc()
        try:
            async for frame in implementation:
                yield frame
        except (asyncio.CancelledError, GeneratorExit):
            observation.status = "cancelled"
            raise
        except Exception:
            observation.status = "error"
            raise
        finally:
            self._active_stream_count = max(0, self._active_stream_count - 1)
            self._is_streaming = self._active_stream_count > 0
            prom_metrics.active_streams.dec()
            self._record_turn(
                observation.started_at,
                observation.turn_type,
                observation.status,
            )

    def _record_first_response(
        self,
        encoder: "StreamEncoder",
        content_length_before: int,
        observation: _TurnObservation,
    ) -> None:
        """Observe latency when an encoder first accumulates visible text."""
        if observation.first_response_recorded:
            return
        content_length_after = len(encoder.get_thinking_content()) + len(encoder.get_accumulated_content())
        if content_length_after <= content_length_before:
            return
        observation.first_response_recorded = True
        prom_metrics.turn_time_to_first_response_seconds.labels(
            agent_name=self.config.name,
            model_id=self.config.model.id,
            turn_type=observation.turn_type,
        ).observe(time.monotonic() - observation.started_at)

    async def _stream_impl(
        self,
        message: str,
        session_id: str,
        user_id: str,
        trace_id: str | None,
        encoder: "StreamEncoder | None",
        observation: _TurnObservation,
        files: list[InputFile] | None = None,
    ) -> AsyncGenerator[str, None]:
        if not self._initialized:
            await self.initialize()

        assert encoder is not None, "encoder must be provided"

        self._cancelled = False

        config = self._build_stream_config(session_id, user_id, trace_id)
        run_id = f"run-{uuid4().hex[:12]}"

        logger.info(
            f"[stream] Starting stream for agent '{self.config.name}': "
            f"agent_id={self.config.id}, user={user_id}, "
            f"user_context={self._user}, client_context={self._client_context}"
        )

        # ── Core lifecycle: run start ──
        for frame in encoder.on_run_start(run_id, session_id):
            yield frame

        # ── Core lifecycle: warnings ──
        # Caller-scoped provider connect warnings first (structured, actionable copy).
        for warning_message in self._mcp_credential_warnings:
            for frame in encoder.on_warning(warning_message):
                yield frame

        # Permanent failures keep the actionable "will not work" wording; transient
        # (still-warming) servers read as "starting up" and are retried — never the
        # permanent wording. Genuine denials surface through the permanent path's
        # diagnostic error string rather than being relabeled as "starting up".
        permanent_for_generic = [
            server_id
            for server_id in self._failed_servers_permanent
            if server_id not in self._mcp_credential_failed_server_ids
        ]
        for warning_message in _mcp_warning_events(
            permanent_for_generic, self._failed_servers_transient
        ):
            for frame in encoder.on_warning(warning_message):
                yield frame

        if self._failed_skills:
            for frame in encoder.on_warning(
                f"{len(self._failed_skills)} skill(s) failed to load and will not be available. "
                f"{self._failed_skills_error}",
            ):
                yield frame

        if self._failed_workflows:
            for frame in encoder.on_warning(
                f"{len(self._failed_workflows)} workflow(s) not found: {', '.join(self._failed_workflows)}. "
                f"{self._failed_workflows_error}",
            ):
                yield frame

        # ── Core lifecycle: chunks ──
        # Build the user turn: plain string normally, or a multimodal content
        # list (text + image blocks) when files are attached. Files the model
        # can't accept (unsupported type, a modality this model declares it
        # doesn't take, or one that breaches an input guardrail) are dropped.
        # The drop is surfaced twice, on purpose:
        #   1. to the *user* as an on_warning frame (visible degradation), and
        #   2. to the *model* as a system-note appended to the turn — because
        #      some channels (Slack) suppress the user warning to avoid noise,
        #      which would otherwise leave the model answering blind (silent
        #      failure). See _skipped_files_notice.
        model_id = self.config.model.id
        max_file_bytes = self.settings.max_input_file_bytes
        max_turn_bytes = self.settings.max_input_turn_bytes
        user_content, skipped_files = _build_user_content(
            message,
            files,
            get_model_capabilities(model_id),
            model_id=model_id,
            max_files=self.settings.max_input_files,
            max_file_bytes=max_file_bytes,
            max_turn_bytes=max_turn_bytes,
            store=self._get_attachment_store(),
        )
        for skip in skipped_files:
            prom_metrics.dropped_input_files_total.labels(
                agent_name=self.config.name,
                model_id=model_id,
                reason=skip.reason,
            ).inc()
            for frame in encoder.on_warning(
                _skipped_file_warning(skip, model_id, max_file_bytes, max_turn_bytes)
            ):
                yield frame
        if skipped_files:
            # Tell the model (channel-agnostic) so it can degrade gracefully.
            notice = _skipped_files_notice(
                skipped_files, model_id, max_file_bytes, max_turn_bytes
            )
            if isinstance(user_content, list):
                user_content[0]["text"] = f"{user_content[0]['text']}\n\n{notice}".strip()
            else:
                user_content = f"{user_content}\n\n{notice}".strip()
        state_input: dict[str, Any] = {"messages": [{"role": "user", "content": user_content}]}
        # Inject skills files into state for StateBackend (non-GridFS mode).
        # In GridFS mode, skills are pre-populated in the store at init time.
        if getattr(self, "_skills_files", None) and self._resolve_backend_type() != BACKEND_STORE:
            state_input["files"] = dict(self._skills_files)
        async for chunk in self._graph.astream(
            state_input,
            config=config,
            stream_mode=["messages", "updates", "tasks"],
            subgraphs=True,
        ):
            if self._cancelled:
                logger.info(f"[stream] Stream cancelled by user for agent '{self.config.name}': user={user_id}")
                observation.status = "cancelled"
                return

            content_length_before = len(encoder.get_thinking_content()) + len(encoder.get_accumulated_content())
            frames = encoder.on_chunk(chunk)
            self._record_first_response(encoder, content_length_before, observation)
            for frame in frames:
                yield frame

        # ── Core lifecycle: stream end (flush) ──
        for frame in encoder.on_stream_end():
            yield frame

        # ── HITL interrupt check ──
        logger.debug("[stream] Stream loop completed, checking for pending interrupt...")
        interrupt_data = await self.has_pending_interrupt(session_id)
        logger.debug(f"[stream] has_pending_interrupt result: {interrupt_data}")
        if interrupt_data:
            logger.debug(f"[stream] Agent '{self.config.name}' has pending interrupt, emitting interrupt event")
            observation.status = "interrupted"
            for frame in self._emit_interrupt(encoder, interrupt_data):
                yield frame
            return

        # ── Core lifecycle: run finish ──
        logger.info(
            f"[stream] Completed stream for agent '{self.config.name}': "
            f"content_length={len(encoder.get_accumulated_content())}"
        )
        for frame in encoder.on_run_finish(run_id, session_id):
            yield frame

    def _emit_interrupt(self, encoder: "StreamEncoder", interrupt_data: dict[str, Any]) -> list[str]:
        """Emit the appropriate SSE interrupt event based on interrupt type."""
        return encoder.on_input_required(
            interrupt_id=interrupt_data["interrupt_id"],
            interrupt_type=interrupt_data.get("type", "form_input"),
            prompt=interrupt_data.get("prompt", ""),
            fields=interrupt_data.get("fields", []),
            tool_name=interrupt_data.get("tool_name"),
            tool_args=interrupt_data.get("tool_args"),
            allowed_decisions=interrupt_data.get("allowed_decisions"),
            tool_approvals=interrupt_data.get("tool_approvals"),
            agent=self.config.name,
        )

    async def has_pending_interrupt(self, session_id: str) -> dict[str, Any] | None:
        """Check if there's a pending interrupt for the given session.

        Returns a discriminated dict with ``type`` field:
        - ``form_input``: agent called ``request_user_input`` (render form)
        - ``tool_approval``: a gated tool was intercepted (render approval card)

        Uses the HumanInTheLoopMiddleware pattern from deepagents.
        """
        if not self._graph:
            logger.warning("[has_pending_interrupt] No graph available")
            return None

        config = {"configurable": {"thread_id": session_id}}

        try:
            state = await self._graph.aget_state(config)
            logger.debug(
                f"[has_pending_interrupt] Got state: has_interrupts={hasattr(state, 'interrupts')}, "
                f"interrupts_count={len(state.interrupts) if hasattr(state, 'interrupts') and state.interrupts else 0}"
            )

            if not state or not hasattr(state, "interrupts") or not state.interrupts:
                logger.debug("[has_pending_interrupt] No interrupts in state")
                return None

            for i, interrupt in enumerate(state.interrupts):
                interrupt_value = getattr(interrupt, "value", None)
                logger.debug(f"[has_pending_interrupt] Interrupt {i}: value_type={type(interrupt_value)}")

                if not isinstance(interrupt_value, dict):
                    continue

                action_requests = interrupt_value.get("action_requests", [])

                # Check for form_input first (request_user_input is always solo)
                for action in action_requests:
                    tool_name = action.get("name", "")
                    if tool_name == "request_user_input":
                        tool_call_id = action.get("id", str(id(interrupt)))
                        args = action.get("args", {})
                        logger.info(
                            f"[has_pending_interrupt] Found request_user_input interrupt: tool_call_id={tool_call_id}"
                        )
                        return {
                            "type": "form_input",
                            "interrupt_id": tool_call_id,
                            "prompt": args.get("prompt", ""),
                            "fields": args.get("fields", []),
                            "tool_call_id": tool_call_id,
                        }

                # Collect ALL tool approval action_requests
                tool_approvals: list[dict[str, Any]] = []
                for action in action_requests:
                    tool_name = action.get("name", "")
                    tool_call_id = action.get("id", str(id(interrupt)))
                    args = action.get("args", {})
                    allowed_decisions = self._get_allowed_decisions_for_tool(tool_name)
                    tool_approvals.append(
                        {
                            "tool_name": tool_name,
                            "tool_args": args,
                            "tool_call_id": tool_call_id,
                            "allowed_decisions": allowed_decisions,
                        }
                    )

                if tool_approvals:
                    # Use first tool_call_id as the interrupt_id for backwards compat
                    logger.info(
                        f"[has_pending_interrupt] Found {len(tool_approvals)} tool approval interrupt(s): "
                        f"tools={[t['tool_name'] for t in tool_approvals]}"
                    )
                    return {
                        "type": "tool_approval",
                        "interrupt_id": tool_approvals[0]["tool_call_id"],
                        # Single-tool backwards compat fields
                        "tool_name": tool_approvals[0]["tool_name"],
                        "tool_args": tool_approvals[0]["tool_args"],
                        "allowed_decisions": tool_approvals[0]["allowed_decisions"],
                        # New: full list for multi-tool support
                        "tool_approvals": tool_approvals,
                    }

            logger.debug("[has_pending_interrupt] No actionable interrupt found")
            return None
        except Exception as e:
            logger.warning(f"Error checking for pending interrupt: {e}")
            return None

    def _get_allowed_decisions_for_tool(self, tool_name: str) -> list[str]:
        """Look up allowed_decisions from the agent's interrupt_on config for a tool."""
        from ..models import InterruptConfig

        interrupt_on = self.config.interrupt_on or {}
        # Search all namespaces for a matching tool or wildcard
        for _namespace, tools in interrupt_on.items():
            cfg = tools.get(tool_name) or tools.get("*")
            if cfg is None:
                continue
            if isinstance(cfg, bool):
                return ["approve", "edit", "reject"]
            if isinstance(cfg, dict):
                # Raw dict from config (not yet parsed as InterruptConfig)
                return cfg.get("allowed_decisions", ["approve", "edit", "reject"])
            if isinstance(cfg, InterruptConfig):
                return cfg.allowed_decisions
        # Default if not found in config
        return ["approve", "edit", "reject"]

    async def _build_resume_payload(self, session_id: str, resume_data: str) -> dict[str, Any]:
        """Build the langgraph Command(resume=...) payload from frontend resume_data.

        Handles both form_input and tool_approval interrupt types.
        """
        try:
            data = json.loads(resume_data)
        except json.JSONDecodeError:
            logger.warning(f"[resume] Invalid resume_data JSON: {resume_data[:100]}")
            return {"decisions": [{"type": "approve"}]}

        interrupt_type = data.get("type", "form_input")

        if interrupt_type == "tool_approval":
            # Support batched decisions for multi-tool interrupts
            raw_decisions = data.get("decisions")
            if raw_decisions and isinstance(raw_decisions, list):
                # New format: UI sends pre-built list of decisions
                built: list[dict[str, Any]] = []
                for d in raw_decisions:
                    dec = d.get("decision", "approve")
                    if dec == "approve":
                        built.append({"type": "approve"})
                    elif dec == "reject":
                        built.append({"type": "reject"})
                    elif dec == "edit":
                        edited_args = d.get("edited_args", {})
                        tool_name = d.get("tool_name", "unknown")
                        built.append(
                            {
                                "type": "edit",
                                "edited_action": {"name": tool_name, "args": edited_args},
                            }
                        )
                    else:
                        built.append({"type": "approve"})
                return {"decisions": built}

            # Legacy single-decision format
            decision = data.get("decision", "approve")
            if decision == "approve":
                # If there are multiple pending tools, approve all of them
                interrupt_data = await self.has_pending_interrupt(session_id)
                tool_count = len(interrupt_data.get("tool_approvals", [])) if interrupt_data else 1
                return {"decisions": [{"type": "approve"}] * tool_count}
            elif decision == "reject":
                interrupt_data = await self.has_pending_interrupt(session_id)
                tool_count = len(interrupt_data.get("tool_approvals", [])) if interrupt_data else 1
                return {"decisions": [{"type": "reject"}] * tool_count}
            elif decision == "edit":
                edited_args = data.get("edited_args", {})
                interrupt_data = await self.has_pending_interrupt(session_id)
                tool_name = interrupt_data["tool_name"] if interrupt_data else "unknown"
                return {
                    "decisions": [
                        {
                            "type": "edit",
                            "edited_action": {
                                "name": tool_name,
                                "args": edited_args,
                            },
                        }
                    ]
                }
            else:
                logger.warning(f"[resume] Unknown tool_approval decision: {decision}")
                return {"decisions": [{"type": "approve"}]}

        # form_input (default / backwards-compatible)
        if data.get("dismissed"):
            return {
                "decisions": [{"type": "reject", "message": "User dismissed the input form without providing values."}]
            }

        user_values = data.get("values", {})
        interrupt_data = await self.has_pending_interrupt(session_id)
        if interrupt_data and interrupt_data.get("type") == "form_input":
            original_fields = interrupt_data.get("fields", [])
            edited_fields = []
            for field in original_fields:
                field_copy = dict(field)
                field_name = field.get("field_name", "")
                if field_name in user_values:
                    field_copy["value"] = user_values[field_name]
                edited_fields.append(field_copy)

            return {
                "decisions": [
                    {
                        "type": "edit",
                        "edited_action": {
                            "name": "request_user_input",
                            "args": {
                                "prompt": interrupt_data.get("prompt", ""),
                                "fields": edited_fields,
                            },
                        },
                    }
                ]
            }

        logger.warning("[resume] No pending interrupt found, using simple approve")
        return {"decisions": [{"type": "approve"}]}

    async def resume(
        self,
        session_id: str,
        user_id: str,
        resume_data: str,
        trace_id: str | None = None,
        encoder: "StreamEncoder | None" = None,
    ) -> AsyncGenerator[str, None]:
        """Resume agent execution after a HITL interrupt.

        ``resume_data`` is a JSON string with a ``type`` discriminator:
        - ``{"type": "form_input", "values": {...}}`` — user filled in form fields
        - ``{"type": "form_input", "dismissed": true}`` — user dismissed form
        - ``{"type": "tool_approval", "decision": "approve"}``
        - ``{"type": "tool_approval", "decision": "reject"}``
        - ``{"type": "tool_approval", "decision": "edit", "edited_args": {...}}``
        """
        observation = _TurnObservation(started_at=time.monotonic(), turn_type="resume")
        implementation = self._resume_impl(
            session_id,
            user_id,
            resume_data,
            trace_id,
            encoder,
            observation,
        )
        async for frame in self._observe_turn(implementation, observation):
            yield frame

    async def _resume_impl(
        self,
        session_id: str,
        user_id: str,
        resume_data: str,
        trace_id: str | None,
        encoder: "StreamEncoder | None",
        observation: _TurnObservation,
    ) -> AsyncGenerator[str, None]:
        if not self._initialized:
            await self.initialize()

        assert encoder is not None, "encoder must be provided"

        self._cancelled = False

        config = self._build_stream_config(session_id, user_id, trace_id)
        run_id = f"run-{uuid4().hex[:12]}"

        logger.info(
            f"[resume] Resuming stream for agent '{self.config.name}': "
            f"agent_id={self.config.id}, user={user_id}, "
            f"user_context={self._user}, client_context={self._client_context}"
        )

        # ── Core lifecycle: run start ──
        for frame in encoder.on_run_start(run_id, session_id):
            yield frame

        # Build resume payload from discriminated resume_data
        resume_payload = await self._build_resume_payload(session_id, resume_data)

        logger.debug(f"[resume] Resume payload: {resume_payload}")

        # ── Core lifecycle: chunks ──
        async for chunk in self._graph.astream(
            Command(resume=resume_payload),
            config=config,
            stream_mode=["messages", "updates", "tasks"],
            subgraphs=True,
        ):
            if self._cancelled:
                logger.info(f"[resume] Resume stream cancelled by user for agent '{self.config.name}'")
                observation.status = "cancelled"
                return

            content_length_before = len(encoder.get_thinking_content()) + len(encoder.get_accumulated_content())
            frames = encoder.on_chunk(chunk)
            self._record_first_response(encoder, content_length_before, observation)
            for frame in frames:
                yield frame

        # ── Core lifecycle: stream end (flush) ──
        for frame in encoder.on_stream_end():
            yield frame

        # ── HITL interrupt check ──
        interrupt_data = await self.has_pending_interrupt(session_id)
        if interrupt_data:
            logger.debug(f"[resume] Agent '{self.config.name}' has pending interrupt after resume")
            observation.status = "interrupted"
            for frame in self._emit_interrupt(encoder, interrupt_data):
                yield frame
            return

        # ── Core lifecycle: run finish ──
        logger.info(
            f"[resume] Completed resume for agent '{self.config.name}': "
            f"content_length={len(encoder.get_accumulated_content())}"
        )
        for frame in encoder.on_run_finish(run_id, session_id):
            yield frame

    def _record_turn(self, start: float, turn_type: str, status: str) -> None:
        """Record turn duration to both Histogram and Summary."""
        duration = time.monotonic() - start
        labels = {
            "agent_name": self.config.name,
            "model_id": self.config.model.id,
            "turn_type": turn_type,
            "status": status,
        }
        prom_metrics.turns_total.labels(**labels).inc()
        prom_metrics.turn_duration_seconds.labels(**labels).observe(duration)
        prom_metrics.turn_duration_summary.labels(**labels).observe(duration)
        logger.info(
            "[%s] Turn completed for agent '%s': status=%s duration=%.2fs",
            turn_type,
            self.config.name,
            status,
            duration,
        )
