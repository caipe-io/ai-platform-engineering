"""Tests for WorkflowApiClient and agent workflow builtin tools."""

from __future__ import annotations

import importlib
import json
from unittest.mock import MagicMock, patch

import pytest


def _load_builtin_tools():
    return importlib.import_module("dynamic_agents.services.builtin_tools")


def test_workflow_api_client_unconfigured_sends_no_authorization() -> None:
    """Without OAuth2 env, WorkflowApiClient must not invent a Bearer header."""
    WorkflowApiClient = getattr(_load_builtin_tools(), "WorkflowApiClient")
    client = WorkflowApiClient(base_url="http://caipe-ui:3000")

    mock_response = MagicMock()
    mock_response.ok = True
    mock_response.json.return_value = {"run_id": "wfrun-test", "status": "running"}

    with patch("dynamic_agents.services.builtin_tools.requests.post", return_value=mock_response) as mock_post:
        client.post("/api/workflow-runs", json_data={"workflow_config_id": "wf-demo"})

    _, kwargs = mock_post.call_args
    headers = kwargs["headers"]
    assert "Authorization" not in headers


def test_workflow_api_client_oauth_adds_bearer_header() -> None:
    """Configured OAuth2 client credentials must attach Authorization on BFF calls."""
    WorkflowApiClient = getattr(_load_builtin_tools(), "WorkflowApiClient")
    client = WorkflowApiClient(
        base_url="http://caipe-ui:3000",
        token_url="http://keycloak/token",
        client_id="caipe-platform",
        client_secret="secret",
    )

    token_response = MagicMock()
    token_response.ok = True
    token_response.json.return_value = {"access_token": "svc-token", "expires_in": 3600}

    api_response = MagicMock()
    api_response.ok = True
    api_response.json.return_value = {"run_id": "wfrun-test", "status": "running"}

    with patch("dynamic_agents.services.builtin_tools.requests.post", side_effect=[token_response, api_response]) as mock_post:
        client.post("/api/workflow-runs", json_data={"workflow_config_id": "wf-demo"})

    assert mock_post.call_count == 2
    token_call, api_call = mock_post.call_args_list
    assert token_call.args[0] == "http://keycloak/token"
    assert api_call.kwargs["headers"]["Authorization"] == "Bearer svc-token"


def test_start_workflow_run_tool_returns_401_error_text() -> None:
    """start_workflow_run surfaces BFF auth failures to the agent (Webex path)."""
    create_workflow_tools = getattr(_load_builtin_tools(), "create_workflow_tools")
    client = MagicMock()
    response = MagicMock()
    response.ok = False
    response.status_code = 401
    response.text = '{"code":"NOT_SIGNED_IN","reason":"not_signed_in"}'
    client.post.return_value = response

    tools = create_workflow_tools(client, ["wf-custom"], trigger_context={"agent_id": "agent-sre-agent"})
    start_tool = next(tool for tool in tools if tool.name == "start_workflow_run")
    result = start_tool.invoke(
        {
            "thought": "trigger from webex",
            "workflow_config_id": "wf-custom",
            "user_context": "run SRI workflow",
        }
    )

    assert "ERROR" in result
    assert "401" in result
    client.post.assert_called_once()
    body = client.post.call_args.kwargs["json_data"]
    assert body["workflow_config_id"] == "wf-custom"
    assert body["trigger_info"]["triggered_by"] == "agent"


def test_start_workflow_run_tool_rejects_unlisted_workflow_id() -> None:
    create_workflow_tools = getattr(_load_builtin_tools(), "create_workflow_tools")
    client = MagicMock()
    tools = create_workflow_tools(client, ["wf-allowed"])
    start_tool = next(tool for tool in tools if tool.name == "start_workflow_run")

    result = start_tool.invoke(
        {"thought": "nope", "workflow_config_id": "wf-other", "user_context": ""},
    )

    assert "not allowed" in result.lower()
    client.post.assert_not_called()


def test_start_workflow_run_tool_success_parses_run_id() -> None:
    create_workflow_tools = getattr(_load_builtin_tools(), "create_workflow_tools")
    client = MagicMock()
    response = MagicMock()
    response.ok = True
    response.json.return_value = {"run_id": "wfrun-abc", "status": "running"}
    client.post.return_value = response

    tools = create_workflow_tools(client, ["wf-allowed"], trigger_context={"agent_name": "SRE Agent"})
    start_tool = next(tool for tool in tools if tool.name == "start_workflow_run")
    result = start_tool.invoke({"thought": "go", "workflow_config_id": "wf-allowed"})

    payload = json.loads(result)
    assert payload["run_id"] == "wfrun-abc"
    assert payload["status"] == "running"
    assert payload["workflow_config_id"] == "wf-allowed"
    assert payload["workflow_name"] == "wf-allowed"


def test_start_workflow_run_tool_includes_configured_workflow_name() -> None:
    create_workflow_tools = getattr(_load_builtin_tools(), "create_workflow_tools")
    client = MagicMock()
    response = MagicMock()
    response.ok = True
    response.json.return_value = {"run_id": "wfrun-sri", "status": "running"}
    client.post.return_value = response

    tools = create_workflow_tools(
        client,
        ["wf-sri"],
        workflow_labels={"wf-sri": "SRI Custom workflow"},
    )
    start_tool = next(tool for tool in tools if tool.name == "start_workflow_run")
    payload = json.loads(
        start_tool.invoke({"thought": "go", "workflow_config_id": "wf-sri"}),
    )
    assert payload["workflow_name"] == "SRI Custom workflow"


def test_get_workflow_run_status_includes_step_output_summary(monkeypatch: pytest.MonkeyPatch) -> None:
    # Exercise the API-base fallback regardless of local UI configuration.
    for key in ("CAIPE_UI_PUBLIC_URL", "CAIPE_UI_BASE_URL", "NEXTAUTH_URL"):
        monkeypatch.delenv(key, raising=False)
    create_workflow_tools = getattr(_load_builtin_tools(), "create_workflow_tools")
    client = MagicMock()
    response = MagicMock()
    response.ok = True
    response.json.return_value = {
        "_id": "wfrun-abc",
        "workflow_config_id": "wf-sri",
        "status": "completed",
        "steps": [
            {
                "index": 0,
                "display_text": "List projects",
                "agent_id": "sre-agent",
                "status": "completed",
                "response": "Found 3 ArgoCD projects.",
            }
        ],
    }
    client.get.return_value = response
    client.base_url = "http://caipe-ui:3000"

    tools = create_workflow_tools(
        client,
        ["wf-sri"],
        workflow_labels={"wf-sri": "SRI Custom workflow"},
    )
    status_tool = next(tool for tool in tools if tool.name == "get_workflow_run_status")
    payload = json.loads(status_tool.invoke({"thought": "output", "run_id": "wfrun-abc"}))

    assert payload["workflow_name"] == "SRI Custom workflow"
    assert payload["steps"][0]["output"] == "Found 3 ArgoCD projects."
    assert "Found 3 ArgoCD projects." in payload["final_output_summary"]
    assert payload["run_url"] == "http://caipe-ui:3000/workflows/run/wfrun-abc"


def test_get_workflow_run_status_run_url_uses_public_ui_base(monkeypatch: pytest.MonkeyPatch) -> None:
    create_workflow_tools = getattr(_load_builtin_tools(), "create_workflow_tools")
    monkeypatch.setenv("CAIPE_UI_PUBLIC_URL", "https://grid.example.com")

    client = MagicMock()
    client.base_url = "http://caipe-ui:3000"
    response = MagicMock()
    response.ok = True
    response.json.return_value = {
        "_id": "wfrun-abc",
        "workflow_config_id": "wf-sri",
        "status": "completed",
        "steps": [],
    }
    client.get.return_value = response

    tools = create_workflow_tools(client, ["wf-sri"])
    status_tool = next(tool for tool in tools if tool.name == "get_workflow_run_status")
    payload = json.loads(status_tool.invoke({"thought": "link", "run_id": "wfrun-abc"}))

    assert payload["run_url"] == "https://grid.example.com/workflows/run/wfrun-abc"


def test_start_workflow_run_includes_run_url(monkeypatch: pytest.MonkeyPatch) -> None:
    create_workflow_tools = getattr(_load_builtin_tools(), "create_workflow_tools")
    monkeypatch.setenv("CAIPE_UI_PUBLIC_URL", "http://localhost:3000")

    client = MagicMock()
    client.base_url = "http://caipe-ui:3000"
    response = MagicMock()
    response.ok = True
    response.json.return_value = {"run_id": "wfrun-abc", "status": "running"}
    client.post.return_value = response

    tools = create_workflow_tools(client, ["wf-allowed"])
    start_tool = next(tool for tool in tools if tool.name == "start_workflow_run")
    payload = json.loads(start_tool.invoke({"thought": "go", "workflow_config_id": "wf-allowed"}))

    assert payload["run_url"] == "http://localhost:3000/workflows/run/wfrun-abc"


@patch("dynamic_agents.services.builtin_tools.time.sleep", return_value=None)
def test_get_workflow_run_status_waits_for_completion(mock_sleep: MagicMock) -> None:
    create_workflow_tools = getattr(_load_builtin_tools(), "create_workflow_tools")
    client = MagicMock()

    running = MagicMock()
    running.ok = True
    running.json.return_value = {
        "_id": "wfrun-abc",
        "workflow_config_id": "wf-sri",
        "status": "running",
        "steps": [{"index": 0, "display_text": "Step 1", "status": "running"}],
    }

    completed = MagicMock()
    completed.ok = True
    completed.json.return_value = {
        "_id": "wfrun-abc",
        "workflow_config_id": "wf-sri",
        "status": "completed",
        "steps": [
            {
                "index": 0,
                "display_text": "Summarize",
                "status": "completed",
                "response": "All systems green.",
            }
        ],
    }
    client.get.side_effect = [running, completed]
    client.base_url = "http://caipe-ui:3000"

    tools = create_workflow_tools(client, ["wf-sri"], workflow_labels={"wf-sri": "SRI Custom workflow"})
    status_tool = next(tool for tool in tools if tool.name == "get_workflow_run_status")
    payload = json.loads(
        status_tool.invoke(
            {
                "thought": "wait",
                "run_id": "wfrun-abc",
                "wait_for_completion": True,
                "max_wait_seconds": 30,
            }
        )
    )

    assert client.get.call_count == 2
    mock_sleep.assert_called_once()
    assert payload["status"] == "completed"
    assert "All systems green." in payload["final_output_summary"]


@patch("dynamic_agents.services.builtin_tools.time.sleep", return_value=None)
@patch("dynamic_agents.services.builtin_tools.time.monotonic")
def test_get_workflow_run_status_wait_times_out(mock_monotonic: MagicMock, mock_sleep: MagicMock) -> None:
    create_workflow_tools = getattr(_load_builtin_tools(), "create_workflow_tools")
    client = MagicMock()

    running = MagicMock()
    running.ok = True
    running.json.return_value = {
        "_id": "wfrun-abc",
        "workflow_config_id": "wf-sri",
        "status": "running",
        "steps": [],
    }
    client.get.return_value = running
    client.base_url = "http://caipe-ui:3000"
    mock_monotonic.side_effect = [0.0, 0.0, 121.0]

    tools = create_workflow_tools(client, ["wf-sri"])
    status_tool = next(tool for tool in tools if tool.name == "get_workflow_run_status")
    payload = json.loads(
        status_tool.invoke(
            {
                "thought": "wait",
                "run_id": "wfrun-abc",
                "wait_for_completion": True,
                "max_wait_seconds": 120,
            }
        )
    )

    assert payload["status"] == "running"
    assert payload["wait_timed_out"] is True
