"""Base protocol and bundle definitions for evaluation dataset ingestion."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import argparse


@dataclass
class DatasetBundle:
    """Standard container for dataset documents, questions, and export handlers."""

    datasource_id: str
    datasource_name: str
    ingestor_type: str
    ingestor_name: str
    docs: list[Any]
    selected_questions: list[Any]
    docs_by_id: dict[str, Any]
    payloads: list[dict[str, Any]]
    corpus_jsonl_name: str
    corpus_csv_name: str
    questions_jsonl_name: str
    questions_csv_name: str
    write_corpus_fn: Callable[[list[Any], Path, Path], None]
    write_questions_fn: Callable[[list[Any], dict[str, Any], Path, Path], None]
    job_description: str
    datasource_description: str


class BaseDatasetIngestor(ABC):
    """Abstract base class for dataset ingestion handlers."""

    @abstractmethod
    def prepare_bundle(self, args: argparse.Namespace) -> DatasetBundle:
        """Parse CLI arguments, load raw documents & questions, and return a DatasetBundle."""
        pass
