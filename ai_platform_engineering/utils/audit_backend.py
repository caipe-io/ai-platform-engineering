# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
Audit backend factory.

Reads ``AUDIT_LOG_BACKEND`` once at first call and returns a process-wide
singleton that all audit write-paths use. Python services no longer own local,
S3, or direct database audit storage; the supported backend is:

  - ``service`` (default) — posts JSON batches to audit-service
  - ``off`` / ``disabled`` / ``none`` — drops audit events intentionally

The ``AuditBackend`` Protocol defines a single ``write(event)`` method.
Implementations must never raise; they catch all errors and log them.
"""

import logging
import os
import threading
from typing import Any, Dict, Optional, Protocol, runtime_checkable

try:
    from loguru import logger
except ImportError:
    logger = logging.getLogger(__name__)

_BACKEND_LOCK = threading.Lock()
_backend: Optional["AuditBackend"] = None


@runtime_checkable
class AuditBackend(Protocol):
    """Fire-and-forget audit event writer."""

    def write(self, event: Dict[str, Any]) -> None:
        """Persist *event*. Must never raise; log errors internally."""
        pass


class NoopAuditBackend:
    """Drop audit events when audit collection is intentionally disabled."""

    def write(self, event: Dict[str, Any]) -> None:
        return None


def get_audit_backend() -> "AuditBackend":
    """Return the process-wide singleton backend (lazy-initialised, thread-safe)."""
    global _backend
    if _backend is not None:
        return _backend
    with _BACKEND_LOCK:
        if _backend is not None:
            return _backend
        _backend = _create_backend()
    return _backend


def _create_backend() -> "AuditBackend":
    """Read ``AUDIT_LOG_BACKEND`` and instantiate the matching backend."""
    backend_name = os.getenv("AUDIT_LOG_BACKEND", "service").strip().lower()

    if backend_name in {"off", "disabled", "none"}:
        logger.warning("[audit] backend=off; audit events will be dropped")
        return NoopAuditBackend()

    if backend_name != "service":
        logger.warning(
            f"[audit] unsupported AUDIT_LOG_BACKEND={backend_name!r}; "
            "local/S3 storage moved to audit-service, so audit events will be dropped"
        )
        return NoopAuditBackend()

    from ai_platform_engineering.utils.audit_backends.service_backend import ServiceBackend

    service_url = os.getenv("AUDIT_SERVICE_URL", "http://audit-service:8010")
    flush_interval = float(os.getenv("AUDIT_SERVICE_FLUSH_INTERVAL_SECONDS", "1"))
    flush_batch_size = int(os.getenv("AUDIT_SERVICE_FLUSH_BATCH_SIZE", "100"))
    instance: AuditBackend = ServiceBackend(
        service_url=service_url,
        flush_interval=flush_interval,
        flush_batch_size=flush_batch_size,
    )
    logger.info(f"[audit] backend=service url={service_url}")
    return instance
