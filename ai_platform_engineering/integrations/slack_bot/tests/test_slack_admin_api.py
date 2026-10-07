from __future__ import annotations

import json
from typing import Any

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.config_models import (
    AgentBinding,
    BotsConfig,
    ChannelConfig,
    Config,
    EmojiEscalation,
    EscalationConfig,
    OverthinkConfig,
    UsersConfig,
    VictorOpsEscalation,
)
from ai_platform_engineering.integrations.slack_bot.utils.slack_admin_api import (
    SlackAdminTokenValidator,
    SlackBotAdminService,
)


class _RoutesCollection:
    def __init__(self) -> None:
        self.update_calls: list[tuple[dict[str, object], dict[str, object], bool]] = []

    def update_one(
        self,
        filter_query: dict[str, object],
        update: dict[str, object],
        upsert: bool = False,
    ) -> None:
        self.update_calls.append((filter_query, update, upsert))


class _Response:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return

    def json(self) -> dict[str, Any]:
        return self._payload


class _Resolver:
    def __init__(self) -> None:
        self.invalidated: list[tuple[str | None, str | None]] = []

    def cache_status(self) -> dict[str, object]:
        return {
            "ttl_seconds": 60,
            "cache_size": 1,
            "cached_channels": ["CAIPE/C123"],
            "last_errors": {},
        }

    def invalidate(self, workspace_id: str, channel_id: str) -> None:
        self.invalidated.append((workspace_id, channel_id))

    def invalidate_all(self) -> None:
        self.invalidated.append((None, None))


def _config() -> Config:
    return Config(
        channels={
            "C123": ChannelConfig(
                name="#incidents",
                agents=[
                    AgentBinding(
                        agent_id="incident-agent",
                        users=UsersConfig(enabled=True, listen="all"),
                    )
                ],
            ),
        }
    )


def _legacy_config() -> Config:
    base = _config()
    base.channels["C999"] = ChannelConfig(
        name="#legacy",
        agents=[
            AgentBinding(
                agent_id="legacy-agent",
                users=UsersConfig(enabled=True, listen="mention"),
            ),
            AgentBinding(
                agent_id="disabled-user-agent",
                users=UsersConfig(enabled=False, listen=None),
            ),
        ],
    )
    return base


def test_dev_auth_token_accepts_explicit_local_token(monkeypatch) -> None:
    monkeypatch.setenv("SLACK_ADMIN_DEV_AUTH_ENABLED", "true")
    monkeypatch.setenv("SLACK_ADMIN_DEV_TOKEN", "local-dev-token")
    validator = SlackAdminTokenValidator(issuer=None, audience=None, jwks_url=None)

    result = validator.validate("local-dev-token", required_scope="routes:read")

    assert result.client_id == "local-dev"
    assert result.subject == "anonymous-local-dev"
    assert result.scopes == ["routes:read"]
    assert result.claims == {"dev_auth": True}


def test_status_reports_route_cache_and_static_config() -> None:
    service = SlackBotAdminService(config=_config(), resolver=_Resolver())

    status = service.status()

    assert status["route_mode"] in {"config", "db_prefer", "db_only"}
    assert status["static_config"]["channels"] == 1
    assert status["route_cache"]["cache_size"] == 1


def test_channel_inspection_uses_provider_owned_workspace_name_and_audience(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SLACK_INTEGRATION_BOT_TOKEN", "test-token")
    calls: list[str] = []

    def request_get(url: str, **_kwargs: object) -> _Response:
        calls.append(url)
        if url.endswith("conversations.info"):
            return _Response(
                {
                    "ok": True,
                    "channel": {
                        "id": "C123",
                        "name": "example-channel",
                        "is_member": True,
                        "num_members": 17,
                    },
                }
            )
        return _Response({"ok": True, "team_id": "TEXAMPLE"})

    service = SlackBotAdminService(
        config=_config(),
        resolver=_Resolver(),
        request_get=request_get,  # type: ignore[arg-type]
    )

    inspected = service.inspect_channel(channel_id="C123")

    assert inspected == {
        "workspace_id": "TEXAMPLE",
        "channel_id": "C123",
        "channel_name": "example-channel",
        "member_count": 17,
    }
    assert calls == [
        "https://slack.com/api/conversations.info",
        "https://slack.com/api/auth.test",
    ]


def test_config_defaults_returns_loaded_channel_agents_without_yaml_body() -> None:
    service = SlackBotAdminService(config=_legacy_config(), resolver=_Resolver())

    defaults = service.config_defaults(workspace_id="CAIPE")

    assert defaults["workspace_id"] == "CAIPE"
    assert defaults["channels_seen"] == 2
    assert defaults["routes_seen"] == 3
    assert defaults["channels"]["C123"] == {
        "workspace_id": "CAIPE",
        "channel_id": "C123",
        "channel_name": "#incidents",
        "agents": [
            {
                "agent_id": "incident-agent",
                "priority": 100,
                "users": {"enabled": True, "listen": "all"},
            }
        ],
        "suggested_agent_id": "incident-agent",
    }
    assert defaults["channels"]["C999"]["suggested_agent_id"] == "legacy-agent"
    assert "yaml" not in json.dumps(defaults).lower()


def test_reload_clears_all_or_one_channel_cache() -> None:
    resolver = _Resolver()
    service = SlackBotAdminService(config=_config(), resolver=resolver)

    assert service.reload_routes() == {"reloaded": "all"}
    assert service.reload_routes(workspace_id="CAIPE", channel_id="C123") == {
        "reloaded": "channel",
        "workspace_id": "CAIPE",
        "channel_id": "C123",
    }
    assert resolver.invalidated == [(None, None), ("CAIPE", "C123")]


def test_sync_from_config_dry_run_plans_without_writes() -> None:
    routes = _RoutesCollection()
    openfga_writes: list[dict[str, str]] = []
    service = SlackBotAdminService(
        config=_config(),
        resolver=_Resolver(),
        collection_factory=lambda _name: routes,
        openfga_writer=lambda tuple_key: openfga_writes.append(tuple_key),
    )

    summary = service.sync_from_config(workspace_id="CAIPE", dry_run=True)

    assert summary["dry_run"] is True
    assert summary["channels_seen"] == 1
    assert summary["routes_planned"] == 1
    assert summary["routes_upserted"] == 0
    assert summary["openfga_tuples_written"] == 0
    assert routes.update_calls == []
    assert openfga_writes == []


def test_sync_from_config_dry_run_includes_full_channel_breakdown() -> None:
    config = Config(
        channels={
            "C500": ChannelConfig(
                name="#ops",
                agents=[
                    AgentBinding(
                        agent_id="ops-agent",
                        users=UsersConfig(
                            enabled=True,
                            listen="all",
                            user_list=["U1", "U2"],
                            overthink=OverthinkConfig(enabled=True, skip_markers=["DEFER"]),
                        ),
                        bots=BotsConfig(enabled=True, listen="message", bot_list=["AlertBot"]),
                        escalation=EscalationConfig(
                            victorops=VictorOpsEscalation(enabled=True, team="dao"),
                            emoji=EmojiEscalation(enabled=True, name="rotating_light"),
                            users=["U027"],
                            delete_admins=["U027"],
                        ),
                    )
                ],
            ),
        }
    )
    service = SlackBotAdminService(config=config, resolver=_Resolver())

    summary = service.sync_from_config(workspace_id="CAIPE", dry_run=True)

    assert len(summary["channels"]) == 1
    channel = summary["channels"][0]
    assert channel["channel_id"] == "C500"
    assert channel["channel_name"] == "#ops"
    agent = channel["agents"][0]
    assert agent["agent_id"] == "ops-agent"
    assert agent["priority"] == 100
    # Full per-side config is surfaced for the admin preview.
    assert agent["users"]["listen"] == "all"
    assert agent["users"]["user_list"] == ["U1", "U2"]
    assert agent["users"]["overthink"]["enabled"] is True
    assert agent["users"]["overthink"]["skip_markers"] == ["DEFER"]
    assert agent["bots"]["listen"] == "message"
    assert agent["bots"]["bot_list"] == ["AlertBot"]
    assert agent["escalation"]["victorops"] == {"enabled": True, "team": "dao"}
    assert agent["escalation"]["emoji"] == {"enabled": True, "name": "rotating_light"}
    assert agent["escalation"]["users"] == ["U027"]
    assert agent["escalation"]["delete_admins"] == ["U027"]


def test_sync_from_config_upserts_routes_writes_openfga_and_invalidates_cache() -> None:
    routes = _RoutesCollection()
    resolver = _Resolver()
    openfga_writes: list[dict[str, str]] = []
    service = SlackBotAdminService(
        config=_config(),
        resolver=resolver,
        collection_factory=lambda _name: routes,
        openfga_writer=lambda tuple_key: openfga_writes.append(tuple_key),
    )

    summary = service.sync_from_config(workspace_id="CAIPE", dry_run=False)

    assert summary["dry_run"] is False
    assert summary["routes_upserted"] == 1
    assert summary["openfga_tuples_written"] == 1
    assert routes.update_calls[0][0] == {
        "workspace_id": "CAIPE",
        "channel_id": "C123",
        "agent_id": "incident-agent",
    }
    assert routes.update_calls[0][1]["$set"] | {"checked": True} == {
        **routes.update_calls[0][1]["$set"],
        "workspace_id": "CAIPE",
        "channel_id": "C123",
        "agent_id": "incident-agent",
        "enabled": True,
        "priority": 100,
        "source_type": "config_sync",
        "status": "active",
        "checked": True,
    }
    assert openfga_writes == [
        {
            "user": "slack_channel:CAIPE--C123",
            "relation": "user",
            "object": "agent:incident-agent",
        }
    ]
    assert resolver.invalidated == [("CAIPE", "C123")]
    # The static YAML config predates execution_identity, so an import must
    # persist the default "User" identity rather than leaving it unset.
    assert routes.update_calls[0][1]["$set"]["execution_identity"] == {"mode": "obo_user"}


def test_sync_from_config_defaults_execution_identity_to_user() -> None:
    """Legacy configs (no execution_identity) import as obo_user, in both the
    dry-run preview and the persisted route doc."""
    routes = _RoutesCollection()
    config = Config(
        channels={
            "C700": ChannelConfig(
                name="#legacy",
                agents=[AgentBinding(agent_id="legacy-agent")],
            ),
        }
    )
    service = SlackBotAdminService(
        config=config,
        resolver=_Resolver(),
        collection_factory=lambda _name: routes,
        openfga_writer=lambda _t: None,
    )

    # Preview surfaces the default.
    preview = service.sync_from_config(workspace_id="CAIPE", dry_run=True)
    assert preview["channels"][0]["agents"][0]["execution_identity"] == {"mode": "obo_user"}

    # Persisted doc carries it explicitly.
    service.sync_from_config(workspace_id="CAIPE", dry_run=False)
    assert routes.update_calls[0][1]["$set"]["execution_identity"] == {"mode": "obo_user"}
