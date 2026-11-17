"""Catalog mounts must preserve deployment-owned app installations on upgrade."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml


CHART = Path(__file__).resolve().parents[1] / "charts/ai-platform-engineering/charts/caipe-ui"
CATALOG_PATH = "/etc/caipe-ui-agentic-apps/agentic-apps.yaml"


def render(tmp_path: Path, **overrides: Any) -> tuple[list[dict], dict, dict]:
    values = {
        "global": {"vpa": {"enabled": False}, "image": {"tag": ""}},
        "oktaSync": {"enabled": False},
        "config": {"AGENTIC_APPS_INSTALL_ENABLED": "true"},
        **overrides,
    }
    path = tmp_path / "values.json"
    path.write_text(json.dumps(values))
    result = subprocess.run(
        ["helm", "template", "example", str(CHART), "-f", str(path)],
        check=True, capture_output=True, text=True,
    )
    documents = [d for d in yaml.safe_load_all(result.stdout) if d]
    pod = next(d for d in documents if d["kind"] == "Deployment")["spec"]["template"]["spec"]
    return documents, pod, pod["containers"][0]


def catalogs(documents: list[dict]) -> list[dict]:
    return [d for d in documents if d["kind"] == "ConfigMap" and d["metadata"]["name"].endswith("-agentic-apps")]


def test_enabled_fresh_install_has_readable_empty_catalog(tmp_path: Path) -> None:
    documents, pod, container = render(tmp_path)
    catalog = catalogs(documents)[0]
    assert yaml.safe_load(catalog["data"]["agentic-apps.yaml"]) == {
        "agentic_apps": {"packages": [], "installations": []},
    }
    volume = next(v for v in pod["volumes"] if v["name"] == "agentic-apps")
    assert volume["configMap"]["name"] == catalog["metadata"]["name"]
    mount = next(m for m in container["volumeMounts"] if m["name"] == "agentic-apps")
    assert mount["mountPath"] == CATALOG_PATH
    assert mount["subPath"] in catalog["data"]


def test_existing_configmap_replaces_generated_catalog(tmp_path: Path) -> None:
    documents, pod, container = render(tmp_path, agenticApps={"existingConfigMap": "example-catalog", "configMapKey": "catalog.yaml"})
    assert not catalogs(documents)
    volume = next(v for v in pod["volumes"] if v["name"] == "agentic-apps")
    assert volume["configMap"] == {"name": "example-catalog", "items": [{"key": "catalog.yaml", "path": "catalog.yaml"}]}
    assert next(m for m in container["volumeMounts"] if m["name"] == "agentic-apps")["subPath"] == "catalog.yaml"


@pytest.mark.parametrize("mount_path", [CATALOG_PATH, "/etc/caipe-ui-agentic-apps", "/etc/caipe-ui-agentic-apps/", "/etc", "/"])
def test_existing_file_or_directory_mount_is_not_shadowed(tmp_path: Path, mount_path: str) -> None:
    mount = {"name": "example-catalog", "mountPath": mount_path, "readOnly": True}
    volume = {"name": "example-catalog", "configMap": {"name": "example-catalog"}}
    documents, pod, container = render(tmp_path, volumeMounts=[mount], volumes=[volume])
    assert not catalogs(documents)
    assert container["volumeMounts"] == [mount]
    assert volume in pod["volumes"]
    assert all(v["name"] != "agentic-apps" for v in pod["volumes"])


def test_adjacent_directory_does_not_suppress_default_catalog(tmp_path: Path) -> None:
    documents, _, container = render(tmp_path, volumeMounts=[{"name": "example", "mountPath": "/etc/caipe-ui-agentic"}], volumes=[{"name": "example", "emptyDir": {}}])
    assert catalogs(documents)
    assert any(m["mountPath"] == CATALOG_PATH for m in container["volumeMounts"])


def test_chart_mount_follows_custom_catalog_path(tmp_path: Path) -> None:
    _, _, container = render(tmp_path, config={"AGENTIC_APPS_INSTALL_ENABLED": "true", "AGENTIC_APPS_CONFIG_PATH": "/etc/example/catalog.yaml"})
    assert next(m for m in container["volumeMounts"] if m["name"] == "agentic-apps")["mountPath"] == "/etc/example/catalog.yaml"


def test_disabled_apps_do_not_create_or_mount_catalog(tmp_path: Path) -> None:
    documents, pod, container = render(tmp_path, config={"AGENTIC_APPS_INSTALL_ENABLED": "false"})
    assert not catalogs(documents)
    assert all(m["name"] != "agentic-apps" for m in (container["volumeMounts"] or []))
    assert all(v["name"] != "agentic-apps" for v in (pod["volumes"] or []))


def test_generated_catalog_uses_configured_key(tmp_path: Path) -> None:
    documents, _, container = render(tmp_path, agenticApps={"configMapKey": "catalog.yaml"})
    mount = next(m for m in container["volumeMounts"] if m["name"] == "agentic-apps")
    assert mount["subPath"] in catalogs(documents)[0]["data"]
