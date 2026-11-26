"""RAG uses the selected shared database without requiring a local provider."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def compose_project(tmp_path: Path) -> Path:
  (tmp_path / ".env").write_text("", encoding="utf-8")
  return tmp_path


@pytest.mark.parametrize("filename", ["docker-compose.yaml", "docker-compose.dev.yaml"])
@pytest.mark.parametrize("provider", ["caipe-mongodb", "caipe-documentdb", None])
def test_rag_database_provider_selection(filename: str, provider: str | None, compose_project: Path) -> None:
  uri = "mongodb://example-mongodb:27017/example"
  if provider == "caipe-documentdb":
    uri = "mongodb://caipe-documentdb:10260/example?tls=false&directConnection=true"
  command = ["docker", "compose", "--project-directory", str(compose_project), "-f", str(ROOT / filename), "--env-file", str(ROOT / ".env.example"), "--profile", "rag"]
  if provider:
    command.extend(["--profile", provider])
  result = subprocess.run(
    [*command, "config", "--format", "json"], cwd=ROOT,
    env={**os.environ, "COMPOSE_PROFILES": "", "MONGODB_URI": uri},
    text=True, capture_output=True, check=False,
  )
  assert result.returncode == 0, result.stderr
  services = json.loads(result.stdout)["services"]
  assert services["rag-server"]["environment"]["MONGODB_URI"] == uri
  assert ("caipe-mongodb" in services) == (provider == "caipe-mongodb")
  assert ("caipe-documentdb" in services) == (provider == "caipe-documentdb")


@pytest.mark.parametrize("filename", ["docker-compose.yaml", "docker-compose.dev.yaml"])
def test_every_ingestor_receives_shared_database_configuration(filename: str, compose_project: Path) -> None:
  result = subprocess.run(
    ["docker", "compose", "--project-directory", str(compose_project), "-f", str(ROOT / filename), "--env-file", str(ROOT / ".env.example"), "--profile", "*", "config", "--format", "json"],
    cwd=ROOT, env={**os.environ, "COMPOSE_PROFILES": "", "MONGODB_URI": "mongodb://example-mongodb:27017/example"},
    text=True, capture_output=True, check=False,
  )
  assert result.returncode == 0, result.stderr
  ingestors = [service for service in json.loads(result.stdout)["services"].values() if "INGESTOR_TYPE" in service.get("environment", {})]
  assert ingestors
  for service in ingestors:
    assert service["environment"]["MONGODB_URI"] == "mongodb://example-mongodb:27017/example"
    assert service["environment"]["MONGODB_DATABASE"]
