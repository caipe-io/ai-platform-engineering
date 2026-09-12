from __future__ import annotations

import logging
import time
from typing import Any

import requests

from deepeval_eval.auth.token_manager import OidcTokenManager
from deepeval_eval.clients.rag import (
    BaseRagClient,
    RagQueryResult,
)
from deepeval_eval.core.prompt_style import PromptStyle, build_prompt

logger = logging.getLogger(__name__)


def check_response(resp: requests.Response) -> requests.Response:
    if not resp.ok:
        raise RuntimeError(
            f"{resp.request.method} {resp.request.url} -> HTTP {resp.status_code}\n{resp.text}"
        )
    return resp


# Thin wrapper around CAIPE RAG search / REST endpoints.
class SearchRagClient(BaseRagClient):
    """Standard non-agentic RAG client connecting directly to rag-server REST endpoints."""

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        verify: bool | str = True,
        keycloak_url: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        db_manager: Any | None = None,
        prompt_args: dict[str, Any] | None = None,
        user_subject: str | None = None,
        user_token: str | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.verify = verify
        self.session.headers.update({"Content-Type": "application/json"})
        self.db_manager = db_manager
        self.prompt_args = prompt_args or {}

        effective_token = user_token or token

        # Initialize OIDC token manager
        self.token_manager = OidcTokenManager(
            token_url=keycloak_url,
            client_id=client_id,
            client_secret=client_secret,
            static_token=effective_token,
            user_subject=user_subject,
            verify=verify,
        )
        self._sync_auth_headers()

    def _sync_auth_headers(self) -> None:
        """Ensure session headers have the latest valid token."""
        auth_headers = self.token_manager.get_auth_headers()
        if auth_headers:
            self.session.headers.update(auth_headers)

    def query_raw(
        self,
        question: str,
        datasource_id: str | None,
        limit: int,
        metadata_filters: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        self._sync_auth_headers()

        payload: dict[str, Any] = {"query": question, "limit": limit}
        filters: dict[str, Any] = {}
        if datasource_id:
            filters["datasource_id"] = datasource_id
        if metadata_filters:
            filters.update(metadata_filters)
        if filters:
            payload["filters"] = filters

        resp = check_response(
            self.session.post(f"{self.base_url}/v1/query", json=payload, timeout=120)
        )
        data = resp.json()
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return list(data.get("results") or [])
        return []

    def query(
        self,
        question: str,
        reference: str = "",
        datasource_id: str | None = None,
        top_k: int = 3,
        answer_mode: str = "generate",
        dataset_name: str = "enterprise",
        prompt_style: str | PromptStyle | None = None,
        llm_client: Any = None,
        max_context_chars: int = 12000,
        metadata_filters: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> RagQueryResult:
        start_time = time.time()
        retrieved_raw = self.query_raw(
            question, datasource_id, top_k, metadata_filters=metadata_filters
        )
        contexts, sources = extract_contexts_and_sources(retrieved_raw)
        trimmed_contexts = [c[:max_context_chars] for c in contexts]

        if llm_client is None:
            raise ValueError("llm_client is required for answer generation")

        def _safe_int(val: Any) -> int:
            if isinstance(val, int):
                return val
            if isinstance(val, (float, str)):
                try:
                    return int(val)
                except (ValueError, TypeError):
                    pass
            return 0

        start_in = _safe_int(getattr(llm_client, "input_tokens", 0))
        start_out = _safe_int(getattr(llm_client, "output_tokens", 0))
        start_tot = _safe_int(getattr(llm_client, "total_tokens", 0))

        combined_prompt_args = dict(self.prompt_args)
        if kwargs.get("prompt_args") and isinstance(kwargs["prompt_args"], dict):
            combined_prompt_args.update(kwargs["prompt_args"])

        prompt = build_prompt(
            prompt_style,
            question,
            trimmed_contexts,
            prompt_args=combined_prompt_args,
            db_manager=self.db_manager,
        )
        answer = str(llm_client.generate(prompt))

        end_in = _safe_int(getattr(llm_client, "input_tokens", start_in))
        end_out = _safe_int(getattr(llm_client, "output_tokens", start_out))
        end_tot = _safe_int(getattr(llm_client, "total_tokens", start_tot))

        input_tokens = max(0, end_in - start_in)
        output_tokens = max(0, end_out - start_out)
        total_tokens = max(0, end_tot - start_tot)

        latency_sec = time.time() - start_time
        retrieved_ids = [
            str(s.get("document_id"))
            for s in sources
            if s.get("document_id") is not None
        ]

        return RagQueryResult(
            answer=answer,
            contexts=trimmed_contexts,
            sources=sources,
            retrieved_doc_ids=retrieved_ids,
            latency_sec=latency_sec,
            latency_ms=latency_sec * 1000.0,
            log_file=" ",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            actual_input=prompt,
        )


def extract_contexts_and_sources(
    results: list[dict[str, Any]],
) -> tuple[list[str], list[dict[str, Any]]]:
    contexts: list[str] = []
    sources: list[dict[str, Any]] = []
    for row in results:
        document = row.get("document") if isinstance(row, dict) else None
        if not isinstance(document, dict):
            document = {}
        metadata = (
            document.get("metadata")
            if isinstance(document.get("metadata"), dict)
            else {}
        )
        nested = (
            metadata.get("metadata")
            if isinstance(metadata.get("metadata"), dict)
            else {}
        )
        text = (
            document.get("page_content")
            or row.get("page_content")
            or document.get("content")
            or row.get("content")
            or ""
        )
        if not text:
            continue
        contexts.append(text)
        sources.append(
            {
                "document_id": metadata.get("document_id"),
                "title": metadata.get("title"),
                "source_type": nested.get("source_type"),
                "score": row.get("score"),
            }
        )
    return contexts, sources


def build_search_rag_client(
    caipe_settings: Any | None = None,
    user_subject: str | None = None,
    user_token: str | None = None,
) -> SearchRagClient:
    """Instantiate SearchRagClient from CaipeClientSettings or environment variables."""
    from deepeval_eval.core.config import CaipeClientSettings

    settings = (
        caipe_settings
        if isinstance(caipe_settings, CaipeClientSettings)
        else CaipeClientSettings()
    )

    raw_token = user_token or (
        settings.auth_token.get_secret_value() if settings.auth_token else None
    )
    raw_secret = (
        settings.client_secret.get_secret_value() if settings.client_secret else None
    )

    return SearchRagClient(
        base_url=settings.base_url,
        token=raw_token,
        verify=not settings.insecure,
        keycloak_url=settings.keycloak_url,
        client_id=settings.client_id,
        client_secret=raw_secret,
        user_subject=user_subject,
        user_token=user_token,
    )
