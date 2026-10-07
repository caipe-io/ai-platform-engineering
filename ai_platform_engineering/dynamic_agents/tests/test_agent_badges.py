"""Real signatures with HTTP fixtures for optional Agent Badge publication."""

import json
import time
from types import SimpleNamespace

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import UserContext
from dynamic_agents.routes import agent_badges as badge_routes
from dynamic_agents.services import agent_badges
from dynamic_agents.services.agent_badges import AgentBadgePublisher, BadgePublicationError
from dynamic_agents.services.mongo import get_mongo_service


@pytest.fixture
def setup(tmp_path, monkeypatch):
    signer = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    provider = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_path = tmp_path / "signing.pem"
    key_path.write_bytes(
        signer.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
    )
    secret_path = tmp_path / "secret"
    secret_path.write_text("test-secret")
    bindings = tmp_path / "bindings.json"
    bindings.write_text(
        json.dumps(
            {
                "primary": {
                    "subject": "IDP-primary-sub",
                    "token_subject": "primary-sub",
                    "client_id": "primary-client",
                    "client_secret_file": str(secret_path),
                }
            }
        )
    )
    settings = Settings(
        _env_file=None,
        agntcy_identity_enabled=True,
        agntcy_identity_node_url="https://node.example.test",
        agntcy_identity_bindings_file=str(bindings),
        agntcy_identity_issuer="issuer.example.test",
        agntcy_identity_signing_key_file=str(key_path),
        agntcy_identity_signing_key_id="signer",
        agntcy_identity_keycloak_issuer="https://issuer.example.test/realms/primary",
        agntcy_identity_keycloak_token_url="https://issuer.example.test/token",
        agntcy_identity_keycloak_jwks_url="https://issuer.example.test/keys",
        agntcy_identity_keycloak_audience="identity-node",
    )
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(signer.public_key())) | {
        "kid": "signer",
        "alg": "RS256",
        "d": "",
        "p": "",
        "q": "",
    }
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(provider.public_key())) | {"kid": "provider", "alg": "RS256"}
    record = {
        "name": "primary",
        "version": "1.0.0",
        "schema_version": "1.0.0",
        "annotations": {"agntcy.dir/identity": "agntcy://IDP-primary-sub"},
    }
    state = {
        "claims": {
            "iss": settings.agntcy_identity_keycloak_issuer,
            "sub": "primary-sub",
            "azp": "primary-client",
            "aud": "identity-node",
            "iat": int(time.time()),
            "exp": int(time.time()) + 300,
        },
        "public": public,
        "jwks": [jwk],
        "provider": provider,
        "controller": "issuer.example.test",
        "subject": "IDP-primary-sub",
        "assertions": ["key"],
        "verified": True,
        "published": [],
        "calls": [],
        "publish_status": 200,
    }

    def handle(request):
        state["calls"].append(request.url.path)
        if request.url.path == "/token":
            assert b"client_credentials" in request.content
            token = jwt.encode(state["claims"], state["provider"], algorithm="RS256", headers={"kid": "provider"})
            return httpx.Response(200, json={"access_token": token})
        if request.url.path == "/keys":
            return httpx.Response(200, json={"keys": state["jwks"]})
        if request.url.path == "/v1alpha1/id/resolve":
            return httpx.Response(
                200,
                json={
                    "resolverMetadata": {
                        "id": state["subject"],
                        "controller": state["controller"],
                        "assertionMethod": state["assertions"],
                        "verificationMethod": [{"id": "key", "publicKeyJwk": state["public"]}],
                    }
                },
            )
        body = json.loads(request.content)
        if request.url.path == "/v1alpha1/vc/verify":
            badge = jwt.decode(body["vc"]["value"], signer.public_key(), algorithms=["RS256"])
            assert badge["credentialSubject"]["badge"] == record
            state["credential"] = badge
            return httpx.Response(200, json={"status": state["verified"]})
        if request.url.path == "/v1alpha1/vc/publish":
            state["published"].append(body)
            return httpx.Response(state["publish_status"], json={})
        raise AssertionError(request.url)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        agent_badges.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw)
    )
    return settings, record, state


async def test_publishes_real_signed_badge_and_returns_reference(setup):
    settings, record, state = setup
    receipt = await AgentBadgePublisher(settings).publish("primary", "primary", record)
    assert receipt["subject"] == "agntcy://IDP-primary-sub"
    assert receipt["credential_id"] == state["credential"]["id"]
    assert receipt["expires_at"] == state["credential"]["expirationDate"]
    assert len(receipt["definition_sha256"]) == 64
    assert "verified" not in receipt and "value" not in receipt
    proof = state["published"][0]["proof"]["proofValue"]
    assert state["published"][0]["vc"]["envelopeType"] == agent_badges.ENVELOPE
    assert jwt.get_unverified_header(proof)["kid"] == "provider"
    assert "test-secret" not in json.dumps(receipt)


@pytest.mark.parametrize(
    "claim,value",
    [
        ("iss", "https://other.example.test"),
        ("aud", "other"),
        ("sub", "secondary-sub"),
        ("azp", "secondary-client"),
        ("exp", 1),
    ],
)
async def test_rejects_wrong_keycloak_bindings(setup, claim, value):
    settings, record, state = setup
    state["claims"][claim] = value
    with pytest.raises(BadgePublicationError):
        await AgentBadgePublisher(settings).publish("primary", "primary", record)
    assert state["published"] == []


@pytest.mark.parametrize("change", ["key", "node", "publish", "binding", "name", "identity", "ttl", "http"])
async def test_rejects_invalid_publication(setup, change):
    settings, record, state = setup
    if change == "key":
        state["public"] = json.loads(
            jwt.algorithms.RSAAlgorithm.to_jwk(
                rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key()
            )
        ) | {"kid": "signer", "alg": "RS256", "d": "", "p": "", "q": ""}
    elif change == "node":
        state["verified"] = False
    elif change == "publish":
        state["publish_status"] = 503
    elif change == "binding":
        settings.agntcy_identity_bindings_file += ".missing"
    elif change == "name":
        record["name"] = "secondary"
    elif change == "identity":
        record["annotations"]["agntcy.dir/identity"] = "agntcy://IDP-secondary-sub"
    elif change == "ttl":
        settings.agntcy_identity_badge_ttl_seconds = 901
    else:
        settings.agntcy_identity_node_url = "http://node.example.test"
    with pytest.raises(BadgePublicationError):
        await AgentBadgePublisher(settings).publish("primary", "primary", record)
    if change != "publish":
        assert state["published"] == []


async def test_disabled_has_no_network_or_file_access(monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError("must not access network or files")

    monkeypatch.setattr(agent_badges.Path, "read_text", fail)
    monkeypatch.setattr(agent_badges.httpx, "AsyncClient", fail)
    with pytest.raises(BadgePublicationError, match="disabled"):
        await AgentBadgePublisher(Settings(_env_file=None)).publish("primary", "primary", {})


def test_route_requires_admin_and_enabled_feature(setup):
    settings, record, state = setup
    app = FastAPI()
    app.include_router(badge_routes.router, prefix="/api/v1")
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_mongo_service] = lambda: SimpleNamespace(
        get_agent=lambda _id: SimpleNamespace(name="primary")
    )
    app.dependency_overrides[get_user_context] = lambda: UserContext(email="test-user@example.test", is_admin=False)
    with TestClient(app) as client:
        assert client.post("/api/v1/agents/primary/badge", json=record).status_code == 403
        assert state["calls"] == []
        app.dependency_overrides[get_user_context] = lambda: UserContext(email="test-user@example.test", is_admin=True)
        assert client.post("/api/v1/agents/primary/badge", json=record).status_code == 200
        settings.agntcy_identity_enabled = False
        assert client.post("/api/v1/agents/primary/badge", json=record).status_code == 404


@pytest.mark.parametrize("change", ["signature", "kid", "controller", "subject", "assertion"])
async def test_rejects_wrong_authority_evidence(setup, change):
    settings, record, state = setup
    if change == "signature":
        state["provider"] = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    elif change == "kid":
        state["jwks"][0]["kid"] = "unknown"
    elif change == "controller":
        state["controller"] = "other.example.test"
    elif change == "subject":
        state["subject"] = "IDP-secondary-sub"
    else:
        state["assertions"] = []
    with pytest.raises(BadgePublicationError):
        await AgentBadgePublisher(settings).publish("primary", "primary", record)
    assert state["published"] == []


@pytest.mark.parametrize("enabled", [False, True])
def test_application_mounts_publication_only_when_enabled(monkeypatch, enabled):
    from dynamic_agents import main
    monkeypatch.setattr(main, "get_settings", lambda: Settings(_env_file=None, agntcy_identity_enabled=enabled))
    paths = main.create_app().openapi()["paths"]
    assert ("/api/v1/agents/{agent_id}/badge" in paths) is enabled
