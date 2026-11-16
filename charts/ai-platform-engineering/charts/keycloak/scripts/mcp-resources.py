"""Register declared MCP scopes without rewriting other clients or audiences."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from collections.abc import Callable
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

OWNER = "caipe.mcp.resource"
POLICY_TYPE = "org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy"


def validate(resources: Any) -> list[dict[str, Any]]:
  if not isinstance(resources, list):
    raise ValueError("mcpResources must be a list")
  names, scopes = set(), set()
  for resource in resources:
    if not isinstance(resource, dict):
      raise ValueError("Each MCP resource must be an object")
    name, resource_url, declared = resource.get("name"), resource.get("resourceUrl"), resource.get("scopes")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", name) or name in names:
      raise ValueError("MCP resource names must be unique lowercase identifiers")
    if not isinstance(resource_url, str):
      raise ValueError(f"MCP resource {name} requires an HTTPS URL")
    url = urlsplit(resource_url)
    if any(c.isspace() for c in resource_url) or url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
      raise ValueError(f"MCP resource {name} requires an HTTPS URL without credentials, query or fragment")
    if not isinstance(declared, dict) or not declared:
      raise ValueError(f"MCP resource {name} requires a scope-to-consent-text map")
    for scope, consent in declared.items():
      if not isinstance(scope, str) or scope in {"openid", "basic", "profile", "email", "roles", "groups", "org", "offline_access", "kc-admin-api"} or not re.fullmatch(r"[A-Za-z0-9:._/-]{1,80}", scope) or scope in scopes or not isinstance(consent, str) or not consent.strip():
        raise ValueError("MCP scopes must be unique and have non-empty consent text")
      scopes.add(scope)
    names.add(name)
  return resources


def ensure_registration_policies(api: Callable[..., Any]) -> None:
  components = api("components?type=" + POLICY_TYPE)
  for provider, context in (("consent-required", "anonymous"), ("scope", "anonymous"), ("scope", "authenticated"), ("default-roles", "anonymous"), ("default-roles", "authenticated")):
    if not any(item.get("providerId") == provider and item.get("subType") == context for item in components):
      api("components", "POST", {"name": provider, "providerId": provider, "providerType": POLICY_TYPE, "parentId": api("")["id"], "subType": context, "config": {}})
  # These policies apply to new anonymous public registrations only.
  profile = {"name": "mcp-resources-pkce", "executors": [{"executor": "pkce-enforcer", "configuration": {"auto-configure": True}}]}
  policy = {
    "name": "mcp-resources-public-pkce",
    "enabled": True,
    "conditions": [{"condition": "client-updater-context", "configuration": {"update-client-source": ["ByAnonymous"]}}, {"condition": "client-type", "configuration": {"protocol": "openid-connect"}}, {"condition": "client-access-type", "configuration": {"type": ["public"]}}],
    "profiles": [profile["name"]],
  }
  for endpoint, key, item in (("client-policies/profiles", "profiles", profile), ("client-policies/policies", "policies", policy)):
    current = api(endpoint).get(key, [])
    managed = next((entry for entry in current if entry["name"] == item["name"]), None)
    if managed is None:
      api(endpoint, "PUT", {key: [*current, item]})
    elif any(managed.get(field) != value for field, value in item.items()):
      raise ValueError(f"Existing {item['name']} differs; review its policy before changing it")


def reconcile(api: Callable[..., Any], resources: list[dict[str, Any]]) -> None:
  resources = validate(resources)
  if not resources:
    return
  existing = {scope["name"]: scope for scope in api("client-scopes")}
  for resource in resources:
    for name in resource["scopes"]:
      if name in existing and (existing[name].get("attributes") or {}).get(OWNER) != resource["name"]:
        raise ValueError(f"Scope {name} already exists outside managed MCP resource {resource['name']}; no scopes changed")
  ensure_registration_policies(api)
  for resource in resources:
    for name, consent in resource["scopes"].items():
      scope = existing.get(name)
      attributes = {**((scope or {}).get("attributes") or {}), OWNER: resource["name"], "include.in.token.scope": "true", "display.on.consent.screen": "true", "consent.screen.text": consent}
      desired = {"name": name, "protocol": "openid-connect", "description": consent, "attributes": attributes}
      if scope is None:
        try:
          api("client-scopes", "POST", desired)
        except HTTPError as exc:
          if exc.code != 409:
            raise
        scope = next(item for item in api("client-scopes") if item["name"] == name)
        if (scope.get("attributes") or {}).get(OWNER) != resource["name"]:
          raise ValueError(f"Scope {name} was concurrently registered by another owner")
      elif any(scope.get(key) != value for key, value in desired.items()):
        api(f"client-scopes/{scope['id']}", "PUT", desired)
      path = f"client-scopes/{scope['id']}/protocol-mappers/models"
      mappers = api(path)
      desired_mappers = [
        {
          "name": "mcp-resource-audience",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {"included.custom.audience": resource["resourceUrl"], "access.token.claim": "true", "id.token.claim": "false", "introspection.token.claim": "true", "userinfo.token.claim": "false"},
        },
        {
          "name": "mcp-email-verified",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-property-mapper",
          "config": {"user.attribute": "emailVerified", "claim.name": "email_verified", "jsonType.label": "boolean", "access.token.claim": "true", "id.token.claim": "false", "introspection.token.claim": "true", "userinfo.token.claim": "false"},
        },
      ]
      for mapper in desired_mappers:
        current = next((item for item in mappers if item["name"] == mapper["name"]), None)
        if current is None:
          api(path, "POST", mapper)
        elif any(current.get(key) != value for key, value in mapper.items()):
          api(f"{path}/{current['id']}", "PUT", {**mapper, "id": current["id"]})
      optional = api("default-optional-client-scopes")
      if not any(item["id"] == scope["id"] for item in optional):
        api(f"default-optional-client-scopes/{scope['id']}", "PUT")

  # Persisted hand-authored realms may predate Keycloak's basic DCR scope.
  if "basic" not in existing:
    api(
      "client-scopes",
      "POST",
      {
        "name": "basic",
        "protocol": "openid-connect",
        "attributes": {"include.in.token.scope": "false", "display.on.consent.screen": "false"},
        "protocolMappers": [
          {"name": "sub", "protocol": "openid-connect", "protocolMapper": "oidc-sub-mapper", "config": {"access.token.claim": "true", "introspection.token.claim": "true"}},
          {
            "name": "auth_time",
            "protocol": "openid-connect",
            "protocolMapper": "oidc-usersessionmodel-note-mapper",
            "config": {"user.session.note": "AUTH_TIME", "claim.name": "auth_time", "jsonType.label": "long", "access.token.claim": "true", "id.token.claim": "true", "introspection.token.claim": "true"},
          },
        ],
      },
    )
  components = api("components?type=" + POLICY_TYPE)
  policy = next((item for item in components if item.get("providerId") == "allowed-client-templates" and item.get("subType") == "anonymous"), None)
  desired = json.loads(json.dumps(policy)) if policy else {"name": "Allowed Client Scopes", "providerId": "allowed-client-templates", "providerType": POLICY_TYPE, "parentId": api("")["id"], "subType": "anonymous", "config": {"allow-default-scopes": ["true"]}}
  allowed = desired["config"].setdefault("allowed-client-scopes", [])
  for name in ["basic", "openid", "profile", "email", *(scope for resource in resources for scope in resource["scopes"])]:
    if name not in allowed:
      allowed.append(name)
  if desired != policy:
    api(f"components/{policy['id']}" if policy else "components", "PUT" if policy else "POST", desired)


def main() -> None:
  resources = validate(json.loads(os.environ.get("MCP_RESOURCES_JSON", "[]")))
  if not resources:
    return
  realm = os.environ.get("KC_REALM", "caipe")
  if not re.fullmatch(r"[A-Za-z0-9_-]+", realm):
    raise ValueError("Invalid Keycloak realm name")
  base = os.environ["KC_URL"].rstrip("/")
  parsed_base = urlsplit(base)
  if parsed_base.scheme not in {"http", "https"} or not parsed_base.hostname or parsed_base.username or parsed_base.password or parsed_base.query or parsed_base.fragment:
    raise ValueError("KC_URL must be an HTTP(S) URL without credentials, query or fragment")
  access_token, renew_at = "", 0.0

  def api(path: str, method: str = "GET", data: Any = None) -> Any:
    nonlocal access_token, renew_at
    if time.monotonic() >= renew_at:
      form = urlencode({"grant_type": "password", "client_id": "admin-cli", "username": os.environ["KEYCLOAK_ADMIN"], "password": os.environ["KEYCLOAK_ADMIN_PASSWORD"]}).encode()
      with urlopen(Request(base + "/realms/master/protocol/openid-connect/token", data=form), timeout=20) as response:
        token = json.load(response)
      access_token, renew_at = token["access_token"], time.monotonic() + max(1, token.get("expires_in", 60) - 15)
    headers = {"Authorization": "Bearer " + access_token, "Content-Type": "application/json"}
    url = base + "/admin/serverinfo" if path == "/serverinfo" else f"{base}/admin/realms/{realm}/{path}"
    request = Request(url, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
    with urlopen(request, timeout=20) as response:
      body = response.read()
      return json.loads(body) if body else None

  version = api("/serverinfo")["systemInfo"]["version"]
  match = re.match(r"^(\d+)\.(\d+)\.(\d+)", version)
  if not match or tuple(map(int, match.groups())) < (26, 8, 2):
    raise ValueError("MCP registration requires a running Keycloak 26.8.2 or newer; retry after its upgrade completes")
  reconcile(api, resources)
  print(f"[init-idp] Registered {len(resources)} declared MCP resource(s)")


if __name__ == "__main__":
  try:
    main()
  except HTTPError as exc:
    print(f"MCP resource registration failed: Keycloak HTTP {exc.code}; retry the initializer after checking issuer readiness", file=sys.stderr)
    sys.exit(1)
  except (ValueError, KeyError, URLError, TimeoutError) as exc:
    print(f"MCP resource registration failed: {exc}", file=sys.stderr)
    sys.exit(1)
