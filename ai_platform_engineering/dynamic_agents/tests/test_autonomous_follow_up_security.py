"""Exercise follow-up authorization through real JWT validation and middleware."""

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
from dynamic_agents.routes import autonomous_follow_up as routes
from dynamic_agents.services.mongo import get_mongo_service

POST = "/api/v1/autonomous/tasks/task/runs/run/follow-up-chat"
GET = "/api/v1/autonomous/tasks/task/follow-up-chats"


@pytest.fixture(scope="module")
def signing_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def secured_app(monkeypatch: pytest.MonkeyPatch, signing_key: rsa.RSAPrivateKey) -> Iterator[SimpleNamespace]:
    monkeypatch.setenv("OIDC_ISSUER", "https://identity.example.test/realm")
    monkeypatch.setenv("KEYCLOAK_AUDIENCE", "example-platform")
    monkeypatch.setenv("AUTHZ_SERVICE_URL", "http://authz.example.test")
    monkeypatch.setattr(jwt_middleware, "DA_REQUIRE_BEARER", False)
    jwks = MagicMock()
    jwks.get_signing_key_from_jwt.return_value = SimpleNamespace(key=signing_key.public_key())
    monkeypatch.setattr(jwks_validate, "_get_jwks_client", lambda: jwks)
    db = {name: MagicMock() for name in (
        "autonomous_tasks", "autonomous_runs", "autonomous_follow_up_chats", "conversations", "users",
    )}
    task = {"owner_id": "owner@example.com", "owner_sub": "owner", "dynamic_agent_id": "agent"}
    run = {"owner_id": "owner@example.com", "status": "success", "finished_at": "2026-09-01T10:00:00Z",
           "execution_context_id": "source"}
    db["autonomous_tasks"].find_one.return_value = task
    db["autonomous_runs"].find_one.return_value = run
    db["autonomous_follow_up_chats"].find.return_value = []
    db["users"].find.return_value.limit.return_value = []
    mongo = MagicMock(_db=db)
    mongo.get_agent.return_value = SimpleNamespace(enabled=True)
    copy = MagicMock(return_value={"conversation_id": "manual", "run_id": "run"})
    monkeypatch.setattr(routes, "create_follow_up_chat", copy)
    state = SimpleNamespace(db=db, copy=copy, task=task, run=run, decisions=[], deny=set(), cas_status={})

    def cas(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        # CAS sees the same signed bearer and subject, never the identity header.
        bearer = request.headers["authorization"][7:]
        claims = jwks_validate.validate_bearer_jwt(bearer)
        assert body["subject"] == {"type": "user", "id": claims["sub"]}
        state.decisions.append(body)
        allowed = body["action"] not in state.deny and (body["action"] != "manage" or claims["sub"] == "admin")
        return httpx.Response(state.cas_status.get(body["action"], 200), json={"decision": "ALLOW" if allowed else "DENY"})

    async_client = httpx.AsyncClient
    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **kwargs: async_client(transport=httpx.MockTransport(cas), **kwargs))
    app = FastAPI()
    app.add_middleware(jwt_middleware.JwtAuthMiddleware)
    app.include_router(routes.router, prefix="/api/v1")
    app.dependency_overrides[get_mongo_service] = lambda: mongo
    app.dependency_overrides[get_settings] = lambda: Settings.model_construct(debug=True)

    def headers(subject: str = "owner", *, email: str | None = None, forged: dict | None = None, **extra: object) -> dict:
        now = datetime.now(timezone.utc)
        claims = {"sub": subject, "email": email if email is not None else f"{subject}@example.com",
                  "iss": "https://identity.example.test/realm", "aud": "example-platform",
                  "iat": now, "exp": now + timedelta(minutes=5), **extra}
        result = {"Authorization": "Bearer " + jwt.encode(claims, signing_key, algorithm="RS256")}
        if forged is not None:
            result["X-User-Context"] = base64.b64encode(json.dumps(forged).encode()).decode()
        return result

    state.headers = headers
    with TestClient(app) as client:
        state.client = client
        yield state


@pytest.mark.parametrize("method,path", [("POST", POST), ("GET", GET)])
@pytest.mark.parametrize("forged", [
    {"email": "attacker@example.com", "is_admin": True},
    {"email": "owner@example.com", "sub": "owner", "is_admin": False},
    {"email": "owner@example.com", "is_admin": True},
])
def test_valid_attacker_bearer_cannot_forge_owner_or_admin(secured_app: SimpleNamespace, method: str, path: str, forged: dict) -> None:
    s = secured_app
    response = s.client.request(method, path, headers=s.headers("attacker", forged=forged))
    assert response.status_code == 403
    s.copy.assert_not_called()


@pytest.mark.parametrize("subject", ["owner", "admin"])
def test_owner_and_cas_admin_work_without_trusting_header(secured_app: SimpleNamespace, subject: str) -> None:
    s = secured_app
    response = s.client.post(POST, headers=s.headers(subject, forged={"email": "victim@example.com", "is_admin": True}))
    assert response.status_code == 200
    user = s.copy.call_args.args[-1]
    assert user.email == f"{subject}@example.com"
    assert user.sub == subject
    assert not user.is_admin  # Access came from CAS, not this header flag.
    assert [d["action"] for d in s.decisions] == (["automate", "use"] if subject == "owner" else ["automate", "manage", "manage", "use"])


def test_verified_identity_does_not_leak_between_requests(secured_app: SimpleNamespace) -> None:
    s = secured_app
    assert s.client.post(POST, headers=s.headers()).status_code == 200
    assert s.client.post(POST, headers={"X-User-Context": "forged"}).status_code == 401
    assert s.client.post(POST, headers=s.headers("attacker")).status_code == 403
    assert s.copy.call_count == 1


@pytest.mark.parametrize("extra", [
    {"exp": 1}, {"iss": "https://wrong.example.test"}, {"aud": "wrong-audience"}, {"sub": ""},
])
def test_invalid_claims_fail_before_copy(secured_app: SimpleNamespace, extra: dict) -> None:
    s = secured_app
    assert s.client.post(POST, headers=s.headers(**extra)).status_code == 401
    s.copy.assert_not_called()


def test_service_account_cannot_assert_interactive_owner(secured_app: SimpleNamespace) -> None:
    s = secured_app
    assert s.client.post(POST, headers=s.headers(preferred_username="service-account-example")).status_code == 403
    s.copy.assert_not_called()


@pytest.mark.parametrize("field", ["keycloak_sub", "metadata.keycloak_sub"])
def test_missing_email_resolves_only_from_subject_directory(secured_app: SimpleNamespace, field: str) -> None:
    s = secured_app
    row = {"email": "owner@example.com", **({"keycloak_sub": "owner"} if field == "keycloak_sub" else {"metadata": {"keycloak_sub": "owner"}})}
    s.db["users"].find.return_value.limit.return_value = [row]
    assert s.client.post(POST, headers=s.headers(email="", forged={"email": "victim@example.com"})).status_code == 200
    assert s.db["users"].find.call_args.args[0] == {"$or": [{"keycloak_sub": "owner"}, {"metadata.keycloak_sub": "owner"}]}
    assert s.copy.call_args.args[-1].email == "owner@example.com"


def test_missing_email_never_falls_back_to_header(secured_app: SimpleNamespace) -> None:
    s = secured_app
    assert s.client.post(POST, headers=s.headers(email="", forged={"email": "owner@example.com"})).status_code == 403
    s.copy.assert_not_called()


@pytest.mark.parametrize("record,field,value", [("task", "owner_sub", "different-sub"), ("run", "owner_id", "other@example.com")])
def test_both_task_and_run_must_belong_to_verified_caller(secured_app: SimpleNamespace, record: str, field: str, value: str) -> None:
    s = secured_app
    getattr(s, record)[field] = value
    assert s.client.post(POST, headers=s.headers()).status_code == 403
    s.copy.assert_not_called()


@pytest.mark.parametrize("denied", ["automate", "use"])
def test_existing_entitlement_and_agent_gates_still_apply(secured_app: SimpleNamespace, denied: str) -> None:
    s = secured_app
    s.deny.add(denied)
    assert s.client.post(POST, headers=s.headers()).status_code == 403
    s.copy.assert_not_called()


def test_authorization_outage_cannot_grant_admin(secured_app: SimpleNamespace) -> None:
    s = secured_app
    s.cas_status["manage"] = 503
    assert s.client.post(POST, headers=s.headers("admin", forged={"is_admin": True})).status_code == 503
    assert [d["action"] for d in s.decisions] == ["automate", "manage"]
    s.copy.assert_not_called()


def test_forged_signature_is_rejected(secured_app: SimpleNamespace) -> None:
    s = secured_app
    header = s.headers()
    claims = jwt.decode(header["Authorization"][7:], options={"verify_signature": False})
    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    header["Authorization"] = "Bearer " + jwt.encode(claims, wrong_key, algorithm="RS256")
    assert s.client.post(POST, headers=header).status_code == 401
    assert not s.decisions
    s.copy.assert_not_called()


@pytest.mark.parametrize("rows", [
    [{"email": "owner@example.com", "keycloak_sub": "owner"}] * 2,
    [{"email": "owner@example.com", "keycloak_sub": "different", "metadata": {"keycloak_sub": "owner"}}],
    [{"keycloak_sub": "owner"}],
])
def test_ambiguous_or_incomplete_directory_fails_closed(secured_app: SimpleNamespace, rows: list) -> None:
    s = secured_app
    s.db["users"].find.return_value.limit.return_value = rows
    assert s.client.post(POST, headers=s.headers(email="")).status_code == 403
    s.copy.assert_not_called()


def test_existing_tasks_without_subject_still_work(secured_app: SimpleNamespace) -> None:
    s = secured_app
    s.task.pop("owner_sub")
    assert s.client.post(POST, headers=s.headers(email="OWNER@EXAMPLE.COM")).status_code == 200
    assert s.copy.call_args.args[-1].email == "owner@example.com"


@pytest.mark.parametrize("subject", ["owner", "admin"])
def test_link_listing_is_scoped_to_bearer_identity(secured_app: SimpleNamespace, subject: str) -> None:
    s = secured_app
    s.db["autonomous_follow_up_chats"].find.return_value = [{"run_id": "run", "conversation": {"_id": "manual"}}]
    s.db["conversations"].find.return_value = [{"_id": "manual"}]
    response = s.client.get(GET, headers=s.headers(subject, forged={"email": "victim@example.com", "is_admin": True}))
    assert response.json() == {"run": "manual"}
    assert s.db["autonomous_follow_up_chats"].find.call_args.args[0]["owner_id"] == f"{subject}@example.com"
