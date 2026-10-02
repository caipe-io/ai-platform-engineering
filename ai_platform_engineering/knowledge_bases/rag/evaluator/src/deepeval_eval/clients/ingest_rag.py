"""Ingestion RAG Client for CAIPE knowledge base management.

Encapsulates datasource registration, heartbeat, job lifecycle, and
batch document ingestion with exponential backoff retries.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import requests

from deepeval_eval.auth.token_manager import OidcTokenManager

logger = logging.getLogger(__name__)

# Default constants for HTTP timeouts and retry backoff
DEFAULT_REQUEST_TIMEOUT_SECONDS: float = 60.0
DEFAULT_INGEST_BATCH_TIMEOUT_SECONDS: float = 600.0
DEFAULT_MAX_RETRIES: int = 4
DEFAULT_INITIAL_BACKOFF_SECONDS: float = 5.0
DEFAULT_BACKOFF_FACTOR: float = 2.0


def check_response(resp: requests.Response) -> requests.Response:
    if not resp.ok:
        raise RuntimeError(
            f"{resp.request.method} {resp.request.url} -> HTTP {resp.status_code}\n{resp.text}"
        )
    return resp


class IngestRagClient:
    """Dedicated client for RAG Server datasource and document ingestion endpoints."""

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        verify: bool | str = True,
        keycloak_url: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        default_timeout: float = DEFAULT_REQUEST_TIMEOUT_SECONDS,
        batch_timeout: float = DEFAULT_INGEST_BATCH_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        initial_backoff: float = DEFAULT_INITIAL_BACKOFF_SECONDS,
        backoff_factor: float = DEFAULT_BACKOFF_FACTOR,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.verify = verify
        self.session.headers.update({"Content-Type": "application/json"})
        self.default_timeout = default_timeout
        self.batch_timeout = batch_timeout
        self.max_retries = max_retries
        self.initial_backoff = initial_backoff
        self.backoff_factor = backoff_factor

        # Initialize OIDC token manager
        self.token_manager = OidcTokenManager(
            token_url=keycloak_url,
            client_id=client_id,
            client_secret=client_secret,
            static_token=token,
            verify=verify,
        )
        self._sync_auth_headers()

    def _sync_auth_headers(self) -> None:
        """Ensure session headers have the latest valid token."""
        auth_headers = self.token_manager.get_auth_headers()
        if auth_headers:
            self.session.headers.update(auth_headers)

    def register_ingestor(
        self, ingestor_type: str, ingestor_name: str, description: str
    ) -> tuple[str, int]:
        self._sync_auth_headers()
        resp = check_response(
            self.session.post(
                f"{self.base_url}/v1/ingestor/heartbeat",
                json={
                    "ingestor_type": ingestor_type,
                    "ingestor_name": ingestor_name,
                    "description": description,
                },
                timeout=self.default_timeout,
            )
        )
        data = resp.json()
        return data["ingestor_id"], int(data["max_documents_per_ingest"])

    def reset_datasource(self, datasource_id: str) -> None:
        self._sync_auth_headers()
        resp = self.session.delete(
            f"{self.base_url}/v1/datasource",
            params={"datasource_id": datasource_id},
            timeout=self.default_timeout,
        )
        if resp.status_code not in (200, 204, 404):
            check_response(resp)

    def upsert_datasource(
        self,
        datasource_id: str,
        name: str,
        ingestor_id: str,
        description: str,
        source_type: str,
    ) -> None:
        self._sync_auth_headers()
        payload = {
            "datasource_id": datasource_id,
            "name": name,
            "ingestor_id": ingestor_id,
            "description": description,
            "source_type": source_type,
            "last_updated": int(time.time()),
        }
        check_response(
            self.session.post(
                f"{self.base_url}/v1/datasource",
                json=payload,
                timeout=self.default_timeout,
            )
        )

    def open_job(self, datasource_id: str, total: int, message: str) -> str:
        self._sync_auth_headers()
        resp = check_response(
            self.session.post(
                f"{self.base_url}/v1/job",
                params={
                    "datasource_id": datasource_id,
                    "job_status": "in_progress",
                    "message": message,
                    "total": total,
                },
                timeout=self.default_timeout,
            )
        )
        return resp.json()["job_id"]

    def close_job(self, job_id: str, message: str) -> None:
        self._sync_auth_headers()
        resp = self.session.patch(
            f"{self.base_url}/v1/job/{job_id}",
            params={"job_status": "completed", "message": message},
            timeout=self.default_timeout,
        )
        if resp.status_code in (401, 403) and self.token_manager.has_client_credentials:
            logger.warning(
                "close_job received HTTP %d. Refreshing token and retrying...",
                resp.status_code,
            )
            self.token_manager.force_refresh()
            self._sync_auth_headers()
            resp = self.session.patch(
                f"{self.base_url}/v1/job/{job_id}",
                params={"job_status": "completed", "message": message},
                timeout=self.default_timeout,
            )
        check_response(resp)

    def ingest_batch(
        self,
        documents: list[dict[str, Any]],
        ingestor_id: str,
        datasource_id: str,
        job_id: str,
        max_retries: int | None = None,
        initial_backoff: float | None = None,
        backoff_factor: float | None = None,
        timeout: float | None = None,
    ) -> None:
        effective_max_retries = (
            max_retries if max_retries is not None else self.max_retries
        )
        effective_initial_backoff = (
            initial_backoff if initial_backoff is not None else self.initial_backoff
        )
        effective_backoff_factor = (
            backoff_factor if backoff_factor is not None else self.backoff_factor
        )
        effective_timeout = timeout if timeout is not None else self.batch_timeout

        for attempt in range(effective_max_retries + 1):
            self._sync_auth_headers()
            try:
                resp = self.session.post(
                    f"{self.base_url}/v1/ingest",
                    json={
                        "documents": documents,
                        "ingestor_id": ingestor_id,
                        "datasource_id": datasource_id,
                        "job_id": job_id,
                    },
                    timeout=effective_timeout,
                )
                if resp.status_code in (429, 500, 502, 503, 504):
                    raise requests.HTTPError(
                        f"HTTP {resp.status_code}: {resp.text}", response=resp
                    )
                check_response(resp)
                break
            except (requests.exceptions.RequestException, RuntimeError) as exc:
                if attempt < effective_max_retries:
                    backoff = effective_initial_backoff * (
                        effective_backoff_factor**attempt
                    )
                    logger.warning(
                        f"ingest_batch attempt {attempt + 1}/{effective_max_retries + 1} failed with error: {exc}. "
                        f"Retrying in {backoff:.1f}s..."
                    )
                    time.sleep(backoff)
                else:
                    logger.exception(
                        f"ingest_batch failed after {effective_max_retries + 1} attempts: {exc}"
                    )
                    raise

        for endpoint in ("increment-document-count", "increment-progress"):
            resp = self.session.post(
                f"{self.base_url}/v1/job/{job_id}/{endpoint}",
                params={"increment": len(documents)},
                timeout=self.default_timeout,
            )
            if resp.status_code >= 500:
                check_response(resp)


def build_ingest_rag_client(
    caipe_settings: Any | None = None,
) -> IngestRagClient:
    """Instantiate IngestRagClient from CaipeClientSettings or environment variables."""
    from deepeval_eval.core.config import CaipeClientSettings

    settings = caipe_settings or CaipeClientSettings()

    base_url = settings.base_url or os.getenv("CAIPE_BASE_URL", "http://localhost:9446")
    token = (
        settings.auth_token.get_secret_value()
        if hasattr(settings.auth_token, "get_secret_value")
        else (settings.auth_token or os.getenv("CAIPE_AUTH_TOKEN"))
    )
    verify = not settings.insecure
    keycloak_url = settings.keycloak_url or os.getenv("KEYCLOAK_URL")
    client_id = settings.client_id or os.getenv("CAIPE_CLIENT_ID")
    client_secret = (
        settings.client_secret.get_secret_value()
        if hasattr(settings.client_secret, "get_secret_value")
        else (settings.client_secret or os.getenv("CAIPE_CLIENT_SECRET"))
    )

    return IngestRagClient(
        base_url=base_url,
        token=token,
        verify=verify,
        keycloak_url=keycloak_url,
        client_id=client_id,
        client_secret=client_secret,
    )
