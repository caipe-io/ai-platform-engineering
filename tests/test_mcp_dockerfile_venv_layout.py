# assisted-by Codex Codex-sonnet-4-6
from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MCP_DOCKERFILE = ROOT / "build" / "agents" / "Dockerfile.mcp"
DEV_COMPOSE = ROOT / "docker-compose.dev.yaml"
EXPECTED_SHARED_DOCKERFILE_MCPS = {
  "mcp-argocd": "argocd",
  "mcp-backstage": "backstage",
  "mcp-jira": "jira",
  "mcp-komodor": "komodor",
  "mcp-netutils": "netutils",
  "mcp-pagerduty": "pagerduty",
  "mcp-sharepoint": "sharepoint",
  "mcp-splunk": "splunk",
  "mcp-victorops": "victorops",
  "mcp-webex": "webex",
  "mcp-webex-meetings": "webex-meetings",
}


def test_mcp_dockerfile_keeps_venv_outside_dev_source_mounts() -> None:
  dockerfile = MCP_DOCKERFILE.read_text()

  assert "UV_PROJECT_ENVIRONMENT=/opt/caipe-mcp-venvs/${AGENT_NAME}" in dockerfile
  assert 'PATH="/opt/caipe-mcp-venvs/${AGENT_NAME}/bin:${PATH}"' in dockerfile
  assert "/app/ai_platform_engineering/mcp/${AGENT_NAME}/.venv" not in dockerfile


def test_all_dev_built_mcps_use_shared_dockerfile_layout() -> None:
  compose = DEV_COMPOSE.read_text()
  services: dict[str, str] = {}

  for match in re.finditer(r"(?ms)^  ([a-zA-Z0-9_-]+):\n(?P<body>.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)", compose):
    body = match.group("body")
    if "dockerfile: build/agents/Dockerfile.mcp" not in body:
      continue

    agent_name = re.search(r"- AGENT_NAME=([^\n]+)", body)
    assert agent_name is not None, f"{match.group(1)} must set AGENT_NAME"
    services[match.group(1)] = agent_name.group(1).strip()

  assert services == EXPECTED_SHARED_DOCKERFILE_MCPS
