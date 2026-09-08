"""Configurable middleware registry and builder for dynamic agents.

Maps string type keys from agent config to langchain middleware classes.
The registry defines default parameters, whether each middleware is
enabled by default, and whether multiple instances are allowed.

``build_middleware`` processes an ordered list of ``MiddlewareEntry``
objects, validates singleton constraints, merges params over defaults,
and instantiates the middleware stack.

Special-case middleware (``pii``, ``llm_tool_selector``, ``model_fallback``,
``context_editing``) require model instantiation or non-trivial
construction and are handled with explicit builder functions.
"""

from __future__ import annotations

import base64
import logging
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from cnoe_agent_utils.llm_factory import resolve_bedrock_client
from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain.agents.middleware.context_editing import (
    ClearToolUsesEdit,
    ContextEditingMiddleware,
)
from langchain.agents.middleware.model_call_limit import ModelCallLimitMiddleware
from langchain.agents.middleware.model_fallback import ModelFallbackMiddleware
from langchain.agents.middleware.model_retry import ModelRetryMiddleware
from langchain.agents.middleware.pii import PIIMiddleware
from langchain.agents.middleware.tool_call_limit import ToolCallLimitMiddleware
from langchain.agents.middleware.tool_retry import ToolRetryMiddleware
from langchain.agents.middleware.tool_selection import LLMToolSelectorMiddleware
from langchain_aws.middleware.prompt_caching import BedrockPromptCachingMiddleware
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langgraph.errors import GraphBubbleUp

from dynamic_agents.services.llm import get_configured_llm

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

from dynamic_agents.metrics import MetricsAgentMiddleware
from dynamic_agents.models import FeaturesConfig, MiddlewareEntry

logger = logging.getLogger(__name__)


# Text-family document MIME types. These are UTF-8 text, and on the
# ``ChatAnthropicBedrock`` (Anthropic Messages API) client Bedrock rejects them
# as base64 document sources — that source only accepts ``application/pdf``
# (error: ``document.source.base64.media_type: Input should be
# 'application/pdf'``). They must be sent as a *text* document source instead
# (``source_type="text"`` with the decoded text and ``media_type="text/plain"``).
# The Converse/legacy clients, by contrast, accept these as base64 documents, so
# the text-source rewrite is gated on the resolved Anthropic client.
#
# Kept here (rather than beside ``_SUPPORTED_DOC_MIME_TYPES`` in agent_runtime)
# so both the write path (agent_runtime imports this) and the rehydration path
# (this module) share one definition without an import cycle.
TEXT_DOCUMENT_MIME_TYPES = frozenset(
    {
        "text/plain",
        "text/markdown",
        "text/csv",
        "text/html",
        "text/xml",
        "application/xml",
    }
)


def anthropic_text_document_block(
    block: dict[str, Any], decoded_text: str
) -> dict[str, Any]:
    """Rewrite a document ``block`` into a LangChain v1 ``text-plain`` block.

    langchain-core normalizes message content to v1 content blocks before the
    Anthropic adapter runs. The adapter renders a ``text-plain`` block into the
    ``{"type": "document", "source": {"type": "text", ...}}`` shape the Anthropic
    Messages API requires for text-family documents (a base64 document source is
    PDF-only there).

    Emitting the v1-native ``text-plain`` block directly is deliberate: a legacy
    ``{"type": "file", "source_type": "text"}`` block would instead be routed
    through langchain-core's v0->v1 converter, which reads the text content from
    the ``url`` key (``KeyError: 'url'`` if it's carried anywhere else) and wraps
    stray keys in ``extras``. ``text-plain`` bypasses that converter entirely.

    ``mime_type`` is forced to ``text/plain`` because Anthropic's text document
    source only accepts that media type — the original type (e.g. ``text/xml``)
    is still fully visible to the model as the text content, tags and all.
    """
    rebuilt = {
        k: v
        for k, v in block.items()
        if k not in ("base64", "source", "url", "source_type")
    }
    rebuilt["type"] = "text-plain"
    rebuilt["mime_type"] = "text/plain"
    rebuilt["text"] = decoded_text
    return rebuilt


class ToolResultInvariantMiddleware(AgentMiddleware):
    """Patch tool calls that lost their results before each model request."""

    @staticmethod
    def _tool_calls(message: AIMessage) -> list[tuple[str, str]]:
        tool_calls: list[tuple[str, str]] = []
        known_ids: set[str] = set()

        for tool_call in (*message.tool_calls, *message.invalid_tool_calls):
            tool_call_id = tool_call.get("id")
            if not isinstance(tool_call_id, str) or tool_call_id in known_ids:
                continue
            tool_name = tool_call.get("name")
            tool_calls.append((tool_call_id, tool_name if isinstance(tool_name, str) else "unknown"))
            known_ids.add(tool_call_id)

        if not isinstance(message.content, list):
            return tool_calls

        for block in message.content:
            if not isinstance(block, Mapping):
                continue

            nested_tool_use = block.get("toolUse")
            if isinstance(nested_tool_use, Mapping):
                tool_call_id = nested_tool_use.get("toolUseId")
                tool_name = nested_tool_use.get("name")
            elif block.get("type") in {"tool_call", "tool_use"}:
                tool_call_id = block.get("id")
                tool_name = block.get("name")
            else:
                continue

            if (
                isinstance(tool_call_id, str)
                and isinstance(tool_name, str)
                and tool_call_id not in known_ids
            ):
                tool_calls.append((tool_call_id, tool_name))
                known_ids.add(tool_call_id)

        return tool_calls

    @classmethod
    def _patch_messages(cls, messages: list[BaseMessage]) -> list[BaseMessage]:
        tool_results = {
            message.tool_call_id: message
            for message in messages
            if isinstance(message, ToolMessage) and message.tool_call_id
        }
        expected_tool_result_ids = {
            tool_call_id
            for message in messages
            if isinstance(message, AIMessage)
            for tool_call_id, _ in cls._tool_calls(message)
        }
        patched_messages: list[BaseMessage] = []

        for message in messages:
            if isinstance(message, ToolMessage) and message.tool_call_id in expected_tool_result_ids:
                continue

            patched_messages.append(message)
            if not isinstance(message, AIMessage):
                continue

            for tool_call_id, tool_name in cls._tool_calls(message):
                tool_result = tool_results.get(tool_call_id)
                if tool_result is not None:
                    patched_messages.append(tool_result)
                    continue

                patched_messages.append(
                    ToolMessage(
                        content=(
                            f"Tool call {tool_name} with id {tool_call_id} was "
                            "cancelled before it could be completed."
                        ),
                        name=tool_name,
                        tool_call_id=tool_call_id,
                        status="error",
                    )
                )

        return patched_messages

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        """Ensure Bedrock receives one result for every prior tool call."""
        patched_messages = self._patch_messages(list(request.messages))
        return await handler(request.override(messages=patched_messages))


class AttachmentRehydrationMiddleware(AgentMiddleware):
    """Re-inflate attachment references into inline bytes before the model call.

    The write path (``agent_runtime._build_user_content``) uploads attachment
    bytes to the blob store and persists only a reference block
    (``{"type": ..., "mime_type": ..., "source": {"store_key": "..."}}``) in the
    checkpoint — bytes never enter conversation state. This middleware runs on
    every model call (initial turn *and* every replay), fetches the bytes back
    from the store, and rewrites each reference block into the inline base64
    block shape the langchain_aws Bedrock adapter expects. It mutates only the
    *outgoing request* via ``request.override(messages=...)`` — persisted state
    is never touched (mirrors ``ToolResultInvariantMiddleware``).

    A small in-process LRU keyed by the content-addressed store key avoids
    refetching the same blob across replays within a process.

    Prompt caching is handled separately by the native langchain caching
    middlewares (see ``_build_prompt_cache_middleware``), which set
    ``model_settings["cache_control"]`` rather than injecting cache markers into
    message content — so cache markers never leak into the checkpointed state.
    """

    def __init__(
        self,
        store: Any,
        *,
        model_id: str = "unknown",
        cache_max_entries: int = 32,
    ) -> None:
        super().__init__()
        self._store = store
        self._cache_max_entries = cache_max_entries
        self._lru: "OrderedDict[str, bytes]" = OrderedDict()
        # Text-family documents must be shaped as text sources (not base64) on
        # the Anthropic Messages API client. Resolve once — the client doesn't
        # change over the agent's lifetime.
        self._is_anthropic = resolve_bedrock_client(model_id) == "anthropic"

    def _fetch(self, key: str) -> bytes:
        cached = self._lru.get(key)
        if cached is not None:
            self._lru.move_to_end(key)
            return cached
        data = self._store.get(key)
        self._lru[key] = data
        self._lru.move_to_end(key)
        while len(self._lru) > self._cache_max_entries:
            self._lru.popitem(last=False)
        return data

    def _rehydrate_block(self, block: Mapping[str, Any]) -> dict[str, Any]:
        """Turn a reference block back into an inline base64 block.

        Non-reference blocks (plain text, already-inline files) pass through
        unchanged. A fetch failure leaves the reference block as-is and logs —
        the model then sees a block it can't render rather than the whole turn
        failing.
        """
        source = block.get("source")
        if not (isinstance(source, Mapping) and source.get("store_key")):
            return dict(block)
        key = source["store_key"]
        try:
            raw = self._fetch(key)
        except Exception as exc:  # noqa: BLE001 — a bad blob shouldn't sink the turn
            logger.warning(
                "[attachment] Rehydration failed for store_key=%s: %s", key, exc
            )
            return dict(block)
        # Text-family documents on the Anthropic client must ride as a text
        # source; base64 document sources there are PDF-only. Everything else
        # (images, PDF, Office docs, and all docs on Converse/legacy) stays
        # inline base64.
        if self._is_anthropic and block.get("mime_type") in TEXT_DOCUMENT_MIME_TYPES:
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("utf-8", errors="replace")
            return anthropic_text_document_block(dict(block), text)
        rebuilt = {k: v for k, v in block.items() if k != "source"}
        rebuilt["base64"] = base64.b64encode(raw).decode("ascii")
        return rebuilt

    def _rehydrate_messages(self, messages: list[BaseMessage]) -> tuple[list[BaseMessage], bool]:
        """Return messages with reference blocks re-inflated; flag if any changed."""
        changed = False
        out: list[BaseMessage] = []
        for message in messages:
            content = getattr(message, "content", None)
            if not isinstance(content, list):
                out.append(message)
                continue
            new_content: list[Any] = []
            msg_changed = False
            for block in content:
                if isinstance(block, Mapping) and isinstance(block.get("source"), Mapping) \
                        and block["source"].get("store_key"):
                    new_content.append(self._rehydrate_block(block))
                    msg_changed = True
                else:
                    new_content.append(block)
            if msg_changed:
                changed = True
                out.append(message.model_copy(update={"content": new_content}))
            else:
                out.append(message)
        return out, changed

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        messages, changed = self._rehydrate_messages(list(request.messages))
        if not changed:
            return await handler(request)
        return await handler(request.override(messages=messages))


class InterruptAwareToolRetryMiddleware(ToolRetryMiddleware):
    """Retry ordinary tool failures without swallowing LangGraph control flow.

    Nested subagent interrupts bubble through the parent ``task`` tool as
    ``GraphBubbleUp`` exceptions. The stock retry middleware treats those as
    failures, relaunches the subagent, and eventually converts the interrupt
    into an error ``ToolMessage``. Raising from the retry predicate preserves
    LangGraph's checkpoint-and-resume behavior while retaining the configured
    retry policy for real tool exceptions.
    """

    def __init__(self, **kwargs: Any) -> None:
        retry_on = kwargs.pop("retry_on", (Exception,))

        def retry_non_control_flow(exc: Exception) -> bool:
            if isinstance(exc, GraphBubbleUp):
                raise exc
            if callable(retry_on):
                return retry_on(exc)
            return isinstance(exc, retry_on)

        super().__init__(retry_on=retry_non_control_flow, **kwargs)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MiddlewareSpec:
    """Specification for a registered middleware type."""

    cls: type
    default_params: dict[str, Any]
    enabled_by_default: bool
    allow_multiple: bool
    label: str
    description: str
    model_params: bool = False
    param_schema: dict[str, str] = field(default_factory=dict)
    # Values: "number", "boolean", "string", or "opt1|opt2|..." for selects


# Order defines the default stack order when features is None.
# model_retry and tool_retry first (retries wrap everything),
# limits next (cap runaway usage),
# then optional add-ons.
MIDDLEWARE_REGISTRY: dict[str, MiddlewareSpec] = {
    "model_retry": MiddlewareSpec(
        cls=ModelRetryMiddleware,
        default_params={"max_retries": 5, "backoff_factor": 2.0, "on_failure": "error"},
        enabled_by_default=True,
        allow_multiple=False,
        label="Model Retry",
        description="Retries failed LLM calls with exponential backoff",
        param_schema={
            "max_retries": "number",
            "backoff_factor": "number",
            "on_failure": "continue|return_message|raise|error|end",
        },
    ),
    "tool_retry": MiddlewareSpec(
        cls=InterruptAwareToolRetryMiddleware,
        default_params={"max_retries": 3, "backoff_factor": 2.0, "initial_delay": 2.0, "on_failure": "continue"},
        enabled_by_default=True,
        allow_multiple=False,
        label="Tool Retry",
        description="Retries failed tool calls with exponential backoff",
        param_schema={
            "max_retries": "number",
            "backoff_factor": "number",
            "initial_delay": "number",
            "on_failure": "continue|return_message|raise|error|end",
        },
    ),
    "model_call_limit": MiddlewareSpec(
        cls=ModelCallLimitMiddleware,
        default_params={"run_limit": 200, "exit_behavior": "end"},
        enabled_by_default=True,
        allow_multiple=False,
        label="Model Call Limit",
        description="Caps total LLM calls per run to prevent runaway loops",
        param_schema={
            "run_limit": "number",
            "exit_behavior": "end|error|continue",
        },
    ),
    "structured_response": MiddlewareSpec(
        cls=object,
        default_params={"allowed_schema_ids": "", "require_tool_submission": True},
        enabled_by_default=False,
        allow_multiple=False,
        label="Structured Response",
        description="Allows app clients to request validated structured JSON output",
        param_schema={
            "allowed_schema_ids": "string",
            "require_tool_submission": "boolean",
        },
    ),
    "tool_call_limit": MiddlewareSpec(
        cls=ToolCallLimitMiddleware,
        default_params={"run_limit": 500, "exit_behavior": "continue"},
        enabled_by_default=False,
        allow_multiple=True,
        label="Tool Call Limit",
        description="Caps total tool invocations per run",
        param_schema={
            "run_limit": "number",
            "exit_behavior": "end|error|continue",
        },
    ),
    "context_editing": MiddlewareSpec(
        cls=ContextEditingMiddleware,
        default_params={"trigger": 100_000, "keep": 3},
        enabled_by_default=True,
        allow_multiple=False,
        label="Context Editing",
        description="Clears older tool outputs when approaching token limits",
        param_schema={
            "trigger": "number",
            "keep": "number",
        },
    ),
    "pii": MiddlewareSpec(
        cls=PIIMiddleware,
        default_params={"pii_type": "email", "strategy": "redact"},
        enabled_by_default=False,
        allow_multiple=True,
        label="PII Detection",
        description="Detects and handles Personally Identifiable Information",
        param_schema={
            "pii_type": "email|credit_card|ip|mac_address|url",
            "strategy": "redact|mask|hash|block",
        },
    ),
    "llm_tool_selector": MiddlewareSpec(
        cls=LLMToolSelectorMiddleware,
        default_params={"max_tools": 10},
        enabled_by_default=False,
        allow_multiple=False,
        label="LLM Tool Selector",
        description="Uses an LLM to select relevant tools before calling main model",
        model_params=True,
        param_schema={
            "max_tools": "number",
        },
    ),
    "model_fallback": MiddlewareSpec(
        cls=ModelFallbackMiddleware,
        default_params={},
        enabled_by_default=False,
        allow_multiple=False,
        label="Model Fallback",
        description="Falls back to an alternative model when primary fails",
        model_params=True,
    ),
}


# ---------------------------------------------------------------------------
# Special-case constructors
# ---------------------------------------------------------------------------


def _build_context_editing(params: dict[str, Any]) -> ContextEditingMiddleware:
    """Build ContextEditingMiddleware from flat params.

    Translates the simplified flat config (``trigger``, ``keep``) into the
    nested ``ClearToolUsesEdit`` structure that the middleware expects.
    """
    return ContextEditingMiddleware(
        edits=[
            ClearToolUsesEdit(
                trigger=params.get("trigger", 100_000),
                keep=params.get("keep", 3),
            ),
        ],
    )


def _build_pii(params: dict[str, Any]) -> PIIMiddleware:
    """Build PIIMiddleware from params.

    Each instance handles a single PII type.  Multiple PII types require
    multiple entries in the middleware list.
    """
    return PIIMiddleware(
        pii_type=params.get("pii_type", "email"),
        strategy=params.get("strategy", "redact"),
    )


def _instantiate_model(
    model_id: str,
    model_provider: str,
) -> Any:
    """Instantiate an LLM via LLMFactory for middleware that need a model.

    Args:
        model_id: LLM model identifier.
        model_provider: LLM provider string.

    Returns:
        Initialized BaseChatModel instance.
    """
    return get_configured_llm(
        model_id=model_id,
        model_provider=model_provider,
    )


def _build_llm_tool_selector(params: dict[str, Any]) -> LLMToolSelectorMiddleware:
    """Build LLMToolSelectorMiddleware from params.

    Requires ``model_id`` and ``model_provider`` in params to instantiate
    the selector LLM.  Falls back to no model (uses agent's own model)
    if not provided.
    """
    kwargs: dict[str, Any] = {"max_tools": params.get("max_tools", 10)}

    model_id = params.get("model_id")
    model_provider = params.get("model_provider")
    if model_id and model_provider:
        kwargs["model"] = _instantiate_model(model_id, model_provider)

    return LLMToolSelectorMiddleware(**kwargs)


def _build_model_fallback(params: dict[str, Any]) -> ModelFallbackMiddleware | None:
    """Build ModelFallbackMiddleware from params.

    Requires ``model_id`` and ``model_provider`` to specify the fallback
    model.  Returns None if no model is configured (middleware is skipped).
    """
    model_id = params.get("model_id")
    model_provider = params.get("model_provider")
    if not model_id or not model_provider:
        logger.warning("model_fallback enabled but no model_id/model_provider configured, skipping")
        return None

    fallback_model = _instantiate_model(model_id, model_provider)
    return ModelFallbackMiddleware(fallback_model)


def _build_structured_response(_params: dict[str, Any]) -> None:
    """Structured response is handled by AgentRuntime tool injection.

    The registry entry exists so the UI can configure the capability per
    agent. It does not add a LangChain middleware object to the stack.
    """
    return None


# Keys that need special construction instead of simple cls(**params)
_SPECIAL_BUILDERS: dict[str, Callable[..., Any]] = {
    "structured_response": _build_structured_response,
    "context_editing": _build_context_editing,
    "pii": _build_pii,
    "llm_tool_selector": _build_llm_tool_selector,
    "model_fallback": _build_model_fallback,
}


# ---------------------------------------------------------------------------
# Default stack
# ---------------------------------------------------------------------------


def get_default_middleware_entries() -> list[dict[str, Any]]:
    """Return the default middleware list for agents with no features config.

    Returns a list of dicts matching the ``MiddlewareEntry`` schema so it
    can be used both at runtime and serialized to the UI/API.
    """
    return [
        {"type": key, "enabled": True, "params": dict(spec.default_params)}
        for key, spec in MIDDLEWARE_REGISTRY.items()
        if spec.enabled_by_default
    ]


def get_middleware_definitions() -> list[dict[str, Any]]:
    """Return the middleware registry as a list of dicts for the API.

    Excludes the ``cls`` field (not serializable). The UI uses this to
    render the middleware picker without hardcoding definitions.
    """
    return [
        {
            "key": key,
            "label": spec.label,
            "description": spec.description,
            "enabled_by_default": spec.enabled_by_default,
            "allow_multiple": spec.allow_multiple,
            "default_params": spec.default_params,
            "model_params": spec.model_params,
            "param_schema": spec.param_schema,
        }
        for key, spec in MIDDLEWARE_REGISTRY.items()
    ]


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


def _build_prompt_cache_middleware(model_id: str) -> AgentMiddleware | None:
    """Return the native prompt-caching middleware for the resolved Bedrock client.

    The Bedrock client adapter is selected by ``resolve_bedrock_client`` (the same
    logic ``LLMFactory`` uses at instantiation time):

    - ``anthropic`` -> ``ChatAnthropicBedrock``: return None. ``create_deep_agent``
      already appends ``AnthropicPromptCachingMiddleware`` unconditionally to the
      parent, every subagent, and the general-purpose subagent. Adding our own
      would put two instances with the same ``.name`` in a ``create_agent`` call,
      which raises ``AssertionError: Please remove duplicate middleware instances``
      at graph-build time and breaks every turn. deepagents owns this path.
    - ``converse`` -> ``ChatBedrockConverse``: use the langchain_aws caching
      middleware. deepagents' Anthropic caching mw no-ops on Converse models
      (``unsupported_model_behavior="ignore"``), so this is additive and its class
      name does not collide with the injected Anthropic one.
    - ``legacy`` -> ``ChatBedrock``: no native caching middleware exists; return
      None (caching is silently unavailable for this client).

    ``BedrockPromptCachingMiddleware`` sets ``model_settings["cache_control"]``
    instead of mutating message content, so cache markers never enter the
    checkpointed state.
    """
    resolved = resolve_bedrock_client(model_id, enable_cache=True)
    if resolved == "converse":
        return BedrockPromptCachingMiddleware()
    return None


def build_middleware(
    features: FeaturesConfig | None,
    session_id: str | None = None,
    agent_name: str = "unknown",
    model_id: str = "unknown",
    model_provider: str = "unknown",
    attachment_store: Any | None = None,
    enable_prompt_cache: bool = False,
) -> list[AgentMiddleware]:
    """Build the middleware stack from an agent's features config.

    When ``features`` is None (agent has no features config in MongoDB),
    all default-enabled middleware are applied with default params.

    When ``features.middleware`` is an explicit list, entries are processed
    in order.  Disabled entries are skipped.  Singleton middleware types
    that appear more than once log a warning and only the first is used.

    Each middleware has a ``MetricsAgentMiddleware``
    appended at the end to record total LLM/tool call duration.

    Args:
        features: Agent features config, or None for all defaults.
        session_id: Optional conversation ID for log context.
        agent_name: Agent name for metric labels.
        model_id: Model identifier for metric labels.

    Returns:
        Ordered list of middleware instances.
    """
    if features is None or not features.middleware:
        # No explicit config — apply all default-enabled middleware
        entries: list[MiddlewareEntry] = []

        for key, spec in MIDDLEWARE_REGISTRY.items():
            if spec.enabled_by_default:
                entries.append(MiddlewareEntry(type=key, enabled=True, params=dict(spec.default_params)))
    else:
        entries = features.middleware

    result: list[AgentMiddleware] = []
    seen_singletons: set[str] = set()

    for entry in entries:
        if not entry.enabled:
            continue

        spec = MIDDLEWARE_REGISTRY.get(entry.type)
        if spec is None:
            logger.warning("Unknown middleware type '%s', skipping", entry.type)
            continue

        # Enforce singleton constraint
        if not spec.allow_multiple:
            if entry.type in seen_singletons:
                logger.warning(
                    "Middleware '%s' does not allow multiple instances, skipping duplicate",
                    entry.type,
                )
                continue
            seen_singletons.add(entry.type)

        # Merge user params over defaults
        params = {**spec.default_params, **entry.params}

        # Special-case construction for middleware with non-trivial init
        builder = _SPECIAL_BUILDERS.get(entry.type)
        if builder is not None:
            instance = builder(params)
            if instance is None:
                continue
        else:
            instance = spec.cls(**params)

        result.append(instance)
        logger.debug("Middleware '%s' added with params: %s", entry.type, params)

    # Rehydrate attachment references into inline bytes just before the model
    # call. Placed before ToolResultInvariant so the final pre-model messages
    # carry both the repaired tool history and the re-inflated file bytes. Only
    # added when a store is configured — otherwise attachments ride inline and
    # there is nothing to rehydrate.
    if attachment_store is not None:
        result.append(AttachmentRehydrationMiddleware(attachment_store, model_id=model_id))

    # Prompt caching: delegate to the native langchain caching middleware for the
    # resolved Bedrock client. Gated on the Bedrock provider — OpenAI/Gemini cache
    # server-side with no client-side breakpoint to insert, and the enable flag
    # (AWS_BEDROCK_ENABLE_PROMPT_CACHE) is Bedrock-scoped by name.
    if enable_prompt_cache and model_provider == "aws-bedrock":
        cache_middleware = _build_prompt_cache_middleware(model_id)
        if cache_middleware is not None:
            result.append(cache_middleware)

    # Repair tool-call history after configurable middleware edits and before the model.
    result.append(ToolResultInvariantMiddleware())

    # Append MetricsAgentMiddleware at the end to capture total LLM/tool duration
    result.append(MetricsAgentMiddleware(agent_name=agent_name, model_id=model_id))

    logger.info(
        "Built middleware stack: %s",
        [type(m).__name__ for m in result],
    )
    return result
