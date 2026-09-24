"""Shared LLM transport clients and LLM instantiation.

Provides a single entry point (`get_llm`) for obtaining a LangChain chat model
with shared transport clients (boto3/httpx) to avoid duplicating heavy resources.

Set LLM_CLIENT_SHARING=false to disable client sharing (each call creates its own).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from functools import lru_cache
from threading import Lock
from typing import Any

from langchain_core.language_models import BaseChatModel

from dynamic_agents._vendor.llm_wrapper.build import LLMConfigError as WrapperConfigError
from dynamic_agents.models import ReasoningEffort
from dynamic_agents.services.model_capabilities import supports_reasoning_effort

logger = logging.getLogger(__name__)

SHARE_CLIENTS = os.getenv("LLM_CLIENT_SHARING", "true").lower() != "false"
_AZURE_RESPONSES_MIN_API_VERSION = "2025-03-01-preview"
_AZURE_ENV_LOCK = Lock()


# ─────────────────────────────────────────────────────────────────────────────
# Transport client creation and caching
# ─────────────────────────────────────────────────────────────────────────────


def _create_bedrock_clients(region: str) -> tuple[Any, Any]:
    import boto3
    from botocore.config import Config

    config = Config(
        read_timeout=int(os.getenv("AWS_BEDROCK_READ_TIMEOUT", "300")),
        connect_timeout=int(os.getenv("AWS_BEDROCK_CONNECT_TIMEOUT", "60")),
    )
    # boto3.Session auto-resolves creds from env/profile/instance-role
    session = boto3.Session(region_name=region)
    runtime = session.client("bedrock-runtime", config=config)
    control = session.client("bedrock", config=config)
    logger.info("Created bedrock clients (region=%s, shared=%s)", region, SHARE_CLIENTS)
    return (runtime, control)


@lru_cache(maxsize=4)
def _cached_bedrock_clients(region: str) -> tuple[Any, Any]:
    return _create_bedrock_clients(region)


def _create_httpx_client(endpoint: str) -> Any:
    import httpx

    client = httpx.Client(timeout=httpx.Timeout(300.0, connect=60.0))
    logger.info("Created httpx client (endpoint=%s, shared=%s)", endpoint, SHARE_CLIENTS)
    return client


@lru_cache(maxsize=4)
def _cached_httpx_client(endpoint: str) -> Any:
    return _create_httpx_client(endpoint)


def _get_bedrock_clients(region: str | None = None) -> tuple[Any, Any]:
    """Get (bedrock-runtime, bedrock) client pair. Cached by region when sharing enabled."""
    region = region or os.getenv("AWS_REGION", "us-east-1")
    if SHARE_CLIENTS:
        return _cached_bedrock_clients(region)
    return _create_bedrock_clients(region)


def _get_httpx_client(endpoint: str) -> Any:
    """Get httpx.Client for OpenAI/Azure. Cached by endpoint when sharing enabled."""
    if SHARE_CLIENTS:
        return _cached_httpx_client(endpoint)
    return _create_httpx_client(endpoint)


def _azure_responses_api_version(configured: str | None) -> str:
    """Return an Azure API version that supports the Responses API."""
    if not configured:
        return _AZURE_RESPONSES_MIN_API_VERSION
    try:
        configured_date = date.fromisoformat(configured[:10])
    except ValueError:
        return configured
    minimum_date = date.fromisoformat(_AZURE_RESPONSES_MIN_API_VERSION[:10])
    if configured_date < minimum_date:
        return _AZURE_RESPONSES_MIN_API_VERSION
    return configured


@contextmanager
def _azure_responses_environment(enabled: bool) -> Iterator[None]:
    """Force the Responses API and its minimum Azure API version during construction."""
    if not enabled:
        yield
        return

    with _AZURE_ENV_LOCK:
        original_responses = os.environ.get("AZURE_OPENAI_USE_RESPONSES")
        original_version = os.environ.get("AZURE_OPENAI_API_VERSION")
        effective_version = _azure_responses_api_version(original_version)
        os.environ["AZURE_OPENAI_USE_RESPONSES"] = "true"
        os.environ["AZURE_OPENAI_API_VERSION"] = effective_version
        if effective_version != original_version:
            logger.warning(
                "[llm] Azure Responses API requires api-version %s or later; using %s",
                _AZURE_RESPONSES_MIN_API_VERSION,
                effective_version,
            )
        try:
            yield
        finally:
            if original_responses is None:
                os.environ.pop("AZURE_OPENAI_USE_RESPONSES", None)
            else:
                os.environ["AZURE_OPENAI_USE_RESPONSES"] = original_responses
            if original_version is None:
                os.environ.pop("AZURE_OPENAI_API_VERSION", None)
            else:
                os.environ["AZURE_OPENAI_API_VERSION"] = original_version


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


class LLMConfigError(ValueError):
    """Raised when an agent has no usable LLM configuration.

    Distinct from the wrapper's generic `ValueError` so callers (and the
    chat SSE wrapper) can map it to a user-actionable message instead of
    the misleading "Something went wrong - some tools or subagents may
    have timed out" fallback.
    """


def _resolve_llm_defaults(provider: str | None, model_id: str | None) -> tuple[str, str | None]:
    """Fill in provider/model from environment when an agent leaves them blank.

    The bootstrap "Hello World" agent (see ui/src/lib/seed-config.ts) is
    intentionally seeded with empty model/provider so it doesn't pin the
    install to a specific deployment. Per the comment there, the dynamic-
    agents backend is supposed to substitute the deployment default; this
    helper is that promise.

    Resolution order:
    - `provider`: agent value → `LLM_PROVIDER` env var
    - `model_id`: agent value → `None` (LLMFactory then reads the
      provider-specific env var, e.g. `AWS_BEDROCK_MODEL_ID`,
      `OPENAI_MODEL_NAME`, `ANTHROPIC_MODEL_NAME`, etc.)

    Empty `model_id` is returned as `None` rather than `""` so the
    downstream `model_override` check in LLMFactory falls through to
    its env-based lookup.
    """
    resolved_provider = (provider or "").strip() or os.getenv("LLM_PROVIDER", "").strip()
    if not resolved_provider:
        raise LLMConfigError(
            "Agent has no LLM provider configured and no deployment default "
            "(LLM_PROVIDER) is set. Open Admin UI → Custom Agents and pick a "
            "provider/model for this agent, or set LLM_PROVIDER on the "
            "dynamic-agents service."
        )
    resolved_model = (model_id or "").strip() or None
    return resolved_provider, resolved_model


def get_llm(
    provider: str,
    model_id: str,
    reasoning_effort: ReasoningEffort | None = None,
) -> BaseChatModel:
    """Get a LangChain chat model for the given provider and model.

    Injects shared transport clients (boto3/httpx) when LLM_CLIENT_SHARING=true,
    avoiding ~20MB of duplicated boto3 sessions per runtime for Bedrock.

    For Google (Gemini/Vertex AI), no shared client is needed — the SDK
    manages its own transport internally.

    When `provider` or `model_id` are empty, falls back to environment
    defaults (`LLM_PROVIDER` and provider-specific model vars). Raises
    `LLMConfigError` with an actionable message if neither agent nor env
    define a usable provider.
    """
    from dynamic_agents._vendor.llm_wrapper.build import build_chat_model

    resolved_provider, resolved_model = _resolve_llm_defaults(provider, model_id)

    kwargs: dict[str, Any] = {}
    model_supports_effort = (
        reasoning_effort is not None
        and supports_reasoning_effort(resolved_model, reasoning_effort)
    )
    if reasoning_effort is not None and not model_supports_effort:
        logger.warning(
            "[llm] Model %s does not advertise configurable reasoning; using provider default",
            resolved_model or "<from env>",
        )

    normalized_provider = resolved_provider.lower().replace("_", "-")
    use_azure_responses = (
        model_supports_effort
        and normalized_provider == "azure-openai"
        and resolved_model is not None
        and resolved_model.lower().startswith(("gpt-5", "gpt-6"))
    )
    if model_supports_effort and normalized_provider in {"aws-bedrock", "bedrock"}:
        # Anthropic accepts only its default temperature while thinking is enabled.
        kwargs["temperature"] = 1.0

    if SHARE_CLIENTS:
        p = resolved_provider.lower().replace("-", "_")
        if "bedrock" in p or "aws" in p:
            rt, ctrl = _get_bedrock_clients()
            kwargs["client"] = rt
            kwargs["bedrock_client"] = ctrl
        elif "azure" in p:
            endpoint = os.getenv("AZURE_OPENAI_ENDPOINT") or os.getenv("OPENAI_ENDPOINT", "https://api.openai.com/v1")
            kwargs["http_client"] = _get_httpx_client(endpoint)
        elif "openai" in p:
            endpoint = os.getenv("OPENAI_ENDPOINT", "https://api.openai.com/v1")
            kwargs["http_client"] = _get_httpx_client(endpoint)
        # google-gemini / google-vertex-ai: no shared client needed

    try:
        with _azure_responses_environment(use_azure_responses):
            if model_supports_effort:
                kwargs["reasoning_effort"] = reasoning_effort
            llm = build_chat_model(resolved_provider, resolved_model, **kwargs)
    except WrapperConfigError as exc:
        # Re-raise as this module's LLMConfigError so the SSE chat wrapper can
        # translate it into an actionable user message. Both are ValueError
        # subclasses; the wrapper's is caught first because it already carries
        # provider and model context.
        raise LLMConfigError(str(exc)) from exc
    except ValueError as exc:
        raise LLMConfigError(
            f"Cannot initialize LLM (provider={resolved_provider!r}, "
            f"model={resolved_model!r}): {exc}"
        ) from exc
    logger.info(
        "[llm] Instantiated %s (provider=%s, model=%s, shared_clients=%s)",
        type(llm).__name__,
        resolved_provider,
        resolved_model or "<from env>",
        SHARE_CLIENTS,
    )
    return llm


def close_all() -> None:
    """Clear cached clients. Called on shutdown."""
    _cached_bedrock_clients.cache_clear()
    _cached_httpx_client.cache_clear()
    logger.info("Cleared shared LLM client caches")
