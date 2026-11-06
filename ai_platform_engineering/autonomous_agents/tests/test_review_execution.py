"""Exercise phase isolation, durable recovery, coverage and publication boundaries."""

import copy
import json
import uuid
from unittest.mock import AsyncMock

import pytest

from autonomous_agents.models import TaskDefinition
from autonomous_agents.services.dynamic_agents_client import DynamicAgentsClientError
from autonomous_agents.services.review_execution import (
    execution_scope,
    parse_report,
    plan_chunks,
    read_only_override,
    run_review_execution,
)

HEAD = "a" * 40
TASK = TaskDefinition(
    id="review",
    name="Review",
    prompt="Existing guarded publication policy",
    owner_id="owner@example.test",
    owner_sub="owner",
    dynamic_agent_id="agent",
    trigger={"type": "webhook", "provider": "github"},
    metadata={"repository": "example/repo", "review_execution_version": 1},
)
CONTEXT = {"repository": {"full_name": "example/repo"}, "pull_request": {"number": 1, "head": {"sha": HEAD}}}
AGENT = {
    "system_prompt": "Scoped review policy",
    "allowed_tools": {
        "github": ["get_file_contents", "pull_request_read", "pull_request_review_write"],
        "other": True,
    },
    "builtin_tools": {"fetch_url": {}},
    "enabled": True,
}


class Harness:
    def __init__(self):
        self.saved = None
        self.calls = []
        self.progress = []
        self.fail_key = None
        self.incomplete = False

    async def load(self):
        return copy.deepcopy(self.saved)

    async def save(self, value):
        self.saved = copy.deepcopy(value)

    async def update(self, state):
        self.progress.append(copy.deepcopy(state))

    async def invoke(self, **kwargs):
        self.calls.append(kwargs)
        data = kwargs["context"]
        if "config_override" not in kwargs:
            return f"Published\n<!-- caipe-pr-verdict:v1;task=review;head={HEAD};result=no_findings -->", []
        evidence = data["evidence"]
        if "paths" in evidence:
            if self.fail_key:
                raise DynamicAgentsClientError("output token limit")
            body = {"files": evidence["paths"], "candidates": [], "limits": [], "skills_used": []}
            if self.incomplete:
                body["limits"] = ["Missing caller contract"]
        elif "groups" in evidence:
            body = {"ready_to_publish": True, "findings": [], "remaining": [], "limits": [], "skills_used": []}
        else:
            body = {
                "expected_files": 3,
                "files": [
                    {"path": "auth/route.ts", "diff_tokens": 4000},
                    {"path": "auth/service.ts", "diff_tokens": 4000},
                    {"path": "tests/auth.ts", "diff_tokens": 100},
                ],
                "prior_findings": [],
            }
        return json.dumps({"head": HEAD, "state": "complete", **body}), []

    async def run(self, **overrides):
        return await run_review_execution(
            task=TASK,
            context=overrides.pop("context", CONTEXT),
            run_id="11111111-1111-4111-8111-111111111111",
            agent=AGENT,
            load=self.load,
            save=self.save,
            invoke=self.invoke,
            progress=self.update,
            **overrides,
        )


async def test_fresh_contexts_and_read_only_inspection_before_single_publication():
    h = Harness()
    _, _, state = await h.run()
    assert state["state"] == "completed" and state["completed"] == state["total"] == 3
    assert len({c["conversation_id"] for c in h.calls}) == len(h.calls) == 6
    for call in h.calls[:-1]:
        assert call["config_override"]["allowed_tools"] == {
            "github": ["get_file_contents", "pull_request_read"],
            "other": False,
        }
        assert call["owner_sub"] == "owner"
    assert "config_override" not in h.calls[-1]
    assert h.saved["publication_started"]


async def test_failed_phase_retries_in_new_context_and_resumes_completed_inventory():
    h = Harness()
    h.fail_key = "chunk"
    _, _, state = await h.run()
    assert state["state"] == "incomplete"
    assert "manifest" in h.saved["reports"] and not h.saved.get("publication_started")
    assert len(h.calls) == 3
    assert h.calls[-1]["conversation_id"] != h.calls[-2]["conversation_id"]
    h.fail_key = None
    h.calls = []
    _, _, state = await h.run()
    assert state["state"] == "completed"
    assert all(
        "paths" in c["context"].get("evidence", {})
        or "groups" in c["context"].get("evidence", {})
        or "config_override" not in c
        for c in h.calls
    )


async def test_missing_coverage_or_contract_never_reaches_publication():
    h = Harness()
    h.incomplete = True
    _, _, state = await h.run()
    assert state["state"] == "incomplete"
    assert all("config_override" in c for c in h.calls)


async def test_exact_run_replay_returns_saved_result_without_republishing():
    h = Harness()
    await h.run()
    h.calls = []
    _, _, state = await h.run()
    assert state["state"] == "completed" and not h.calls


async def test_uncertain_publication_is_not_retried():
    h = Harness()
    original = h.invoke

    async def invoke(**kwargs):
        if "config_override" not in kwargs:
            raise DynamicAgentsClientError("Write timed out")
        return await original(**kwargs)

    h.invoke = invoke
    _, _, state = await h.run()
    assert state["state"] == "incomplete" and h.saved["publication_started"]
    h.invoke = AsyncMock()
    _, _, state = await h.run()
    assert "Publication may already" in state["reason"]
    h.invoke.assert_not_called()


async def test_checkpoint_scope_changes_fail_closed():
    h = Harness()
    await h.run()
    h.saved["fingerprint"] = "other-owner-or-policy"
    with pytest.raises(ValueError, match="scope or configuration"):
        await h.run()


def test_related_groups_obey_token_budget_and_do_not_drop_large_files():
    files = [
        {"path": "a/one", "diff_tokens": 4000},
        {"path": "a/two", "diff_tokens": 4000},
        {"path": "b/large", "diff_tokens": 40000},
    ]
    assert plan_chunks(files) == [["a/one"], ["a/two"], ["b/large"]]
    for bad in [[{"path": "../escape", "diff_tokens": 1}], files * 2]:
        with pytest.raises(ValueError):
            plan_chunks(bad)


def test_context_cannot_change_repository_or_head_and_reports_are_bounded():
    bad = copy.deepcopy(CONTEXT)
    bad["repository"]["full_name"] = "other/repo"
    with pytest.raises(ValueError):
        execution_scope(TASK, bad)
    for body in [
        {"state": "complete", "head": "b" * 40},
        {"state": "complete", "head": HEAD, "files": None},
        {"state": "complete", "head": HEAD, "text": "x" * 12000},
    ]:
        with pytest.raises(ValueError):
            parse_report(json.dumps(body), {"head": HEAD})
    assert read_only_override(AGENT, str(uuid.uuid4()))["subagents"] == []


async def test_resume_endpoint_checks_owner_and_never_retries_uncertain_publication(monkeypatch):
    from fastapi import BackgroundTasks, HTTPException
    from mongomock_motor import AsyncMongoMockClient
    from starlette.requests import Request

    from autonomous_agents.models import TaskRun, TaskStatus
    from autonomous_agents.routes import tasks
    from autonomous_agents.services import mongo

    h = Harness()
    h.fail_key = "chunk"
    await h.run()
    run_id = "11111111-1111-4111-8111-111111111111"
    collection = AsyncMongoMockClient().db.checkpoints
    await collection.insert_one({"_id": run_id, "checkpoint": h.saved})
    service = AsyncMock()

    async def store(key):
        return collection, await collection.find_one({"_id": key})

    service.review_execution_store = store
    monkeypatch.setattr(mongo, "get_mongo_service", lambda: service)
    task_store = AsyncMock()
    task_store.get.return_value = TASK
    monkeypatch.setattr(tasks, "get_task_store", lambda: task_store)
    run_store = AsyncMock()
    run_store.list_by_task.return_value = [
        TaskRun(
            run_id=run_id,
            task_id=TASK.id,
            task_name=TASK.name,
            status=TaskStatus.FAILED,
            review_execution={"checkpoint_run_id": run_id},
        )
    ]
    monkeypatch.setattr(tasks, "get_run_store", lambda: run_store)

    def request(email):
        return Request({"type": "http", "headers": [(b"x-authenticated-user-email", email.encode())]})

    with pytest.raises(HTTPException) as denied:
        await tasks.resume_review(TASK.id, run_id, request("other@example.test"), BackgroundTasks())
    assert denied.value.status_code == 403
    background = BackgroundTasks()
    result = await tasks.resume_review(TASK.id, run_id, request(TASK.owner_id), background)
    assert result["status"] == "pending" and len(background.tasks) == 1
    duplicate_background = BackgroundTasks()
    duplicate = await tasks.resume_review(TASK.id, run_id, request(TASK.owner_id), duplicate_background)
    assert duplicate["run_id"] == result["run_id"] and not duplicate_background.tasks
    await collection.update_one(
        {"_id": run_id}, {"$set": {"checkpoint.publication_started": True}, "$unset": {"resume_until": ""}}
    )
    with pytest.raises(HTTPException) as uncertain:
        await tasks.resume_review(TASK.id, run_id, request(TASK.owner_id), BackgroundTasks())
    assert uncertain.value.status_code == 409


async def test_output_limit_bisects_a_group_but_authorization_revocation_does_not_retry():
    from autonomous_agents.services.dynamic_agents_client import DynamicAgentsAuthorizationRevokedError

    h = Harness()
    original = h.invoke

    async def invoke(**kwargs):
        evidence = kwargs["context"].get("evidence", {})
        if "paths" in evidence and len(evidence["paths"]) > 1:
            raise DynamicAgentsClientError("output token limit")
        text, events = await original(**kwargs)
        if "expected_files" in text:
            body = json.loads(text)
            for f in body["files"]:
                f["diff_tokens"] = 100
            text = json.dumps(body)
        return text, events

    h.invoke = invoke
    _, _, state = await h.run()
    assert state["state"] == "completed" and state["total"] == 3
    assert h.saved["chunks"] == [["auth/route.ts"], ["auth/service.ts"], ["tests/auth.ts"]]
    h = Harness()
    h.invoke = AsyncMock(side_effect=DynamicAgentsAuthorizationRevokedError("revoked"))
    with pytest.raises(DynamicAgentsAuthorizationRevokedError):
        await h.run()
    assert h.invoke.await_count == 1


async def test_progress_projection_omits_private_prompts_outputs_and_events():
    from datetime import datetime, timezone
    from types import SimpleNamespace

    from mongomock_motor import AsyncMongoMockClient

    from autonomous_agents.services.mongo import MongoService

    service = object.__new__(MongoService)
    service._primary_db = AsyncMongoMockClient().db
    service.settings = SimpleNamespace(mongodb_collection="runs")
    await service._primary_db.runs.insert_one(
        {
            "run_id": "example-run",
            "task_id": "review",
            "status": "running",
            "started_at": datetime.now(timezone.utc),
            "review_execution": {"version": 1, "head": HEAD, "number": 1},
            "request_prompt": "Private prompt",
            "response_full": "Private response",
            "events": [{"private": "trace"}],
        }
    )
    result = await service.review_run_statuses("review")
    assert len(result) == 1
    assert set(result[0]) == {"run_id", "status", "started_at", "review_execution"}
    assert await service.review_run_statuses("other-task") == []


async def test_scoped_manual_review_requires_owner_and_uses_bounded_deduplicated_dispatch(monkeypatch):
    from types import SimpleNamespace

    from fastapi import BackgroundTasks, HTTPException, Request, Response
    from pydantic import ValidationError

    from autonomous_agents.models import ReviewRunCreate
    from autonomous_agents.routes import tasks

    store = AsyncMock()
    store.get.return_value = TASK
    monkeypatch.setattr(tasks, "get_task_store", lambda: store)
    dispatch = AsyncMock(return_value=SimpleNamespace(run_id=str(uuid.uuid4()), status_code=202))
    monkeypatch.setattr(tasks, "dispatch_webhook_run", dispatch)
    monkeypatch.setattr(tasks, "_assert_webhook_provider_enabled", lambda _: None)
    payload = ReviewRunCreate(request_id=uuid.uuid4(), repository="example/repo", pull_request_number=1, head_sha=HEAD)

    def request(email):
        return Request({"type": "http", "headers": [(b"x-authenticated-user-email", email.encode())] if email else []})

    for email, code in [("other@example.test", 403), (None, 401)]:
        with pytest.raises(HTTPException) as denied:
            await tasks.start_review(TASK.id, payload, request(email), Response(), BackgroundTasks())
        assert denied.value.status_code == code
    dispatch.assert_not_awaited()
    response = Response()
    first = await tasks.start_review(TASK.id, payload, request(TASK.owner_id), response, BackgroundTasks())
    first_call = dispatch.call_args.kwargs
    second = await tasks.start_review(TASK.id, payload, request(TASK.owner_id), Response(), BackgroundTasks())
    assert first["run_id"] == second["run_id"] and response.status_code == 202
    assert first_call["dedup_key"].key == dispatch.call_args.kwargs["dedup_key"].key
    assert first_call["max_pending_per_task"] > 0
    context = first_call["context"]
    assert context["_caipe_manual_request"]["source"] == "authenticated_ui" and context["manual_review"]
    assert context["pull_request"]["head"]["sha"] == HEAD
    assert set(context) == {"repository", "pull_request", "manual_review", "_caipe_manual_request"}
    dispatch.reset_mock()
    for bad_task, bad_payload in [
        (TASK, payload.model_copy(update={"repository": "other/repo"})),
        (TASK.model_copy(update={"enabled": False}), payload),
        (TASK.model_copy(update={"metadata": {"repository": "example/repo"}}), payload),
    ]:
        store.get.return_value = bad_task
        with pytest.raises(HTTPException) as conflict:
            await tasks.start_review(TASK.id, bad_payload, request(TASK.owner_id), Response(), BackgroundTasks())
        assert conflict.value.status_code == 409
    dispatch.assert_not_awaited()
    for extra in [{"context": {"owner_sub": "other"}}, {"head_sha": "not-a-sha"}, {"pull_request_number": True}]:
        with pytest.raises(ValidationError):
            ReviewRunCreate.model_validate({**payload.model_dump(), **extra})


async def test_incomplete_report_is_not_cached_and_resume_reinspects_it():
    h = Harness()
    original = h.invoke
    incomplete = True

    async def invoke(**kwargs):
        if incomplete and "paths" in kwargs["context"].get("evidence", {}):
            return json.dumps({"head": HEAD, "state": "incomplete", "limits": ["Source unavailable"]}), []
        return await original(**kwargs)

    h.invoke = invoke
    _, _, state = await h.run()
    assert state["state"] == "incomplete" and state["resumable"]
    assert not any(key.startswith("chunk-") for key in h.saved["reports"])
    incomplete = False
    _, _, state = await h.run()
    assert state["state"] == "completed"
    publication = next(call for call in h.calls if "config_override" not in call)
    assert publication["context"]["repository"]["full_name"] == "example/repo"
    assert publication["context"]["pull_request"]["head"]["sha"] == HEAD


async def test_manual_publication_preserves_server_authenticated_request_identity():
    h = Harness()
    await h.run(context={**CONTEXT, "manual_review": True,
                         "_caipe_manual_request": {"source": "authenticated_ui"}})
    publication = next(call for call in h.calls if "config_override" not in call)
    assert publication["context"]["manual_review"] is True
    assert publication["context"]["_caipe_manual_request"]["source"] == "authenticated_ui"
