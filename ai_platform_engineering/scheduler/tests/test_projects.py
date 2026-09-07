from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from caipe_scheduler.app import validate_project
from caipe_scheduler.auth import CallerIdentity
from caipe_scheduler.config import Settings


CALLER = CallerIdentity(sub="sub-a", email="a@example.test", token="bearer")


def test_project_validation_forwards_caller_and_accepts_owned_project(monkeypatch) -> None:
  calls: list[tuple[str, dict]] = []

  def fake_get(url: str, **kwargs):
    calls.append((url, kwargs))
    payload = {"data": {"items": [{"id": "project_a", "name": "Project A"}]}}
    return SimpleNamespace(status_code=200, json=lambda: payload)

  monkeypatch.setattr("caipe_scheduler.app.httpx.get", fake_get)
  validate_project("agent-a", "project_a", CALLER, Settings())

  assert len(calls) == 1
  assert all(call[1]["headers"] == {"Authorization": "Bearer bearer"} for call in calls)


def test_project_validation_fails_closed_for_invalid_or_unlisted_id(monkeypatch) -> None:
  with pytest.raises(HTTPException) as invalid:
    validate_project("agent-a", "../project", CALLER, Settings())
  assert invalid.value.status_code == 422

  monkeypatch.setattr(
    "caipe_scheduler.app.httpx.get",
    lambda *args, **kwargs: SimpleNamespace(
      status_code=200,
      json=lambda: {"data": {"items": []}},
    ),
  )
  with pytest.raises(HTTPException) as unavailable:
    validate_project("agent-a", "project_a", CALLER, Settings())
  assert unavailable.value.status_code == 422


def test_project_validation_rejects_platform_disabled(monkeypatch) -> None:
  monkeypatch.setattr(
    "caipe_scheduler.app.httpx.get",
    lambda *args, **kwargs: SimpleNamespace(status_code=404, json=lambda: {}),
  )
  with pytest.raises(HTTPException) as unsupported:
    validate_project("agent-a", "project_a", CALLER, Settings())
  assert unsupported.value.status_code == 422
