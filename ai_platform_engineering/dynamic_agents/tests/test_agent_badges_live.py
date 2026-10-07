"""Opt-in check against a disposable, pre-enrolled Keycloak and Identity Node.

Set AGNTCY_BADGE_LIVE_SETTINGS to a Settings JSON file. No production defaults.
The file points to mounted secret/binding files for the fixture agent `primary`.
"""

import json
import os
from pathlib import Path
from types import SimpleNamespace

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from fastapi import FastAPI
from fastapi.testclient import TestClient

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import UserContext
from dynamic_agents.routes import agent_badges as badge_routes
from dynamic_agents.services.mongo import get_mongo_service


@pytest.mark.skipif(not os.getenv("AGNTCY_BADGE_LIVE_SETTINGS"), reason="requires disposable live identity services")
def test_live_keycloak_agent_badge_publication():
    settings = Settings(_env_file=None, **json.loads(Path(os.environ["AGNTCY_BADGE_LIVE_SETTINGS"]).read_text()))
    binding = json.loads(Path(settings.agntcy_identity_bindings_file).read_text())["primary"]
    record = {
        "name": "primary",
        "version": "1.0.0",
        "schema_version": "1.0.0",
        "description": "Example public agent definition",
        "authors": ["test-user@example.test"],
        "created_at": "2026-01-01T00:00:00Z",
        "annotations": {"agntcy.dir/identity": f"agntcy://{binding['subject']}"},
    }
    app = FastAPI()
    app.include_router(badge_routes.router, prefix="/api/v1")
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_mongo_service] = lambda: SimpleNamespace(
        get_agent=lambda _id: SimpleNamespace(name="primary")
    )
    app.dependency_overrides[get_user_context] = lambda: UserContext(email="test-user@example.test", is_admin=True)
    with TestClient(app) as client:
        response = client.post("/api/v1/agents/primary/badge", json=record)
        assert response.status_code == 200, response.text
        receipt = response.json()
    badges = httpx.get(receipt["badges_url"], timeout=15).json()["vcs"]
    private = serialization.load_pem_private_key(
        Path(settings.agntcy_identity_signing_key_file).read_bytes(), password=None
    )
    badge = next(
        item
        for item in badges
        if jwt.decode(item["value"], private.public_key(), algorithms=["RS256"])["id"] == receipt["credential_id"]
    )
    credential = jwt.decode(badge["value"], private.public_key(), algorithms=["RS256"])
    assert credential["credentialSubject"] == {"id": binding["subject"], "badge": record}
    assert credential["expirationDate"] == receipt["expires_at"]
    assert (
        httpx.post(f"{settings.agntcy_identity_node_url}/v1alpha1/vc/verify", json={"vc": badge}, timeout=15).json()[
            "status"
        ]
        is True
    )
    # Same payload with a valid signature from an unauthorized key is rejected.
    from cryptography.hazmat.primitives.asymmetric import rsa

    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    altered = {
        "envelopeType": badge["envelopeType"],
        "value": jwt.encode(
            credential,
            wrong_key,
            algorithm="RS256",
            headers={"kid": settings.agntcy_identity_signing_key_id, "typ": "JOSE"},
        ),
    }
    assert (
        httpx.post(f"{settings.agntcy_identity_node_url}/v1alpha1/vc/verify", json={"vc": altered}, timeout=15).json()[
            "status"
        ]
        is False
    )
