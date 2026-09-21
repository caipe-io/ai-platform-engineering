# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""HTTP audit-service backend for Python services."""

from __future__ import annotations

import logging
import threading
from collections import deque
from typing import Any, Deque, Dict, List

import httpx

try:
    from loguru import logger
except ImportError:
    logger = logging.getLogger(__name__)

_FLUSH_INTERVAL_SECONDS = 1.0
_FLUSH_BATCH_SIZE = 100


class ServiceBackend:
    """Buffers audit events and submits JSON batches to audit-service."""

    def __init__(
        self,
        service_url: str,
        flush_interval: float = _FLUSH_INTERVAL_SECONDS,
        flush_batch_size: int = _FLUSH_BATCH_SIZE,
        timeout_seconds: float = 2.0,
    ) -> None:
        # assisted-by Codex Codex-sonnet-4-6
        self._service_url = service_url.rstrip("/")
        self._flush_interval = flush_interval
        self._flush_batch_size = flush_batch_size
        self._timeout_seconds = timeout_seconds
        self._buffer: Deque[Dict[str, Any]] = deque()
        self._lock = threading.Lock()
        self._schedule_flush()

    def write(self, event: Dict[str, Any]) -> None:
        """Buffer *event* for the next flush. Never raises."""
        with self._lock:
            self._buffer.append(event)
            if len(self._buffer) >= self._flush_batch_size:
                self._flush_locked()

    def _schedule_flush(self) -> None:
        timer = threading.Timer(self._flush_interval, self._timer_flush)
        timer.daemon = True
        timer.start()

    def _timer_flush(self) -> None:
        with self._lock:
            if self._buffer:
                self._flush_locked()
        self._schedule_flush()

    def _flush_locked(self) -> None:
        """Submit buffered events as one service batch. Caller holds the lock."""
        events: List[Dict[str, Any]] = list(self._buffer)
        self._buffer.clear()
        if not events:
            return

        try:
            with httpx.Client(timeout=self._timeout_seconds) as client:
                response = client.post(f"{self._service_url}/v1/audit/events", json={"events": events})
                response.raise_for_status()
            logger.debug(f"[audit/service] Flushed {len(events)} events")
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[audit/service] Failed to flush {len(events)} events: {exc}")
