"""Tests for MCP credential reference resolution."""

import pytest

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.models import MCPCredentialSource, MCPServerConfig, TransportType
from dynamic_agents.services import mcp_client
from dynamic_agents.services.mcp_client import (
    CALLER_PROVIDER_NOT_CONNECTED,
    McpCredentialUnavailableError,
    build_mcp_connection_config,
    mcp_credential_connect_warning,
    resolve_mcp_connections_credential_refs,
    resolve_mcp_credential_refs,
)


class FakeCredentialClient:
    async def retrieve_secret(self, secret_ref: str, *, intended_use: str) -> str:
        assert secret_ref == "secret-1"
        assert intended_use == "mcp_server"
        return "github-token-value"

    async def exchange_provider_connection_by_provider(
        self, provider: str, *, intended_use: str, mcp_server_id: str | None = None
    ) -> dict:
        assert provider == "atlassian"
        assert intended_use == "mcp_server"
        return {"access_token": "atlassian-oauth-token", "provider_connection_id": "conn-for-user"}


@pytest.mark.asyncio
async def test_resolves_secret_ref_to_stdio_env_when_impersonation_enabled(monkeypatch):
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")
    server = MCPServerConfig(
        _id="github",
        name="GitHub",
        transport=TransportType.STDIO,
        command="github-mcp",
        credential_sources=[
            MCPCredentialSource(kind="secret_ref", target="env", name="GITHUB_TOKEN", secret_ref="secret-1")
        ],
    )
    config = build_mcp_connection_config(server)

    resolved = await resolve_mcp_credential_refs(
        server,
        config,
        credential_client=FakeCredentialClient(),
    )

    assert resolved["env"]["GITHUB_TOKEN"] == "github-token-value"


@pytest.mark.asyncio
async def test_resolves_secret_ref_to_http_header_when_impersonation_enabled(monkeypatch):
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")
    server = MCPServerConfig(
        _id="jira",
        name="Jira",
        transport=TransportType.HTTP,
        endpoint="http://jira-mcp:8080/mcp",
        credential_sources=[
            MCPCredentialSource(kind="secret_ref", target="header", name="Authorization", secret_ref="secret-1")
        ],
    )
    config = build_mcp_connection_config(server)

    resolved = await resolve_mcp_credential_refs(
        server,
        config,
        credential_client=FakeCredentialClient(),
    )

    assert resolved["headers"]["Authorization"] == "Bearer github-token-value"


@pytest.mark.asyncio
async def test_resolves_provider_connection_by_provider_to_dedicated_header_when_impersonation_enabled(monkeypatch):
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")
    server = MCPServerConfig(
        _id="jira",
        name="Jira",
        transport=TransportType.HTTP,
        endpoint="http://jira-mcp:8080/mcp",
        credential_sources=[
            MCPCredentialSource(
                kind="provider_connection",
                target="header",
                name="X-CAIPE-Provider-Token",
                provider="atlassian",
            )
        ],
    )
    config = build_mcp_connection_config(server, auth_bearer="keycloak-user-jwt")

    resolved = await resolve_mcp_credential_refs(
        server,
        config,
        credential_client=FakeCredentialClient(),
    )

    assert resolved["headers"]["Authorization"] == "Bearer keycloak-user-jwt"
    assert resolved["headers"]["X-CAIPE-Provider-Token"] == "atlassian-oauth-token"


class NoConnectionCredentialClient:
    """Simulates a caller with no provider connection (exchange raises 404)."""

    async def exchange_provider_connection_by_provider(
        self, provider: str, *, intended_use: str, mcp_server_id: str | None = None
    ) -> dict:
        raise RuntimeError("CREDENTIAL_NOT_FOUND")


class ConnectedCredentialClient:
    async def exchange_provider_connection_by_provider(
        self, provider: str, *, intended_use: str, mcp_server_id: str | None = None
    ) -> dict:
        return {"access_token": "user-github-oauth-token"}


@pytest.mark.asyncio
async def test_provider_connection_falls_back_to_env_when_not_connected(monkeypatch):
    """No personal connection -> use the static service-account token from fallback_env."""
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")
    monkeypatch.setenv("GITHUB_PERSONAL_ACCESS_TOKEN", "org-pat-value")
    server = MCPServerConfig(
        _id="github",
        name="GitHub",
        transport=TransportType.HTTP,
        endpoint="http://agentgateway:4000/mcp",
        credential_sources=[
            MCPCredentialSource(
                kind="provider_connection",
                target="header",
                name="X-CAIPE-Provider-Token",
                provider="github",
                fallback_env="GITHUB_PERSONAL_ACCESS_TOKEN",
            )
        ],
    )
    config = build_mcp_connection_config(server)

    resolved = await resolve_mcp_credential_refs(
        server,
        config,
        credential_client=NoConnectionCredentialClient(),
    )

    assert resolved["headers"]["X-CAIPE-Provider-Token"] == "org-pat-value"


@pytest.mark.asyncio
async def test_per_user_token_wins_over_fallback_env(monkeypatch):
    """A connected caller's personal token must take precedence over the static fallback."""
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")
    monkeypatch.setenv("GITHUB_PERSONAL_ACCESS_TOKEN", "org-pat-value")
    server = MCPServerConfig(
        _id="github",
        name="GitHub",
        transport=TransportType.HTTP,
        endpoint="http://agentgateway:4000/mcp",
        credential_sources=[
            MCPCredentialSource(
                kind="provider_connection",
                target="header",
                name="X-CAIPE-Provider-Token",
                provider="github",
                fallback_env="GITHUB_PERSONAL_ACCESS_TOKEN",
            )
        ],
    )
    config = build_mcp_connection_config(server)

    resolved = await resolve_mcp_credential_refs(
        server,
        config,
        credential_client=ConnectedCredentialClient(),
    )

    assert resolved["headers"]["X-CAIPE-Provider-Token"] == "user-github-oauth-token"


@pytest.mark.asyncio
async def test_no_credential_and_no_fallback_raises_for_caller_scope(monkeypatch):
    """No connection and no fallback_env -> fail closed for caller-scoped provider."""
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    server = MCPServerConfig(
        _id="github",
        name="GitHub",
        transport=TransportType.HTTP,
        endpoint="http://agentgateway:4000/mcp",
        credential_sources=[
            MCPCredentialSource(
                kind="provider_connection",
                target="header",
                name="X-CAIPE-Provider-Token",
                provider="github",
            )
        ],
    )
    config = build_mcp_connection_config(server)

    with pytest.raises(McpCredentialUnavailableError) as exc_info:
        await resolve_mcp_credential_refs(
            server,
            config,
            credential_client=NoConnectionCredentialClient(),
        )

    assert exc_info.value.reason == CALLER_PROVIDER_NOT_CONNECTED
    assert exc_info.value.provider == "github"
    assert "GitHub" in mcp_credential_connect_warning(exc_info.value)


def _kb_server() -> MCPServerConfig:
    return MCPServerConfig(
        _id="knowledge-base",
        name="Knowledge Base",
        transport=TransportType.HTTP,
        endpoint="http://agentgateway:4000/mcp/knowledge-base",
        credential_sources=[
            MCPCredentialSource(
                kind="caller_token",
                target="header",
                name="X-CAIPE-Provider-Token",
                fallback_client_credentials=True,
            )
        ],
    )


@pytest.mark.asyncio
async def test_caller_token_forwards_user_jwt(monkeypatch):
    """A user-driven request forwards the caller's Keycloak JWT for per-user RBAC."""
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")

    async def _should_not_mint():
        raise AssertionError("client-credentials must not be minted when a user JWT exists")

    monkeypatch.setattr(mcp_client, "mint_service_client_credentials_token", _should_not_mint)

    server = _kb_server()
    config = build_mcp_connection_config(server)
    token_ref = current_user_token.set("user-keycloak-jwt")
    try:
        resolved = await resolve_mcp_credential_refs(
            server, config, credential_client=FakeCredentialClient()
        )
    finally:
        current_user_token.reset(token_ref)

    assert resolved["headers"]["X-CAIPE-Provider-Token"] == "user-keycloak-jwt"


@pytest.mark.asyncio
async def test_caller_token_falls_back_to_client_credentials(monkeypatch):
    """No user context (background reconcile) -> mint a caipe-platform service token."""
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")

    async def _mint():
        return "service-client-credentials-token"

    monkeypatch.setattr(mcp_client, "mint_service_client_credentials_token", _mint)

    server = _kb_server()
    config = build_mcp_connection_config(server)
    # Ensure no caller token is set.
    current_user_token.set(None)
    resolved = await resolve_mcp_credential_refs(
        server, config, credential_client=FakeCredentialClient()
    )

    assert resolved["headers"]["Authorization"] == "Bearer service-client-credentials-token"
    assert resolved["headers"]["X-CAIPE-Provider-Token"] == "service-client-credentials-token"


@pytest.mark.asyncio
async def test_caller_token_no_jwt_no_mint_skips_injection(monkeypatch):
    """No user JWT and mint unavailable -> no header injected, no exception."""
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")

    async def _mint_none():
        return None

    monkeypatch.setattr(mcp_client, "mint_service_client_credentials_token", _mint_none)

    server = _kb_server()
    config = build_mcp_connection_config(server)
    current_user_token.set(None)
    resolved = await resolve_mcp_credential_refs(
        server, config, credential_client=FakeCredentialClient()
    )

    assert "X-CAIPE-Provider-Token" not in resolved.get("headers", {})


@pytest.mark.asyncio
async def test_batch_resolves_caller_token_fallback_without_credential_api_client(monkeypatch):
    """Local no-SSO has no user bearer, but can still mint the platform token."""
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")

    async def _mint():
        return "service-client-credentials-token"

    monkeypatch.setattr(mcp_client, "mint_service_client_credentials_token", _mint)
    server = _kb_server()
    connections = {"knowledge-base": build_mcp_connection_config(server)}

    result = await resolve_mcp_connections_credential_refs(
        [server],
        connections,
        credential_client=None,
    )

    assert result.connections["knowledge-base"]["headers"]["Authorization"] == (
        "Bearer service-client-credentials-token"
    )


@pytest.mark.asyncio
async def test_credential_refs_are_noop_when_impersonation_disabled(monkeypatch):
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "false")
    server = MCPServerConfig(
        _id="github",
        name="GitHub",
        transport=TransportType.STDIO,
        command="github-mcp",
        credential_sources=[
            MCPCredentialSource(kind="secret_ref", target="env", name="GITHUB_TOKEN", secret_ref="secret-1")
        ],
    )
    config = build_mcp_connection_config(server)

    resolved = await resolve_mcp_credential_refs(
        server,
        config,
        credential_client=FakeCredentialClient(),
    )

    assert "env" not in resolved


class LegacyConnectionIdCredentialClient:
    """Simulates exchange for a legacy doc that has provider_connection_id but no provider.

    The BFF /api/credentials/exchange endpoint resolves the *caller's own*
    connection for that id's provider, so no shared token leaks across callers.
    """

    async def exchange_provider_connection(
        self,
        provider_connection_id: str,
        *,
        intended_use: str,
        mcp_server_id: str | None = None,
    ) -> dict:
        assert provider_connection_id == "conn-admin"
        assert intended_use == "mcp_server"
        assert mcp_server_id == "mcp-custom"
        return {"access_token": "caller-atlassian-token"}


class EmptyLegacyConnectionIdCredentialClient:
    """Simulates an empty exchange (caller has no connection for the legacy id's provider)."""

    async def exchange_provider_connection(
        self,
        provider_connection_id: str,
        *,
        intended_use: str,
        mcp_server_id: str | None = None,
    ) -> dict:
        return {}


@pytest.mark.asyncio
async def test_legacy_id_only_source_resolves_token_via_by_id_exchange(monkeypatch):
    """A legacy doc with connection_scope='pinned' + provider_connection_id still resolves.

    Under the new caller-only model the exchange endpoint returns the *caller's*
    connection for that id's provider — no shared admin token.  The
    connection_scope field is ignored; origin is recorded as 'per_user_oauth'.
    """
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")
    server = MCPServerConfig(
        _id="mcp-custom",
        name="Custom Jira",
        transport=TransportType.HTTP,
        endpoint="http://agentgateway:4000/mcp/mcp-custom",
        credential_sources=[
            MCPCredentialSource(
                kind="provider_connection",
                target="header",
                name="X-CAIPE-Provider-Token",
                connection_scope="pinned",  # legacy field; ignored by resolution code
                provider_connection_id="conn-admin",
            )
        ],
    )
    config = build_mcp_connection_config(server)

    resolved = await resolve_mcp_credential_refs(
        server,
        config,
        credential_client=LegacyConnectionIdCredentialClient(),
    )

    assert resolved["headers"]["X-CAIPE-Provider-Token"] == "caller-atlassian-token"


@pytest.mark.asyncio
async def test_legacy_id_only_source_no_credential_does_not_raise(monkeypatch):
    """Empty exchange for a legacy id-only source (no provider, no fallback_env) is silent.

    Under the new model an id-only source has no provider field, so the
    CALLER_PROVIDER_NOT_CONNECTED raise condition is not triggered.
    The server is simply skipped (no credential injected).
    """
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")
    server = MCPServerConfig(
        _id="mcp-custom",
        name="Custom Jira",
        transport=TransportType.HTTP,
        endpoint="http://agentgateway:4000/mcp/mcp-custom",
        credential_sources=[
            MCPCredentialSource(
                kind="provider_connection",
                target="header",
                name="X-CAIPE-Provider-Token",
                connection_scope="pinned",  # legacy field; ignored
                provider_connection_id="conn-admin",
            )
        ],
    )
    config = build_mcp_connection_config(server)

    # Should NOT raise — empty exchange + no provider + no fallback_env = silent skip.
    resolved = await resolve_mcp_credential_refs(
        server,
        config,
        credential_client=EmptyLegacyConnectionIdCredentialClient(),
    )

    assert "X-CAIPE-Provider-Token" not in resolved.get("headers", {})


@pytest.mark.asyncio
async def test_caller_provider_with_empty_exchange_and_no_fallback_raises(monkeypatch):
    """A source with provider set + no fallback_env + empty exchange raises CALLER_PROVIDER_NOT_CONNECTED."""
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")
    monkeypatch.delenv("ATLASSIAN_TOKEN", raising=False)
    server = MCPServerConfig(
        _id="mcp-custom",
        name="Custom Jira",
        transport=TransportType.HTTP,
        endpoint="http://agentgateway:4000/mcp/mcp-custom",
        credential_sources=[
            MCPCredentialSource(
                kind="provider_connection",
                target="header",
                name="X-CAIPE-Provider-Token",
                provider="atlassian",
            )
        ],
    )
    config = build_mcp_connection_config(server)

    with pytest.raises(McpCredentialUnavailableError) as exc_info:
        await resolve_mcp_credential_refs(
            server,
            config,
            credential_client=EmptyLegacyConnectionIdCredentialClient(),
        )

    assert exc_info.value.reason == CALLER_PROVIDER_NOT_CONNECTED


@pytest.mark.asyncio
async def test_resolve_mcp_connections_omits_caller_scope_failures(monkeypatch):
    """Batch resolution drops servers with caller credential failures."""
    monkeypatch.setenv("USE_IMPERSONATION_TOKENS", "true")
    jira_server = MCPServerConfig(
        _id="jira",
        name="Jira",
        transport=TransportType.HTTP,
        endpoint="http://agentgateway:4000/mcp/jira",
        credential_sources=[
            MCPCredentialSource(
                kind="provider_connection",
                target="header",
                name="X-CAIPE-Provider-Token",
                provider="atlassian",
            )
        ],
    )
    github_server = MCPServerConfig(
        _id="github",
        name="GitHub",
        transport=TransportType.HTTP,
        endpoint="http://agentgateway:4000/mcp/github",
        credential_sources=[
            MCPCredentialSource(
                kind="provider_connection",
                target="header",
                name="X-CAIPE-Provider-Token",
                provider="github",
                fallback_env="GITHUB_PERSONAL_ACCESS_TOKEN",
            )
        ],
    )
    monkeypatch.setenv("GITHUB_PERSONAL_ACCESS_TOKEN", "org-pat-value")
    connections = {
        "jira": build_mcp_connection_config(jira_server),
        "github": build_mcp_connection_config(github_server),
    }

    result = await resolve_mcp_connections_credential_refs(
        [jira_server, github_server],
        connections,
        credential_client=NoConnectionCredentialClient(),
    )

    assert "jira" not in result.connections
    assert "github" in result.connections
    assert result.failures["jira"].reason == CALLER_PROVIDER_NOT_CONNECTED
    assert "Atlassian" in mcp_credential_connect_warning(result.failures["jira"])
