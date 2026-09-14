import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def test_parent_chart_renders_bridge_token_validation_env() -> None:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering"
    result = subprocess.run(
        [
            "helm",
            "template",
            "caipe",
            str(chart),
            "--namespace",
            "caipe",
            "--set",
            "openfga.enabled=true",
            "--set",
            "openfgaAuthzBridge.enabled=true",
            "--set",
            "tags.keycloak=true",
            "--set",
            "keycloak.admin.secretRef=caipe-keycloak-admin",
            "--set",
            "openfga-authz-bridge.tokenValidation.issuer=https://idp.example.com/realms/caipe",
            "--set",
            "openfga-authz-bridge.tokenValidation.audiences[0]=agentgateway",
            "--set",
            "openfga-authz-bridge.tokenValidation.audiences[1]=caipe-platform",
            "--set",
            "openfga-authz-bridge.audit.serviceUrl=http://audit-service:8010",
            "--set",
            "openfga-authz-bridge.organizationKey=example-org",
            "--set",
            "openfga-authz-bridge.restrictedMcpServers[0]=scheduler",
        ],
        check=True,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )

    rendered = result.stdout
    assert "name: caipe-openfga-authz-bridge" in rendered
    assert 'value: "http://caipe-keycloak:8080/realms/caipe/protocol/openid-connect/certs"' in rendered
    assert 'value: "https://idp.example.com/realms/caipe"' in rendered
    assert 'value: "agentgateway,caipe-platform"' in rendered
    assert 'value: "RS256"' in rendered
    assert "name: AUDIT_SERVICE_URL" in rendered
    assert 'value: "http://audit-service:8010"' in rendered
    assert "name: CAIPE_ORG_KEY" in rendered
    assert 'value: "example-org"' in rendered
    assert "name: CAIPE_RESTRICTED_MCP_SERVERS" in rendered
    assert 'value: "scheduler"' in rendered
    assert "name: MONGODB_DATABASE" not in rendered
    assert "name: MONGODB_URI" not in rendered


def test_agentgateway_chart_can_mount_provider_backend_auth_secret_env() -> None:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering"
    result = subprocess.run(
        [
            "helm",
            "template",
            "caipe",
            str(chart),
            "--namespace",
            "caipe",
            "--set",
            "agentgateway.enabled=true",
            "--set",
            "agentgateway.extraEnv[0].name=GITHUB_PERSONAL_ACCESS_TOKEN",
            "--set",
            "agentgateway.extraEnv[0].valueFrom.secretKeyRef.name=github-mcp-secret",
            "--set",
            "agentgateway.extraEnv[0].valueFrom.secretKeyRef.key=GITHUB_PERSONAL_ACCESS_TOKEN",
            "--set",
            "agentgateway.extraEnv[1].name=GITLAB_PERSONAL_ACCESS_TOKEN",
            "--set",
            "agentgateway.extraEnv[1].valueFrom.secretKeyRef.name=gitlab-mcp-secret",
            "--set",
            "agentgateway.extraEnv[1].valueFrom.secretKeyRef.key=GITLAB_PERSONAL_ACCESS_TOKEN",
            "--set",
            "agentgateway.config.binds[0].listeners[0].routes[0].matches[0].path.pathPrefix=/mcp/github",
            "--set",
            "agentgateway.config.binds[0].listeners[0].routes[0].backends[0].mcp.targets[0].name=github",
            "--set",
            "agentgateway.config.binds[0].listeners[0].routes[0].backends[0].mcp.targets[0].mcp.host=http://github-mcp-server:8082/mcp",
            "--set",
            "agentgateway.config.binds[0].listeners[0].routes[0].backends[0].mcp.targets[0].policies.backendAuth.key=\\$GITHUB_PERSONAL_ACCESS_TOKEN",
            "--set",
            "agentgateway.config.binds[0].listeners[0].routes[1].matches[0].path.pathPrefix=/mcp/gitlab",
            "--set",
            "agentgateway.config.binds[0].listeners[0].routes[1].backends[0].mcp.targets[0].name=gitlab",
            "--set",
            "agentgateway.config.binds[0].listeners[0].routes[1].backends[0].mcp.targets[0].mcp.host=http://mcp-gitlab:8000/mcp",
            "--set",
            "agentgateway.config.binds[0].listeners[0].routes[1].backends[0].mcp.targets[0].policies.backendAuth.key=\\$GITLAB_PERSONAL_ACCESS_TOKEN",
        ],
        check=True,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )

    rendered = result.stdout
    assert "name: GITHUB_PERSONAL_ACCESS_TOKEN" in rendered
    assert "secretKeyRef:" in rendered
    assert "name: github-mcp-secret" in rendered
    assert "key: GITHUB_PERSONAL_ACCESS_TOKEN" in rendered
    assert "name: GITLAB_PERSONAL_ACCESS_TOKEN" in rendered
    assert "name: gitlab-mcp-secret" in rendered
    assert "key: GITLAB_PERSONAL_ACCESS_TOKEN" in rendered
    assert "backendAuth:" in rendered
    assert "key: $GITHUB_PERSONAL_ACCESS_TOKEN" in rendered
    assert "key: $GITLAB_PERSONAL_ACCESS_TOKEN" in rendered


def test_umbrella_values_define_webex_bot_section() -> None:
    root = _repo_root()
    values = yaml.safe_load((root / "charts/ai-platform-engineering/values.yaml").read_text())
    assert "webex-bot" in values
    webex = values["webex-bot"]
    assert webex["existingSecret"] == "webex-bot-secrets"
    assert webex["config"]["WEBEX_ADMIN_JWT_AUDIENCE"] == "caipe-webex-bot-admin"
    assert webex["config"]["WEBEX_ADMIN_API_ENABLED"] == "true"
    assert webex["config"]["WEBEX_ADMIN_API_PORT"] == "3002"
    assert "ghcr.io/caipe-io/caipe-webex-bot" in webex["image"]["repository"]


def test_caipe_ui_values_wire_webex_bot_admin_env() -> None:
    root = _repo_root()
    for rel in (
        "charts/ai-platform-engineering/values.yaml",
        "charts/ai-platform-engineering/charts/caipe-ui/values.yaml",
        "charts/ai-platform-engineering/charts/caipe-ui/values-external-secrets.yaml",
    ):
        values = yaml.safe_load((root / rel).read_text())
        config = values.get("caipe-ui", values).get("config", values.get("config", {}))
        assert config["WEBEX_BOT_ADMIN_URL"].endswith("webex-bot:3002"), rel
        assert config["WEBEX_BOT_ADMIN_CLIENT_ID"] == "caipe-ui", rel
        assert config["WEBEX_BOT_ADMIN_AUDIENCE"] == "caipe-webex-bot-admin", rel


def test_caipe_ui_values_wire_credential_env_defaults() -> None:
    root = _repo_root()
    for rel in (
        "charts/ai-platform-engineering/values.yaml",
        "charts/ai-platform-engineering/charts/caipe-ui/values.yaml",
    ):
        values = yaml.safe_load((root / rel).read_text())
        config = values.get("caipe-ui", values).get("config", values.get("config", {}))
        assert config["CAIPE_CREDENTIALS_ENABLED"] == "false", rel
        assert config["CREDENTIAL_STORE_BACKEND"] == "mongodb-envelope", rel
        assert config["CREDENTIAL_KEY_PROVIDER"] == "local-cmk", rel
        assert "CREDENTIAL_KMS_CMK_ID" in config, rel
        assert config["CREDENTIAL_SERVICE_AUDIENCE"] == "caipe-credential-service", rel


def test_webex_bot_chart_uses_secret_refs_not_literal_tokens() -> None:
    root = _repo_root()
    values = yaml.safe_load(
        (root / "charts/ai-platform-engineering/charts/webex-bot/values.yaml").read_text()
    )
    assert values["existingSecret"] == "webex-bot-secrets"
    config = values["config"]
    for key in config:
        assert "token" not in key.lower() or key.endswith("_AUDIENCE"), key
        val = str(config[key]).lower()
        assert "xoxb" not in val
        assert "secret" not in val or key.endswith("AUDIENCE")


def test_webex_bot_deployment_enforces_non_root_security_context() -> None:
    root = _repo_root()
    deployment = (root / "charts/ai-platform-engineering/charts/webex-bot/templates/deployment.yaml").read_text()
    values = yaml.safe_load(
        (root / "charts/ai-platform-engineering/charts/webex-bot/values.yaml").read_text()
    )
    assert "securityContext" in deployment
    assert "secretKeyRef" in deployment
    assert values["podSecurityContext"]["runAsNonRoot"] is True
    assert values["securityContext"]["runAsUser"] == 1001
    assert values["securityContext"]["allowPrivilegeEscalation"] is False


def test_helm_openfga_model_includes_webex_space_type() -> None:
    root = _repo_root()
    model_path = root / "charts/ai-platform-engineering/charts/openfga/authorization-model.json"
    model = json.loads(model_path.read_text())
    types = {item["type"] for item in model["type_definitions"]}
    assert "webex_space" in types
    assert "webex_workspace" in types


def test_webex_bot_configmap_includes_in_cluster_service_urls() -> None:
    rendered = _helm_template_webex_bot()
    for key in (
        "KEYCLOAK_URL:",
        "OPENFGA_HTTP:",
        "WEBEX_ADMIN_JWT_ISSUER:",
        "WEBEX_ADMIN_JWKS_URL:",
    ):
        assert key in rendered
    assert "http://ai-platform-engineering-keycloak:8080" in rendered
    assert "http://ai-platform-engineering-openfga:8080" in rendered


def test_webex_bot_catalog_renders_default_marker() -> None:
    rendered = _helm_template_webex_bot(
        "--set-json",
        'webex-bot.bots=[{"id":"primary","name":"Primary bot","tokenEnv":"PRIMARY_TOKEN","default":true}]',
    )
    docs = [doc for doc in yaml.safe_load_all(rendered) if isinstance(doc, dict)]
    config = next(
        doc
        for doc in docs
        if doc.get("kind") == "ConfigMap"
        and doc.get("metadata", {}).get("name") == "caipe-webex-bot-config"
    )
    assert json.loads(config["data"]["WEBEX_INTEGRATION_BOTS_JSON"]) == [
        {
            "id": "primary",
            "name": "Primary bot",
            "tokenEnv": "PRIMARY_TOKEN",
            "default": True,
        }
    ]


def test_openfga_helm_model_is_the_single_json_artifact() -> None:
    root = _repo_root()
    helm_model = root / "charts/ai-platform-engineering/charts/openfga/authorization-model.json"
    assert helm_model.exists()
    assert not (root / "deploy/openfga/init/authorization-model.json").exists()


def test_keycloak_renders_webex_bot_client_secret_when_enabled() -> None:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering"
    result = subprocess.run(
        [
            "helm",
            "template",
            "caipe",
            str(chart),
            "--namespace",
            "caipe",
            "--set",
            "tags.keycloak=true",
            "--set",
            "keycloak.admin.secretRef=caipe-keycloak-admin",
        ],
        check=True,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )
    rendered = result.stdout
    assert "name: caipe-keycloak-webex-bot" in rendered
    assert "KC_WEBEX_BOT_CLIENT_SECRET" in rendered


def test_keycloak_chart_does_not_generate_random_admin_password() -> None:
    root = _repo_root()
    admin_secret = root / "charts/ai-platform-engineering/charts/keycloak/templates/secret.yaml"

    assert "randAlphaNum" not in admin_secret.read_text()


def test_init_idp_fails_when_idp_secret_env_is_missing() -> None:
    root = _repo_root()
    init_idp = root / "charts/ai-platform-engineering/charts/keycloak/scripts/init-idp.sh"
    script = init_idp.read_text()

    assert "IDP_CLIENT_SECRET is required" in script
    assert "skipping IdP broker setup" not in script


def test_keycloak_chart_requires_stable_admin_secret_source() -> None:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering" / "charts" / "keycloak"
    result = subprocess.run(
        ["helm", "template", "caipe", str(chart), "--namespace", "caipe"],
        check=False,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )

    assert result.returncode != 0
    assert "generated admin passwords are disabled" in result.stderr


def test_keycloak_chart_requires_idp_client_secret_source_when_idp_enabled() -> None:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering" / "charts" / "keycloak"
    result = subprocess.run(
        [
            "helm",
            "template",
            "caipe",
            str(chart),
            "--namespace",
            "caipe",
            "--set",
            "admin.secretRef=caipe-keycloak-admin",
            "--set",
            "idp.enabled=true",
            "--set",
            "idp.alias=okta",
            "--set",
            "idp.issuer=https://example.okta.com/oauth2/default",
            "--set",
            "idp.clientId=okta-client",
        ],
        check=False,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )

    assert result.returncode != 0
    assert "init-idp requires IDP_CLIENT_SECRET" in result.stderr


def test_keycloak_chart_wires_required_idp_secret_refs() -> None:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering" / "charts" / "keycloak"
    result = subprocess.run(
        [
            "helm",
            "template",
            "caipe",
            str(chart),
            "--namespace",
            "caipe",
            "--set",
            "admin.secretRef=caipe-keycloak-admin",
            "--set",
            "idp.enabled=true",
            "--set",
            "idp.alias=okta",
            "--set",
            "idp.issuer=https://example.okta.com/oauth2/default",
            "--set",
            "idp.clientId=okta-client",
            "--set",
            "idp.secretRef=caipe-keycloak-idp",
        ],
        check=True,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )

    rendered = result.stdout
    assert "name: caipe-keycloak-admin" in rendered
    assert "name: caipe-keycloak-idp" in rendered
    assert "key: IDP_CLIENT_SECRET" in rendered
    assert not re.search(r"secretKeyRef:\n\s+name: caipe-keycloak-(admin|idp)\n\s+key: [^\n]+\n\s+optional: true", rendered)


def test_keycloak_chart_omits_idp_pkce_env_by_default() -> None:
    rendered = _helm_template_keycloak_with_idp()

    for job_name in ("caipe-keycloak-init-idp", "caipe-keycloak-auth-reconcile"):
        env_names = _job_env_names(rendered, job_name)
        assert "IDP_PKCE_ENABLED" not in env_names
        assert "IDP_PKCE_METHOD" not in env_names


def test_keycloak_chart_wires_idp_pkce_env_when_enabled() -> None:
    rendered = _helm_template_keycloak_with_idp(
        "--set",
        "idp.pkce.enabled=true",
        "--set",
        "idp.pkce.method=S256",
    )

    for job_name in ("caipe-keycloak-init-idp", "caipe-keycloak-auth-reconcile"):
        env = _job_env(rendered, job_name)
        assert env["IDP_PKCE_ENABLED"] == "true"
        assert env["IDP_PKCE_METHOD"] == "S256"


def test_init_idp_conditionally_writes_pkce_broker_config() -> None:
    root = _repo_root()
    init_idp = root / "charts/ai-platform-engineering/charts/keycloak/scripts/init-idp.sh"
    script = init_idp.read_text()

    assert "IDP_PKCE_ENABLED" in script
    assert '"pkceEnabled": "true"' in script
    assert '"pkceMethod": "${IDP_PKCE_METHOD:-S256}"' in script


def test_webex_bot_service_account_disables_token_automount() -> None:
    rendered = _helm_template_webex_bot()
    assert "automountServiceAccountToken: false" in rendered


def test_webex_bot_deployment_emits_single_keycloak_client_secret_env() -> None:
    rendered = _helm_template_webex_bot(
        "--set",
        "webex-bot.keycloakBot.clientSecretFromSecret.name=caipe-keycloak-webex-bot",
    )
    assert rendered.count("name: KEYCLOAK_WEBEX_BOT_CLIENT_SECRET") == 1
    assert 'name: "caipe-keycloak-webex-bot"' in rendered
    assert 'key: "KC_WEBEX_BOT_CLIENT_SECRET"' in rendered


def test_parent_chart_renders_webex_bot_when_enabled() -> None:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering"
    result = subprocess.run(
        [
            "helm",
            "template",
            "caipe",
            str(chart),
            "--namespace",
            "caipe",
            "--set",
            "tags.webex-bot=true",
            "--set",
            "webex-bot.config.WEBEX_ADMIN_API_ENABLED=true",
        ],
        check=True,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )
    rendered = result.stdout
    assert "name: caipe-webex-bot" in rendered
    assert 'WEBEX_ADMIN_JWT_AUDIENCE: "caipe-webex-bot-admin"' in rendered
    assert "runAsUser: 1001" in rendered
    assert "secretRef" in rendered
    assert "webex-bot-secrets" in rendered


def test_keycloak_realm_config_declares_webex_bot_clients() -> None:
    root = _repo_root()
    realm = json.loads(
        (root / "charts/ai-platform-engineering/charts/keycloak/realm-config.json").read_text()
    )
    client_ids = {client["clientId"] for client in realm["clients"]}
    assert "caipe-webex-bot" in client_ids
    assert "caipe-webex-bot-admin" in client_ids
    ui = next(c for c in realm["clients"] if c["clientId"] == "caipe-ui")
    mapper_names = {m["name"] for m in ui.get("protocolMappers", [])}
    assert "webex-bot-admin-audience" in mapper_names


def test_keycloak_realm_config_uses_eight_hour_idle_sessions() -> None:
    root = _repo_root()
    for path in [
        root / "charts/ai-platform-engineering/charts/keycloak/realm-config.json",
        root / "deploy/keycloak/realm-config.example.json",
    ]:
        realm = json.loads(path.read_text())
        assert realm["accessTokenLifespan"] == 3600
        assert realm["ssoSessionIdleTimeout"] == 8 * 60 * 60
        assert realm["ssoSessionMaxLifespan"] == 24 * 60 * 60


def test_local_compose_keycloak_realm_import_mounts_existing_file() -> None:
    """Local Keycloak must not bind-mount a missing path as a directory."""
    root = _repo_root()
    compose_files = [
        root / "docker-compose.dev.yaml",
        root / "deploy/keycloak/docker-compose.yml",
    ]
    for compose_file in compose_files:
        compose = yaml.safe_load(compose_file.read_text())
        keycloak = compose["services"]["keycloak"]
        volumes = keycloak["volumes"]
        realm_mount = next(
            volume
            for volume in volumes
            if volume.endswith(":/opt/keycloak/data/import/realm-config.json:ro")
            or volume.endswith(":/opt/keycloak/data/import/realm-config.json")
        )
        source = realm_mount.split(":", 1)[0]
        source_path = (compose_file.parent / source).resolve()
        assert source_path.is_file(), f"{source} in {compose_file} must exist as a file"


def test_keycloak_readiness_requires_imported_realm_jwks() -> None:
    """Kubernetes should not mark Keycloak ready before the CAIPE realm exists."""
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering"
    result = subprocess.run(
        [
            "helm",
            "template",
            "caipe",
            str(chart),
            "--namespace",
            "caipe",
            "--set",
            "tags.keycloak=true",
            "--set",
            "keycloak.admin.secretRef=caipe-keycloak-admin",
        ],
        check=True,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )
    rendered = result.stdout
    assert "/realms/caipe/protocol/openid-connect/certs" in rendered
    assert "startupProbe:" in rendered
    assert "readinessProbe:" in rendered


def test_caipe_ui_external_secrets_example_uses_oidc_for_slack_admin() -> None:
    root = _repo_root()
    values = yaml.safe_load(
        (root / "charts/ai-platform-engineering/charts/caipe-ui/values-external-secrets.yaml").read_text()
    )
    secret_keys = {entry["secretKey"] for entry in values["externalSecrets"]["data"]}
    assert "OIDC_CLIENT_SECRET" in secret_keys
    assert "SLACK_BOT_ADMIN_CLIENT_SECRET" not in secret_keys
    assert "WEBEX_BOT_ADMIN_CLIENT_SECRET" in secret_keys
    webex_entry = next(
        entry
        for entry in values["externalSecrets"]["data"]
        if entry["secretKey"] == "WEBEX_BOT_ADMIN_CLIENT_SECRET"
    )
    assert webex_entry["remoteRef"]["property"] == "WEBEX_BOT_ADMIN_CLIENT_SECRET"


def _helm_template_webex_bot(*extra_args: str) -> str:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering"
    cmd = [
        "helm",
        "template",
        "caipe",
        str(chart),
        "--namespace",
        "caipe",
        "--set",
        "tags.webex-bot=true",
        *extra_args,
    ]
    result = subprocess.run(
        cmd,
        check=True,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )
    return result.stdout


def _helm_template_keycloak_with_idp(*extra_args: str) -> str:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering" / "charts" / "keycloak"
    cmd = [
        "helm",
        "template",
        "caipe",
        str(chart),
        "--namespace",
        "caipe",
        "--set",
        "admin.secretRef=caipe-keycloak-admin",
        "--set",
        "idp.enabled=true",
        "--set",
        "idp.alias=okta",
        "--set",
        "idp.issuer=https://example.okta.com/oauth2/default",
        "--set",
        "idp.clientId=okta-client",
        "--set",
        "idp.secretRef=caipe-keycloak-idp",
        *extra_args,
    ]
    result = subprocess.run(
        cmd,
        check=True,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )
    return result.stdout


def _job_env(rendered: str, job_name: str) -> dict[str, str]:
    docs = [doc for doc in yaml.safe_load_all(rendered) if isinstance(doc, dict)]
    job = next(
        doc
        for doc in docs
        if doc.get("kind") == "Job" and doc.get("metadata", {}).get("name") == job_name
    )
    containers = job["spec"]["template"]["spec"]["containers"]
    env = containers[0]["env"]
    return {entry["name"]: entry.get("value", "") for entry in env}


def _job_env_names(rendered: str, job_name: str) -> set[str]:
    return set(_job_env(rendered, job_name))


def test_webex_bot_renders_external_secret_when_enabled() -> None:
    rendered = _helm_template_webex_bot(
        "--set",
        "webex-bot.externalSecrets.enabled=true",
        "--set",
        "webex-bot.externalSecrets.data[0].secretKey=WEBEX_INTEGRATION_BOT_ACCESS_TOKEN",
        "--set",
        "webex-bot.externalSecrets.data[0].remoteRef.key=prod/webex-bot",
        "--set",
        "webex-bot.externalSecrets.data[0].remoteRef.property=bot_token",
    )
    assert "kind: ExternalSecret" in rendered
    assert "name: caipe-webex-bot-external-secret" in rendered
    assert "secretKey: WEBEX_INTEGRATION_BOT_ACCESS_TOKEN" in rendered
    assert "name: caipe-webex-bot-secret" in rendered
    assert "key: prod/webex-bot" in rendered


def test_webex_bot_renders_bot_configmap_when_bot_config_set() -> None:
    rendered = _helm_template_webex_bot(
        "--set",
        'webex-bot.botConfig.space-abc.agent_id=default-agent',
    )
    assert "name: caipe-webex-bot-bot-config" in rendered
    assert "bot-config.yaml:" in rendered
    assert "default-agent" in rendered
    assert "WEBEX_INTEGRATION_BOT_CONFIG" in rendered
    assert "/etc/caipe/bot-config.yaml" in rendered


def test_caipe_ui_renders_webex_admin_secret_via_external_secrets() -> None:
    if shutil.which("helm") is None:
        pytest.skip("helm is required for chart render assertions")

    chart = _repo_root() / "charts" / "ai-platform-engineering"
    result = subprocess.run(
        [
            "helm",
            "template",
            "caipe",
            str(chart),
            "--namespace",
            "caipe",
            "--set",
            "tags.caipe-ui=true",
            "--set",
            "caipe-ui.externalSecrets.enabled=true",
            "--set",
            "caipe-ui.externalSecrets.data[0].secretKey=WEBEX_BOT_ADMIN_CLIENT_SECRET",
            "--set",
            "caipe-ui.externalSecrets.data[0].remoteRef.key=dev/caipe-ui",
            "--set",
            "caipe-ui.externalSecrets.data[0].remoteRef.property=WEBEX_BOT_ADMIN_CLIENT_SECRET",
        ],
        check=True,
        cwd=_repo_root(),
        text=True,
        capture_output=True,
    )
    rendered = result.stdout
    assert "kind: ExternalSecret" in rendered
    assert "name: caipe-caipe-ui-external-secret" in rendered or "caipe-ui-external-secret" in rendered
    assert "secretKey: WEBEX_BOT_ADMIN_CLIENT_SECRET" in rendered
