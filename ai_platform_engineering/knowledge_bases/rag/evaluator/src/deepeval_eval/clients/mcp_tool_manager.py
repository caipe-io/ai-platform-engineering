from __future__ import annotations

import logging
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)


class DynamicMCPToolManager:
    """Creates an ephemeral MCP custom search tool before an evaluation run

    and deletes it afterwards, functioning as a context manager.

    Tool ID is based on the evaluation run_id for full traceability.
    """

    def __init__(
        self,
        rag_client: Any,
        run_id: str,
        datasource_ids: list[str] | None = None,
        semantic_weight: float = 0.5,
        extra_filters: dict[str, Any] | None = None,
        description: str = "",
        ttl_seconds: int = 7200,
    ) -> None:
        self.rag_client = rag_client
        self.tool_id = f"eval-{run_id[:16]}"
        self.datasource_ids = list(datasource_ids) if datasource_ids is not None else []
        self.semantic_weight = semantic_weight
        self.extra_filters = extra_filters or {}
        self.description = description or f"Ephemeral search tool for eval run {run_id}"
        self.ttl_seconds = ttl_seconds

    def _payload(self) -> dict[str, Any]:
        expires_at = int(time.time()) + self.ttl_seconds
        return {
            "tool_id": self.tool_id,
            "description": self.description,
            "parallel_searches": [
                {
                    "label": "results",
                    "datasource_ids": self.datasource_ids,
                    "semantic_weight": self.semantic_weight,
                    "extra_filters": self.extra_filters,
                }
            ],
            "allow_runtime_filters": True,
            "shared_with_org": True,
            "enabled": True,
            "expires_at": expires_at,
        }

    def create(self) -> str:
        """Provision the custom tool on RAG server via POST /v1/mcp/custom-tools."""
        if hasattr(self.rag_client, "ensure_authenticated"):
            self.rag_client.ensure_authenticated()

        session: requests.Session = getattr(self.rag_client, "session", requests)
        base_url = getattr(self.rag_client, "base_url", "").rstrip("/")
        url = f"{base_url}/v1/mcp/custom-tools"

        try:
            resp = session.post(url, json=self._payload(), timeout=30)
            if not resp.ok:
                raise RuntimeError(
                    f"Failed to create ephemeral MCP tool '{self.tool_id}': "
                    f"HTTP {resp.status_code} {resp.text}"
                )
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(
                f"Failed to create ephemeral MCP tool '{self.tool_id}': {exc}"
            ) from exc

        logger.info(f"Created ephemeral MCP custom tool '{self.tool_id}'")
        return self.tool_id

    def delete(self) -> None:
        """Best-effort cleanup of ephemeral tool via DELETE /v1/mcp/custom-tools/{tool_id}."""
        try:
            if hasattr(self.rag_client, "ensure_authenticated"):
                self.rag_client.ensure_authenticated()

            session: requests.Session = getattr(self.rag_client, "session", requests)
            base_url = getattr(self.rag_client, "base_url", "").rstrip("/")
            url = f"{base_url}/v1/mcp/custom-tools/{self.tool_id}"

            resp = session.delete(url, timeout=30)
            if resp.ok:
                logger.info(f"Deleted ephemeral MCP custom tool '{self.tool_id}'")
            else:
                logger.warning(
                    f"Failed to delete ephemeral MCP tool '{self.tool_id}': "
                    f"HTTP {resp.status_code}"
                )
        except Exception as exc:
            logger.warning(
                f"Error during cleanup of ephemeral MCP tool '{self.tool_id}': {exc}"
            )

    def __enter__(self) -> DynamicMCPToolManager:
        self.create()
        return self

    def __exit__(self, *_: Any) -> None:
        self.delete()
