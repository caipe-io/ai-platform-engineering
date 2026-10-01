import base64
import hashlib
import hmac
import importlib.util
import json
import time
from pathlib import Path

import pytest


def _load_bridge_module():
    module_path = Path(__file__).resolve().parents[1] / "main.py"
    spec = importlib.util.spec_from_file_location("openfga_bridge_main", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _unsigned_token(sub: str) -> str:
    def encode(part: dict[str, str]) -> str:
        raw = json.dumps(part, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    return f"{encode({'alg': 'none', 'typ': 'JWT'})}.{encode({'sub': sub})}."


def test_uses_verified_bearer_subject(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _load_bridge_module()
    monkeypatch.setattr(
        bridge,
        "_decode_verified_bearer_subject",
        lambda auth_header: "verified-sub" if auth_header == "Bearer valid-token" else None,
        raising=False,
    )
    request = bridge.build_check_request(
        headers={"authorization": "Bearer valid-token"},
        path="/mcp",
        method="GET",
    )

    assert bridge.subject_from_check_request(request) == "verified-sub"


def test_does_not_trust_unsigned_bearer_token() -> None:
    bridge = _load_bridge_module()
    token = _unsigned_token("user-sub-123")
    request = bridge.build_check_request(
        headers={"authorization": f"Bearer {token}"},
        path="/mcp",
        method="GET",
    )

    assert bridge.subject_from_check_request(request) is None


def test_does_not_trust_gateway_forwarded_subject_header() -> None:
    bridge = _load_bridge_module()
    request = bridge.build_check_request(
        headers={"x-authenticated-sub": "gateway-sub"},
        path="/mcp",
        method="GET",
    )

    assert bridge.subject_from_check_request(request) is None


def test_uses_agentgateway_jwt_subject_metadata_when_authorization_header_is_absent() -> None:
    bridge = _load_bridge_module()
    request = bridge.build_check_request(
        headers={"accept": "application/json"},
        path="/mcp",
        method="GET",
        metadata_subject="metadata-sub",
    )

    assert bridge.subject_from_check_request(request) == "metadata-sub"


def test_decode_verified_bearer_uses_jwks_and_claim_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _load_bridge_module()

    class _SigningKey:
        key = "public-key"

    class _FakeJwksClient:
        def __init__(self, url: str) -> None:
            assert url == "https://idp.example.com/jwks"

        def get_signing_key_from_jwt(self, token: str) -> _SigningKey:
            assert token == "valid-token"
            return _SigningKey()

    def _fake_decode(token, key, **kwargs):
        assert token == "valid-token"
        assert key == "public-key"
        assert kwargs["algorithms"] == ["RS256"]
        assert kwargs["issuer"] == "https://idp.example.com/realms/caipe"
        assert kwargs["audience"] == ["agentgateway", "caipe-platform"]
        return {"sub": "verified-sub"}

    monkeypatch.setattr(bridge, "JWT_JWKS_URL", "https://idp.example.com/jwks")
    monkeypatch.setattr(bridge, "JWT_ISSUER", "https://idp.example.com/realms/caipe")
    monkeypatch.setattr(bridge, "JWT_AUDIENCES", ("agentgateway", "caipe-platform"))
    monkeypatch.setattr(bridge, "JWT_ALGORITHMS", ("RS256",))
    monkeypatch.setattr(bridge, "_JWKS_CLIENT", None)
    monkeypatch.setattr(bridge.jwt, "PyJWKClient", _FakeJwksClient, raising=False)
    monkeypatch.setattr(bridge.jwt, "decode", _fake_decode)

    assert bridge._decode_verified_bearer_subject("Bearer valid-token") == "verified-sub"


def test_metadata_only_request_reaches_openfga(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _load_bridge_module()
    called = False

    def _fake_check_openfga(user: str, relation: str, obj: str):
        nonlocal called
        called = True
        assert user == "user:metadata-sub"
        assert relation == "can_call"
        assert obj == "mcp_gateway:list"
        return True

    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **_event: None, raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    request = bridge.build_check_request(
        headers={"accept": "application/json"},
        path="/mcp",
        method="GET",
        metadata_subject="metadata-sub",
    )

    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    assert called is True


def test_builds_allow_and_deny_check_responses() -> None:
    bridge = _load_bridge_module()

    allowed = bridge.build_check_response(allowed=True)
    denied = bridge.build_check_response(allowed=False)

    assert allowed.status.code == 0
    assert allowed.HasField("ok_response")
    assert denied.status.code != 0
    assert "OpenFGA" in denied.status.message


def test_check_audits_openfga_allow(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _load_bridge_module()
    events: list[dict] = []

    monkeypatch.setattr(
        bridge,
        "_decode_verified_bearer_subject",
        lambda auth_header: "user-sub-123" if auth_header == "Bearer valid-token" else None,
        raising=False,
    )
    monkeypatch.setattr(bridge, "_check_openfga", lambda *_args: True)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())

    request = bridge.build_check_request(headers={"authorization": "Bearer valid-token"}, path="/mcp")
    request.attributes.request.http.id = "request-allow"
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    assert events == [
        {
            "subject": "user-sub-123",
            "subject_ref": "user:user-sub-123",
            "outcome": "allow",
            "reason_code": "OK",
            "correlation_id": "request-allow",
            "action": "mcp#can_call",
            "component": "agent_gateway",
            "resource_ref": "user:user-sub-123 can_call mcp_gateway:list",
            "pdp": "openfga",
            "source": "openfga_authz_bridge",
            "duration_ms": pytest.approx(events[0]["duration_ms"]),
        }
    ]


def test_check_audits_openfga_deny(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _load_bridge_module()
    events: list[dict] = []

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_check_openfga", lambda *_args: False)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())

    request = bridge.build_check_request(headers={"authorization": "Bearer valid-token"}, path="/mcp")
    request.attributes.request.http.id = "request-deny"
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.PERMISSION_DENIED
    assert events[0]["outcome"] == "deny"
    assert events[0]["reason_code"] == "DENY_NO_CAPABILITY"
    assert events[0]["correlation_id"] == "request-deny"
    assert events[0]["resource_ref"] == "user:user-sub-123 can_call mcp_gateway:list"
    assert events[0]["subject_ref"] == "user:user-sub-123"


def test_check_audits_unauthenticated_request(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _load_bridge_module()
    events: list[dict] = []

    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)

    request = bridge.build_check_request(headers={"accept": "application/json"}, path="/mcp")
    request.attributes.request.http.id = "request-missing-subject"
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.UNAUTHENTICATED
    assert events[0]["subject"] == "anonymous"
    assert events[0]["outcome"] == "deny"
    assert events[0]["reason_code"] == "DENY_NO_TOKEN"
    assert events[0]["correlation_id"] == "request-missing-subject"
    # No verifiable subject → no resolvable identity to attach.
    assert events[0]["subject_ref"] is None


def test_check_audits_openfga_error(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _load_bridge_module()
    events: list[dict] = []

    def _raise_openfga_error(*_args):
        raise RuntimeError("openfga unavailable")

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_check_openfga", _raise_openfga_error)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())

    request = bridge.build_check_request(headers={"authorization": "Bearer valid-token"}, path="/mcp")
    request.attributes.request.http.id = "request-error"
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.UNAVAILABLE
    assert events[0]["outcome"] == "deny"
    assert events[0]["reason_code"] == "DENY_PDP_UNAVAILABLE"
    assert events[0]["correlation_id"] == "request-error"


def test_restricted_mcp_server_denies_caller_without_invoke_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _load_bridge_module()
    checks: list[tuple[str, str, str]] = []
    events: list[dict] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        checks.append((user, relation, obj))
        return (user, relation, obj) == (
            "user:user-sub-123",
            "can_call",
            "mcp_gateway:list",
        )

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "RESTRICTED_MCP_SERVERS", frozenset({"scheduler"}))

    request = bridge.build_check_request(
        headers={"authorization": "Bearer valid-token"},
        path="/mcp/scheduler",
        method="POST",
        body='{"jsonrpc":"2.0","method":"initialize"}',
    )
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.PERMISSION_DENIED
    assert response.status.message == "caller lacks MCP server invoke grant"
    assert checks == [
        ("user:user-sub-123", "can_call", "mcp_gateway:list"),
        ("user:user-sub-123", "can_invoke", "mcp_server:scheduler"),
    ]
    assert events[-1]["reason_code"] == "DENY_MCP_SERVER_INVOKE"
    assert events[-1]["resource_ref"] == (
        "user:user-sub-123 can_invoke mcp_server:scheduler"
    )


def test_restricted_mcp_server_allows_caller_with_invoke_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _load_bridge_module()
    checks: list[tuple[str, str, str]] = []
    events: list[dict] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        checks.append((user, relation, obj))
        return (user, relation, obj) in {
            ("user:admin-sub", "can_call", "mcp_gateway:list"),
            ("user:admin-sub", "can_invoke", "mcp_server:scheduler"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "admin-sub")
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "RESTRICTED_MCP_SERVERS", frozenset({"scheduler"}))

    request = bridge.build_check_request(
        headers={"authorization": "Bearer valid-token"},
        path="/mcp/scheduler",
        method="POST",
        body='{"jsonrpc":"2.0","method":"initialize"}',
    )
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    assert checks == [
        ("user:admin-sub", "can_call", "mcp_gateway:list"),
        ("user:admin-sub", "can_invoke", "mcp_server:scheduler"),
    ]
    assert any(event["reason_code"] == "OK_MCP_SERVER_INVOKE" for event in events)


def test_unrestricted_mcp_server_does_not_require_invoke_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _load_bridge_module()
    checks: list[tuple[str, str, str]] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        checks.append((user, relation, obj))
        return (user, relation, obj) == (
            "user:user-sub-123",
            "can_call",
            "mcp_gateway:list",
        )

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **_event: None, raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "RESTRICTED_MCP_SERVERS", frozenset({"scheduler"}))

    request = bridge.build_check_request(
        headers={"authorization": "Bearer valid-token"},
        path="/mcp/jira",
        method="POST",
        body='{"jsonrpc":"2.0","method":"initialize"}',
    )
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    assert checks == [("user:user-sub-123", "can_call", "mcp_gateway:list")]


def test_tools_call_requires_user_agent_and_agent_tool_grants(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _load_bridge_module()
    checks: list[tuple[str, str, str]] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        checks.append((user, relation, obj))
        return (user, relation, obj) in {
            ("user:user-sub-123", "can_call", "mcp_gateway:list"),
            ("user:user-sub-123", "can_use", "agent:agent-test-april-2025"),
            ("agent:agent-test-april-2025", "can_call", "tool:jira/search"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **_event: None, raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    context_header, signature = bridge.build_agent_context_header(
        "agent-test-april-2025",
        secret="test-secret",
    )
    request = bridge.build_check_request(
        headers={
            "authorization": "Bearer valid-token",
            "x-caipe-agent-context": context_header,
            "x-caipe-agent-context-signature": signature,
        },
        path="/mcp/jira",
        method="POST",
        body='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search"}}',
    )

    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    assert checks == [
        ("user:user-sub-123", "can_call", "mcp_gateway:list"),
        ("user:user-sub-123", "can_use", "agent:agent-test-april-2025"),
        ("agent:agent-test-april-2025", "can_call", "tool:jira/search"),
    ]


def test_tools_call_denies_when_agent_tool_grant_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _load_bridge_module()
    events: list[dict] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        return (user, relation, obj) in {
            ("user:user-sub-123", "can_call", "mcp_gateway:list"),
            ("user:user-sub-123", "can_use", "agent:agent-test-april-2025"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    context_header, signature = bridge.build_agent_context_header(
        "agent-test-april-2025",
        secret="test-secret",
    )
    request = bridge.build_check_request(
        headers={
            "authorization": "Bearer valid-token",
            "x-caipe-agent-context": context_header,
            "x-caipe-agent-context-signature": signature,
        },
        path="/mcp/jira",
        method="POST",
        body='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"delete_filter"}}',
    )

    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.PERMISSION_DENIED
    assert "agent tool grant" in response.status.message
    # This decision's OpenFGA "user" tuple-key is agent:<id> (resource_ref
    # reflects the agent being checked), but subject_ref must still identify
    # the actual caller, not the agent.
    assert events[-1]["reason_code"] == "DENY_AGENT_TOOL"
    assert events[-1]["resource_ref"] == (
        "agent:agent-test-april-2025 can_call tool:jira/delete_filter"
    )
    assert events[-1]["subject_ref"] == "user:user-sub-123"


def _tools_call_request(
    bridge,
    *,
    tool_name: str,
    agent_id: str = "agent-test-april-2025",
    server_id: str = "jira",
) -> object:
    """Build a signed tools/call CheckRequest for the caller-keyed tests."""
    context_header, signature = bridge.build_agent_context_header(
        agent_id,
        secret="test-secret",
    )
    return bridge.build_check_request(
        headers={
            "authorization": "Bearer valid-token",
            "x-caipe-agent-context": context_header,
            "x-caipe-agent-context-signature": signature,
        },
        path=f"/mcp/{server_id}",
        method="POST",
        body=f'{{"jsonrpc":"2.0","method":"tools/call","params":{{"name":"{tool_name}"}}}}',
    )


def _local_tools_call_request(bridge, *, tool_name: str, agent_id: str = "mcp-local-agent-abc123"):
    """Build a signed kind="local" tools/call CheckRequest (CLI/local caller path)."""
    context_header, signature = bridge.build_agent_context_header(
        agent_id,
        secret="test-secret",
        kind=bridge.AGENT_CONTEXT_KIND_LOCAL,
    )
    return bridge.build_check_request(
        headers={
            "authorization": "Bearer valid-token",
            "x-caipe-agent-context": context_header,
            "x-caipe-agent-context-signature": signature,
        },
        path="/mcp/jira",
        method="POST",
        body=f'{{"jsonrpc":"2.0","method":"tools/call","params":{{"name":"{tool_name}"}}}}',
    )


def test_caller_keyed_denies_user_with_agent_tool_but_no_caller_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """S5b / FR-012a: the agent can call the tool and the user can use the agent,
    but the user does NOT hold the tool directly → deny (closes the
    confused-deputy escalation for human callers)."""
    bridge = _load_bridge_module()
    events: list[dict] = []

    def _fake_check_openfga(user: str, relation: str, obj: str) -> bool:
        # Everything the AGENT-keyed path needs is granted; the only thing
        # missing is the CALLER's own tool grant.
        return (user, relation, obj) in {
            ("user:user-sub-123", "can_call", "mcp_gateway:list"),
            ("user:user-sub-123", "can_use", "agent:agent-test-april-2025"),
            ("agent:agent-test-april-2025", "can_call", "tool:jira/search"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_decode_verified_bearer_claims", lambda _auth_header: {"sub": "user-sub-123"})
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", True)

    request = _tools_call_request(bridge, tool_name="search")
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.PERMISSION_DENIED
    assert "caller lacks tool grant" in response.status.message
    assert events[-1]["outcome"] == "deny"
    assert events[-1]["reason_code"] == "DENY_CALLER_TOOL"
    assert events[-1]["resource_ref"] == "user:user-sub-123 can_call tool:jira/search"


def test_knowledge_base_caller_uses_search_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _load_bridge_module()
    checks: list[tuple[str, str, str]] = []
    events: list[dict] = []

    def _fake_check_openfga(user: str, relation: str, obj: str) -> bool:
        checks.append((user, relation, obj))
        return (user, relation, obj) in {
            ("user:user-sub-123", "can_call", "mcp_gateway:list"),
            ("user:user-sub-123", "can_use", "agent:agent-test-april-2025"),
            (
                "agent:agent-test-april-2025",
                "can_call",
                "tool:knowledge-base/search",
            ),
            ("user:user-sub-123", "can_search", "organization:example-org"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _header: "user-sub-123")
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event))
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", True)
    monkeypatch.setattr(bridge, "CAIPE_ORG_KEY", "example-org")

    request = _tools_call_request(
        bridge,
        tool_name="search",
        server_id="knowledge-base",
    )
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    assert ("user:user-sub-123", "can_search", "organization:example-org") in checks
    assert (
        "user:user-sub-123",
        "can_call",
        "tool:knowledge-base/search",
    ) not in checks
    assert any(event["reason_code"] == "OK_CALLER_SEARCH" for event in events)


def test_knowledge_base_caller_cannot_replace_search_with_mcp_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = _load_bridge_module()
    events: list[dict] = []

    def _fake_check_openfga(user: str, relation: str, obj: str) -> bool:
        return (user, relation, obj) in {
            ("user:user-sub-123", "can_call", "mcp_gateway:list"),
            ("user:user-sub-123", "can_use", "agent:agent-test-april-2025"),
            (
                "agent:agent-test-april-2025",
                "can_call",
                "tool:knowledge-base/search",
            ),
            ("user:user-sub-123", "can_call", "tool:knowledge-base/search"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _header: "user-sub-123")
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event))
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", True)
    monkeypatch.setattr(bridge, "CAIPE_ORG_KEY", "example-org")

    request = _tools_call_request(
        bridge,
        tool_name="search",
        server_id="knowledge-base",
    )
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.PERMISSION_DENIED
    assert "Knowledge Base search access" in response.status.message
    assert events[-1]["reason_code"] == "DENY_CALLER_SEARCH"
    assert events[-1]["resource_ref"] == (
        "user:user-sub-123 can_search organization:example-org"
    )


def test_caller_keyed_allows_service_account_with_both_grants(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """S5 / FR-012: a service-account caller with BOTH the agent-use+agent-tool
    grants AND its own caller tool grant is allowed, and the allow is audited."""
    bridge = _load_bridge_module()
    events: list[dict] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        return (user, relation, obj) in {
            ("service_account:sa-sub", "can_call", "mcp_gateway:list"),
            ("service_account:sa-sub", "can_use", "agent:agent-test-april-2025"),
            ("agent:agent-test-april-2025", "can_call", "tool:jira/search"),
            ("service_account:sa-sub", "can_call", "tool:jira/search"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "sa-sub")
    monkeypatch.setattr(
        bridge,
        "_decode_verified_bearer_claims",
        lambda _auth_header: {
            "sub": "sa-sub",
            "preferred_username": "service-account-caipe-sa-incident-bot-a1b2c3",
        },
    )
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", True)

    request = _tools_call_request(bridge, tool_name="search")
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    # The caller-keyed allow is audited (FR-027/SC-009).
    caller_tool_allow = [
        e
        for e in events
        if e["reason_code"] == "OK_CALLER_TOOL"
        and e["resource_ref"] == "service_account:sa-sub can_call tool:jira/search"
    ]
    assert len(caller_tool_allow) == 1
    assert caller_tool_allow[0]["outcome"] == "allow"
    # Real identity is attached for service-account callers too, not just users.
    assert caller_tool_allow[0]["subject_ref"] == "service_account:sa-sub"


def test_caller_keyed_denies_service_account_without_caller_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A service-account caller that can use the agent (and the agent can call the
    tool) but lacks its OWN tool grant is denied."""
    bridge = _load_bridge_module()

    def _fake_check_openfga(user: str, relation: str, obj: str):
        return (user, relation, obj) in {
            ("service_account:sa-sub", "can_call", "mcp_gateway:list"),
            ("service_account:sa-sub", "can_use", "agent:agent-test-april-2025"),
            ("agent:agent-test-april-2025", "can_call", "tool:jira/search"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "sa-sub")
    monkeypatch.setattr(
        bridge,
        "_decode_verified_bearer_claims",
        lambda _auth_header: {
            "sub": "sa-sub",
            "preferred_username": "service-account-caipe-sa-incident-bot-a1b2c3",
        },
    )
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **_event: None, raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", True)

    request = _tools_call_request(bridge, tool_name="search")
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.PERMISSION_DENIED
    assert "caller lacks tool grant" in response.status.message


def test_caller_keyed_check_disabled_keeps_legacy_agent_only_behavior(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rollout safety (FR-012c): with the flag OFF, a caller who lacks the tool
    directly is still allowed via the agent grant (legacy behavior preserved),
    and NO caller-keyed check is performed."""
    bridge = _load_bridge_module()
    checks: list[tuple[str, str, str]] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        checks.append((user, relation, obj))
        return (user, relation, obj) in {
            ("user:user-sub-123", "can_call", "mcp_gateway:list"),
            ("user:user-sub-123", "can_use", "agent:agent-test-april-2025"),
            ("agent:agent-test-april-2025", "can_call", "tool:jira/search"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_decode_verified_bearer_claims", lambda _auth_header: {"sub": "user-sub-123"})
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **_event: None, raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", False)

    request = _tools_call_request(bridge, tool_name="search")
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    # No caller-keyed (user→tool) check was performed.
    assert ("user:user-sub-123", "can_call", "tool:jira/search") not in checks


def test_preferred_username_from_metadata_reads_caipe_auth() -> None:
    # #49: the gateway passes preferred_username in caipe.auth metadata because it
    # consumes the bearer and the bridge can't re-decode it.
    bridge = _load_bridge_module()
    request = bridge.build_check_request(
        headers={},
        metadata_subject="sa-sub",
        metadata_preferred_username="service-account-caipe-sa-incident-bot-a1b2c3",
    )
    assert bridge._preferred_username_from_metadata(request) == (
        "service-account-caipe-sa-incident-bot-a1b2c3"
    )
    # Absent → None
    assert bridge._preferred_username_from_metadata(bridge.build_check_request(headers={})) is None


def test_request_caller_is_service_account_prefers_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    # Metadata says SA; there is NO bearer (gateway consumed it). Must detect SA
    # from metadata alone — the #49 production path.
    bridge = _load_bridge_module()
    sa_request = bridge.build_check_request(
        headers={},
        metadata_subject="sa-sub",
        metadata_preferred_username="service-account-caipe-sa-bot-abc",
    )
    assert bridge.request_caller_is_service_account(sa_request, {}) is True

    # Metadata present, human preferred_username → not an SA.
    human_request = bridge.build_check_request(
        headers={},
        metadata_subject="kevin-sub",
        metadata_preferred_username="kevin@example.com",
    )
    assert bridge.request_caller_is_service_account(human_request, {}) is False


def test_request_caller_is_service_account_falls_back_to_bearer(monkeypatch: pytest.MonkeyPatch) -> None:
    # No metadata preferred_username → fall back to decoding the bearer header
    # (local diagnostics / metadata-less path).
    bridge = _load_bridge_module()
    monkeypatch.setattr(
        bridge,
        "_decode_verified_bearer_claims",
        lambda auth: {"preferred_username": "service-account-x"} if auth == "Bearer t" else None,
    )
    no_meta = bridge.build_check_request(headers={"authorization": "Bearer t"})
    assert bridge.request_caller_is_service_account(no_meta, {"authorization": "Bearer t"}) is True
    assert bridge.request_caller_is_service_account(no_meta, {}) is False


def test_local_agent_context_bypasses_agent_use_and_tool_checks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """kind="local" (see ui/src/app/api/mcp-servers/agent-context/route.ts) skips
    the agent:<id> can_use/can_call checks entirely — the caller's own
    can_call mcp_gateway:list grant is all that's required."""
    bridge = _load_bridge_module()
    checks: list[tuple[str, str, str]] = []
    events: list[dict] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        checks.append((user, relation, obj))
        return (user, relation, obj) == ("user:user-sub-123", "can_call", "mcp_gateway:list")

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", False)

    context_header, signature = bridge.build_agent_context_header(
        "mcp-local-agent-abc123",
        secret="test-secret",
        kind=bridge.AGENT_CONTEXT_KIND_LOCAL,
    )
    request = bridge.build_check_request(
        headers={
            "authorization": "Bearer valid-token",
            "x-caipe-agent-context": context_header,
            "x-caipe-agent-context-signature": signature,
        },
        path="/mcp/jira",
        method="POST",
        body='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search"}}',
    )

    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    # No agent:<id> can_use/can_call checks were performed.
    assert checks == [("user:user-sub-123", "can_call", "mcp_gateway:list")]
    local_allow = [e for e in events if e["reason_code"] == "OK_LOCAL_AGENT_CONTEXT"]
    assert len(local_allow) == 1
    # The audit event is scoped to the actual tool target (tool:<server>/<name>),
    # not agent:<id> — so audit trails record which tool a local caller invoked.
    assert local_allow[0]["resource_ref"] == "user:user-sub-123 can_call tool:jira/search"


def test_local_agent_context_with_caller_check_denies_without_caller_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The production-relevant path: kind="local" with CALLER_TOOL_CHECK_ENABLED=True
    (as this repo's dev/prod helm values set it). A local caller who holds only
    the coarse mcp_gateway:list grant — but NOT the per-tool grant — is denied.
    This is the check the local branch's safety rests on when the flag is on."""
    bridge = _load_bridge_module()
    events: list[dict] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        # Only the coarse gateway gate is held; no tool:jira/search or wildcard.
        return (user, relation, obj) == ("user:user-sub-123", "can_call", "mcp_gateway:list")

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_decode_verified_bearer_claims", lambda _auth_header: {"sub": "user-sub-123"})
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", True)

    request = _local_tools_call_request(bridge, tool_name="search")
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.PERMISSION_DENIED
    assert "caller lacks tool grant" in response.status.message
    assert events[-1]["outcome"] == "deny"
    assert events[-1]["reason_code"] == "DENY_CALLER_TOOL"
    assert events[-1]["resource_ref"] == "user:user-sub-123 can_call tool:jira/search"


def test_local_agent_context_with_caller_check_allows_with_exact_tool_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """kind="local" with CALLER_TOOL_CHECK_ENABLED=True and the caller holding the
    exact per-tool grant → allowed, and the caller-keyed allow is audited."""
    bridge = _load_bridge_module()
    events: list[dict] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        return (user, relation, obj) in {
            ("user:user-sub-123", "can_call", "mcp_gateway:list"),
            ("user:user-sub-123", "can_call", "tool:jira/search"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_decode_verified_bearer_claims", lambda _auth_header: {"sub": "user-sub-123"})
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **event: events.append(event), raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", True)

    request = _local_tools_call_request(bridge, tool_name="search")
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    caller_tool_allow = [
        e
        for e in events
        if e["reason_code"] == "OK_CALLER_TOOL"
        and e["resource_ref"] == "user:user-sub-123 can_call tool:jira/search"
    ]
    assert len(caller_tool_allow) == 1
    assert caller_tool_allow[0]["outcome"] == "allow"


def test_local_agent_context_with_caller_check_allows_with_wildcard_tool_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """kind="local" with CALLER_TOOL_CHECK_ENABLED=True and only a wildcard
    tool:<server>/* grant (no exact tuple) → allowed via the wildcard fallback."""
    bridge = _load_bridge_module()

    def _fake_check_openfga(user: str, relation: str, obj: str):
        # Exact tool:jira/search is deliberately withheld to force the wildcard path.
        return (user, relation, obj) in {
            ("user:user-sub-123", "can_call", "mcp_gateway:list"),
            ("user:user-sub-123", "can_call", "tool:jira/*"),
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_decode_verified_bearer_claims", lambda _auth_header: {"sub": "user-sub-123"})
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **_event: None, raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", True)

    request = _local_tools_call_request(bridge, tool_name="search")
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK


def test_missing_kind_defaults_to_dynamic_and_still_enforces_agent_checks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backward compatibility: older producers (Dynamic Agents runtime, the
    diagnostic test-tool route) never send "kind" — the bridge must keep
    enforcing the full agent:<id> can_use/can_call checks for them."""
    bridge = _load_bridge_module()

    def _fake_check_openfga(user: str, relation: str, obj: str):
        return (user, relation, obj) in {
            ("user:user-sub-123", "can_call", "mcp_gateway:list"),
            # Deliberately withhold can_use agent:<id> to prove it's still checked.
        }

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **_event: None, raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")

    issued_at = int(time.time())
    payload = {
        "agent_id": "agent-test-april-2025",
        "iat": issued_at,
        "exp": issued_at + 300,
        # no "kind" key at all
    }
    encoded = bridge._b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    signature = hmac.new(b"test-secret", encoded.encode(), hashlib.sha256).hexdigest()
    request = bridge.build_check_request(
        headers={
            "authorization": "Bearer valid-token",
            "x-caipe-agent-context": encoded,
            "x-caipe-agent-context-signature": signature,
        },
        path="/mcp/jira",
        method="POST",
        body='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search"}}',
    )

    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.PERMISSION_DENIED
    assert response.status.message == "user lacks dynamic agent grant"


def test_agent_context_with_unknown_kind_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = _load_bridge_module()

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(
        bridge,
        "_check_openfga",
        lambda user, relation, obj: (user, relation, obj) == ("user:user-sub-123", "can_call", "mcp_gateway:list"),
    )
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **_event: None, raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")

    issued_at = int(time.time())
    payload = {
        "agent_id": "agent-test-april-2025",
        "iat": issued_at,
        "exp": issued_at + 300,
        "kind": "admin",
    }
    encoded = bridge._b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    signature = hmac.new(b"test-secret", encoded.encode(), hashlib.sha256).hexdigest()
    request = bridge.build_check_request(
        headers={
            "authorization": "Bearer valid-token",
            "x-caipe-agent-context": encoded,
            "x-caipe-agent-context-signature": signature,
        },
        path="/mcp/jira",
        method="POST",
        body='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search"}}',
    )

    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.PERMISSION_DENIED
    assert response.status.message == "missing or invalid signed agent context"


def test_agent_context_claiming_lifetime_over_kind_max_age_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Defense in depth: even a validly-signed payload can't claim an exp - iat
    span longer than its kind's configured max age."""
    bridge = _load_bridge_module()

    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth_header: "user-sub-123")
    monkeypatch.setattr(
        bridge,
        "_check_openfga",
        lambda user, relation, obj: (user, relation, obj) == ("user:user-sub-123", "can_call", "mcp_gateway:list"),
    )
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **_event: None, raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_LOCAL_MAX_AGE_SECONDS", 43200)
    monkeypatch.setattr(
        bridge,
        "_AGENT_CONTEXT_MAX_AGE_BY_KIND",
        {
            bridge.AGENT_CONTEXT_KIND_DYNAMIC: bridge.AGENT_CONTEXT_MAX_AGE_SECONDS,
            bridge.AGENT_CONTEXT_KIND_LOCAL: 43200,
        },
    )

    issued_at = int(time.time())
    payload = {
        "agent_id": "mcp-local-agent-abc123",
        "iat": issued_at,
        "exp": issued_at + 43200 + 1,  # claims a lifetime 1s over the max age
        "kind": bridge.AGENT_CONTEXT_KIND_LOCAL,
    }
    encoded = bridge._b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    signature = hmac.new(b"test-secret", encoded.encode(), hashlib.sha256).hexdigest()
    request = bridge.build_check_request(
        headers={
            "authorization": "Bearer valid-token",
            "x-caipe-agent-context": encoded,
            "x-caipe-agent-context-signature": signature,
        },
        path="/mcp/jira",
        method="POST",
        body='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search"}}',
    )

    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.PERMISSION_DENIED
    assert response.status.message == "missing or invalid signed agent context"


def test_check_namespaces_service_account_from_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    # End-to-end: an SA tools/call with NO bearer but SA metadata must graph as
    # service_account:<sub> (the #49 fix). Pre-fix it graphed user:<sub>.
    bridge = _load_bridge_module()
    checks: list[tuple[str, str, str]] = []

    def _fake_check_openfga(user: str, relation: str, obj: str):
        checks.append((user, relation, obj))
        return (user, relation, obj) in {
            ("service_account:sa-sub", "can_call", "mcp_gateway:list"),
            ("service_account:sa-sub", "can_use", "agent:agent-test-april-2025"),
            ("agent:agent-test-april-2025", "can_call", "tool:jira/search"),
            ("service_account:sa-sub", "can_call", "tool:jira/search"),
        }

    # Subject resolved from metadata (no bearer). preferred_username also in metadata.
    monkeypatch.setattr(bridge, "_decode_verified_bearer_subject", lambda _auth: None)
    monkeypatch.setattr(bridge, "_decode_verified_bearer_claims", lambda _auth: None)
    monkeypatch.setattr(bridge, "_check_openfga", _fake_check_openfga)
    monkeypatch.setattr(bridge, "log_authz_decision", lambda **_event: None, raising=False)
    monkeypatch.setattr(bridge, "BYPASS_SUBS", frozenset())
    monkeypatch.setattr(bridge, "AGENT_CONTEXT_HMAC_SECRET", "test-secret")
    monkeypatch.setattr(bridge, "CALLER_TOOL_CHECK_ENABLED", True)

    context_header, signature = bridge.build_agent_context_header(
        "agent-test-april-2025", secret="test-secret"
    )
    request = bridge.build_check_request(
        headers={
            "x-caipe-agent-context": context_header,
            "x-caipe-agent-context-signature": signature,
        },
        path="/mcp/jira",
        method="POST",
        body='{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search"}}',
        metadata_subject="sa-sub",
        metadata_preferred_username="service-account-caipe-sa-incident-bot-a1b2c3",
    )
    response = bridge.OpenFgaAuthorizationService().Check(request, None)

    assert response.status.code == bridge.OK
    # The caller was graphed as service_account:, NOT user: — the #49 fix.
    assert ("service_account:sa-sub", "can_call", "tool:jira/search") in checks
    assert not any(u.startswith("user:sa-sub") for (u, _, _) in checks)
