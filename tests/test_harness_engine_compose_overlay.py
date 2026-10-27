from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / "docker-compose.caipe-oss.yaml"
NGINX = ROOT / "deploy" / "caipe-oss-nginx.conf"


class ComposeLoader(yaml.SafeLoader):
    """Load Compose merge tags while preserving their underlying value."""


ComposeLoader.add_constructor(
    "!override",
    lambda loader, node: loader.construct_sequence(node),
)


def test_preview_overlay_adds_harness_engine_without_overriding_dynamic_agents() -> None:
    services = yaml.load(
        OVERLAY.read_text(encoding="utf-8"),
        Loader=ComposeLoader,
    )["services"]

    assert "dynamic-agents" not in services
    assert services["harness-engine"]["build"]["dockerfile"] == (
        "ai_platform_engineering/harness_engine/build/Dockerfile"
    )
    assert services["harness-engine"]["environment"]["HARNESS_ENGINE_STORAGE_BACKEND"] == (
        "mongodb"
    )
    assert services["harness-engine"]["tmpfs"] == [
        "/workspace:rw,nosuid,nodev,mode=1777,size=512m"
    ]
    assert services["caipe-ui"]["environment"]["HARNESS_ENGINE_URL"] == (
        "http://harness-engine:8010"
    )
    assert services["langfuse-web"]["ports"] == ["127.0.0.1:3001:3000"]
    assert services["rag-server"]["environment"]["EMBEDDINGS_PROVIDER"] == "ollama"
    assert services["rag-server"]["depends_on"]["ollama-models"]["condition"] == (
        "service_completed_successfully"
    )
    assert services["keycloak-ui-client-config"]["environment"][
        "KEYCLOAK_UI_BASE_URL"
    ] == "https://caipe-oss.outshift.io"
    assert services["caipe-nginx"]["depends_on"]["keycloak-ui-client-config"][
        "condition"
    ] == "service_completed_successfully"


def test_preview_nginx_exposes_ui_but_not_harness_engine_directly() -> None:
    config = NGINX.read_text(encoding="utf-8")

    assert "server_name caipe-oss.outshift.io;" in config
    assert "proxy_pass http://caipe-ui:3000;" in config
    assert "proxy_pass http://harness-engine:8010;" not in config
    assert "location ~ ^/(realms|resources|js|welcome-content)/" in config
    assert "location ~ ^/(realms|resources|admin|js|welcome-content)/" not in config
