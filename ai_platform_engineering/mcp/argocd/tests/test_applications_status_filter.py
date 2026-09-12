"""Tests for server-side application status filtering."""

import asyncio
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ.setdefault("ARGOCD_API_URL", "https://argocd.example.test")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.api_v1_applications import list_applications


def _application(name: str, sync_status: str, health_status: str) -> dict:
    return {
        "metadata": {"name": name, "namespace": "example"},
        "spec": {
            "project": "example",
            "source": {
                "repoURL": "https://github.com/example/example",
                "path": ".",
                "targetRevision": "main",
            },
        },
        "status": {
            "sync": {"status": sync_status},
            "health": {"status": health_status},
        },
    }


def _applications() -> list[dict]:
    return [
        _application("healthy", "Synced", "Healthy"),
        _application("degraded", "OutOfSync", "Degraded"),
        _application("missing", "Unknown", "Missing"),
        _application("progressing", "Synced", "Progressing"),
    ]


def test_filters_multiple_health_statuses_before_pagination() -> None:
    request = AsyncMock(return_value=(True, {"items": _applications()}))

    with patch("tools.api_v1_applications.make_api_request", request):
        result = asyncio.run(
            list_applications(
                health_status="degraded, MISSING",
                summary_only=True,
                page=1,
                page_size=20,
            )
        )

    assert [application["name"] for application in result["items"]] == ["degraded", "missing"]
    assert result["pagination"]["total_items"] == 2
    assert result["pagination"]["total_pages"] == 1
    request.assert_awaited_once()


def test_combines_sync_and_health_status_filters() -> None:
    request = AsyncMock(return_value=(True, {"items": _applications()}))

    with patch("tools.api_v1_applications.make_api_request", request):
        result = asyncio.run(
            list_applications(
                sync_status="OutOfSync",
                health_status="Degraded",
                summary_only=False,
            )
        )

    assert [application["metadata"]["name"] for application in result["items"]] == ["degraded"]
    assert result["pagination"]["total_items"] == 1


def test_paginates_filtered_results() -> None:
    request = AsyncMock(return_value=(True, {"items": _applications()}))

    with patch("tools.api_v1_applications.make_api_request", request):
        result = asyncio.run(
            list_applications(
                health_status="Degraded,Missing",
                summary_only=True,
                page=2,
                page_size=1,
            )
        )

    assert [application["name"] for application in result["items"]] == ["missing"]
    assert result["pagination"] == {
        "page": 2,
        "page_size": 1,
        "total_items": 2,
        "total_pages": 2,
        "has_next": False,
        "has_prev": True,
        "showing_from": 2,
        "showing_to": 2,
    }
