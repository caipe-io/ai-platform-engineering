"""Render MCP ExternalSecrets independently and with the parent chart's globals."""

import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
PARENT = ROOT / "charts/ai-platform-engineering"
MCP = PARENT / "charts/mcp-server"
VERSION_CASES = [
    pytest.param([], "v1beta1", id="compatibility-default"),
    pytest.param(["global.externalSecrets.apiVersion=v1"], "v1", id="v1"),
    pytest.param(["global.externalSecrets.apiVersion=v1beta1"], "v1beta1", id="v1beta1"),
    pytest.param(["global.llmSecrets.externalSecrets.apiVersion=v1"], "v1", id="legacy-only"),
    pytest.param(
        ["global.externalSecrets.apiVersion=", "global.llmSecrets.externalSecrets.apiVersion=v1"],
        "v1", id="empty-primary",
    ),
    pytest.param(
        ["global.externalSecrets.apiVersion=v1", "global.llmSecrets.externalSecrets.apiVersion=v1beta1"],
        "v1", id="explicit-v1-precedence",
    ),
    pytest.param(
        ["global.externalSecrets.apiVersion=v1beta1", "global.llmSecrets.externalSecrets.apiVersion=v1"],
        "v1beta1", id="explicit-v1beta1-precedence",
    ),
]


@pytest.fixture
def parent_chart(tmp_path: Path) -> Path:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for MCP chart rendering")

    # Exercise parent globals and helper visibility without unrelated dependencies.
    dest = tmp_path / "parent"
    (dest / "templates").mkdir(parents=True)
    for name in ("_helpers.tpl", "externalsecrets.yaml"):
        shutil.copyfile(PARENT / "templates" / name, dest / "templates" / name)
    shutil.copyfile(PARENT / "values.yaml", dest / "values.yaml")
    shutil.copytree(MCP, dest / "charts/mcp-server")
    version = yaml.safe_load((MCP / "Chart.yaml").read_text())["version"]
    (dest / "Chart.yaml").write_text(
        "apiVersion: v2\nname: example\nversion: 1.0.0\n"
        "dependencies:\n  - name: mcp-server\n    alias: example-mcp\n"
        f"    version: {version}\n    repository: file://charts/mcp-server\n"
    )
    return dest


@pytest.fixture(params=["standalone", "parent"])
def chart(request: pytest.FixtureRequest, parent_chart: Path) -> tuple[Path, str]:
    return (MCP, "") if request.param == "standalone" else (parent_chart, "example-mcp.")


def render(
    chart: tuple[Path, str], *settings: str, values_file: Path | None = None,
) -> list[dict[str, Any]]:
    path, prefix = chart
    args = ["helm", "template", "example", str(path),
            "--set", "global.image.tag=example",
            "--set", f"{prefix}mcp.image.repository=example/mcp-server"]
    if values_file is not None:
        args.extend(["--values", str(values_file)])
    for setting in settings:
        args.extend(["--set", setting])
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


@pytest.mark.parametrize(("settings", "version"), VERSION_CASES)
def test_external_secret_versions(
    chart: tuple[Path, str], settings: list[str], version: str,
) -> None:
    _, prefix = chart
    resources = render(
        chart,
        "global.llmSecrets.create=true",
        f"{prefix}mcpSecrets.externalSecrets.enabled=true",
        f"{prefix}mcpSecrets.externalSecrets.secretStoreRef.name=example-store",
        f"{prefix}mcpSecrets.externalSecrets.data[0].secretKey=API_KEY",
        f"{prefix}mcpSecrets.externalSecrets.data[0].remoteRef.key=example/credentials",
        f"{prefix}llmSecrets.externalSecrets.enabled=true",
        f"{prefix}llmSecrets.externalSecrets.secretStoreRef.name=example-store",
        f"{prefix}llmSecrets.externalSecrets.target.template.engineVersion=v2",
        f"{prefix}llmSecrets.externalSecrets.data[0].secretKey=MODEL_API_KEY",
        f"{prefix}llmSecrets.externalSecrets.data[0].remoteRef.key=example/model",
        *settings,
    )
    secrets = [doc for doc in resources if doc["kind"] == "ExternalSecret"]
    assert len(secrets) == 2
    assert {doc["apiVersion"] for doc in secrets} == {f"external-secrets.io/{version}"}
    assert {entry["secretKey"] for doc in secrets for entry in doc["spec"]["data"]} == {"API_KEY", "MODEL_API_KEY"}
    assert all(doc["spec"]["target"]["name"] == doc["metadata"]["name"] for doc in secrets)
    assert not any(doc["kind"] == "Secret" for doc in resources)


def test_external_secrets_remain_opt_in(chart: tuple[Path, str]) -> None:
    assert not any(doc["kind"] == "ExternalSecret" for doc in render(chart))


@pytest.mark.parametrize(("settings", "version"), VERSION_CASES)
def test_parent_and_mcp_external_secrets_agree(
    parent_chart: Path, settings: list[str], version: str,
) -> None:
    resources = render(
        (parent_chart, "example-mcp."),
        "global.externalSecrets.enabled=true",
        "global.externalSecrets.secretStoreRef.name=example-store",
        "global.llmSecrets.externalSecrets.data[0].secretKey=MODEL_API_KEY",
        "global.llmSecrets.externalSecrets.data[0].remoteRef.key=example/model",
        *settings,
    )
    secrets = [doc for doc in resources if doc["kind"] == "ExternalSecret"]
    assert {doc["metadata"]["name"] for doc in secrets} == {"llm-secret", "example-mcp-secret"}
    assert {doc["apiVersion"] for doc in secrets} == {f"external-secrets.io/{version}"}


@pytest.mark.parametrize(("settings", "version"), VERSION_CASES)
def test_external_secrets_example_allows_version_overrides(
    parent_chart: Path, settings: list[str], version: str,
) -> None:
    resources = render(
        (parent_chart, "example-mcp."), *settings,
        values_file=PARENT / "values-external-secrets.yaml",
    )
    secrets = [doc for doc in resources if doc["kind"] == "ExternalSecret"]
    assert len(secrets) == 2
    assert {doc["apiVersion"] for doc in secrets} == {f"external-secrets.io/{version}"}
