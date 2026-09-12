from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from deepeval_eval.sinks.protocol import ResultSink


class CompositeResultSink:
    """Composite result sink that broadcasts save calls across multiple registered sinks."""

    def __init__(self, sinks: Sequence[ResultSink]):
        self.sinks = list(sinks)

    def add_sink(self, sink: ResultSink) -> None:
        """Register an additional result sink."""
        self.sinks.append(sink)

    def save(
        self,
        results_dir: Path,
        prefix: str,
        results: list[dict[str, Any]],
        evaluation_time: float,
        config_args: dict[str, Any],
    ) -> None:
        """Broadcast result save operation to all registered sinks."""
        for sink in self.sinks:
            sink.save(results_dir, prefix, results, evaluation_time, config_args)
