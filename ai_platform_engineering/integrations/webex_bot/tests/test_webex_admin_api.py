from __future__ import annotations

import json
from http.client import HTTPConnection
from threading import Thread
from unittest.mock import MagicMock, patch

import pytest
from http.server import ThreadingHTTPServer

from ai_platform_engineering.integrations.slack_bot.utils.config_models import (
    AgentBinding,
    UsersConfig,
)
from ai_platform_engineering.integrations.webex_bot.utils.webex_admin_api import (
    MAX_ADMIN_REQUEST_BODY_BYTES,
    OpenFgaWriteError,
    WebexAdminAuthError,
    WebexAdminTokenValidator,
    WebexBotAdminService,
    _WebexAdminRequestHandler,
    load_webex_bot_config,
    webex_admin_jwt_audience,
)
from ai_platform_engineering.integrations.webex_bot.utils.webex_config_models import (
    SpaceConfig,
    WebexBotConfig,
)


class _RoutesCollection:
    def __init__(self) -> None:
        self.update_calls: list[tuple[dict[str, object], dict[str, object], bool]] = []
        self.update_many_calls: list[tuple[dict[str, object], dict[str, object]]] = []
        self.delete_calls: list[dict[str, object]] = []

    def update_one(
        self,
        filter_query: dict[str, object],
        update: dict[str, object],
        upsert: bool = False,
    ) -> None:
        self.update_calls.append((filter_query, update, upsert))

    def update_many(self, filter_query: dict[str, object], update: dict[str, object]) -> None:
        self.update_many_calls.append((filter_query, update))

    def delete_one(self, filter_query: dict[str, object]) -> None:
        self.delete_calls.append(filter_query)


class _Resolver:
    def __init__(self) -> None:
        self.invalidated: list[tuple[str | None, str | None, str | None]] = []

    def cache_status(self) -> dict[str, object]:
        return {
            "ttl_seconds": 60,
            "cache_size": 1,
            "cached_spaces": ["CAIPE-WEBEX/space-abc"],
            "last_errors": {},
        }

    def invalidate(self, bot_id: str, workspace_id: str, space_id: str) -> None:
        self.invalidated.append((bot_id, workspace_id, space_id))

    def invalidate_all(self) -> None:
        self.invalidated.append((None, None, None))


def _config() -> WebexBotConfig:
    return WebexBotConfig(
        spaces={
            "space-abc": SpaceConfig(
                name="Platform Space",
                agents=[
                    AgentBinding(
                        agent_id="incident-agent",
                        users=UsersConfig(enabled=True, listen="all"),
                    )
                ],
            )
        }
    )


def _catalog_bot(bot_id: str, token_env: str) -> dict[str, object]:
    return {
        "id": bot_id,
        "name": f"{bot_id.title()} bot",
        "tokenEnv": token_env,
        "spaces": {"accessMode": "allowlist"},
        "directMessages": {"accessMode": "allowlist"},
    }


@pytest.fixture(autouse=True)
def _configured_bot_catalog(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOTS_JSON",
        json.dumps([_catalog_bot("primary", "PRIMARY_TOKEN")]),
    )


def test_status_reports_route_cache_and_static_config() -> None:
    service = WebexBotAdminService(config=_config(), resolver=_Resolver())

    status = service.status()

    assert status["route_mode"] in {"config", "db_prefer", "db_only"}
    assert status["static_config"]["spaces"] == 1
    assert status["route_cache"]["cache_size"] == 1


def test_bot_catalog_exposes_policy_without_token_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PRIMARY_TOKEN", "secret-token")
    service = WebexBotAdminService(config=_config(), resolver=_Resolver())

    catalog = service.bot_catalog()

    assert catalog == {
        "auto_link": {"enabled": False, "configured": False},
        "bots": [
            {
                "id": "primary",
                "name": "Primary bot",
                "available": True,
                "spaces": {
                    "accessMode": "allowlist",
                    "defaultTeamSlug": None,
                    "defaultAgentId": None,
                },
                "directMessages": {
                    "accessMode": "allowlist",
                    "defaultAgentId": None,
                },
            }
        ]
    }
    assert "tokenEnv" not in catalog["bots"][0]


def test_status_reports_thread_context_runtime_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBEX_THREAD_CONTEXT_ENABLED", "false")
    monkeypatch.setenv("WEBEX_THREAD_CONTEXT_MAX_MESSAGES", "7")
    monkeypatch.setenv("WEBEX_THREAD_CONTEXT_MAX_CHARS", "2500")
    service = WebexBotAdminService(config=_config(), resolver=_Resolver())

    status = service.status()

    assert status["thread_context"] == {
        "enabled": False,
        "max_messages": 7,
        "max_chars": 2500,
    }


def test_reload_clears_all_or_one_space_cache() -> None:
    resolver = _Resolver()
    service = WebexBotAdminService(config=_config(), resolver=resolver)

    assert service.reload_routes() == {"reloaded": "all"}
    assert service.reload_routes(
        bot_id="primary", workspace_id="CAIPE-WEBEX", space_id="space-abc"
    ) == {
        "reloaded": "space",
        "bot_id": "primary",
        "workspace_id": "CAIPE-WEBEX",
        "space_id": "space-abc",
    }
    assert resolver.invalidated == [
        (None, None, None),
        ("primary", "CAIPE-WEBEX", "space-abc"),
    ]


def test_sync_from_config_dry_run_plans_without_writes() -> None:
    routes = _RoutesCollection()
    openfga_writes: list[dict[str, str]] = []
    service = WebexBotAdminService(
        config=_config(),
        resolver=_Resolver(),
        collection_factory=lambda _name: routes,
        openfga_writer=lambda tuple_key: openfga_writes.append(tuple_key),
    )

    summary = service.sync_from_config(
        bot_id="primary", workspace_id="CAIPE-WEBEX", dry_run=True
    )

    assert summary["dry_run"] is True
    assert summary["bot_id"] == "primary"
    assert summary["spaces_seen"] == 1
    assert summary["routes_planned"] == 1
    assert summary["routes_upserted"] == 0
    assert summary["openfga_tuples_written"] == 0
    assert routes.update_calls == []
    assert openfga_writes == []


def test_sync_from_config_upserts_routes_writes_openfga_and_invalidates_cache() -> None:
    routes = _RoutesCollection()
    resolver = _Resolver()
    openfga_writes: list[dict[str, str]] = []
    service = WebexBotAdminService(
        config=_config(),
        resolver=resolver,
        collection_factory=lambda _name: routes,
        openfga_writer=lambda tuple_key: openfga_writes.append(tuple_key),
    )

    summary = service.sync_from_config(
        bot_id="primary", workspace_id="CAIPE-WEBEX", dry_run=False
    )

    assert summary["dry_run"] is False
    assert summary["routes_upserted"] == 1
    assert summary["openfga_tuples_written"] == 3
    assert routes.update_calls[0][0] == {
        "bot_id": "primary",
        "workspace_id": "CAIPE-WEBEX",
        "space_id": "space-abc",
        "agent_id": "incident-agent",
    }
    assert openfga_writes == [
        {
            "user": "webex_bot:primary",
            "relation": "bot",
            "object": "webex_bot_installation:primary--CAIPE-WEBEX--space-abc",
        },
        {
            "user": "webex_space:CAIPE-WEBEX--space-abc",
            "relation": "space",
            "object": "webex_bot_installation:primary--CAIPE-WEBEX--space-abc",
        },
        {
            "user": "webex_bot_installation:primary--CAIPE-WEBEX--space-abc",
            "relation": "user",
            "object": "agent:incident-agent",
        },
    ]
    assert resolver.invalidated == [("primary", "CAIPE-WEBEX", "space-abc")]


def test_sync_from_config_replaces_existing_agent_metadata_without_touching_others() -> None:
    config = WebexBotConfig(
        spaces={
            "space-abc": SpaceConfig(
                name="Platform Space",
                agents=[
                    AgentBinding(
                        agent_id="incident-agent",
                        users=UsersConfig(enabled=True, listen="message"),
                    )
                ],
            )
        }
    )
    routes = _RoutesCollection()
    service = WebexBotAdminService(
        config=config,
        resolver=_Resolver(),
        collection_factory=lambda _name: routes,
        openfga_writer=lambda _tuple_key: None,
    )

    summary = service.sync_from_config(
        bot_id="primary", workspace_id="CAIPE-WEBEX", dry_run=False
    )

    assert summary["routes_upserted"] == 1
    assert len(routes.update_calls) == 1
    filter_query, update, upsert = routes.update_calls[0]
    assert upsert is True
    assert filter_query == {
        "bot_id": "primary",
        "workspace_id": "CAIPE-WEBEX",
        "space_id": "space-abc",
        "agent_id": "incident-agent",
    }
    assert update["$set"]["users"]["listen"] == "message"  # type: ignore[index]
    assert update["$unset"] == {"bots": "", "escalation": ""}
    assert routes.update_many_calls == []
    assert routes.delete_calls == []


def test_sync_from_config_canonicalizes_public_webex_room_ids() -> None:
    config = WebexBotConfig(
        spaces={
            "Y2lzY29zcGFyazovL3VzL1JPT00vNmY5MWIwNzAtNTMxYS0xMWYxLTkyNmQtNmZkM2MyMGRmZGM0": SpaceConfig(
                name="Grid Test",
                agents=[AgentBinding(agent_id="incident-agent", users=UsersConfig(enabled=True, listen="all"))],
            )
        }
    )
    routes = _RoutesCollection()
    resolver = _Resolver()
    openfga_writes: list[dict[str, str]] = []
    service = WebexBotAdminService(
        config=config,
        resolver=resolver,
        collection_factory=lambda _name: routes,
        openfga_writer=lambda tuple_key: openfga_writes.append(tuple_key),
    )

    service.sync_from_config(
        bot_id="primary", workspace_id="CAIPE-WEBEX", dry_run=False
    )

    assert routes.update_calls[0][0]["space_id"] == "6f91b070-531a-11f1-926d-6fd3c20dfdc4"
    assert openfga_writes[2]["user"] == (
        "webex_bot_installation:primary--CAIPE-WEBEX--6f91b070-531a-11f1-926d-6fd3c20dfdc4"
    )
    assert resolver.invalidated == [
        ("primary", "CAIPE-WEBEX", "6f91b070-531a-11f1-926d-6fd3c20dfdc4")
    ]


def test_sync_from_config_uses_explicit_requested_bot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOTS_JSON",
        json.dumps(
            [
                _catalog_bot("primary", "WEBEX_PRIMARY_TOKEN"),
                _catalog_bot("secondary", "WEBEX_SECONDARY_TOKEN"),
            ]
        ),
    )
    routes = _RoutesCollection()
    resolver = _Resolver()
    service = WebexBotAdminService(
        config=_config(),
        resolver=resolver,
        collection_factory=lambda _name: routes,
        openfga_writer=lambda _tuple_key: None,
    )

    summary = service.sync_from_config(
        bot_id="secondary", workspace_id="CAIPE-WEBEX", dry_run=False
    )

    assert summary["bot_id"] == "secondary"
    filter_query, update, upsert = routes.update_calls[0]
    assert filter_query["bot_id"] == "secondary"
    assert update["$set"]["bot_id"] == "secondary"  # type: ignore[index]
    assert upsert is True
    assert resolver.invalidated == [("secondary", "CAIPE-WEBEX", "space-abc")]


def test_sync_from_config_rejects_unknown_bot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOTS_JSON",
        json.dumps(
            [
                _catalog_bot("primary", "WEBEX_PRIMARY_TOKEN"),
                _catalog_bot("secondary", "WEBEX_SECONDARY_TOKEN"),
            ]
        ),
    )
    routes = _RoutesCollection()
    resolver = _Resolver()
    service = WebexBotAdminService(
        config=_config(),
        resolver=resolver,
        collection_factory=lambda _name: routes,
        openfga_writer=lambda _tuple_key: None,
    )

    with pytest.raises(ValueError, match="Unknown Webex bot"):
        service.sync_from_config(
            bot_id="missing", workspace_id="CAIPE-WEBEX", dry_run=False
        )

    assert routes.update_calls == []
    assert resolver.invalidated == []


def test_load_webex_bot_config_from_inline_yaml(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOT_CONFIG",
        """
space-abc:
  name: Platform Space
  agents:
    - agent_id: incident-agent
      users:
        enabled: true
        listen: all
""",
    )

    config = load_webex_bot_config()

    assert list(config.spaces) == ["space-abc"]
    assert config.spaces["space-abc"].agents[0].agent_id == "incident-agent"
    assert config.spaces["space-abc"].agents[0].users is not None
    assert config.spaces["space-abc"].agents[0].users.listen == "all"


def test_load_webex_bot_config_from_file_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    config_path = tmp_path / "webex-bot.yaml"
    config_path.write_text(
        """
spaces:
  space-from-file:
    name: File Space
    agents:
      - agent_id: file-agent
        users:
          enabled: true
          listen: mention
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("WEBEX_INTEGRATION_BOT_CONFIG", str(config_path))

    config = load_webex_bot_config()

    assert config.spaces["space-from-file"].name == "File Space"
    assert config.spaces["space-from-file"].agents[0].agent_id == "file-agent"


def test_load_webex_bot_config_supports_legacy_agent_id_mapping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOT_CONFIG",
        """
space-legacy:
  agent_id: legacy-agent
""",
    )

    config = load_webex_bot_config()

    route = config.spaces["space-legacy"].agents[0]
    assert config.spaces["space-legacy"].name == "space-legacy"
    assert route.agent_id == "legacy-agent"
    assert route.users is not None
    assert route.users.listen == "all"


def test_validator_default_audience_is_webex_admin() -> None:
    validator = WebexAdminTokenValidator(
        issuer="https://keycloak.example/realms/caipe",
        jwks_url="https://keycloak.example/jwks",
    )

    assert validator.audience == "caipe-webex-bot-admin"


def test_validator_rejects_disallowed_client() -> None:
    validator = WebexAdminTokenValidator(
        issuer="https://keycloak.example/realms/caipe",
        audience="caipe-webex-bot-admin",
        jwks_url="https://keycloak.example/jwks",
        allowed_client_ids=["caipe-ui"],
    )
    mock_key = MagicMock()
    mock_key.key = "secret"
    with (
        patch.object(validator._jwks_client, "get_signing_key_from_jwt", return_value=mock_key),
        patch(
            "ai_platform_engineering.integrations.webex_bot.utils.webex_admin_api.jwt.decode",
            return_value={"azp": "other-client", "scope": "admin"},
        ),
    ):
        with pytest.raises(WebexAdminAuthError, match="client is not allowed"):
            validator.validate("fake-token")


def test_validator_accepts_allowed_client_and_scope() -> None:
    validator = WebexAdminTokenValidator(
        issuer="https://keycloak.example/realms/caipe",
        audience="caipe-webex-bot-admin",
        jwks_url="https://keycloak.example/jwks",
        allowed_client_ids=["caipe-ui"],
    )
    mock_key = MagicMock()
    mock_key.key = "secret"
    with (
        patch.object(validator._jwks_client, "get_signing_key_from_jwt", return_value=mock_key),
        patch(
            "ai_platform_engineering.integrations.webex_bot.utils.webex_admin_api.jwt.decode",
            return_value={"azp": "caipe-ui", "sub": "service-account", "scope": "admin reload"},
        ),
    ):
        result = validator.validate("fake-token", required_scope="reload")

    assert result.client_id == "caipe-ui"
    assert result.subject == "service-account"
    assert "reload" in result.scopes


def test_webex_admin_jwt_audience_honors_api_audience_alias(monkeypatch) -> None:
    monkeypatch.delenv("WEBEX_ADMIN_JWT_AUDIENCE", raising=False)
    monkeypatch.setenv("WEBEX_ADMIN_API_AUDIENCE", "custom-webex-admin")

    assert webex_admin_jwt_audience() == "custom-webex-admin"


@pytest.fixture
def admin_http_server() -> tuple[ThreadingHTTPServer, int]:
    service = WebexBotAdminService(config=_config(), resolver=_Resolver())
    validator = MagicMock()

    class Handler(_WebexAdminRequestHandler):
        pass

    Handler.service = service
    Handler.validator = validator
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server, port, validator
    server.shutdown()


def _admin_request(
    port: int,
    method: str,
    path: str,
    *,
    token: str | None = None,
    body: dict[str, object] | None = None,
) -> tuple[int, dict[str, object]]:
    conn = HTTPConnection("127.0.0.1", port, timeout=5)
    headers: dict[str, str] = {}
    payload = b""
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    conn.request(method, path, body=payload, headers=headers)
    response = conn.getresponse()
    raw = response.read().decode("utf-8")
    conn.close()
    parsed = json.loads(raw) if raw else {}
    return response.status, parsed if isinstance(parsed, dict) else {}


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "/admin/webex/routes/status", None),
        ("POST", "/admin/webex/routes/reload", {}),
        ("POST", "/admin/webex/routes/sync-from-config", {"dry_run": True}),
    ],
)
def test_admin_http_missing_bearer_returns_401(
    admin_http_server: tuple[ThreadingHTTPServer, int, MagicMock],
    method: str,
    path: str,
    body: dict[str, object] | None,
) -> None:
    _server, port, _validator = admin_http_server

    status, payload = _admin_request(port, method, path, body=body)

    assert status == 401
    assert payload.get("error") == "missing_bearer"


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "/admin/webex/routes/status", None),
        ("POST", "/admin/webex/routes/reload", {}),
        ("POST", "/admin/webex/routes/sync-from-config", {"dry_run": True}),
    ],
)
def test_admin_http_invalid_token_returns_403(
    admin_http_server: tuple[ThreadingHTTPServer, int, MagicMock],
    method: str,
    path: str,
    body: dict[str, object] | None,
) -> None:
    _server, port, validator = admin_http_server
    validator.validate.side_effect = WebexAdminAuthError("Invalid Webex admin bearer token")

    status, payload = _admin_request(port, method, path, token="bad-token", body=body)

    assert status == 403
    assert "Invalid" in str(payload.get("error", ""))


def test_sync_from_config_stops_on_second_openfga_write_failure() -> None:
    config = WebexBotConfig(
        spaces={
            "space-a": SpaceConfig(
                name="A",
                agents=[AgentBinding(agent_id="agent-a", users=UsersConfig(enabled=True, listen="all"))],
            ),
            "space-b": SpaceConfig(
                name="B",
                agents=[AgentBinding(agent_id="agent-b", users=UsersConfig(enabled=True, listen="all"))],
            ),
        }
    )
    routes = _RoutesCollection()
    write_calls: list[dict[str, str]] = []

    def openfga_writer(tuple_key: dict[str, str]) -> None:
        write_calls.append(tuple_key)
        if len(write_calls) == 2:
            raise RuntimeError("openfga write failed on second tuple")

    service = WebexBotAdminService(
        config=config,
        resolver=_Resolver(),
        collection_factory=lambda _name: routes,
        openfga_writer=openfga_writer,
    )

    with pytest.raises(OpenFgaWriteError) as exc_info:
        service.sync_from_config(
            bot_id="primary", workspace_id="CAIPE-WEBEX", dry_run=False
        )

    summary = exc_info.value.summary
    assert summary["routes_upserted"] == 1
    assert summary["openfga_tuples_written"] == 1
    assert summary["openfga_write_failed"] is True
    assert summary["failed_route"]["agent_id"] == "agent-a"
    assert len(write_calls) == 2


def test_admin_http_request_body_too_large_returns_413(
    admin_http_server: tuple[ThreadingHTTPServer, int, MagicMock],
) -> None:
    _server, port, validator = admin_http_server
    validator.validate.return_value = MagicMock()

    conn = HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request(
        "POST",
        "/admin/webex/routes/reload",
        body=b"x" * (MAX_ADMIN_REQUEST_BODY_BYTES + 1),
        headers={
            "Authorization": "Bearer good-token",
            "Content-Type": "application/json",
            "Content-Length": str(MAX_ADMIN_REQUEST_BODY_BYTES + 1),
        },
    )
    response = conn.getresponse()
    payload = json.loads(response.read().decode("utf-8"))
    conn.close()

    assert response.status == 413
    assert payload.get("error") == "request_body_too_large"


def test_admin_http_missing_required_scope_returns_403(
    admin_http_server: tuple[ThreadingHTTPServer, int, MagicMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _server, port, validator = admin_http_server
    monkeypatch.setenv("WEBEX_ADMIN_STATUS_SCOPE", "webex-admin-status")
    validator.validate.side_effect = WebexAdminAuthError(
        "Webex admin bearer token is missing scope webex-admin-status"
    )

    status, payload = _admin_request(port, "GET", "/admin/webex/routes/status", token="scoped-token")

    assert status == 403
    assert "missing scope" in str(payload.get("error", ""))
