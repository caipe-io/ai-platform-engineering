"""Direct runtime requests must authenticate and obtain a fresh CAS decision."""

import base64
import json
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from dynamic_agents.auth import authz, jwks_validate, jwt_middleware
from dynamic_agents.config import Settings, get_settings
from dynamic_agents.routes import chat
from dynamic_agents.services.mongo import get_mongo_service

ROUTES = [
    ("/api/v1/chat/stream/start", {"message": "hello"}),
    ("/api/v1/chat/stream/resume", {"resume_data": "{}"}),
    ("/api/v1/chat/invoke", {"message": "hello"}),
]


@pytest.fixture(scope="module")
def signing_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def boundary(monkeypatch: pytest.MonkeyPatch, signing_key: rsa.RSAPrivateKey) -> Iterator[SimpleNamespace]:
    monkeypatch.setenv("OIDC_ISSUER", "https://identity.example.test/realm")
    monkeypatch.setenv("KEYCLOAK_AUDIENCE", "example-platform")
    monkeypatch.setenv("AUTHZ_SERVICE_URL", "https://authz.example.test")
    # Prove the execution gate also rejects trusted-header-only requests.
    monkeypatch.setattr(jwt_middleware, "DA_REQUIRE_BEARER", False)
    jwks = MagicMock()
    jwks.get_signing_key_from_jwt.return_value = SimpleNamespace(key=signing_key.public_key())
    monkeypatch.setattr(jwks_validate, "_get_jwks_client", lambda: jwks)
    mongo = MagicMock()
    mongo.get_agent.return_value = None  # Authorized requests reach lookup, not an LLM.
    state = SimpleNamespace(allowed=True, status=200, decisions=[], mongo=mongo)

    def cas(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/access/check"
        assert json.loads(request.content) == {"resource": {"type": "agent", "id": "example"}, "action": "use"}
        claims = jwks_validate.validate_bearer_jwt(request.headers["authorization"][7:])
        state.decisions.append(claims["sub"])
        return httpx.Response(state.status, json={"decision": "ALLOW" if state.allowed else "DENY"})

    async_client = httpx.AsyncClient
    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **kw: async_client(transport=httpx.MockTransport(cas), **kw))
    app = FastAPI()
    app.add_middleware(jwt_middleware.JwtAuthMiddleware)
    app.include_router(chat.router, prefix="/api/v1")
    app.dependency_overrides[get_mongo_service] = lambda: mongo
    app.dependency_overrides[get_settings] = lambda: Settings.model_construct(debug=False)
    now = datetime.now(timezone.utc)
    token = jwt.encode({"sub": "test-user", "iss": "https://identity.example.test/realm", "aud": "example-platform",
                        "iat": now, "exp": now + timedelta(minutes=5)}, signing_key, algorithm="RS256")
    state.headers = {
        "Authorization": f"Bearer {token}",
        # Even an asserted admin cannot override the bearer-bound CAS denial.
        "X-User-Context": base64.b64encode(json.dumps({"email": "other@example.test", "sub": "other-user",
                                                     "is_admin": True}).encode()).decode(),
    }
    with TestClient(app) as client:
        state.client = client
        yield state


@pytest.mark.parametrize(("path", "extra"), ROUTES)
def test_revocation_stops_the_next_execution(boundary: SimpleNamespace, path: str, extra: dict) -> None:
    s = boundary
    body = {"agent_id": "example", "conversation_id": "example-conversation", **extra}
    assert s.client.post(path, headers=s.headers, json=body).status_code == 404
    s.mongo.get_agent.assert_called_once_with("example")
    s.mongo.reset_mock()
    s.allowed = False
    response = s.client.post(path, headers=s.headers, json=body)
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "pdp_denied"
    assert s.decisions == ["test-user", "test-user"]
    s.mongo.get_agent.assert_not_called()


@pytest.mark.parametrize(("path", "extra"), ROUTES)
@pytest.mark.parametrize(("credential", "cas_status", "expected"), [
    ("missing", 200, 401), ("invalid", 200, 401), ("valid", 503, 503), ("valid", 401, 401),
])
def test_failure_never_reaches_agent_lookup(
    boundary: SimpleNamespace, path: str, extra: dict, credential: str, cas_status: int, expected: int,
) -> None:
    s = boundary
    s.status = cas_status
    headers = dict(s.headers)
    if credential == "missing":
        del headers["Authorization"]
    elif credential == "invalid":
        headers["Authorization"] = "Bearer invalid"
    response = s.client.post(path, headers=headers, json={"agent_id": "example", "conversation_id": "example", **extra})
    assert response.status_code == expected
    assert s.decisions == (["test-user"] if credential == "valid" else [])
    s.mongo.get_agent.assert_not_called()
