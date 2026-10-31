"""Live BFF → Engine → Deep Agents E2E; requires isolated, real OIDC/CAS fixtures."""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
from uuid import uuid4


def http(
    url: str, body: Any = None, token: str | None = None, *, form: bool = False, method: str | None = None
) -> tuple[int, Any]:
    headers = {"Content-Type": "application/x-www-form-urlencoded" if form else "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = (urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()) if body is not None else None
    try:
        response = urllib.request.urlopen(urllib.request.Request(url, data, headers, method=method), timeout=90)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read().decode()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = raw
    return response.status, parsed


def run(args: argparse.Namespace) -> None:
    checks: list[str] = []

    def passed_check(message: str) -> None:
        checks.append(message)
        print("PASS " + message, flush=True)

    Path(args.output).write_text(json.dumps({"status": "running"}))
    fixture = json.loads(Path(args.fixture).read_text())
    env = dict(line.split("=", 1) for line in Path(args.env).read_text().splitlines() if "=" in line)
    token_url = env["OIDC_ISSUER"] + "/protocol/openid-connect/token"

    def login(username: str) -> str:
        status, result = http(
            token_url,
            {
                "grant_type": "password",
                "client_id": fixture["client"],
                "client_secret": fixture["secret"],
                "username": username,
                "password": fixture["password"],
                "scope": "openid profile email",
            },
            form=True,
        )
        assert status == 200, ("OIDC login", status)
        return result["access_token"]

    token = login("test-admin")
    other = login("test-user")

    def call(
        path: str, body: Any = None, *, expected: int = 200, identity: str | None = token, method: str | None = None
    ) -> Any:
        status, result = http(args.url + path, body, identity, method=method)
        assert status == expected, (path, status, result)
        return result

    def conversation(agent: str) -> str:
        return call(
            "/api/chat/conversations",
            {"agent_id": agent, "title": "Example session lifecycle", "client_type": "webui"},
            expected=201,
        )["data"]["conversation"]["_id"]

    def start(agent: str, thread: str, message: str = "", **extra: Any) -> dict[str, Any]:
        return call(
            "/api/harness-engine/runs",
            {"agent_id": agent, "conversation_id": thread, "message": message, **extra},
            expected=202,
        )["data"]

    def wait(run: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        for _ in range(200):
            page = call(f"/api/harness-engine/runs/{run['run_id']}/events")["data"]
            if page["run"]["status"] not in {"running", "queued"}:
                return page["run"], page["events"]
            time.sleep(0.1)
        raise AssertionError("Execution did not terminate")

    def check(run: dict[str, Any], status: str = "completed") -> list[dict[str, Any]]:
        final, events = wait(run)
        assert final["status"] == status, (final, events)
        assert [event["sequence"] for event in events] == list(range(1, len(events) + 1))
        assert token not in json.dumps(events)
        return events

    agent = call(
        "/api/dynamic-agents",
        {
            "name": "Example session lifecycle " + uuid4().hex[:8],
            "description": "Isolated lifecycle fixture",
            "system_prompt": "Use the requested tool and return the result.",
            "model": {"provider": "openai-compatible", "id": "example-model"},
            "visibility": "global",
            "allowed_tools": {},
            "skills": [],
            "builtin_tools": {"request_user_input": {"enabled": True}, "wait": {"enabled": True}},
            "backend": {"type": "store"},
        },
        expected=201,
    )["data"]
    identifier = agent["_id"]
    assert agent["execution_blueprint_version"] >= 1
    thread = conversation(identifier)
    first = start(identifier, thread, "remember-example-state", client_request_id="first-example")
    check(first)
    same = start(identifier, thread, "remember-example-state", client_request_id="first-example")
    assert same["run_id"] == first["run_id"]
    passed_check("published version, admission, ordered replay and idempotency")
    # Restart only the explicitly named isolated Engine. Committed checkpoints,
    # events and bindings must outlive that process.
    if args.engine_container:
        subprocess.run(
            ["sudo", "-n", "docker", "restart", args.engine_container], check=True, stdout=subprocess.DEVNULL
        )
        for _ in range(100):
            try:
                if http(args.engine_url + "/healthz")[0] == 200:
                    break
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.1)
        else:
            raise AssertionError("Restarted Engine never became healthy")
    events = check(start(identifier, thread, "recall-example-state"))
    content = next(event["data"]["content"] for event in events if event["event_type"] == "result.updated")
    assert "remember-example-state" in content
    passed_check("native checkpoint continuity after Engine restart" if args.engine_container else "native checkpoint continuity across turns")
    paused = start(identifier, thread, "pause-example")
    paused_events = check(paused, "paused")
    interrupt = paused_events[-1]["data"]
    assert interrupt["interrupt_id"]
    assert not any(event["event_type"] == "run.completed" for event in paused_events)
    state = call(f"/api/dynamic-agents/conversations/{thread}/interrupt-state?agent_id={identifier}")
    assert state["interrupt_data"]["interrupt_id"] == interrupt["interrupt_id"]
    call(
        "/api/harness-engine/runs",
        {"agent_id": identifier, "conversation_id": thread, "message": "blocked"},
        expected=409,
    )
    resume = {
        "agent_id": identifier,
        "conversation_id": thread,
        "command": "resume",
        "resume_data": {
            "type": "form_input",
            "interrupt_id": interrupt["interrupt_id"],
            "values": {"value": "selected-example"},
        },
        "client_request_id": "resume-example",
    }
    resumed = call("/api/harness-engine/runs", resume, expected=202)["data"]
    check(resumed)
    assert call("/api/harness-engine/runs", resume, expected=202)["data"]["run_id"] == resumed["run_id"]
    passed_check("durable pause, checkpoint inspection, guarded resume")
    call(f"/api/harness-engine/runs/{first['run_id']}", expected=404, identity=other)
    call(
        "/api/harness-engine/runs",
        {"agent_id": identifier, "conversation_id": thread, "message": "cross-owner"},
        expected=403,
        identity=other,
    )
    passed_check("cross-owner authorization")
    file_events = check(start(identifier, thread, "file-example"))
    assert any(
        event["event_type"] == "runtime.event" and event["data"].get("name") == "TOOL_CALL_START"
        for event in file_events
    )
    namespace = json.dumps([identifier, thread, "filesystem"])
    files = call("/api/files/list?" + urllib.parse.urlencode({"fs_namespace": namespace}))
    assert "/example.txt" in files["files"], files
    denied_status, _ = http(args.url + "/api/files/list?" + urllib.parse.urlencode({"fs_namespace": namespace}), token=other)
    assert denied_status in {403, 404}, ("cross-owner files", denied_status)
    passed_check("native tools and persisted files")
    text_attachment_events = check(
        start(
            identifier,
            thread,
            "attachment-example",
            files=[
                {
                    "mime_type": "text/plain",
                    "data": base64.b64encode(b"example attachment").decode(),
                    "name": "example.txt",
                }
            ],
        )
    )
    image_attachment_events = check(
        start(
            identifier,
            thread,
            "binary-attachment-example",
            files=[
                {
                    "mime_type": "image/png",
                    "name": "example.png",
                    "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=",
                }
            ],
        )
    )
    assert "example attachment" in json.dumps(text_attachment_events)
    assert "image-observed" in json.dumps(image_attachment_events)
    passed_check("authorized attachment references")
    child_events = check(start(identifier, thread, "child-example"))
    assert any(
        event["event_type"] == "runtime.event" and event["data"].get("name") == "TOOL_CALL_START" and event["data"].get("payload", {}).get("toolCallName") == "task"
        for event in child_events
    )
    child_ids = {event["data"]["payload"]["toolCallId"] for event in child_events
                 if event["event_type"] == "runtime.event" and event["data"].get("name") == "TOOL_CALL_START"
                 and event["data"].get("payload", {}).get("toolCallName") == "task"}
    assert any(event["data"].get("payload", {}).get("toolCallId") in child_ids
               and "child-result" in event["data"].get("payload", {}).get("content", "")
               for event in child_events if event["event_type"] == "runtime.event" and event["data"].get("name") == "TOOL_CALL_RESULT")
    passed_check("native general-purpose subagent")
    slow = start(identifier, thread, "slow-example")
    time.sleep(0.3)
    call(f"/api/harness-engine/runs/{slow['run_id']}", method="DELETE")
    check(slow, "cancelled")
    check(start(identifier, thread, "after-cancellation"))
    passed_check("cancellation drain and next-turn admission")
    call("/api/dynamic-agents/chat/restart-runtime", {"agent_id": identifier, "conversation_id": thread})
    check(start(identifier, thread, "after-tool-reconnect"))
    call("/api/harness-engine/sessions/clear", {"agent_id": identifier, "conversation_id": thread})
    cleared = start(identifier, thread, "after-clear")
    assert cleared["provider_session_id"] != first["provider_session_id"]
    cleared_events = check(cleared)
    assert "remember-example-state" not in next(
        event["data"]["content"] for event in cleared_events if event["event_type"] == "result.updated"
    )
    passed_check("runtime reconnect and clean epoch rotation")
    rolled_back = call(
        "/api/harness-engine/sessions/migrate",
        {"agent_id": identifier, "conversation_id": thread, "action": "rollback"},
    )
    assert rolled_back["data"]["native_thread_id"] == cleared["provider_session_id"]
    legacy = call(
        "/api/v1/chat/stream/start",
        {"agent_id": identifier, "conversation_id": thread, "message": "after-rollback", "protocol": "agui"},
    )
    assert "after-clear" in legacy and "after-rollback" in legacy
    call("/api/harness-engine/sessions/migrate", {"agent_id": identifier, "conversation_id": thread, "action": "adopt"})
    adopted_events = check(start(identifier, thread, "after-adoption"))
    assert "after-rollback" in next(
        event["data"]["content"] for event in adopted_events if event["event_type"] == "result.updated"
    )
    passed_check("reconciled rollback and native thread adoption")
    check(start(identifier, thread, "keep-before-rewind", turn_id="example-turn-one"))
    check(start(identifier, thread, "remove-on-rewind", turn_id="example-turn-two"))
    check(
        start(
            identifier,
            thread,
            command="rewind",
            turn_id="example-turn-two",
            rewind_data={"message_content": "remove-on-rewind", "content_occurrence": 1},
        )
    )
    after_rewind = check(start(identifier, thread, "after-rewind"))
    assert "keep-before-rewind" in next(
        event["data"]["content"] for event in after_rewind if event["event_type"] == "result.updated"
    )
    assert "remove-on-rewind" not in next(
        event["data"]["content"] for event in after_rewind if event["event_type"] == "result.updated"
    )
    passed_check("native turn rewind")
    edited = call(
        "/api/dynamic-agents?id=" + identifier, {"system_prompt": "Updated example instructions"}, method="PUT"
    )["data"]
    assert edited["execution_blueprint_version"] > first["agent_version"]
    pinned = start(identifier, thread, "pinned-version")
    assert pinned["agent_version"] == first["agent_version"]
    check(pinned)
    new_thread = conversation(identifier)
    updated = start(identifier, new_thread, "new-version")
    assert updated["agent_version"] == edited["execution_blueprint_version"]
    check(updated)
    passed_check("coherent publication and pinned execution versions")
    approval_agent = call(
        "/api/dynamic-agents",
        {
            "name": "Example approval " + uuid4().hex[:8],
            "system_prompt": "Use the requested tool",
            "model": {"provider": "openai-compatible", "id": "example-model"},
            "visibility": "global",
            "allowed_tools": {},
            "builtin_tools": {"wait": {"enabled": True}},
            "interrupt_on": {"builtin": {"wait": True}},
        },
        expected=201,
    )["data"]["_id"]
    approval_thread = conversation(approval_agent)
    approval_events = check(start(approval_agent, approval_thread, "approval-example"), "paused")
    approval = approval_events[-1]["data"]
    assert approval["interrupt_type"] == "tool_approval"
    approval_resume = start(
        approval_agent,
        approval_thread,
        command="resume",
        client_request_id="approval-example",
        resume_data={
            "type": "tool_approval",
            "interrupt_id": approval["interrupt_id"],
            "decision": "edit",
            "tool_name": "wait",
            "edited_args": {"seconds": 0.01},
        },
    )
    approval_result = check(approval_resume)
    assert any("0.01" in json.dumps(event["data"]) for event in approval_result if event["event_type"] == "runtime.event" and event["data"].get("name") == "TOOL_CALL_RESULT")
    passed_check("persisted tool approval and authorized argument edit")
    request = urllib.request.Request(
        args.url + "/api/v1/chat/stream/start",
        json.dumps(
            {"agent_id": identifier, "conversation_id": thread, "message": "slow-example", "protocol": "agui"}
        ).encode(),
        {"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )
    with urllib.request.urlopen(request, timeout=30) as stream:
        disconnected_run = stream.headers["X-Harness-Run-ID"]
        assert stream.readline()
    check({"run_id": disconnected_run})
    passed_check("execution continues after subscriber disconnect")

    if args.replica_url:
        claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))

        def replica(path: str, body: Any = None, method: str = "POST", expected: int = 200) -> Any:
            data = json.dumps(body).encode() if body is not None else None
            request = urllib.request.Request(
                args.replica_url + path,
                data,
                {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + env["HARNESS_ENGINE_INTERNAL_TOKEN"],
                    "X-Harness-Engine-Subject": claims["sub"],
                    "X-Harness-Caller-Token": token,
                    "X-Harness-Caller-Email": "test-admin@example.test",
                },
                method=method,
            )
            try:
                response = urllib.request.urlopen(request, timeout=60)
            except urllib.error.HTTPError as error:
                response = error
            result = json.loads(response.read())
            assert response.status == expected, (path, response.status, result)
            return result

        pause = start(identifier, thread, "pause-example")
        pending = check(pause, "paused")[-1]["data"]
        resumed_on_replica = replica(
            "/api/v1/runs",
            {
                "agent_id": identifier,
                "conversation_id": thread,
                "command": "resume",
                "interrupt_id": pending["interrupt_id"],
                "resumes_run_id": pause["run_id"],
                "resume_data": {"type": "form_input", "values": {"value": "second-replica"}},
            },
            expected=202,
        )["data"]
        check(resumed_on_replica)
        passed_check("pending checkpoint resumes on a second Engine replica")
        busy = start(identifier, thread, "slow-example")
        replica(
            "/api/v1/runs",
            {"agent_id": identifier, "conversation_id": thread, "message": "competing producer"},
            expected=409,
        )
        replica("/api/v1/runs/" + busy["run_id"], method="DELETE")
        check(busy, "cancelled")
        passed_check("cross-replica admission and cancellation")
    Path(args.output).write_text(
        json.dumps(
            {
                "agent_id": identifier,
                "conversation_id": thread,
                "run_id": cleared["run_id"],
                "checks": checks,
                "status": "passed",
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--env", required=True)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--engine-container")
    parser.add_argument("--replica-url")
    parser.add_argument("--engine-url", default="http://127.0.0.1:8310")
    parser.add_argument("--output", default="harness-e2e-result.json")
    run(parser.parse_args())
