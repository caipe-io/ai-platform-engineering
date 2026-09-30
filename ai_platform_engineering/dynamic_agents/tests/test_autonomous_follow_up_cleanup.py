"""Worker supervision and shutdown must survive unexpected recovery failures."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from bson.errors import BSONError
from fastapi import FastAPI, HTTPException

from dynamic_agents.config import Settings
from dynamic_agents.services import autonomous_follow_up_cleanup as cleanup


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [KeyError("bad journal"), BSONError("bad BSON"), RuntimeError("unexpected")])
async def test_worker_retries_unexpected_errors_and_propagates_cancellation(
    monkeypatch: pytest.MonkeyPatch, failure: Exception,
) -> None:
    reap = MagicMock(side_effect=[failure, None])
    monkeypatch.setattr(cleanup, "reap_copy_attempts", reap)
    pause = AsyncMock(side_effect=[None, asyncio.CancelledError])
    monkeypatch.setattr(cleanup.asyncio, "sleep", pause)
    with pytest.raises(asyncio.CancelledError):
        await cleanup.run_copy_cleanup(MagicMock())
    assert reap.call_count == 2
    assert pause.await_count == 2


def test_failed_retry_bookkeeping_does_not_abort_other_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    journal = MagicMock()
    journal.find.return_value.sort.return_value.limit.return_value = [{"_id": "bad"}, {"_id": "good"}]
    journal.update_one.side_effect = BSONError("cannot defer")
    clean = MagicMock(side_effect=[KeyError("bad coordinates"), None])
    monkeypatch.setattr(cleanup, "cleanup_copy_attempt", clean)
    cleanup.reap_copy_attempts(SimpleNamespace(_db={cleanup.ATTEMPTS_COLLECTION: journal}))
    assert clean.call_count == 2
    journal.update_one.assert_called_once()


def test_finish_does_not_replace_request_result_with_cleanup_error(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MagicMock()
    monkeypatch.setattr(cleanup, "cleanup_copy_attempt", MagicMock(side_effect=ValueError("bad coordinates")))
    cleanup.finish_copy_attempt(db, {"_id": "attempt", "registry_id": "registry"}, writer_stopped=True)


def test_publication_race_retains_journal_for_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    db = MagicMock()
    attempt = {"_id": "destination", "registry_id": "registry", "checkpoint_collection": "checkpoints",
               "writes_collection": "writes", "gridfs_bucket": "files"}
    db["autonomous_follow_up_chats"].find_one.return_value = {
        "token": "destination", "state": "ready", "conversation": {"_id": "destination"},
    }
    monkeypatch.setattr(cleanup, "publish_follow_up_chat", MagicMock(side_effect=HTTPException(409, "publication changed")))
    with pytest.raises(HTTPException):
        cleanup.cleanup_copy_attempt(db, attempt)
    db[cleanup.ATTEMPTS_COLLECTION].delete_one.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_location", ["worker", "body", "cache"])
async def test_lifespan_always_closes_cache_and_database(
    monkeypatch: pytest.MonkeyPatch, failure_location: str,
) -> None:
    # Import only after disabling deployment-specific startup dependencies.
    monkeypatch.setenv("DEBUG", "false")
    from cnoe_agent_utils import tracing

    from dynamic_agents import main
    from dynamic_agents.services import mcp_client, skill_scrubber

    mongo = MagicMock(_client=object(), _db=None)
    cache = MagicMock(stop=AsyncMock())
    monkeypatch.setattr(main, "get_settings", lambda: Settings.model_construct())
    monkeypatch.setattr(main, "get_mongo_service", lambda: mongo)
    monkeypatch.setattr(main, "get_runtime_cache", lambda: cache)
    monkeypatch.setattr(mcp_client, "warn_if_agent_gateway_missing_hmac", lambda: None)
    monkeypatch.setattr(skill_scrubber, "install_skill_content_scrubber", lambda: None)
    monkeypatch.setattr(tracing, "TracingManager", lambda: None)
    started = asyncio.Event()

    async def worker(_mongo: object) -> None:
        started.set()
        if failure_location == "worker":
            raise RuntimeError("unexpected worker failure")
        await asyncio.Future()

    monkeypatch.setattr(main, "run_copy_cleanup", worker)
    if failure_location == "cache":
        cache.stop.side_effect = RuntimeError("cache stop failed")

    async def run() -> None:
        async with main.lifespan(FastAPI()):
            await started.wait()
            if failure_location == "body":
                raise RuntimeError("application failure")

    if failure_location == "worker":
        await run()
    else:
        with pytest.raises(RuntimeError):
            await run()
    cache.stop.assert_awaited_once()
    mongo.disconnect.assert_called_once()
