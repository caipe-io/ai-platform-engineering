"""Logging configuration for Autonomous Agents."""

import logging
import os
import sys
from contextvars import ContextVar

task_id_var: ContextVar[str] = ContextVar("task_id", default="-")

LOG_FORMAT = "%(asctime)s %(levelname)s [autonomous_agents] task=%(task_id)s %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

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


class TaskContextFilter(logging.Filter):
    """Logging filter that adds task_id to log records."""
    def filter(self, record: logging.LogRecord) -> bool:
        record.task_id = task_id_var.get()
        return True


def setup_logging() -> logging.Logger:
    """Setup logging for the autonomous_agents."""
    log_level = get_log_level()
    pkg_logger = logging.getLogger("autonomous_agents")
    pkg_logger.setLevel(log_level)

    if not pkg_logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setLevel(log_level)
        formatter = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATE_FORMAT)
        handler.setFormatter(formatter)
        handler.addFilter(TaskContextFilter())
        pkg_logger.addHandler(handler)

    pkg_logger.propagate = False
    return pkg_logger
