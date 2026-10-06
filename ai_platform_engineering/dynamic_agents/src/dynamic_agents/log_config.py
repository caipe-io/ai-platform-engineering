"""Logging configuration for Dynamic Agents.

This module configures logging for the dynamic_agents package with:
- Conversation ID context for request tracing
- Custom format with [dynamic_agents] prefix
- Isolation from third-party logging
- Configurable log level via LOG_LEVEL env var
"""

import logging
import os
import sys
from contextvars import ContextVar

# Conversation context for logging - set in route handlers
conversation_id_var: ContextVar[str] = ContextVar("conversation_id", default="-")

LOG_FORMAT = "%(asctime)s %(levelname)s [dynamic_agents] conv=%(conversation_id)s %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# Valid log levels
LOG_LEVELS = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL,
}


def get_log_level() -> int:
    """Get log level from LOG_LEVEL env var, defaults to INFO."""
    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    return LOG_LEVELS.get(level_name, logging.INFO)


class ConversationContextFilter(logging.Filter):
    """Logging filter that adds conversation_id to log records."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.conversation_id = conversation_id_var.get()
        return True


class HealthEndpointFilter(logging.Filter):
    """Suppress INFO-level access logs for health check endpoints."""

    _HEALTH_PATHS = ("/healthz", "/health", "/ready", "/metrics")

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno >= logging.WARNING:
            return True
        msg = record.getMessage()
        return not any(path in msg for path in self._HEALTH_PATHS)


def setup_logging() -> logging.Logger:
    """Configure logging for the dynamic_agents package.

    Sets up a dedicated handler for the 'dynamic_agents' logger that:
    - Uses our own format with [dynamic_agents] prefix
    - Includes conversation_id for request tracing
    - Does not propagate to root logger (avoids third-party root formatting)
    - Log level configurable via LOG_LEVEL env var (DEBUG, INFO, WARNING, ERROR, CRITICAL)

    Returns:
        The configured logger for the dynamic_agents package.
    """
    log_level = get_log_level()
    pkg_logger = logging.getLogger("dynamic_agents")
    pkg_logger.setLevel(log_level)

    # Only add handler if not already configured (avoid duplicates on reload)
    if not pkg_logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setLevel(log_level)
        formatter = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATE_FORMAT)
        handler.setFormatter(formatter)
        handler.addFilter(ConversationContextFilter())
        pkg_logger.addHandler(handler)

    # Don't propagate to root logger (third-party libraries may reconfigure it)
    pkg_logger.propagate = False

    # Suppress health endpoint access logs from uvicorn
    logging.getLogger("uvicorn.access").addFilter(HealthEndpointFilter())

    # Suppress noisy langfuse media parsing errors (non-fatal, upstream bug:
    # langfuse tries to parse strings starting with "data:" as base64 URIs)
    class _LangfuseMediaFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            return "Error parsing base64 data URI" not in record.getMessage()

    logging.getLogger("langfuse").addFilter(_LangfuseMediaFilter())

    return pkg_logger
