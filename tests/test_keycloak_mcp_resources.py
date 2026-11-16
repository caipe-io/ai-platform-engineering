"""MCP registration preserves other applications and recovers on upgrade retries."""

from __future__ import annotations

import copy
import importlib.util
import io
import json
import subprocess
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

import pytest
import yaml

CHART = Path(__file__).resolve().parents[1] / "charts/ai-platform-engineering/charts/keycloak"
SPEC = importlib.util.spec_from_file_location("mcp_resources", CHART / "scripts/mcp-resources.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
RESOURCES = [{"name": "primary", "resourceUrl": "https://tools.example.com/mcp", "scopes": {"tools:read": "Inspect permitted resources", "tools:exec": "Run permitted commands"}}]


class Issuer:
  def __init__(self) -> None:
    self.scopes = [{"id": "other", "name": "other:read", "attributes": {"custom": "preserve"}, "protocolMappers": [{"id": "other-mapper", "name": "existing", "config": {"included.custom.audience": "https://other.example.com/mcp"}}]}]
    self.optional = [self.scopes[0]]
    self.components = [
      {"id": "allowed", "providerId": "allowed-client-templates", "subType": "anonymous", "config": {"allowed-client-scopes": ["other:read"], "allow-default-scopes": ["false"]}},
      {"id": "hosts", "providerId": "trusted-hosts", "subType": "anonymous", "config": {"trusted-hosts": ["localhost"]}},
    ]
    self.documents = {"client-policies/profiles": {"profiles": [{"name": "existing-profile"}]}, "client-policies/policies": {"policies": [{"name": "existing-policy"}]}}
    self.writes = 0
    self.fail_mapper_once = False

  def __call__(self, path: str, method: str = "GET", data: Any = None) -> Any:
    if method != "GET":
      self.writes += 1
    result = self.route(path, method, copy.deepcopy(data))
    return copy.deepcopy(result)

  def route(self, path: str, method: str, data: Any) -> Any:
    if not path:
      return {"id": "example"}
    if path in self.documents:
      if method == "PUT":
        self.documents[path] = data
      return self.documents[path]
    if path.startswith("components"):
      if method == "POST":
        self.components.append({**data, "id": str(len(self.components))})
      elif method == "PUT":
        self.components[self.components.index(next(c for c in self.components if c["id"] == path.split("/")[1]))] = data
      return self.components
    if path == "client-scopes":
      if method == "POST":
        if any(s["name"] == data["name"] for s in self.scopes):
          raise HTTPError(path, 409, "already exists", None, None)
        self.scopes.append({**data, "id": str(len(self.scopes)), "protocolMappers": data.get("protocolMappers", [])})
      return self.scopes
    if path.startswith("default-optional-client-scopes"):
      if method == "PUT":
        self.optional.append(next(s for s in self.scopes if s["id"] == path.split("/")[1]))
      return self.optional
    parts = path.split("/")
    scope = next(s for s in self.scopes if s["id"] == parts[1])
    if len(parts) == 2 and method == "PUT":
      scope.update(data)
      return None
    if method == "POST":
      if self.fail_mapper_once:
        self.fail_mapper_once = False
        raise HTTPError(path, 503, "temporary outage", None, None)
      data["config"].setdefault("userinfo.token.claim", "false")
      scope["protocolMappers"].append({**data, "id": str(len(scope["protocolMappers"]))})
    elif method == "PUT":
      scope["protocolMappers"][int(parts[-1])] = data
    return scope["protocolMappers"]


def test_registration_preserves_other_resources_and_is_idempotent() -> None:
  issuer = Issuer()
  original_scope, original_hosts = copy.deepcopy(issuer.scopes[0]), copy.deepcopy(issuer.components[1])
  MODULE.reconcile(issuer, RESOURCES)
  assert issuer.scopes[0] == original_scope and issuer.components[1] == original_hosts
  assert issuer.components[0]["config"]["allow-default-scopes"] == ["false"]
  assert "other:read" in issuer.components[0]["config"]["allowed-client-scopes"]
  created = next(s for s in issuer.scopes if s["name"] == "tools:exec")
  assert created["attributes"]["consent.screen.text"] == "Run permitted commands"
  assert next(m for m in created["protocolMappers"] if m["name"] == "mcp-resource-audience")["config"]["included.custom.audience"] == RESOURCES[0]["resourceUrl"]
  writes = issuer.writes
  MODULE.reconcile(issuer, RESOURCES)
  assert issuer.writes == writes


def test_owned_scope_changes_are_reconciled_without_touching_other_mappers() -> None:
  issuer = Issuer()
  MODULE.reconcile(issuer, RESOURCES)
  owned = next(s for s in issuer.scopes if s["name"] == "tools:exec")
  custom_mapper = {"name": "operator-custom", "id": "operator", "config": {"example": "preserve"}}
  owned["protocolMappers"].append(copy.deepcopy(custom_mapper))
  changed = copy.deepcopy(RESOURCES)
  changed[0]["resourceUrl"] = "https://updated.example.com/mcp"
  changed[0]["scopes"]["tools:exec"] = "Updated command consent"
  MODULE.reconcile(issuer, changed)
  scope = next(s for s in issuer.scopes if s["name"] == "tools:exec")
  assert scope["description"] == "Updated command consent"
  assert scope["protocolMappers"][0]["config"]["included.custom.audience"] == changed[0]["resourceUrl"]
  assert scope["protocolMappers"][-1] == custom_mapper
  assert issuer.scopes[0]["protocolMappers"][0]["config"]["included.custom.audience"] == "https://other.example.com/mcp"


def test_multiple_resources_receive_separate_audiences() -> None:
  issuer = Issuer()
  secondary = {"name": "secondary", "resourceUrl": "https://secondary.example.com/mcp", "scopes": {"secondary:read": "Inspect secondary resources"}}
  MODULE.reconcile(issuer, [*RESOURCES, secondary])
  for resource in [*RESOURCES, secondary]:
    for name in resource["scopes"]:
      scope = next(s for s in issuer.scopes if s["name"] == name)
      assert scope["protocolMappers"][0]["config"]["included.custom.audience"] == resource["resourceUrl"]


def test_unmanaged_scope_collision_fails_before_writes() -> None:
  issuer = Issuer()
  requested = [{**RESOURCES[0], "scopes": {"other:read": "Conflicting scope"}}]
  with pytest.raises(ValueError, match="outside managed"):
    MODULE.reconcile(issuer, requested)
  assert issuer.writes == 0


def test_retry_recovers_partial_registration_without_duplicates() -> None:
  issuer = Issuer()
  issuer.fail_mapper_once = True
  with pytest.raises(HTTPError):
    MODULE.reconcile(issuer, RESOURCES)
  MODULE.reconcile(issuer, RESOURCES)
  assert len({s["name"] for s in issuer.scopes}) == len(issuer.scopes)
  for scope in issuer.scopes[1:3]:
    assert len(scope["protocolMappers"]) == 2


@pytest.mark.parametrize("resource", [{**RESOURCES[0], "resourceUrl": "http://tools.example.com/mcp"}, {**RESOURCES[0], "scopes": {"openid": "Reserved"}}, {**RESOURCES[0], "scopes": {"tools:read": ""}}])
def test_invalid_configuration_fails_before_writes(resource: dict[str, Any]) -> None:
  issuer = Issuer()
  with pytest.raises(ValueError):
    MODULE.reconcile(issuer, [resource])
  assert issuer.writes == 0


def test_empty_configuration_has_no_issuer_calls() -> None:
  def fail(*args: Any) -> None:
    pytest.fail("Empty configuration must not contact Keycloak")

  MODULE.reconcile(fail, [])


def test_local_issuer_job_is_wired_without_enabling_legacy_bootstrap() -> None:
  rendered = subprocess.check_output(["helm", "template", "example", str(CHART), "--set", "admin.secretRef=example-admin", "--set-json", "mcpResources=" + json.dumps(RESOURCES)], text=True)
  documents = [d for d in yaml.safe_load_all(rendered) if d]
  job = next(d for d in documents if d["kind"] == "Job" and d["metadata"]["name"].endswith("-init-idp"))
  environment = {e["name"]: e.get("value") for e in job["spec"]["template"]["spec"]["containers"][0]["env"]}
  assert json.loads(environment["MCP_RESOURCES_JSON"]) == RESOURCES
  assert environment["MCP_DCR_ENABLED"] == "false"
  assert job["metadata"]["annotations"]["helm.sh/hook"] == "post-install,post-upgrade"
  scripts = next(d for d in documents if d["kind"] == "ConfigMap" and "mcp-resources.py" in d.get("data", {}))
  assert "python3" in scripts["data"]["init-idp.sh"]


def test_pre_upgrade_hook_does_not_register_scopes_on_the_old_issuer() -> None:
  rendered = subprocess.check_output(
    ["helm", "template", "example", str(CHART), "--set", "admin.secretRef=example-admin", "--set", "idp.enabled=true", "--set", "idp.issuer=https://idp.example.com", "--set", "idp.clientId=primary", "--set", "idp.secretRef=example-idp", "--set-json", "mcpResources=" + json.dumps(RESOURCES)],
    text=True,
  )
  hook = next(d for d in yaml.safe_load_all(rendered) if d and d["kind"] == "Job" and d["metadata"]["name"].endswith("-auth-reconcile"))
  assert "MCP_RESOURCES_JSON" not in {e["name"] for e in hook["spec"]["template"]["spec"]["containers"][0]["env"]}


def test_registration_rejects_a_chart_pinned_to_the_old_issuer() -> None:
  result = subprocess.run(["helm", "template", "example", str(CHART), "--set", "admin.secretRef=example-admin", "--set", "image.tag=26.8.1", "--set-json", "mcpResources=" + json.dumps(RESOURCES)], text=True, capture_output=True, check=False)
  assert result.returncode != 0
  assert ">= 26.8.2" in result.stderr


def test_registration_rejects_a_running_old_issuer_before_configuration_calls(monkeypatch: pytest.MonkeyPatch) -> None:
  for name, value in {"MCP_RESOURCES_JSON": json.dumps(RESOURCES), "KC_URL": "https://idp.example.com", "KC_REALM": "example", "KEYCLOAK_ADMIN": "example-admin", "KEYCLOAK_ADMIN_PASSWORD": "example-password"}.items():
    monkeypatch.setenv(name, value)

  @contextmanager
  def response(request: Any, timeout: int) -> Any:
    if request.full_url.endswith("/realms/master/protocol/openid-connect/token"):
      yield io.BytesIO(json.dumps({"access_token": "example-token", "expires_in": 60}).encode())
    elif request.full_url.endswith("/admin/serverinfo"):
      yield io.BytesIO(json.dumps({"systemInfo": {"version": "26.8.1"}}).encode())
    else:
      pytest.fail("Old issuers must not receive configuration calls")

  monkeypatch.setattr(MODULE, "urlopen", response)
  with pytest.raises(ValueError, match="retry after its upgrade"):
    MODULE.main()


def test_resource_changes_do_not_restart_keycloak() -> None:
  templates = []
  for resources in (RESOURCES, [*RESOURCES, {"name": "secondary", "resourceUrl": "https://secondary.example.com/mcp", "scopes": {"secondary:access": "Use secondary resources"}}]):
    rendered = subprocess.check_output(["helm", "template", "example", str(CHART), "--set", "admin.secretRef=example-admin", "--set-json", "mcpResources=" + json.dumps(resources)], text=True)
    templates.append(next(d["spec"]["template"] for d in yaml.safe_load_all(rendered) if d and d["kind"] == "Deployment"))
  assert templates[0] == templates[1]
