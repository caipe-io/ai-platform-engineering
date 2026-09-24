from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from deepeval.test_case import LLMTestCase


class ResultSink(Protocol):
    """Pure structural contract for evaluation result output sinks."""

    def save(
        self,
        results_dir: Path,
        prefix: str,
        results: list[dict[str, Any]],
        evaluation_time: float,
        config_args: dict[str, Any],
    ) -> None:
        """Save evaluation results and summary stats."""
        ...


class EvaluatorMetric(Protocol):
    """Pure structural protocol contract for all evaluation metrics (deterministic and LLM-evaluated)."""

    name: str
    score: float | None
    reason: str | None
    success: bool | None
    threshold: float

    def measure(self, test_case: LLMTestCase) -> float: ...

    def get_reason(self) -> str: ...

    def is_successful(self) -> bool: ...
