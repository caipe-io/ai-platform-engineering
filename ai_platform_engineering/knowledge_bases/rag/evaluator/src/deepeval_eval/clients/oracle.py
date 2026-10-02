"""Oracle RAG client for DeepEval evaluation.

This module provides ``OracleRagClient``, a thin RAG client interface (matching ``caipe_client.py``)
that executes gold-source oracle retrieval via CAIPE RAG and handles answer generation.
All evaluation loop execution, metrics, and result writing are handled by ``deepeval_evaluator.py``.
"""

from __future__ import annotations

import time

from deepeval_eval.clients.llm import OpenAICompatibleClient
from deepeval_eval.clients.rag import BaseRagClient, RagQueryResult
from deepeval_eval.clients.search_rag import (
    SearchRagClient,
    extract_contexts_and_sources,
)
from deepeval_eval.core.prompt_style import PromptStyle, build_prompt


class OracleRagClient(BaseRagClient):
    """RAG client for oracle (question + reference) gold-source retrieval and answer building."""

    def __init__(self, caipe_client: SearchRagClient) -> None:
        self.caipe_client = caipe_client

    def query(
        self,
        question: str,
        reference: str,
        datasource_id: str | None,
        top_k: int = 3,
        answer_mode: str = "generate",
        dataset_name: str = "enterprise",
        prompt_style: str | PromptStyle | None = None,
        llm_client: OpenAICompatibleClient | None = None,
        max_context_chars: int = 12000,
    ) -> RagQueryResult:
        """Query CAIPE using oracle (question + reference) and generate/select response."""
        start_time = time.time()
        reference_query = f"{question} {reference}".strip()

        results = self.caipe_client.query_raw(
            reference_query, datasource_id=datasource_id, limit=top_k
        )
        contexts, sources = extract_contexts_and_sources(results)
        trimmed_contexts = [c[:max_context_chars] for c in contexts]

        if answer_mode == "ground_truth":
            answer = reference
        elif answer_mode == "generate":
            if llm_client is None:
                raise ValueError(
                    "llm_client is required when answer_mode is 'generate'"
                )
            prompt = build_prompt(prompt_style, question, trimmed_contexts)
            answer = str(llm_client.generate(prompt))
        else:
            raise ValueError(
                f"Invalid answer_mode: {answer_mode}. Must be 'generate' or 'ground_truth'"
            )

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
            log_file="",
        )
