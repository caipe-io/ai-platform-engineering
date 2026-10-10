"""Debug mode cannot create a user or promote a gateway user to admin."""

import base64
import json
from typing import Annotated, Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from dynamic_agents.auth.auth import get_current_user, get_user_context, require_admin
from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import UserContext


@pytest.fixture(params=[False, True], ids=["normal", "debug"])
def client(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    debug = request.param
    monkeypatch.setenv("DEBUG", "true" if debug else "false")
    app = FastAPI()
    app.dependency_overrides[get_settings] = lambda: Settings.model_construct(debug=debug)

    # Exercise the dependency directly so JWT middleware cannot mask a regression.
    @app.get("/context")
    async def context(user: Annotated[UserContext, Depends(get_user_context)]) -> dict[str, Any]:
        return user.model_dump()

    @app.get("/current")
    async def current(user: Annotated[UserContext, Depends(get_current_user)]) -> dict[str, Any]:
        return user.model_dump()

    @app.get("/admin")
    async def admin(user: Annotated[UserContext, Depends(require_admin)]) -> dict[str, str]:
        return {"email": user.email}

    return TestClient(app)


def _header(**fields: Any) -> dict[str, str]:
    payload = {"email": "test-user@example.test", "name": "Test User", **fields}
    return {"X-User-Context": base64.b64encode(json.dumps(payload).encode()).decode()}


@pytest.mark.parametrize("headers", [{}, {"X-User-Context": ""}])
def test_missing_context_requires_authentication(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/context", headers=headers)
    assert response.status_code == 401
    assert "Missing X-User-Context" in response.json()["detail"]


@pytest.mark.parametrize(
    "payload",
    ["not-base64", base64.b64encode(b"not-json").decode(), base64.b64encode(b"{}").decode()],
)
def test_malformed_context_is_rejected(client: TestClient, payload: str) -> None:
    response = client.get("/context", headers={"X-User-Context": payload})
    assert response.status_code == 400
    assert response.json()["detail"] == "Malformed X-User-Context header"


@pytest.mark.parametrize("path", ["/context", "/current"])
def test_gateway_user_is_preserved_without_elevation(client: TestClient, path: str) -> None:
    response = client.get(
        path, headers=_header(sub="test-subject", is_admin=False, can_view_admin=False, groups=["test-group"])
    )
    assert response.status_code == 200
    context = response.json()
    assert context["email"] == "test-user@example.test"
    assert context["name"] == "Test User"
    assert context["sub"] == "test-subject"
    assert context["is_admin"] is False
    assert context["can_view_admin"] is False
    assert context["groups"] == ["test-group"]


def test_non_admin_cannot_access_admin_endpoint(client: TestClient) -> None:
    response = client.get("/admin", headers=_header(is_admin=False))
    assert response.status_code == 403
    assert response.json()["detail"] == "Admin role required"


def test_gateway_admin_can_access_admin_endpoint(client: TestClient) -> None:
    response = client.get("/admin", headers=_header(is_admin=True))
    assert response.status_code == 200
    assert response.json() == {"email": "test-user@example.test"}


def test_missing_context_cannot_access_admin_endpoint(client: TestClient) -> None:
    response = client.get("/admin")
    assert response.status_code == 401
