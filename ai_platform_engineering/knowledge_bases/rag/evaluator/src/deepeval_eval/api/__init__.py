"""API application, authentication, job queue, and telemetry."""

from typing import Any

__all__ = ["app", "run_server"]


def __getattr__(name: str) -> Any:
    if name in ("app", "run_server"):
        from deepeval_eval.api.app import app, run_server

        if name == "app":
            return app
        return run_server
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
