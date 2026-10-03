"""Construct a LangChain chat model from CAIPE provider configuration.

Thin wrapper over ``langchain.chat_models.init_chat_model``. It returns
provider-native ``BaseChatModel`` instances, so the agent middleware stack,
provider-specific kwargs, and shared-transport injection all keep working
unchanged.

Single shared source, imported directly. See README.md.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from pydantic import SecretStr

from .bedrock_family import BEDROCK_FAMILY_TO_PROVIDER, resolve_bedrock_client
from .providers import (
    OPENAI_COMPATIBLE,
    PROVIDERS,
    is_bedrock,
    model_env_var,
    normalize,
    resolve_model_id,
    supported_providers,
)
from .reasoning import apply_reasoning_effort

logger = logging.getLogger(__name__)

_BEDROCK_CONVERSE_PROVIDER = BEDROCK_FAMILY_TO_PROVIDER["converse"]
_BEDROCK_LEGACY_PROVIDER = BEDROCK_FAMILY_TO_PROVIDER["legacy"]

# Converse and legacy clients require foundation-model metadata for profile
# ARNs. Resolve it before construction so native provider validation succeeds.
_BEDROCK_AIP_PROVIDERS = frozenset({_BEDROCK_CONVERSE_PROVIDER, _BEDROCK_LEGACY_PROVIDER})


class LLMConfigError(ValueError):
    """Raised when provider configuration cannot produce a usable model.

    Distinct from the generic ``ValueError`` that ``init_chat_model`` raises so
    callers can translate it into an actionable message rather than surfacing a
    raw provider error (spec FR-008).
    """


def langchain_provider_for(provider: str, model_id: str | None, enable_cache: bool = False) -> str:
    """Return the ``init_chat_model`` provider string for a CAIPE provider.

    Bedrock resolves per-model to one of three client families; every other
    provider is a fixed mapping.
    """
    canonical = normalize(provider)
    if is_bedrock(canonical):
        family = resolve_bedrock_client(model_id or "", enable_cache=enable_cache)
        return BEDROCK_FAMILY_TO_PROVIDER[family]
    spec = PROVIDERS.get(canonical)
    if spec is None:
        allowed = ", ".join(sorted(supported_providers()))
        raise LLMConfigError(
            f"Unsupported LLM provider {provider!r}. Expected one of: {allowed}."
        )
    return spec.langchain_provider


def _is_bedrock_aip(resolved_model: str, lc_provider: str) -> bool:
    """Whether a Bedrock ARN needs foundation-model metadata.

    A deployment-wide base-model override must not leak onto plain model IDs.
    """
    return (
        lc_provider in _BEDROCK_AIP_PROVIDERS
        and resolved_model.startswith("arn:")
        and ":bedrock:" in resolved_model
        and any(kind in resolved_model for kind in (":application-inference-profile/", ":inference-profile/"))
    )


def _apply_bedrock_base_model_id(resolved_model: str, lc_provider: str, kwargs: dict[str, Any]) -> None:
    """Use an environment base model only when the caller did not supply one."""
    if not _is_bedrock_aip(resolved_model, lc_provider) or kwargs.get("base_model_id") or kwargs.get("base_model"):
        return
    base_model_id = os.getenv("AWS_BEDROCK_BASE_MODEL_ID")
    if base_model_id:
        kwargs["base_model_id"] = base_model_id


def _resolve_bedrock_aip(resolved_model: str, lc_provider: str, kwargs: dict[str, Any]) -> None:
    """Resolve the foundation model before native ARN/provider validation.

    Both clients need a native provider as well as a base model. When IAM
    denies discovery, the configured base model must supply that information;
    an unknown placeholder cannot select a valid request format.
    """
    if not _is_bedrock_aip(resolved_model, lc_provider):
        return
    _apply_bedrock_base_model_id(resolved_model, lc_provider, kwargs)
    base_model = kwargs.get("base_model_id") or kwargs.get("base_model")
    if not base_model:
        # Optional provider dependencies are loaded only on this Bedrock path.
        from botocore.exceptions import ClientError

        control = kwargs.get("bedrock_client")
        if control is None:
            from langchain_aws.utils import create_aws_client

            runtime = kwargs.get("client")
            region = kwargs.get("region_name") or getattr(getattr(runtime, "meta", None), "region_name", None)
            credentials = {
                name: SecretStr(value) if isinstance(value := kwargs.get(name), str) else value
                for name in ("aws_access_key_id", "aws_secret_access_key", "aws_session_token")
            }
            api_key = kwargs.get("bedrock_api_key")
            control = create_aws_client(
                service_name="bedrock",
                region_name=region or resolved_model.split(":")[3],
                credentials_profile_name=kwargs.get("credentials_profile_name"),
                **credentials,
                config=kwargs.get("config"),
                endpoint_url=kwargs.get("endpoint_url"),
                api_key=SecretStr(api_key) if isinstance(api_key, str) else api_key,
            )
            kwargs["bedrock_client"] = control
        try:
            response = control.get_inference_profile(inferenceProfileIdentifier=resolved_model)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") not in {"AccessDeniedException", "AccessDenied"}:
                raise
            raise LLMConfigError(
                "bedrock:GetInferenceProfile denied. Set AWS_BEDROCK_BASE_MODEL_ID "
                "to this profile's underlying foundation model ID, or grant GetInferenceProfile."
            ) from exc
        models = response.get("models") or []
        if not models or not models[0].get("modelArn"):
            raise LLMConfigError("Bedrock inference profile returned no foundation model; set AWS_BEDROCK_BASE_MODEL_ID.")
        base_model = models[0]["modelArn"].rsplit("/", 1)[-1]
    base_model = str(base_model).rsplit("/", 1)[-1]
    parts = base_model.split(".")
    if parts[0] in {"us", "eu", "apac", "global", "us-gov", "sa", "amer", "jp", "au"}:
        parts = parts[1:]
    if len(parts) < 2:
        raise LLMConfigError("AWS_BEDROCK_BASE_MODEL_ID must identify a foundation model, such as anthropic.claude-3-7-sonnet-20250219-v1:0.")
    kwargs.pop("base_model", None)
    kwargs["base_model_id"] = base_model
    kwargs.setdefault("provider", parts[0])


def build_chat_model(
    provider: str,
    model_id: str | None = None,
    *,
    enable_cache: bool = False,
    **kwargs: Any,
) -> BaseChatModel:
    """Build a chat model for ``provider``.

    Args:
        provider: A CAIPE public provider string, e.g. ``aws-bedrock``.
        model_id: Explicit model id. When ``None`` the provider's environment
            variable is read.
        enable_cache: Whether prompt caching is wanted. Only affects Bedrock,
            where it selects the Converse client over the legacy one.
        **kwargs: Passed through to the underlying chat model -- shared
            transport clients, timeouts, reasoning effort, and so on.

    Returns:
        A provider-native ``BaseChatModel``.

    Raises:
        LLMConfigError: The provider is unknown, no model id is available, or
            the provider rejected the configuration.
    """
    canonical = normalize(provider)
    resolved_model = resolve_model_id(canonical, model_id)
    if not resolved_model:
        raise LLMConfigError(
            f"No model id for provider {provider!r}. Set {model_env_var(canonical)} "
            f"or choose a model for this agent in the admin UI."
        )

    lc_provider = langchain_provider_for(canonical, resolved_model, enable_cache=enable_cache)

    if canonical == OPENAI_COMPATIBLE:
        base_url = os.getenv("OPENAI_COMPATIBLE_BASE_URL")
        if not base_url:
            raise LLMConfigError(
                "OPENAI_COMPATIBLE_BASE_URL is required for the "
                f"{OPENAI_COMPATIBLE!r} provider."
            )
        kwargs.setdefault("base_url", base_url)
        # A sandboxed runtime reaches its egress boundary without a credential;
        # the boundary attaches one. Send a placeholder so the OpenAI client
        # does not refuse to construct.
        kwargs.setdefault("api_key", os.getenv("OPENAI_COMPATIBLE_API_KEY", "not-needed"))
    elif canonical == "openai":
        if endpoint := os.getenv("OPENAI_ENDPOINT"):
            kwargs.setdefault("base_url", endpoint)
    elif canonical == "azure-openai":
        if api_version := os.getenv("AZURE_OPENAI_API_VERSION"):
            kwargs.setdefault("api_version", api_version)
        if endpoint := os.getenv("AZURE_OPENAI_ENDPOINT"):
            kwargs.setdefault("azure_endpoint", endpoint)
        if use_responses := os.getenv("AZURE_OPENAI_USE_RESPONSES"):
            kwargs.setdefault("use_responses_api", use_responses.lower() == "true")

    if lc_provider == "anthropic_bedrock":
        # This client uses the Anthropic SDK, which creates its own transport.
        # Boto3 clients and Botocore config would become request parameters.
        kwargs.pop("client", None)
        kwargs.pop("bedrock_client", None)
        config = kwargs.pop("config", None)
        if config is not None and "timeout" not in kwargs:
            kwargs["timeout"] = config.read_timeout

    try:
        kwargs = apply_reasoning_effort(lc_provider, kwargs.pop("reasoning_effort", None), kwargs)
        _resolve_bedrock_aip(resolved_model, lc_provider, kwargs)
        return init_chat_model(model=resolved_model, model_provider=lc_provider, **kwargs)
    except ImportError as exc:
        raise LLMConfigError(
            f"Provider {provider!r} needs an integration package that is not installed "
            f"in this image ({exc}). Use an image built with that provider, or pick a "
            f"provider this deployment ships."
        ) from exc
    except ValueError as exc:
        raise LLMConfigError(
            f"Cannot initialize LLM (provider={provider!r}, model={resolved_model!r}): {exc}"
        ) from exc
