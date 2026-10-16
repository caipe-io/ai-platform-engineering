"""Durable HTTP replay authorizes before lookup and validates before SSE success."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from urllib.parse import unquote

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from dynamic_agents.models import DynamicAgentConfig, UserContext
from dynamic_agents.routes import chat
from dynamic_agents.services.native_run_repository import (
    NativeExecutionRun,
    NativeReplayUnavailableError,
    NativeRunBusyError,
    NativeRunConflictError,
    NativeRunStorageError,
)

SCOPE = "agent_id=example-agent&conversation_id=original-thread"


@pytest.fixture
def environment(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    now = datetime.now(timezone.utc)
    run = NativeExecutionRun(
        run_id="original-run", owner_subject="example-owner", agent_id="example-agent", session_id="original-thread",
        turn_id="original-turn", fingerprint="private-payload-fingerprint", protocol="agui", status="completed",
        last_sequence=2, lease_id="private-authority-lease", created_at=now, updated_at=now,
    )
    streamed = []

    async def events(record: NativeExecutionRun, after: int = 0) -> AsyncGenerator[str, None]:
        streamed.append((record, after))
        yield f"id: {record.run_id}:2\nevent: CAIPE_RUN_STATUS\ndata: {{\"status\":\"completed\"}}\n\n"

    service = SimpleNamespace(
        get_run_status=AsyncMock(return_value=run), run_events=events, start_run=AsyncMock(return_value=run),
        coordinator=SimpleNamespace(repository=SimpleNamespace(replay=AsyncMock())),
    )
    factory = MagicMock(return_value=service)
    monkeypatch.setattr(chat, "AgentExecutionService", factory)
    permission = AsyncMock()
    monkeypatch.setattr(chat, "require_agent_use_permission", permission)
    agent = DynamicAgentConfig(
        _id="example-agent", name="Example", owner_id="owner@example.com", system_prompt="Assist the caller.",
        model={"id": "example-model", "provider": "example-provider"},
    )
    mongo = MagicMock(get_agent=MagicMock(return_value=agent))
    user = UserContext(email="owner@example.com")
    app = FastAPI()
    app.include_router(chat.router)
    app.dependency_overrides[chat.get_user_context] = lambda: user
    app.dependency_overrides[chat.get_mongo_service] = lambda: mongo
    return SimpleNamespace(
        client=TestClient(app), service=service, factory=factory, permission=permission,
        streamed=streamed, run=run, user=user, agent=agent, mongo=mongo,
    )


@pytest.mark.parametrize("path", ["/chat/runs", "/chat/runs/original-run", "/chat/runs/original-run/stream"])
@pytest.mark.parametrize("status", [401, 403, 503])
def test_run_reads_deny_before_durable_lookup_or_event_subscription(environment: SimpleNamespace, path: str, status: int) -> None:
    environment.permission.side_effect = HTTPException(status_code=status, detail="Agent use not permitted")
    response = environment.client.get(f"{path}?{SCOPE}&after=0")
    assert response.status_code == status
    environment.factory.assert_not_called()
    environment.service.get_run_status.assert_not_awaited()
    environment.service.coordinator.repository.replay.assert_not_awaited()
    assert environment.streamed == []


def test_run_status_omits_private_identity_payload_and_lease_authority(environment: SimpleNamespace) -> None:
    response = environment.client.get(f"/chat/runs/original-run?{SCOPE}")
    assert response.status_code == 200
    public = response.json()["run"]
    assert public["run_id"] == "original-run" and public["status"] == "completed"
    assert {"owner_subject", "fingerprint", "lease_id", "total_bytes", "frame_count", "cancel_requested"}.isdisjoint(public)
    assert "private" not in response.text
    environment.service.get_run_status.assert_awaited_once_with(
        "example-agent", "original-thread", environment.user, run_id="original-run",
    )


@pytest.mark.parametrize("path", ["/chat/runs/original-run", "/chat/runs/original-run/stream"])
def test_wrong_agent_or_session_run_is_not_found_before_subscription(environment: SimpleNamespace, path: str) -> None:
    environment.service.get_run_status.return_value = None
    response = environment.client.get(f"{path}?agent_id=other-agent&conversation_id=other-thread&after=0")
    assert response.status_code == 404
    environment.service.coordinator.repository.replay.assert_not_awaited()
    assert environment.streamed == []


def test_latest_empty_session_returns_no_run(environment: SimpleNamespace) -> None:
    environment.service.get_run_status.return_value = None
    response = environment.client.get(f"/chat/runs?{SCOPE}")
    assert response.status_code == 200 and response.json() == {"run": None}


def test_replay_keeps_original_protocol_cursor_and_header_identity(environment: SimpleNamespace) -> None:
    response = environment.client.get(f"/chat/runs/original-run/stream?{SCOPE}&after=1")
    assert response.status_code == 200
    assert response.headers["x-caipe-run-id"] == "original-run"
    assert response.headers["x-caipe-turn-id"] == "original-turn"
    assert response.headers["x-caipe-protocol"] == "agui"
    assert response.headers["content-type"].startswith("text/event-stream")
    environment.service.coordinator.repository.replay.assert_awaited_once_with(
        "original-run", 1, owner_subject="example-owner", agent_id="example-agent", session_id="original-thread",
    )
    assert environment.streamed == [(environment.run, 1)] and response.text.startswith("id: original-run:2\n")


@pytest.mark.parametrize("turn_id", ["opaque/turn:identifier", "turn-\u03b1", "turn\r\nX-Injected: invalid"])
@pytest.mark.parametrize("action", ["start", "resume", "replay"])
def test_opaque_turn_ids_remain_canonical_and_safe_in_response_headers(
    environment: SimpleNamespace, turn_id: str, action: str,
) -> None:
    environment.run.turn_id = turn_id
    if action == "replay":
        response = environment.client.get(f"/chat/runs/original-run/stream?{SCOPE}")
    else:
        body = {"agent_id": "example-agent", "conversation_id": "original-thread", "turn_id": turn_id}
        body.update({"resume_data": "{}"} if action == "resume" else {"message": "Original request"})
        response = environment.client.post(f"/chat/stream/{action}", json=body)
        assert environment.service.start_run.await_args.args[0].turn_id == turn_id
    assert response.status_code == 200
    header = response.headers["x-caipe-turn-id"]
    assert header.isascii() and "\r" not in header and "\n" not in header
    assert "x-injected" not in response.headers and unquote(header) == turn_id
    status = environment.client.get(f"/chat/runs/original-run?{SCOPE}")
    assert status.json()["run"]["turn_id"] == turn_id


@pytest.mark.parametrize("cursor", ["-1", "invalid"])
def test_invalid_cursor_is_rejected_before_replay_or_sse_headers(environment: SimpleNamespace, cursor: str) -> None:
    response = environment.client.get(f"/chat/runs/original-run/stream?{SCOPE}&after={cursor}")
    assert response.status_code == 422 and "x-caipe-run-id" not in response.headers
    environment.factory.assert_not_called()
    assert environment.streamed == []


@pytest.mark.parametrize("failure,status", [
    (NativeReplayUnavailableError("Stored events are missing"), 410),
    (NativeRunStorageError("Canonical storage unavailable"), 503),
])
def test_cursor_or_storage_failure_is_explicit_before_sse_success(
    environment: SimpleNamespace, failure: Exception, status: int,
) -> None:
    environment.service.coordinator.repository.replay.side_effect = failure
    response = environment.client.get(f"/chat/runs/original-run/stream?{SCOPE}&after=1")
    assert response.status_code == status and "x-caipe-run-id" not in response.headers
    assert environment.streamed == []


@pytest.mark.parametrize("resume", [False, True])
def test_streaming_request_preserves_stable_turn_identity_and_detached_run_headers(
    environment: SimpleNamespace, resume: bool,
) -> None:
    path = "/chat/stream/resume" if resume else "/chat/stream/start"
    body = {"agent_id": "example-agent", "conversation_id": "original-thread", "turn_id": "original-turn", "protocol": "agui"}
    body.update({"resume_data": '{"type":"form_input","values":{"value":"accepted"}}'} if resume else {"message": "Original request"})
    response = environment.client.post(path, json=body)
    assert response.status_code == 200 and response.headers["x-caipe-run-id"] == "original-run"
    assert response.headers["x-caipe-turn-id"] == "original-turn"
    turn, protocol = environment.service.start_run.await_args.args
    assert protocol == "agui" and turn.turn_id == "original-turn"
    assert turn.session_id == "original-thread" and turn.agent == environment.agent and turn.user == environment.user
    if resume:
        assert turn.resume_data == body["resume_data"] and turn.message is None
    else:
        assert turn.message == "Original request"
    assert environment.streamed == [(environment.run, 0)]


@pytest.mark.parametrize("failure,status", [
    (NativeRunBusyError("An active request owns this session"), 409),
    (NativeRunConflictError("The turn ID belongs to different input"), 409),
    (NativeRunStorageError("Canonical storage unavailable"), 503),
])
def test_start_admission_conflicts_and_storage_failure_never_fall_back_to_unpersisted_execution(
    environment: SimpleNamespace, failure: Exception, status: int,
) -> None:
    environment.service.start_run.side_effect = failure
    response = environment.client.post("/chat/stream/start", json={
        "agent_id": "example-agent", "conversation_id": "original-thread", "turn_id": "original-turn", "message": "Original request",
    })
    assert response.status_code == status and "x-caipe-run-id" not in response.headers
    assert environment.streamed == []
