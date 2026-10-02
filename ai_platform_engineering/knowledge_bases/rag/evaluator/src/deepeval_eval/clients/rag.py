"""Base RAG Client interface and adapter classes for DeepEval evaluation.

This module provides standard abstractions for executing queries against different
RAG backends (Standard CAIPE RAG, Agentic RAG, and Precomputed RAG) and returning
a unified ``RagQueryResult``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    pass


@dataclass
class RagQueryResult:
    """Standardized result returned by RAG client implementations."""

    answer: str
    contexts: list[str]
    sources: list[dict[str, Any]]
    retrieved_doc_ids: list[str]
    latency_sec: float = 0.0
    latency_ms: float = 0.0
    log_file: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    actual_input: str = ""


class BaseRagClient(ABC):
    """Abstract base class for all evaluation RAG clients."""

    @abstractmethod
    def query(
        self,
        question: str,
        top_k: int = 3,
        **kwargs: Any,
    ) -> RagQueryResult:
        """Execute a query against the RAG system and return a standardized result."""
        pass


class AgenticRagAdapter(BaseRagClient):
    """Adapter wrapping AgenticRetriever for agentic evaluation runs."""

    def __init__(
        self,
        agent_url: str | None = None,
        results_dir: Any = None,
        fail_on_error: bool | None = None,
        datasource_id: str | None = None,
        agent_id: str | None = None,
        insecure: bool | None = None,
        trace_log: bool | None = None,
        agentic_settings: Any | None = None,
        db_manager: Any | None = None,
        prompt_args: dict[str, Any] | None = None,
        search_tool_name: str | None = None,
        fetch_tool_name: str | None = None,
        user_subject: str | None = None,
        user_token: str | None = None,
    ) -> None:
        from deepeval_eval.core.config import DEFAULT_RESULTS_DIR, AgenticSettings

        settings = (
            agentic_settings
            if isinstance(agentic_settings, AgenticSettings)
            else AgenticSettings()
        )

        agentic_rag_module = __import__(
            "deepeval_eval.engine.agentic_rag", fromlist=["AgenticRetriever"]
        )
        log_dir: Path = (
            results_dir
            if isinstance(results_dir, Path)
            else Path(results_dir)
            if results_dir is not None
            else DEFAULT_RESULTS_DIR
        )
        self.datasource_id = datasource_id
        self.search_tool_name = search_tool_name
        self.fetch_tool_name = fetch_tool_name
        self.agent_id = agent_id
        self.db_manager = db_manager
        self.prompt_args = prompt_args or {}
        self.user_subject = user_subject
        self.user_token = user_token

        resolved_agent_url = agent_url or settings.agent_url
        resolved_trace_log = trace_log if trace_log is not None else settings.trace_log
        retriever_kwargs: dict[str, Any] = {
            "agent_api_url": resolved_agent_url,
            "timeout": settings.timeout,
            "log_dir": log_dir,
            "fail_on_error": (
                fail_on_error if fail_on_error is not None else settings.fail_on_error
            ),
            "datasource_id": datasource_id,
            "agent_id": agent_id,
            "trace_log": resolved_trace_log,
            "user_subject": user_subject,
            "user_token": user_token,
        }
        if db_manager is not None:
            retriever_kwargs["db_manager"] = db_manager
        if prompt_args is not None:
            retriever_kwargs["prompt_args"] = prompt_args
        if search_tool_name is not None:
            retriever_kwargs["search_tool_name"] = search_tool_name
        if fetch_tool_name is not None:
            retriever_kwargs["fetch_tool_name"] = fetch_tool_name
        if insecure is not None:
            retriever_kwargs["insecure"] = insecure

        self.retriever = agentic_rag_module.AgenticRetriever(**retriever_kwargs)

    def query(
        self,
        question: str,
        top_k: int = 3,
        max_context_chars: int = 12000,
        datasource_id: str | None = None,
        **kwargs: Any,
    ) -> RagQueryResult:
        effective_ds_id = (
            datasource_id
            if datasource_id is not None
            else kwargs.get("datasource_id", self.datasource_id)
        )
        dataset_name = kwargs.get("dataset_name")
        experiment_name = kwargs.get("experiment_name")
        run_id = kwargs.get("run_id")
        prompt_style = kwargs.get("prompt_style")
        prompt_args = kwargs.get("prompt_args")
        search_tool_name = kwargs.get("search_tool_name", self.search_tool_name)
        fetch_tool_name = kwargs.get("fetch_tool_name", self.fetch_tool_name)

        extra_kwargs: dict[str, Any] = {}
        if prompt_style is not None:
            extra_kwargs["prompt_style"] = prompt_style
        if prompt_args is not None:
            extra_kwargs["prompt_args"] = prompt_args
        if search_tool_name is not None:
            extra_kwargs["search_tool_name"] = search_tool_name
        if fetch_tool_name is not None:
            extra_kwargs["fetch_tool_name"] = fetch_tool_name

        agentic_result = self.retriever.retrieve(
            question,
            k=top_k,
            datasource_id=effective_ds_id,
            dataset_name=dataset_name,
            experiment_name=experiment_name,
            run_id=run_id,
            log_file_prefix=kwargs.get("log_file_prefix"),
            **extra_kwargs,
        )
        answer = agentic_result.answer
        trimmed_contexts = [c[:max_context_chars] for c in agentic_result.contexts]
        sources = []
        for c_idx in range(len(agentic_result.contexts)):
            doc_id = None
            if c_idx < len(self.retriever.documents_metadata):
                doc_id = self.retriever.documents_metadata[c_idx].get("doc_id")
            if not doc_id:
                doc_id = c_idx
            sources.append({"document_id": doc_id})

        latency_sec = agentic_result.latency_ms / 1000.0 if agentic_result else 0.0
        log_file_val = (
            (getattr(agentic_result, "log_file", None) or "") if agentic_result else ""
        )
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
            latency_ms=agentic_result.latency_ms if agentic_result else 0.0,
            log_file=log_file_val,
            input_tokens=agentic_result.input_tokens if agentic_result else 0,
            output_tokens=agentic_result.output_tokens if agentic_result else 0,
            total_tokens=agentic_result.total_tokens if agentic_result else 0,
            actual_input=getattr(agentic_result, "actual_input", "") or question,
        )
