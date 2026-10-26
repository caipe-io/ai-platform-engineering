"""Render platform cache resources without external chart dependencies."""

from pathlib import Path
import shutil
import subprocess

import pytest
import yaml

CHART = Path(__file__).resolve().parents[1] / "charts" / "ai-platform-engineering"


@pytest.fixture
def cache_chart(tmp_path: Path) -> Path:
    (tmp_path / "templates").mkdir()
    (tmp_path / "Chart.yaml").write_text("apiVersion: v2\nname: example-cache\nversion: 0.1.0\n")
    shutil.copy(CHART / "values.yaml", tmp_path / "values.yaml")
    shutil.copy(CHART / "templates" / "caipe-redis.yaml", tmp_path / "templates" / "caipe-redis.yaml")
    return tmp_path


def render(chart: Path, values: dict[str, str]) -> subprocess.CompletedProcess[str]:
    command = ["helm", "template", "example", str(chart)]
    for key, value in values.items():
        command.extend(["--set", f"{key}={value}"])
    return subprocess.run(command, capture_output=True, text=True, check=False)


def test_platform_cache_disabled_by_default(cache_chart: Path) -> None:
    result = render(cache_chart, {})
    assert result.returncode == 0, result.stderr
    assert not list(yaml.safe_load_all(result.stdout))


def test_platform_cache_requires_password_secret(cache_chart: Path) -> None:
    result = render(cache_chart, {"caipe-redis.enabled": "true"})
    assert result.returncode != 0
    assert "auth.existingSecret.name is required" in result.stderr


def test_platform_cache_bounds_memory_and_retains_separate_volume(cache_chart: Path) -> None:
    result = render(cache_chart, {
        "caipe-redis.enabled": "true",
        "caipe-redis.auth.existingSecret.name": "example-cache-auth",
    })
    assert result.returncode == 0, result.stderr
    objects = {item["kind"]: item for item in yaml.safe_load_all(result.stdout) if item}
    deployment = objects["Deployment"]
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    assert deployment["spec"]["replicas"] == 1
    assert deployment["spec"]["strategy"]["type"] == "Recreate"
    assert "allkeys-lru" in container["args"]
    assert "512mb" in container["args"]
    assert container["resources"]["limits"]["memory"] == "1Gi"
    assert container["env"][0]["valueFrom"]["secretKeyRef"]["name"] == "example-cache-auth"
    assert objects["PersistentVolumeClaim"]["metadata"]["annotations"]["helm.sh/resource-policy"] == "keep"
    assert objects["PersistentVolumeClaim"]["metadata"]["name"] == "example-caipe-redis"
    assert objects["Service"]["spec"]["type"] == "ClusterIP"
    ingress = objects["NetworkPolicy"]["spec"]["ingress"][0]
    assert {peer["podSelector"]["matchLabels"]["app.kubernetes.io/name"] for peer in ingress["from"]} == {"caipe-ui", "slack-bot"}


def test_platform_cache_requires_eviction(cache_chart: Path) -> None:
    result = render(cache_chart, {
        "caipe-redis.enabled": "true",
        "caipe-redis.auth.existingSecret.name": "example-cache-auth",
        "caipe-redis.redis.maxmemoryPolicy": "noeviction",
    })
    assert result.returncode != 0
    assert "requires redis.maxmemoryPolicy=allkeys-lru" in result.stderr


@pytest.mark.parametrize("consumer", ["caipe-ui", "slack-bot"])
@pytest.mark.parametrize("enabled", [True, False])
def test_consumers_receive_only_secret_url_when_enabled(consumer: str, enabled: bool) -> None:
    result = render(CHART / "charts" / consumer, {
        "global.vpa.enabled": "false",
        "global.image.tag": "example",
        "oktaSync.enabled": "false",
        "cacheRedis.enabled": str(enabled).lower(),
        "cacheRedis.existingSecret.name": "example-cache-url",
    })
    assert result.returncode == 0, result.stderr
    deployment = next(item for item in yaml.safe_load_all(result.stdout) if item and item["kind"] == "Deployment")
    environment = deployment["spec"]["template"]["spec"]["containers"][0]["env"]
    variables = [item for item in environment if item["name"] == "CAIPE_CACHE_REDIS_URL"]
    if enabled:
        assert variables == [{"name": "CAIPE_CACHE_REDIS_URL", "valueFrom": {"secretKeyRef": {
            "name": "example-cache-url", "key": "CAIPE_CACHE_REDIS_URL",
        }}}]
    else:
        assert not variables
