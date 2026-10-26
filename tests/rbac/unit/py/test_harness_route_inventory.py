"""Offline inventory and bearer-only fixture contracts for Engine trust boundaries."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import jsonschema
import pytest
import yaml

from tests.rbac.fixtures.keycloak import PERSONAS, PersonaToken
from tests.rbac.unit.py import matrix_driver

ROOT = Path(__file__).resolve().parents[4]
SCHEMA = ROOT / "docs/docs/specs/102-comprehensive-rbac-tests-and-completion/contracts/rbac-matrix.schema.json"


@pytest.fixture
def validator():
    name = "_rbac_harness_validator"
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts/validate-rbac-matrix.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop(name, None)


def _routes():
    return yaml.safe_load((ROOT / "tests/rbac/rbac-matrix.yaml").read_text())["routes"]


def test_every_engine_and_da_resource_route_has_its_exact_auth_boundary(validator):
    sites = validator.find_harness_route_sites()
    declared = {(row["surface"], row["method"], row["path"]): row for row in _routes()}
    assert sites
    for identity, (authorization, where) in sites.items():
        assert identity in declared, where
        assert declared[identity]["authorization_system"] == authorization, where
    assert ("harness_engine", "GET", "/healthz") not in sites
    git = "/api/v1/runs/{run_id}/git/github.com/{owner}/{repository}/{operation:path}"
    assert sites[("harness_engine", "GET", git)][0] == "run_capability"
    assert sites[("harness_engine", "POST", git)][0] == "run_capability"


def test_harness_inventory_detects_new_routes_including_both_api_route_methods(validator, tmp_path, monkeypatch):
    relative = "ai_platform_engineering/harness_engine/src/harness_engine/coding/routes.py"
    path = tmp_path / relative
    path.parent.mkdir(parents=True)
    path.write_text(
        '@app.post("/api/v1/new-interaction")\n'
        'async def new_interaction(): pass\n'
        '@app.api_route("/api/v1/new-git", methods=["GET", "POST"])\n'
        'async def git_proxy(): pass\n'
    )
    monkeypatch.setattr(validator, "REPO_ROOT", tmp_path)
    assert {identity: auth for identity, (auth, _) in validator.find_harness_route_sites().items()} == {
        ("harness_engine", "POST", "/api/v1/new-interaction"): "internal",
        ("harness_engine", "GET", "/api/v1/new-git"): "run_capability",
        ("harness_engine", "POST", "/api/v1/new-git"): "run_capability",
    }


@pytest.mark.parametrize("declared_authorization", [None, "keycloak", "internal"])
def test_strict_linter_rejects_missing_or_mislabelled_harness_routes(
    validator, tmp_path, monkeypatch, capsys, declared_authorization
):
    path = tmp_path / "ai_platform_engineering/harness_engine/src/harness_engine/main.py"
    path.parent.mkdir(parents=True)
    path.write_text('@app.get("/api/v1/new-route")\nasync def new_route(): pass\n')
    row = {
        "id": "engine-new-route",
        "surface": "harness_engine",
        "method": "GET",
        "path": "/api/v1/new-route",
        "resource": "harness_run",
        "scope": "read",
        "authorization_system": declared_authorization,
        "expectations": {persona: {"status": 401, "reason": "DENY_INVALID_TOKEN"} for persona in PERSONAS},
    }
    monkeypatch.setattr(validator, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(validator, "MATRIX_PATH", tmp_path / "matrix.yaml")
    monkeypatch.setattr(validator, "load_realm_resources", lambda: {"other_realm_resource"})
    monkeypatch.setattr(validator, "load_matrix", lambda: {"version": 1, "routes": [row] if declared_authorization else []})
    monkeypatch.setattr(sys, "argv", ["validate-rbac-matrix.py"])
    result = validator.main()
    if declared_authorization == "internal":
        assert result == 0  # Internal resources do not pretend to be realm resources.
    else:
        assert result == 1
        assert "missing_in_matrix" in capsys.readouterr().err


def test_da_inventory_reads_the_router_prefix(validator, tmp_path, monkeypatch):
    path = tmp_path / "ai_platform_engineering/dynamic_agents/src/dynamic_agents/routes/harness_resources.py"
    path.parent.mkdir(parents=True)
    path.write_text(
        'router = APIRouter(prefix="/harness-resources")\n'
        '@router.post("/{run_id}/calls/{request_id}")\n'
        'async def platform_call(): pass\n'
    )
    monkeypatch.setattr(validator, "REPO_ROOT", tmp_path)
    sites = validator.find_harness_route_sites()
    assert sites[("dynamic_agents", "POST", "/api/v1/harness-resources/{run_id}/calls/{request_id}")][0] == "openfga"


@pytest.mark.parametrize("authorization", ["internal", "run_capability"])
def test_internal_and_capability_rows_deny_all_six_bearer_only_personas(authorization, validator):
    rows = [row for row in _routes() if row.get("authorization_system") == authorization]
    assert rows
    schema = json.loads(SCHEMA.read_text())
    for row in rows:
        assert set(row["expectations"]) == set(PERSONAS)
        assert all(item["status"] in {401, 403} and "skip_reason" not in item for item in row["expectations"].values())
        jsonschema.validate({"version": 1, "routes": [row]}, schema)
    row = json.loads(json.dumps(rows[0]))
    row["expectations"]["alice_admin"]["status"] = 200
    assert any("bearer-only alice_admin" in item.message for item in validator.validate_schema_shape({"version": 1, "routes": [row]}))
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"version": 1, "routes": [row]}, schema)


def test_capabilities_cannot_be_mislabelled_as_openfga_or_keycloak(validator):
    row = next(row for row in _routes() if row.get("authorization_system") == "run_capability")
    row = {**row, "relation": "can_use", "object_type": "agent"}
    assert any("must not declare an OpenFGA relation" in item.message for item in validator.validate_schema_shape({"version": 1, "routes": [row]}))
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"version": 1, "routes": [row]}, json.loads(SCHEMA.read_text()))


def test_driver_sends_only_persona_bearer_and_requires_explicit_engine_url(monkeypatch):
    monkeypatch.delenv("E2E_HARNESS_ENGINE_URL", raising=False)
    row = next(row for row in matrix_driver.expand_matrix() if row.authorization_system == "internal")
    token = PersonaToken("persona-token", "", {}, 0)
    with pytest.raises(pytest.skip.Exception, match="E2E_HARNESS_ENGINE_URL"):
        matrix_driver._build_request(row, token)
    monkeypatch.setenv("E2E_HARNESS_ENGINE_URL", "http://engine.test/")
    request = matrix_driver._build_request(row, token)
    assert request["headers"] == {"Authorization": "Bearer persona-token"}
    assert request["url"].startswith("http://engine.test/api/v1/")
    assert not any(key in request["headers"] for key in ("X-Harness-Engine-Subject", "X-CAIPE-Harness-Capability", "X-Harness-Producer"))


def test_da_rows_state_all_owner_use_and_producer_requirements():
    rows = [row for row in _routes() if row["id"].startswith("dynamic-agents-harness-resources-")]
    assert len(rows) == 2
    for row in rows:
        assert row["authorization_system"] == "openfga"
        assert row["relation"] == "can_use" and row["object_type"] == "agent"
        assert all(term in row["notes"] for term in ("middleware-verified", "owner", "CAS", "producer", "lease"))
        assert all("live owner OBO" in value["skip_reason"] for value in row["expectations"].values())
        assert row["expectations"]["frank_service_account"]["status"] == 403
