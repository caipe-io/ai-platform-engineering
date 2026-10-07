"""Prometheus metric definitions for Dynamic Agents.

All collectors are created once on the singleton ``AgentMetrics`` instance.
Import ``metrics`` for direct access.
"""

import logging

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, Summary, generate_latest

logger = logging.getLogger(__name__)


class AgentMetrics:
    """Centralised Prometheus metrics for the Dynamic Agents service."""

    _instance: "AgentMetrics | None" = None

    def __new__(cls) -> "AgentMetrics":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return

        # -----------------------------------------------------------------
        # HTTP request metrics
        # -----------------------------------------------------------------
        self.request_duration_seconds = Histogram(
            "da_request_duration_seconds",
            "HTTP request duration in seconds",
            labelnames=["method", "path", "status", "agent_name"],
            buckets=(0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 30, 60, 120, 300, float("inf")),
        )
        self.active_requests = Gauge(
            "da_active_requests",
            "Number of in-flight requests",
        )
        self.active_streams = Gauge(
            "da_active_streams",
            "Number of agent turns currently streaming",
        )

        # -----------------------------------------------------------------
        # LLM call metrics (recorded by MetricsAgentMiddleware)
        # -----------------------------------------------------------------
        self.llm_call_duration_seconds = Histogram(
            "da_llm_call_duration_seconds",
            "LLM model call duration in seconds (histogram)",
            labelnames=["agent_name", "model_id", "status"],
            buckets=(0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 30, 60, 120, float("inf")),
        )
        self.llm_call_duration_summary = Summary(
            "da_llm_call_duration_summary_seconds",
            "LLM model call duration in seconds (exact quantiles)",
            labelnames=["agent_name", "model_id", "status"],
        )
        self.llm_calls_total = Counter(
            "da_llm_calls_total",
            "Total LLM model calls",
            labelnames=["agent_name", "model_id", "status"],
        )
        self.llm_input_tokens_total = Counter(
            "da_llm_input_tokens_total",
            "Total input tokens reported by LLM providers",
            labelnames=["agent_name", "model_id"],
        )
        self.llm_output_tokens_total = Counter(
            "da_llm_output_tokens_total",
            "Total output tokens reported by LLM providers",
            labelnames=["agent_name", "model_id"],
        )

        # -----------------------------------------------------------------
        # Tool call metrics (recorded by MetricsAgentMiddleware)
        # -----------------------------------------------------------------
        self.tool_call_duration_seconds = Histogram(
            "da_tool_call_duration_seconds",
            "Tool call duration in seconds (histogram)",
            labelnames=["tool_name", "agent_name", "status"],
            buckets=(0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 30, 60, float("inf")),
        )
        self.tool_call_duration_summary = Summary(
            "da_tool_call_duration_summary_seconds",
            "Tool call duration in seconds (exact quantiles)",
            labelnames=["tool_name", "agent_name", "status"],
        )
        self.tool_calls_total = Counter(
            "da_tool_calls_total",
            "Total tool calls",
            labelnames=["tool_name", "agent_name", "status"],
        )

        # -----------------------------------------------------------------
        # Input file metrics
        # -----------------------------------------------------------------
        self.dropped_input_files_total = Counter(
            "da_dropped_input_files_total",
            "Total input files attached but dropped from the user turn",
            labelnames=["agent_name", "model_id", "reason"],
        )

        # -----------------------------------------------------------------
        # Runtime init metrics
        # -----------------------------------------------------------------
        self.runtime_init_duration_seconds = Histogram(
            "da_runtime_init_duration_seconds",
            "Agent runtime initialisation duration in seconds (histogram)",
            labelnames=["agent_name"],
            buckets=(0.25, 0.5, 1, 2, 3, 5, 10, 20, 30, 60, float("inf")),
        )
        self.runtime_init_duration_summary = Summary(
            "da_runtime_init_duration_summary_seconds",
            "Agent runtime initialisation duration in seconds (exact quantiles)",
            labelnames=["agent_name"],
        )

        # -----------------------------------------------------------------
        # Turn metrics (full end-to-end stream/resume duration)
        # -----------------------------------------------------------------
        self.turn_duration_seconds = Histogram(
            "da_turn_duration_seconds",
            "Full end-to-end turn duration in seconds (histogram)",
            labelnames=["agent_name", "model_id", "turn_type", "status"],
            buckets=(0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, float("inf")),
        )
        self.turn_duration_summary = Summary(
            "da_turn_duration_summary_seconds",
            "Full end-to-end turn duration in seconds (exact quantiles)",
            labelnames=["agent_name", "model_id", "turn_type", "status"],
        )
        self.turns_total = Counter(
            "da_turns_total",
            "Total turns (stream or resume)",
            labelnames=["agent_name", "model_id", "turn_type", "status"],
        )
        self.turn_time_to_first_response_seconds = Histogram(
            "da_turn_time_to_first_response_seconds",
            "Time from turn start to the first user-visible text response",
            labelnames=["agent_name", "model_id", "turn_type"],
            buckets=(0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 30, 60, 120, float("inf")),
        )

        # -----------------------------------------------------------------
        # Runtime cache saturation metrics
        # -----------------------------------------------------------------
        self.runtime_cache_entries = Gauge(
            "da_runtime_cache_entries",
            "Number of agent runtimes currently held in the shared cache",
        )
        self.runtime_cache_capacity = Gauge(
            "da_runtime_cache_capacity",
            "Configured maximum number of runtimes in the shared cache",
        )
        self.runtime_cache_pending_initializations = Gauge(
            "da_runtime_cache_pending_initializations",
            "Number of agent runtime initializations currently in progress",
        )
        self.runtime_cache_evictions_total = Counter(
            "da_runtime_cache_evictions_total",
            "Total agent runtime cache evictions",
            labelnames=["reason"],
        )
        self.runtime_cache_capacity_rejections_total = Counter(
            "da_runtime_cache_capacity_rejections_total",
            "Total requests rejected because every cached runtime was actively streaming",
        )

        self._initialized = True
        logger.info("AgentMetrics initialised")

    # Convenience helpers ------------------------------------------------

    def generate(self) -> bytes:
        """Generate Prometheus text exposition."""
        return generate_latest()

    @staticmethod
    def content_type() -> str:
        """Content-Type header for the metrics response."""
        return CONTENT_TYPE_LATEST


# Singleton
metrics = AgentMetrics()
