# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for the standalone webloader Helm deployment."""

import subprocess
from pathlib import Path

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
RAG_STACK = REPO_ROOT / "charts/rag-stack"
RAG_SERVER = RAG_STACK / "charts/rag-server"


def _render_rag_stack(set_values: dict[str, str] | None = None) -> list[dict]:
  command = [
    "helm",
    "template",
    "test",
    str(RAG_STACK),
    "--set",
    "neo4j.enabled=false",
    "--set",
    "milvus.enabled=false",
    "--set",
    "agent-ontology.enabled=false",
  ]
  for key, value in (set_values or {}).items():
    command.extend(["--set", f"{key}={value}"])
  result = subprocess.run(
    command,
    capture_output=True,
    check=True,
    text=True,
  )
  return [document for document in yaml.safe_load_all(result.stdout) if document]


def _deployments(documents: list[dict]) -> list[dict]:
  return [document for document in documents if document.get("kind") == "Deployment"]


def _environment(container: dict) -> dict[str, object]:
  return {entry["name"]: entry.get("value") for entry in container.get("env", [])}


def _environment_names(container: dict) -> list[str]:
  return [entry["name"] for entry in container.get("env", [])]


def test_webloader_runs_in_its_own_deployment() -> None:
  deployments = _deployments(_render_rag_stack())
  webloader = next(
    deployment
    for deployment in deployments
    if deployment["metadata"]["labels"].get("app.kubernetes.io/ingestor-type") == "webloader"
  )
  container = webloader["spec"]["template"]["spec"]["containers"][0]

  assert webloader["metadata"]["name"].endswith("-rag-ingestors-webloader")
  assert container["name"] == "ingestor"
  assert "caipe-rag-ingestors" in container["image"]
  assert _environment(container)["INGESTOR_TYPE"] == "webloader"
  assert _environment(container)["RAG_SERVER_URL"] == "http://rag-server:9446"
  assert "SYNC_INTERVAL" not in _environment(container)


def test_rag_server_never_contains_a_web_ingestor_sidecar() -> None:
  deployments = _deployments(_render_rag_stack())
  rag_server = next(
    deployment for deployment in deployments if deployment["metadata"]["name"] == "rag-server"
  )

  assert [container["name"] for container in rag_server["spec"]["template"]["spec"]["containers"]] == [
    "rag-server"
  ]


def test_webloader_is_a_regular_ingestor_list_item() -> None:
  values = yaml.safe_load((RAG_STACK / "values.yaml").read_text())
  ingestors = values["rag-ingestors"]["ingestors"]

  assert ingestors[0]["name"] == "webloader"
  assert ingestors[0]["type"] == "webloader"


def test_custom_ingestor_list_uses_normal_helm_replacement_semantics() -> None:
  deployments = _deployments(
    _render_rag_stack(
      {
        "rag-ingestors.ingestors[0].name": "jira-example",
        "rag-ingestors.ingestors[0].type": "jira",
      }
    )
  )
  ingestor_types = {
    deployment["metadata"]["labels"].get("app.kubernetes.io/ingestor-type")
    for deployment in deployments
  }

  assert "jira" in ingestor_types
  assert "webloader" not in ingestor_types


def test_fixed_interval_is_only_emitted_when_configured() -> None:
  deployments = _deployments(
    _render_rag_stack(
      {
        "rag-ingestors.ingestors[0].name": "argocd-example",
        "rag-ingestors.ingestors[0].type": "argocdv3",
        "rag-ingestors.ingestors[0].syncInterval": "7200",
      }
    )
  )
  argocd = next(
    deployment
    for deployment in deployments
    if deployment["metadata"]["labels"].get("app.kubernetes.io/ingestor-type")
    == "argocdv3"
  )
  container = argocd["spec"]["template"]["spec"]["containers"][0]

  assert _environment(container)["SYNC_INTERVAL"] == "7200"


def test_custom_environment_overrides_do_not_create_duplicate_names() -> None:
  overrides = {
    "INGESTOR_TYPE": "custom",
    "RAG_SERVER_URL": "http://rag.example.test:9446",
    "REDIS_URL": "redis://redis.example.test:6379/1",
    "LOG_LEVEL": "DEBUG",
    "SYNC_INTERVAL": "3600",
    "INIT_DELAY_SECONDS": "5",
  }
  set_values = {
    "rag-ingestors.ingestors[0].name": "custom-example",
    "rag-ingestors.ingestors[0].type": "webloader",
    "rag-ingestors.ingestors[0].syncInterval": "7200",
  }
  set_values.update(
    {
      f"rag-ingestors.ingestors[0].env.{name}": value
      for name, value in overrides.items()
    }
  )
  deployments = _deployments(_render_rag_stack(set_values))
  custom = next(
    deployment
    for deployment in deployments
    if deployment["metadata"]["labels"].get("app.kubernetes.io/ingestor-name")
    == "custom-example"
  )
  container = custom["spec"]["template"]["spec"]["containers"][0]
  names = _environment_names(container)
  environment = _environment(container)

  assert len(names) == len(set(names))
  for name, value in overrides.items():
    assert environment[name] == value


@pytest.mark.parametrize(
  "ingestor_type",
  ["webloader", "slack", "webex", "jira", "confluence"],
)
def test_ui_managed_ingestors_do_not_receive_a_deployment_interval(
  ingestor_type: str,
) -> None:
  deployments = _deployments(
    _render_rag_stack(
      {
        "rag-ingestors.ingestors[0].name": f"{ingestor_type}-example",
        "rag-ingestors.ingestors[0].type": ingestor_type,
      }
    )
  )
  deployment = next(
    item
    for item in deployments
    if item["metadata"]["labels"].get("app.kubernetes.io/ingestor-type")
    == ingestor_type
  )
  container = deployment["spec"]["template"]["spec"]["containers"][0]

  assert "SYNC_INTERVAL" not in _environment(container)


def test_legacy_web_ingestor_sidecar_values_are_ignored() -> None:
  result = subprocess.run(
    [
      "helm",
      "template",
      "test",
      str(RAG_SERVER),
      "--set",
      "global.vpa.enabled=false",
      "--set",
      "global.image.tag=test",
      "--set",
      "webIngestor.enabled=true",
    ],
    capture_output=True,
    check=True,
    text=True,
  )
  documents = [document for document in yaml.safe_load_all(result.stdout) if document]
  deployment = _deployments(documents)[0]

  assert [container["name"] for container in deployment["spec"]["template"]["spec"]["containers"]] == [
    "rag-server"
  ]
