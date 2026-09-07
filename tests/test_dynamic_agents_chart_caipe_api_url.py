# assisted-by Claude:claude-opus-4-8
"""Helm template tests for the dynamic-agents subchart's ``CAIPE_API_URL``
env-var wiring.

Pins the contract relied on by the built-in workflow tools in
``ai_platform_engineering/dynamic_agents/src/dynamic_agents/services/builtin_tools.py``:

* Workflow calls are built as ``f"{self.base_url}{path}"`` against paths such
  as ``/api/workflow-runs``. An empty base URL therefore yields the bare
  relative path and the request dies with
  ``Invalid URL '/api/workflow-runs': No scheme supplied``.
* ``dynamic-agents.config.CAIPE_API_URL`` defaults to ``""``, and
  ``configmap.yaml`` deliberately skips empty-string values — so the key never
  reaches the pod via ``envFrom``. The Deployment must supply a release-scoped
  default explicitly, exactly like ``KEYCLOAK_URL``/``OPENFGA_HTTP``/
  ``CREDENTIAL_API_URL`` already do, and like the ``slack-bot`` and
  ``webex-bot`` subcharts already do for this very key.

Regression test for caipe-io/ai-platform-engineering#1958.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
CHART_PATH = (
    REPO_ROOT
    / "charts"
    / "ai-platform-engineering"
    / "charts"
    / "dynamic-agents"
)

# global.image.tag must be set so the subchart can resolve appVersion
# when rendered standalone (the umbrella chart provides this normally).
_BASE_SET = [
    "global.image.tag=0.5.1-test",
]


def _require_helm() -> None:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for dynamic-agents chart tests")


def _helm_template(*extra_set_args: str, release: str = "test") -> list[dict[str, Any]]:
    _require_helm()
    cmd = ["helm", "template", release, str(CHART_PATH)]
    for arg in _BASE_SET + list(extra_set_args):
        cmd.extend(["--set", arg])
    rendered = subprocess.run(cmd, check=True, text=True, capture_output=True).stdout
    return [doc for doc in yaml.safe_load_all(rendered) if doc]


def _find_deployment(docs: list[dict[str, Any]]) -> dict[str, Any]:
    for doc in docs:
        if doc.get("kind") == "Deployment":
            return doc
    raise AssertionError("Deployment not found in render")


def _env_var(docs: list[dict[str, Any]], name: str) -> dict[str, Any]:
    env = _find_deployment(docs)["spec"]["template"]["spec"]["containers"][0]["env"]
    matches = [e for e in env if e.get("name") == name]
    assert matches, f"{name} not found in rendered container env"
    assert len(matches) == 1, f"{name} rendered {len(matches)} times; must be exactly once"
    return matches[0]


def _find_configmap(docs: list[dict[str, Any]], suffix: str) -> dict[str, Any]:
    for doc in docs:
        if doc.get("kind") == "ConfigMap" and doc.get("metadata", {}).get("name", "").endswith(suffix):
            return doc
    raise AssertionError(f"ConfigMap ending with {suffix!r} not found in render")


def test_caipe_api_url_defaults_to_release_scoped_ui_service() -> None:
    """With no override, the Deployment must inject an absolute in-cluster URL
    derived from the release name. This is the actual bug in #1958: the env var
    was absent entirely, so the workflow client fell back to an empty base URL.
    """
    caipe_api_url = _env_var(_helm_template(), "CAIPE_API_URL")
    assert caipe_api_url["value"] == "http://test-caipe-ui:3000"


def test_caipe_api_url_default_tracks_release_name() -> None:
    """The default must be release-scoped, not the hardcoded
    ``ai-platform-engineering-`` prefix — installs under any other release name
    would otherwise fail DNS resolution.
    """
    docs = _helm_template(release="my-caipe")
    assert _env_var(docs, "CAIPE_API_URL")["value"] == "http://my-caipe-caipe-ui:3000"


def test_caipe_api_url_override_is_respected() -> None:
    """Operators pointing dynamic-agents at an external CAIPE UI/BFF must get
    their exact value, not the in-cluster default.
    """
    docs = _helm_template("config.CAIPE_API_URL=https://caipe.example.com")
    assert _env_var(docs, "CAIPE_API_URL")["value"] == "https://caipe.example.com"


def test_empty_caipe_api_url_is_omitted_from_configmap() -> None:
    """The default ``CAIPE_API_URL=""`` must stay out of the ConfigMap.

    ``env`` outranks ``envFrom`` in Kubernetes, but leaking an empty value here
    would still be wrong — and it is precisely the configmap skip that made the
    key vanish from the pod in the first place.
    """
    data = _find_configmap(_helm_template(), "-config")["data"]
    assert "CAIPE_API_URL" not in data
    # Sanity: a non-empty key from the same range loop IS present, so we know
    # the iteration itself is healthy.
    assert data.get("MONGODB_DATABASE") == "caipe"


def test_caipe_api_url_default_matches_bot_subcharts() -> None:
    """slack-bot and webex-bot already default this key to the release-scoped
    CAIPE UI service. dynamic-agents must not drift from that shape.
    """
    expected = 'default (printf "http://%s-caipe-ui:3000" .Release.Name)'
    for chart in ("dynamic-agents", "slack-bot", "webex-bot"):
        template = (
            REPO_ROOT
            / "charts"
            / "ai-platform-engineering"
            / "charts"
            / chart
            / "templates"
            / "deployment.yaml"
        ).read_text()
        assert expected in template, f"{chart} lost the release-scoped CAIPE_API_URL default"


def test_umbrella_values_documents_caipe_api_url() -> None:
    """The parent chart values file must keep the key discoverable so operators
    know where to override it.
    """
    umbrella_values = (
        REPO_ROOT / "charts" / "ai-platform-engineering" / "values.yaml"
    ).read_text()
    assert "CAIPE_API_URL:" in umbrella_values
