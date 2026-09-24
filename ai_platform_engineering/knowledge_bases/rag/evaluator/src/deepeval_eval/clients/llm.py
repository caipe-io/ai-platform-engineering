from __future__ import annotations

import asyncio
import json
import re
import threading
from typing import Any

import httpx
from pydantic import BaseModel, SecretStr
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
)

from deepeval_eval.core.config import LLMSettings
from deepeval_eval.core.prompt_style import (
    make_generation_prompt,
    make_short_answer_prompt,
)


def is_transient_error(exception: Exception) -> bool:
    """Helper to determine if an HTTP error is transient and worth retrying,
    explicitly including temporary 403 replication/auth-lag errors."""
    if isinstance(exception, httpx.HTTPStatusError):
        # Skip retrying structural bad requests or bad API keys
        if exception.response.status_code in (400, 401, 422):
            return False
        return True  # Retry on everything else, including 403


class OpenAICompatibleClient:
    def __init__(
        self,
        llm_settings: LLMSettings | None = None,
        model: str | None = None,
        api_key: str | SecretStr | None = None,
        base_url: str | None = None,
    ):
        settings = llm_settings or LLMSettings()

        self.model = model or settings.model
        self.base_url = (base_url or settings.base_url).rstrip("/")

        raw_key = api_key or settings.api_key
        self.api_key = (
            raw_key.get_secret_value()
            if isinstance(raw_key, SecretStr)
            else (str(raw_key) if raw_key is not None else "")
        )

        self._lock = threading.Lock()
        self.input_tokens = 0
        self.output_tokens = 0
        self.total_tokens = 0
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        with self._lock:
            if self._client is None or self._client.is_closed:
                limits = httpx.Limits(max_keepalive_connections=20, max_connections=100)
                self._client = httpx.Client(timeout=300.0, limits=limits)
            return self._client

    def close(self) -> None:
        """Close underlying HTTP client connection pool."""
        if self._client is not None and not self._client.is_closed:
            self._client.close()

    def __enter__(self) -> OpenAICompatibleClient:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def reset_tokens(self) -> None:
        with self._lock:
            self.input_tokens = 0
            self.output_tokens = 0
            self.total_tokens = 0

    @retry(
        reraise=True,
        stop=stop_after_attempt(
            4
        ),  # Give it a few attempts to let gateway/IAM sync complete
        wait=wait_exponential(
            multiplier=2, min=2, max=12
        ),  # Exponential backoff: 2s, 4s, 8s...
        retry=is_transient_error,
    )
    def generate(
        self, prompt: str, schema: type[BaseModel] | None = None
    ) -> str | BaseModel:
        if schema is not None:
            prompt = with_json_schema_instruction(prompt, schema)
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        response = self.client.post(
            f"{self.base_url}/chat/completions", headers=headers, json=payload
        )
        response.raise_for_status()
        resp_json = response.json()
        usage = resp_json.get("usage")
        if isinstance(usage, dict):
            with self._lock:
                self.input_tokens += usage.get("prompt_tokens") or 0
                self.output_tokens += usage.get("completion_tokens") or 0
                self.total_tokens += usage.get("total_tokens") or 0
        text = resp_json["choices"][0]["message"]["content"] or ""
        if schema is None:
            return text.strip()
        return parse_schema_response(text, schema)


# DeepEval expects its own model interface; this adapter routes those judge
# calls through OpenAI-compatible endpoint.
class DeepEvalJudge:
    def __init__(
        self,
        provider: str = "openai-compatible",
        model: str | None = None,
        client: OpenAICompatibleClient | None = None,
        llm_settings: LLMSettings | None = None,
    ):
        from deepeval.models.base_model import DeepEvalBaseLLM

        llm_client = client or OpenAICompatibleClient(
            llm_settings=llm_settings, model=model
        )
        provider_name = provider
        model_name = model or llm_client.model

        class Judge(DeepEvalBaseLLM):
            def __init__(
                self,
                p_name: str,
                m_name: str,
                judge_client: OpenAICompatibleClient,
            ):
                self.provider_name = p_name
                self.model_name = m_name
                self.llm_client = judge_client
                super().__init__(model=m_name)

            def load_model(self, *args: Any, **kwargs: Any):
                return self.llm_client

            def get_model_name(self, *args: Any, **kwargs: Any) -> str:
                return f"{self.provider_name}:{self.model_name}"

            def generate(
                self, prompt: str, schema: type[BaseModel] | None = None, **kwargs: Any
            ):
                return self.llm_client.generate(prompt, schema=schema)

            async def a_generate(
                self, prompt: str, schema: type[BaseModel] | None = None, **kwargs: Any
            ):
                return await asyncio.to_thread(
                    self.generate, prompt, schema=schema, **kwargs
                )

        self.model = Judge(provider_name, model_name, llm_client)


def with_json_schema_instruction(prompt: str, schema: type[BaseModel]) -> str:
    schema_json = json.dumps(schema.model_json_schema(), indent=2)
    instruction = (
        "Return only valid JSON matching this JSON schema. "
        "Do not include markdown fences."
    )
    return f"{prompt}\n\n{instruction}\n\n{schema_json}"


def parse_schema_response(text: str, schema: type[BaseModel]) -> BaseModel:
    cleaned = text.strip()
    fence = chr(96) * 3
    if fence in cleaned:
        parts = [part.strip() for part in cleaned.split(fence) if part.strip()]
        if parts:
            cleaned = parts[-1]
            if cleaned.lower().startswith("json"):
                cleaned = cleaned[4:].strip()
    try:
        return schema.model_validate_json(cleaned)
    except Exception:
        match = re.search(r"(\{.*\}|\[.*\])", cleaned, flags=re.DOTALL)
        if not match:
            raise
        return schema.model_validate_json(match.group(1))


__all__ = [
    "DeepEvalJudge",
    "OpenAICompatibleClient",
    "is_transient_error",
    "make_generation_prompt",
    "make_short_answer_prompt",
]
