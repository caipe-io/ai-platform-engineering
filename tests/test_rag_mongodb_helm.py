"""RAG consumers require an explicit application database Secret reference."""
from pathlib import Path
import subprocess

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]


def render(chart: str, *, configured: bool) -> subprocess.CompletedProcess[str]:
  command = ["helm", "template", "example", str(ROOT / "charts/rag-stack/charts" / chart), "--set", "global.image.tag=test"]
  if chart == "rag-ingestors":
    command.extend(["--set", "ingestors[0].name=example", "--set", "ingestors[0].type=webloader"])
  if configured:
    command.extend(["--set", "global.rag.mongodb.existingSecret=example-mongodb", "--set", "global.rag.mongodb.caConfigMap=example-ca"])
  return subprocess.run(command, capture_output=True, text=True, check=False)


@pytest.mark.parametrize("chart", ["rag-server", "rag-ingestors", "agent-ontology"])
def test_rag_mongodb_secret_and_ca_contract(chart: str) -> None:
  result = render(chart, configured=True)
  assert result.returncode == 0, result.stderr
  deployment = next(document for document in yaml.safe_load_all(result.stdout) if document and document["kind"] == "Deployment")
  pod = deployment["spec"]["template"]["spec"]
  container = pod["containers"][0]
  environment = {item["name"]: item for item in container["env"]}
  assert environment["MONGODB_URI"]["valueFrom"]["secretKeyRef"] == {"name": "example-mongodb", "key": "MONGODB_URI"}
  assert environment["MONGODB_TLS_CA_FILE"]["value"] == "/etc/rag-mongodb-ca/ca.pem"
  assert "REDIS_URL" not in environment
  assert any(volume.get("configMap", {}).get("name") == "example-ca" for volume in pod["volumes"])


@pytest.mark.parametrize("chart", ["rag-server", "rag-ingestors", "agent-ontology"])
def test_rag_mongodb_missing_secret_fails_closed(chart: str) -> None:
  result = render(chart, configured=False)
  assert result.returncode != 0
  assert "global.rag.mongodb.existingSecret" in result.stderr
