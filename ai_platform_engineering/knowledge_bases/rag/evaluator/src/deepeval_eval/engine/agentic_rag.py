"""
Agentic RAG client for DeepEval evaluation.

Uses the SSE streaming gateway (/api/v1/chat/stream/start) to capture rag_context
artifacts emitted during agent execution, alongside the final answer and token usage.

SSE event structure observed from agent gateway:
  - event: content                              → final answer text pieces (in data.text)
  - event: tool_end                             → tool outputs / RAG contexts (in data.result)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from pydantic import SecretStr

from deepeval_eval.auth.token_manager import OidcTokenManager
from deepeval_eval.core.config import (
    DEFAULT_FETCH_TOOL_NAME,
    DEFAULT_SEARCH_TOOL_NAME,
    AgenticSettings,
)
from deepeval_eval.sinks.file_sink import FileLogSink

logger = logging.getLogger(__name__)

# ============================================================
# Stubs to match base class structure and API
# ============================================================


class BaseRetriever:
    def __init__(self) -> None:
        self.documents: list[str] = []
        self.documents_metadata: list[dict[str, Any]] = []


class TraceEvent:
    def __init__(self, event_type: str, component: str, data: dict[str, Any]) -> None:
        self.event_type = event_type
        self.component = component
        self.data = data
        self.timestamp = datetime.now()


class BaseRAG:
    def __init__(
        self,
        llm_client: Any = None,
        model_name: str = "agentic",
        retriever: AgenticRetriever | None = None,
        log_dir: Path | None = None,
    ) -> None:
        self.llm_client = llm_client
        self.model_name = model_name
        self.retriever = retriever
        self.log_dir = log_dir
        self._log_sink = FileLogSink()
        self.traces: list[TraceEvent] = []

    def export_traces_to_log(
        self,
        run_id: str,
        question: str,
        result: dict[str, Any] | None,
        trace_log: bool = False,
    ) -> str:
        """Export traces to a JSON log file if trace_log is enabled."""
        if not trace_log:
            return ""
        from deepeval_eval.core.config import DEFAULT_RESULTS_DIR

        effective_log_dir = self.log_dir or DEFAULT_RESULTS_DIR
        path = self._log_sink.write_query_trace(
            effective_log_dir, run_id, question, result, self.traces
        )
        return str(path)


# ============================================================
# Helper functions for markdown cleaning and parsing
# ============================================================

_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_SNIPPET_PREFIX_RE = re.compile(r"^\s*\*\*Snippet:\*\*\s*")
_ELLIPSIS_RE = re.compile(r"\.{3,}")


def clean_snippet_markdown(text: str) -> str:
    """Strip bold/ellipsis display markup from search tool snippets.

    The search tool returns UI-formatted snippets e.g.
    '**Snippet:** ...**CAIPE** uses nomic-embed-text...'.
    Stripping gives plain prose and avoids WAF 403s.
    """
    if not text:
        return text
    cleaned = _SNIPPET_PREFIX_RE.sub("", text)
    cleaned = _ELLIPSIS_RE.sub(" ", cleaned)
    cleaned = _BOLD_RE.sub(r"\1", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def _extract_text_from_parts(parts: list) -> str:
    """Concatenate response parts into a single string."""
    return "".join(p.get("text", "") for p in parts if p.get("kind") == "text")


def _parse_rag_context_artifact(text: Any) -> list:
    """Parse a rag_context artifact into (content, doc_id) tuples.

    Handles both tool shapes:
      - search:         {"results": [...], "semantic_results": [...], "keyword_results": [...]}
                        (or any dictionary key ending with 'results')
      - fetch_document: [{"document": {"page_content": ..., "document_id": ...}}]
    """
    out = []
    if isinstance(text, (dict, list)):
        data = text
    else:
        try:
            data = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return out

    if isinstance(data, dict):
        results_keys = [
            k for k in data.keys() if isinstance(k, str) and k.endswith("results")
        ]
        if results_keys:
            for key in results_keys:
                for item in data.get(key, []) or []:
                    if not isinstance(item, dict):
                        continue
                    txt = (
                        item.get("text_content")
                        or item.get("snippet")
                        or item.get("page_content")
                    )
                    if txt:
                        meta = (
                            item.get("metadata", {})
                            if isinstance(item.get("metadata"), dict)
                            else {}
                        )
                        doc_id = (
                            meta.get("document_id")
                            or meta.get("doc_id")
                            or item.get("document_id")
                            or item.get("doc_id")
                        )
                        resolved_id = str(doc_id) if doc_id is not None else None
                        out.append((clean_snippet_markdown(txt), resolved_id))
                        logger.info(
                            "Snippet: %s | DocID: %s",
                            clean_snippet_markdown(txt),
                            resolved_id,
                        )
        else:
            doc = (
                data.get("document", {})
                if isinstance(data.get("document"), dict)
                else data
            )
            txt = doc.get("page_content") or doc.get("text_content")
            if txt:
                doc_meta = (
                    doc.get("metadata") if isinstance(doc.get("metadata"), dict) else {}
                )
                doc_id = (
                    doc.get("document_id")
                    or doc.get("doc_id")
                    or doc_meta.get("document_id")
                    or doc_meta.get("doc_id")
                    or data.get("document_id")
                    or data.get("doc_id")
                )
                out.append((txt, str(doc_id) if doc_id is not None else None))
    elif isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            doc = (
                item.get("document", {})
                if isinstance(item.get("document"), dict)
                else item
            )
            txt = doc.get("page_content") or doc.get("text_content")
            if txt:
                doc_meta = (
                    doc.get("metadata") if isinstance(doc.get("metadata"), dict) else {}
                )
                doc_id = (
                    doc.get("document_id")
                    or doc.get("doc_id")
                    or doc_meta.get("document_id")
                    or doc_meta.get("doc_id")
                    or item.get("document_id")
                    or item.get("doc_id")
                )
                out.append((txt, str(doc_id) if doc_id is not None else None))
    return out


def _dedupe_preserve_order(items: list) -> list:
    """Deduplicate (content, doc_id) tuples by content, preserving order."""
    seen = set()
    result = []
    for item in items:
        content = item[0] if isinstance(item, tuple) else item
        if content not in seen:
            seen.add(content)
            result.append(item)
    return result


def _dedupe_and_merge_contexts(items: list) -> list:
    """Deduplicate and merge contexts by doc_id, preferring longer/full content."""
    doc_id_to_content = {}
    ordered_keys = []

    for item in items:
        if not isinstance(item, tuple) or len(item) < 2:
            continue
        content, doc_id = item
        if doc_id:
            if doc_id not in doc_id_to_content:
                ordered_keys.append(doc_id)
                doc_id_to_content[doc_id] = content
            else:
                if len(content) > len(doc_id_to_content[doc_id]):
                    doc_id_to_content[doc_id] = content
        else:
            content_key = f"content_hash:{hash(content)}"
            if content_key not in doc_id_to_content:
                ordered_keys.append(content_key)
                doc_id_to_content[content_key] = content

    result = []
    for key in ordered_keys:
        content = doc_id_to_content[key]
        resolved_doc_id = None if key.startswith("content_hash:") else key
        result.append((content, resolved_doc_id))
    return result


def _extract_usage_from_response(raw_resp: Any) -> dict[str, int]:
    """Extract token usage metadata from gateway or supervisor response dictionary.

    Walks result.metadata -> resp.metadata -> artifacts[].metadata.
    """
    input_tokens = 0
    output_tokens = 0
    total_tokens = 0

    if isinstance(raw_resp, dict):
        result_obj = raw_resp.get("result") or {}
        result_meta = (
            result_obj.get("metadata") if isinstance(result_obj, dict) else None
        )
        resp_meta = raw_resp.get("metadata")

        usage_meta = None
        if isinstance(result_meta, dict):
            usage_meta = result_meta.get("usage_metadata") or result_meta.get("usage")
        if not usage_meta and isinstance(resp_meta, dict):
            usage_meta = resp_meta.get("usage_metadata") or resp_meta.get("usage")

        if not usage_meta and isinstance(result_obj, dict):
            for art in result_obj.get("artifacts", []):
                if isinstance(art, dict) and isinstance(art.get("metadata"), dict):
                    usage_meta = art["metadata"].get("usage_metadata") or art[
                        "metadata"
                    ].get("usage")
                    if usage_meta:
                        break
        if isinstance(usage_meta, dict):
            input_tokens = (
                usage_meta.get("input_tokens")
                or usage_meta.get("prompt_tokens")
                or usage_meta.get("input_token_count")
                or 0
            )
            output_tokens = (
                usage_meta.get("output_tokens")
                or usage_meta.get("completion_tokens")
                or usage_meta.get("output_token_count")
                or 0
            )
            total_tokens = (
                usage_meta.get("total_tokens")
                or usage_meta.get("total_token_count")
                or (input_tokens + output_tokens)
            )

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
    }


# ============================================================
# Return type for DeepEval specific backward compatibility
# ============================================================


@dataclass
class AgenticRAGResult:
    answer: str
    contexts: list[str]
    latency_ms: float
    task_id: str
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    error: str | None = None
    log_file: str | None = None
    actual_input: str = ""


# ============================================================
# Agentic retrieval — queries supervisor or BFF gateway
# ============================================================


class AgenticRetriever(BaseRetriever):
    """Retriever that queries caipe-supervisor's endpoint."""

    def __init__(
        self,
        settings: AgenticSettings | None = None,
        agent_api_url: str | None = None,
        agent_id: str | None = None,
        datasource_id: str | None = None,
        timeout: float | None = None,
        insecure: bool | None = None,
        trace_log: bool | None = None,
        fail_on_error: bool | None = None,
        auth_token: str | SecretStr | None = None,
        log_dir: Path | None = None,
        db_manager: Any | None = None,
        prompt_args: dict[str, Any] | None = None,
        search_tool_name: str | None = None,
        fetch_tool_name: str | None = None,
        user_subject: str | None = None,
        user_token: str | None = None,
    ) -> None:
        super().__init__()
        cfg = settings or AgenticSettings()

        self.agent_id = agent_id or cfg.agent_id
        raw_url = (agent_api_url or cfg.agent_url).rstrip("/")
        for suffix in ("/api/dynamic-agents", "/api/v1", "/api/chat"):
            if raw_url.endswith(suffix):
                raw_url = raw_url[: -len(suffix)].rstrip("/")
        self.agent_api_url = raw_url
        self.datasource_id = datasource_id or cfg.datasource_id
        self.search_tool_name = (
            search_tool_name
            or getattr(cfg, "search_tool_name", None)
            or DEFAULT_SEARCH_TOOL_NAME
        )
        self.fetch_tool_name = (
            fetch_tool_name
            or getattr(cfg, "fetch_tool_name", None)
            or DEFAULT_FETCH_TOOL_NAME
        )
        self.timeout = timeout if timeout is not None else cfg.timeout
        self.insecure = insecure if insecure is not None else cfg.insecure
        self.trace_log = trace_log if trace_log is not None else cfg.trace_log
        self.fail_on_error = (
            fail_on_error if fail_on_error is not None else cfg.fail_on_error
        )
        effective_token = user_token or auth_token or cfg.auth_token
        self.token_manager = OidcTokenManager(
            token_url=cfg.oidc_token_url,
            client_id=cfg.client_id,
            client_secret=cfg.client_secret,
            static_token=effective_token,
            user_subject=user_subject,
            verify=not self.insecure,
        )
        self.last_answer: str = ""
        self.last_raw_response: dict | None = None
        self.documents_metadata: list[dict[str, Any]] = []
        self.log_dir = log_dir
        self._log_sink = FileLogSink()
        self.db_manager = db_manager
        self.prompt_args = prompt_args or {}

    def fit(self, documents: list[str]) -> None:
        """AgenticRetriever doesn't support local fitting."""
        self.documents = documents
        self.documents_metadata = [{} for _ in documents]

    def _get_oidc_token(self) -> str | None:
        """Fetch OIDC token dynamically using OidcTokenManager."""
        return self.token_manager.get_token()

    def _query_gateway(
        self,
        question: str,
        k: int = 3,
        run_id: str | None = None,
        trace_log: bool | None = None,
        log_file_prefix: str | None = None,
    ) -> list[tuple]:
        """Send query to the streaming BFF gateway endpoints."""
        max_attempts = 3
        backoff_base = 2.0
        last_exception = None

        for attempt in range(1, max_attempts + 1):
            headers = {
                "Content-Type": "application/json",
                **self.token_manager.get_auth_headers(),
            }
            agent_id = self.agent_id

            try:
                # Step 1: Create a new conversation session
                conv_url = f"{self.agent_api_url.rstrip('/')}/api/chat/conversations"
                conv_payload = {
                    "title": "Agentic Session",
                    "client_type": "webui",
                    "agent_id": agent_id,
                }

                logger.info(
                    "Creating conversation session on %s... (Attempt %d/%d)",
                    conv_url,
                    attempt,
                    max_attempts,
                )
                r_conv = httpx.post(
                    conv_url,
                    json=conv_payload,
                    headers=headers,
                    verify=not self.insecure,
                    timeout=self.timeout,
                )
                if r_conv.status_code == 401:
                    logger.warning(
                        "Gateway returned 401 Unauthorized. Attempting token refresh..."
                    )
                    self.token_manager.force_refresh()
                    headers.update(self.token_manager.get_auth_headers())
                    logger.info(
                        "Retrying conversation session creation with fresh token..."
                    )
                    r_conv = httpx.post(
                        conv_url,
                        json=conv_payload,
                        headers=headers,
                        verify=not self.insecure,
                        timeout=self.timeout,
                    )
                r_conv.raise_for_status()
                conv_data = r_conv.json()
                conversation_id = conv_data["data"]["conversation"]["_id"]
                logger.info("Conversation session created with ID: %s", conversation_id)

                # Step 2: Stream the chat start request
                stream_url = (
                    f"{self.agent_api_url.rstrip('/')}/api/v1/chat/stream/start"
                )
                stream_payload = {
                    "message": question,
                    "conversation_id": conversation_id,
                    "agent_id": agent_id,
                    "protocol": "custom",
                    "client_context": {
                        "source": "eval",
                        "tool_result_display_limit": -1,
                    },
                }

                raw_contexts = []
                self.last_answer = ""

                # Resolve trace_log
                should_trace = trace_log if trace_log is not None else self.trace_log

                log_file = None
                if should_trace:
                    from deepeval_eval.core.config import DEFAULT_RESULTS_DIR

                    effective_log_dir = self.log_dir or DEFAULT_RESULTS_DIR
                    log_filepath, log_file = self._log_sink.open_stream_log(
                        effective_log_dir,
                        prefix=log_file_prefix,
                        run_id=run_id,
                        datasource_id=self.datasource_id,
                    )
                    self.last_log_file = str(log_filepath)

                try:
                    logger.info("Streaming query from %s...", stream_url)
                    with httpx.stream(
                        "POST",
                        stream_url,
                        json=stream_payload,
                        headers=headers,
                        verify=not self.insecure,
                        timeout=self.timeout,
                    ) as response:
                        if response.status_code != 200:
                            try:
                                err_body = response.read().decode("utf-8")
                                logger.error(
                                    "Gateway stream start returned HTTP %s: %s",
                                    response.status_code,
                                    err_body,
                                )
                            except Exception:
                                logger.exception(
                                    "Gateway stream start returned HTTP %s (failed to read body)",
                                    response.status_code,
                                )
                        response.raise_for_status()
                        current_event = None
                        for line in response.iter_lines():
                            if line:
                                if log_file:
                                    self._log_sink.write_stream_line(log_file, line)

                                if line.startswith("event: "):
                                    current_event = line[7:].strip()
                                    if current_event in ("tool_start", "tool_end"):
                                        self.last_answer = ""
                                elif line.startswith("data: "):
                                    data_str = line[6:].strip()
                                    try:
                                        data_json = json.loads(data_str)
                                    except Exception:
                                        continue
                                    if current_event == "content":
                                        self.last_answer += data_json.get("text", "")
                                    elif current_event == "tool_end":
                                        tool_result = data_json.get("result", "")
                                        if tool_result:
                                            raw_contexts.extend(
                                                _parse_rag_context_artifact(tool_result)
                                            )

                                    # Capture token usage metadata from SSE stream event payloads
                                    extracted_usage = None
                                    if isinstance(data_json, dict):
                                        if "usage_metadata" in data_json and isinstance(
                                            data_json["usage_metadata"], dict
                                        ):
                                            extracted_usage = data_json[
                                                "usage_metadata"
                                            ]
                                        elif "usage" in data_json and isinstance(
                                            data_json["usage"], dict
                                        ):
                                            extracted_usage = data_json["usage"]
                                        elif "metadata" in data_json and isinstance(
                                            data_json["metadata"], dict
                                        ):
                                            extracted_usage = data_json["metadata"].get(
                                                "usage_metadata"
                                            ) or data_json["metadata"].get("usage")

                                    if isinstance(extracted_usage, dict):
                                        if self.last_raw_response is None:
                                            self.last_raw_response = {}
                                        if isinstance(self.last_raw_response, dict):
                                            self.last_raw_response.setdefault(
                                                "metadata", {}
                                            )["usage_metadata"] = extracted_usage

                    return raw_contexts

                finally:
                    if log_file:
                        log_file.close()

            except Exception as e:
                last_exception = e
                logger.warning(
                    "Error on attempt %d/%d: %s",
                    attempt,
                    max_attempts,
                    e,
                )
                if attempt < max_attempts:
                    sleep_time = backoff_base**attempt
                    logger.info("Waiting %.1f seconds before retrying...", sleep_time)
                    time.sleep(sleep_time)

        if last_exception:
            logger.error("All %d attempts failed for gateway query.", max_attempts)
            if self.fail_on_error:
                raise last_exception
        return []

    def get_top_k(
        self,
        query: str,
        k: int = 10,
        run_id: str | None = None,
        trace_log: bool | None = None,
        datasource_id: str | None = None,
        dataset_name: str | None = None,
        experiment_name: str | None = None,
        log_file_prefix: str | None = None,
        prompt_style: str | None = None,
        prompt_args: dict[str, Any] | None = None,
        search_tool_name: str | None = None,
        fetch_tool_name: str | None = None,
    ) -> list[tuple]:
        """Query caipe-supervisor or gateway and extract contexts.

        Populates self.documents, self.documents_metadata, and self.last_answer.
        """
        from deepeval_eval.core.prompt_style import build_agentic_prompt

        self.documents = []
        self.documents_metadata = []
        self.last_answer = ""
        self.last_raw_response = None

        combined_prompt_args = dict(self.prompt_args)
        if prompt_args and isinstance(prompt_args, dict):
            combined_prompt_args.update(prompt_args)

        formatted_user_query = build_agentic_prompt(
            style=prompt_style,
            question=query,
            prompt_args=combined_prompt_args,
            db_manager=self.db_manager,
        )

        search_tool = (
            search_tool_name or self.search_tool_name or DEFAULT_SEARCH_TOOL_NAME
        )
        fetch_tool = fetch_tool_name or self.fetch_tool_name or DEFAULT_FETCH_TOOL_NAME

        effective_datasource_id = (
            datasource_id or self.datasource_id or os.environ.get("CAIPE_DATASOURCE_ID")
        )
        if effective_datasource_id:
            enriched_query = (
                f"Instructions: You are answering a question that belongs to the '{effective_datasource_id}' datasource. "
                f'When calling the `{search_tool}` tool, you MUST pass `filters={{"datasource_id": "{effective_datasource_id}"}}` '
                f"to restrict your search to this knowledge base, and set the `limit` parameter to up to {k}. "
                f"Keep the `query` argument of the search tool clean and do not include these instructions in it. "
                f"Importantly, only fetch and read (using the `{fetch_tool}` tool) the specific documents "
                f"you actually need to confidently answer the question, up to a maximum of {k} documents.\n\n"
                f"{formatted_user_query}"
            )
        else:
            enriched_query = (
                f"Instructions: Search across all available knowledge bases to answer the question. "
                f"When calling the `{search_tool}` tool, set the `limit` parameter to up to {k} without any datasource filter. "
                f"Keep the `query` argument of the search tool clean and do not include these instructions in it. "
                f"Importantly, only fetch and read (using the `{fetch_tool}` tool) the specific documents "
                f"you actually need to confidently answer the question, up to a maximum of {k} documents.\n\n"
                f"{formatted_user_query}"
            )

        self.last_enriched_query = enriched_query
        raw_contexts = self._query_gateway(
            enriched_query,
            k=k,
            run_id=run_id,
            trace_log=trace_log,
            log_file_prefix=log_file_prefix,
        )
        if self.last_raw_response is None:
            self.last_raw_response = {"result": {"artifacts": []}}
        elif isinstance(self.last_raw_response, dict):
            self.last_raw_response.setdefault("result", {})["artifacts"] = []

        raw_contexts = _dedupe_and_merge_contexts(raw_contexts)

        for content, doc_id in raw_contexts:
            self.documents.append(content)
            self.documents_metadata.append({"doc_id": doc_id} if doc_id else {})

        return [(i, 1.0) for i in range(len(self.documents))]

    def retrieve(
        self,
        question: str,
        k: int = 5,
        datasource_id: str | None = None,
        dataset_name: str | None = None,
        experiment_name: str | None = None,
        run_id: str | None = None,
        log_file_prefix: str | None = None,
        prompt_style: str | None = None,
        prompt_args: dict[str, Any] | None = None,
        search_tool_name: str | None = None,
        fetch_tool_name: str | None = None,
    ) -> AgenticRAGResult:
        """Backward compatible method for DeepEval evaluations."""
        start = time.perf_counter()
        task_id = run_id or str(uuid.uuid4())
        try:
            self.get_top_k(
                question,
                k=k,
                run_id=run_id,
                datasource_id=datasource_id,
                dataset_name=dataset_name,
                experiment_name=experiment_name,
                log_file_prefix=log_file_prefix,
                prompt_style=prompt_style,
                prompt_args=prompt_args,
                search_tool_name=search_tool_name,
                fetch_tool_name=fetch_tool_name,
            )
            latency_ms = (time.perf_counter() - start) * 1000

            usage_dict = _extract_usage_from_response(self.last_raw_response)
            input_tokens = usage_dict["input_tokens"]
            output_tokens = usage_dict["output_tokens"]
            total_tokens = usage_dict["total_tokens"]

            return AgenticRAGResult(
                answer=self.last_answer,
                contexts=list(self.documents),
                latency_ms=latency_ms,
                task_id=task_id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                log_file=getattr(self, "last_log_file", None),
                actual_input=getattr(self, "last_enriched_query", "") or question,
            )
        except Exception as e:
            latency_ms = (time.perf_counter() - start) * 1000
            logger.exception(f"Agentic retrieval failed: {e}")
            if getattr(self, "fail_on_error", False):
                raise e
            return AgenticRAGResult(
                answer="",
                contexts=[],
                latency_ms=latency_ms,
                task_id=run_id,
                error=str(e),
                actual_input=getattr(self, "last_enriched_query", "") or question,
            )


class AgenticRAG(BaseRAG):
    """RAG pipeline that uses caipe-supervisor for both retrieval and generation."""

    def __init__(
        self,
        settings: AgenticSettings | None = None,
        agent_api_url: str | None = None,
        agent_id: str | None = None,
        datasource_id: str | None = None,
        timeout: float | None = None,
        insecure: bool | None = None,
        trace_log: bool | None = None,
        fail_on_error: bool | None = None,
        log_dir: Path | None = None,
    ) -> None:
        super().__init__(
            llm_client=None,
            model_name="agentic",
            retriever=AgenticRetriever(
                settings=settings,
                agent_api_url=agent_api_url,
                agent_id=agent_id,
                datasource_id=datasource_id,
                timeout=timeout,
                insecure=insecure,
                trace_log=trace_log,
                fail_on_error=fail_on_error,
                log_dir=log_dir,
            ),
            log_dir=log_dir,
        )

    @property
    def _agentic_retriever(self) -> AgenticRetriever:
        return self.retriever  # type: ignore

    def query(
        self,
        question: str,
        top_k: int = 3,
        run_id: str | None = None,
        trace_log: bool | None = None,
        max_context_chars: int = 12000,
        datasource_id: str | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Single call returns both contexts and answer."""
        if run_id is None:
            _q_hash = (
                int(hashlib.sha256(question.encode("utf-8")).hexdigest(), 16) % 10000
            )
            run_id = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{_q_hash:04d}"

        self.traces = []
        self.traces.append(
            TraceEvent(
                event_type="query_start",
                component="agentic_rag",
                data={
                    "run_id": run_id,
                    "question": question,
                    "agent_api_url": self._agentic_retriever.agent_api_url,
                },
            )
        )

        try:
            top_docs = self._agentic_retriever.get_top_k(
                question, k=top_k, run_id=run_id, trace_log=trace_log
            )

            retrieved_docs = [
                {
                    "content": self._agentic_retriever.documents[idx],
                    "similarity_score": score,
                    "document_id": (
                        self._agentic_retriever.documents_metadata[idx].get("doc_id")
                        if idx < len(self._agentic_retriever.documents_metadata)
                        and self._agentic_retriever.documents_metadata[idx].get(
                            "doc_id"
                        )
                        else idx
                    ),
                    "metadata": (
                        self._agentic_retriever.documents_metadata[idx]
                        if idx < len(self._agentic_retriever.documents_metadata)
                        else {}
                    ),
                }
                for idx, score in top_docs
                if idx < len(self._agentic_retriever.documents)
            ]

            retrieved_doc_ids = [doc["document_id"] for doc in retrieved_docs]
            answer = self._agentic_retriever.last_answer

            usage_dict = _extract_usage_from_response(
                self._agentic_retriever.last_raw_response
            )
            if (
                usage_dict["input_tokens"]
                or usage_dict["output_tokens"]
                or usage_dict["total_tokens"]
            ):
                usage = {
                    "prompt_tokens": usage_dict["input_tokens"],
                    "completion_tokens": usage_dict["output_tokens"],
                    "total_tokens": usage_dict["total_tokens"],
                }
            else:
                usage = None

            if not retrieved_docs and answer:
                logger.warning(
                    "AgenticRAG [%s]: no rag_context artifacts in response.",
                    run_id,
                )
            elif not retrieved_docs and not answer:
                logger.warning(
                    "AgenticRAG [%s]: no contexts and no answer.",
                    run_id,
                )

            self.traces.append(
                TraceEvent(
                    event_type="query_complete",
                    component="agentic_rag",
                    data={
                        "run_id": run_id,
                        "success": True,
                        "num_retrieved": len(retrieved_docs),
                        "answer_length": len(answer),
                    },
                )
            )

            result = {
                "answer": answer,
                "run_id": run_id,
                "retrieved_docs": retrieved_docs,
                "usage": usage,
            }

            # Resolve trace_log (Precedence: arg flags > env var > config file > default)
            should_trace = (
                trace_log
                if trace_log is not None
                else self._agentic_retriever.trace_log
            )
            logs_path = self.export_traces_to_log(
                run_id,
                question,
                result,
                trace_log=should_trace,
            )

            return {
                "answer": answer,
                "run_id": run_id,
                "retrieved_docs": retrieved_docs,
                "retrieved_doc_ids": retrieved_doc_ids,
                "usage": usage,
                "logs": logs_path,
            }

        except Exception as e:
            logger.exception(
                "AgenticRAG [%s]: unhandled exception during query", run_id
            )
            self.traces.append(
                TraceEvent(
                    event_type="error",
                    component="agentic_rag",
                    data={"run_id": run_id, "error": str(e)},
                )
            )
            logs_path = self.export_traces_to_log(
                run_id, question, None, trace_log=False
            )
            return {
                "answer": f"Error processing query: {str(e)}",
                "run_id": run_id,
                "retrieved_docs": [],
                "retrieved_doc_ids": [],
                "usage": None,
                "logs": logs_path,
            }


def default_agentic_rag_client(
    settings: AgenticSettings | None = None,
    log_dir: Path | None = None,
    agent_api_url: str | None = None,
    agent_id: str | None = None,
    datasource_id: str | None = None,
    timeout: float | None = None,
    insecure: bool | None = None,
    trace_log: bool | None = None,
    fail_on_error: bool | None = None,
) -> AgenticRAG:
    """Create an AgenticRAG client that routes queries through the agent API."""
    return AgenticRAG(
        settings=settings,
        agent_api_url=agent_api_url,
        agent_id=agent_id,
        datasource_id=datasource_id,
        timeout=timeout,
        insecure=insecure,
        trace_log=trace_log,
        fail_on_error=fail_on_error,
        log_dir=log_dir,
    )
