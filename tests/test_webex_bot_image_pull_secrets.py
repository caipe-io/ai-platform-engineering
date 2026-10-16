"""Render registry credentials without changing service-account token policy."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "charts" / "ai-platform-engineering"
pytestmark = pytest.mark.skipif(shutil.which("helm") is None, reason="helm is required")


def _pod_spec(*, umbrella: bool, values: dict[str, Any]) -> dict[str, Any]:
    chart = CHART if umbrella else CHART / "charts" / "webex-bot"
    prefix = "webex-bot." if umbrella else ""
    command = ["helm", "template", "test", str(chart), "--set", "global.image.tag=test"]
    if umbrella:
        command.extend(["--set", "tags.webex-bot=true"])
    for key, value in values.items():
        command.extend(["--set-json", f"{prefix}{key}={json.dumps(value)}"])
    rendered = subprocess.run(command, check=True, text=True, capture_output=True)
    deployments = [
        doc for doc in yaml.safe_load_all(rendered.stdout)
        if doc and doc.get("kind") == "Deployment"
        and doc["metadata"]["name"].endswith("-webex-bot")
    ]
    assert len(deployments) == 1
    return deployments[0]["spec"]["template"]["spec"]


@pytest.mark.parametrize("umbrella", [False, True], ids=["standalone", "umbrella"])
def test_default_omits_pull_secrets_and_keeps_token_mount_disabled(umbrella: bool) -> None:
    pod = _pod_spec(umbrella=umbrella, values={})
    assert "imagePullSecrets" not in pod
    assert pod["automountServiceAccountToken"] is False


@pytest.mark.parametrize("umbrella", [False, True], ids=["standalone", "umbrella"])
@pytest.mark.parametrize("names", [["primary-registry"], ["primary-registry", "secondary-registry"]])
def test_renders_registry_secret_references(umbrella: bool, names: list[str]) -> None:
    secrets = [{"name": name} for name in names]
    pod = _pod_spec(umbrella=umbrella, values={"imagePullSecrets": secrets})
    assert pod.get("imagePullSecrets") == secrets
    assert pod["automountServiceAccountToken"] is False


@pytest.mark.parametrize("umbrella", [False, True], ids=["standalone", "umbrella"])
def test_pull_secrets_do_not_override_explicit_token_mount_policy(umbrella: bool) -> None:
    pod = _pod_spec(umbrella=umbrella, values={
        "imagePullSecrets": [{"name": "primary-registry"}],
        "serviceAccount.automount": True,
    })
    assert pod.get("imagePullSecrets") == [{"name": "primary-registry"}]
    assert pod["automountServiceAccountToken"] is True
