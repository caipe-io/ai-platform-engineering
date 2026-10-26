"""Cancellation observation must not replace native execution lease authority."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from pymongo.errors import AutoReconnect

from dynamic_agents.services import native_run_coordinator
from dynamic_agents.services.native_run_coordinator import NativeRunCoordinator
from dynamic_agents.services.native_run_repository import NativeExecutionRun, NativeRunStorageError


def _run(**updates: object) -> NativeExecutionRun:
    return NativeExecutionRun(
        run_id="example-run", agent_id="primary", session_id="example-session", owner_subject="example-user",
        turn_id="example-turn", fingerprint="example-fingerprint", protocol="agui",
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    ).model_copy(update=updates)


async def test_transient_cancellation_read_does_not_cancel_before_confirmed_remote_stop(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(native_run_coordinator, "POLL_SECONDS", 0)
    unavailable = NativeRunStorageError("Temporary database observation failure")
    unavailable.__cause__ = AutoReconnect("Temporary connection loss")
    owner = MagicMock()
    calls = 0

    async def observe(*_args: object, **_kwargs: object) -> NativeExecutionRun:
        nonlocal calls
        calls += 1
        owner.cancel.assert_not_called()
        if calls == 1:
            raise unavailable
        return _run(cancel_requested=True)

    repository = MagicMock(get=AsyncMock(side_effect=observe))
    await NativeRunCoordinator(repository)._watch_cancel(_run(), owner)
    assert repository.get.await_count == 2
    owner.cancel.assert_called_once()


@pytest.mark.parametrize("result", [None, NativeRunStorageError("Invalid persisted state"), _run(status="interrupted")])
async def test_confirmed_loss_or_non_database_observation_error_stops_producer(
    monkeypatch: pytest.MonkeyPatch, result: NativeExecutionRun | Exception | None,
) -> None:
    monkeypatch.setattr(native_run_coordinator, "POLL_SECONDS", 0)
    repository = MagicMock(get=AsyncMock(side_effect=result) if isinstance(result, Exception) else AsyncMock(return_value=result))
    owner = MagicMock()
    await NativeRunCoordinator(repository)._watch_cancel(_run(), owner)
    owner.cancel.assert_called_once()
