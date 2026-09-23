# assisted-by Codex Codex-sonnet-4-6

"""Regression tests for the checked-in standalone AgentGateway config."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml


CONFIG_PATH = Path(__file__).resolve().parents[1] / "config.yaml"
# The rbac/outshift host-specific variant repeats the same extAuthz wiring and is
# a live deployment config — it must forward the request body too (#36 parity).
RBAC_CONFIG_PATH = Path(__file__).resolve().parents[1] / "config.caipe-rbac.yaml"


PROVIDER_TOKEN_TRANSFORM = (
    '"Bearer " + default(request.headers["x-caipe-provider-token"], "")'
)


def _mcp_route(config: dict[str, Any], server_id: str) -> dict[str, Any]:
    routes = config["binds"][0]["listeners"][0]["routes"]
    return next(
        route
        for route in routes
        if route["matches"][0]["path"]["pathPrefix"] == f"/mcp/{server_id}"
    )


def _mcp_target(config: dict[str, Any], server_id: str) -> dict[str, Any]:
    return _mcp_route(config, server_id)["backends"][0]["mcp"]["targets"][0]


def test_github_route_rewrites_provider_token_to_authorization() -> None:
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))

    route = _mcp_route(config, "github")
    target = _mcp_target(config, "github")

    # No static PAT on the backend anymore; auth comes from the route-level
    # transformation reading X-CAIPE-Provider-Token.
    assert "policies" not in target
    transform = route["policies"]["transformations"]["request"]["set"]
    assert transform["authorization"] == PROVIDER_TOKEN_TRANSFORM
    assert "extAuthz" in route["policies"]
    assert "authorization" in route["policies"]


def test_gitlab_route_rewrites_provider_token_to_authorization() -> None:
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))

    route = _mcp_route(config, "gitlab")
    target = _mcp_target(config, "gitlab")

    assert "policies" not in target
    transform = route["policies"]["transformations"]["request"]["set"]
    assert transform["authorization"] == PROVIDER_TOKEN_TRANSFORM
    assert "extAuthz" in route["policies"]
    assert "authorization" in route["policies"]


def test_knowledge_base_route_rewrites_provider_token_to_authorization() -> None:
    # The RAG server enforces its own OIDC auth, so the knowledge-base route must
    # rewrite the user-JWT/service-token (X-CAIPE-Provider-Token) into Authorization.
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))

    route = _mcp_route(config, "knowledge-base")
    transform = route["policies"]["transformations"]["request"]["set"]
    assert transform["authorization"] == PROVIDER_TOKEN_TRANSFORM
    assert "extAuthz" in route["policies"]
    assert "authorization" in route["policies"]


@pytest.mark.parametrize("config_path", [CONFIG_PATH, RBAC_CONFIG_PATH], ids=["config", "caipe-rbac"])
def test_platform_route_uses_standard_authz_and_preserves_initiator_header(config_path: Path) -> None:
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    route = _mcp_route(config, "platform")
    target = _mcp_target(config, "platform")

    assert target["mcp"]["host"] == "http://mcp-platform:8000/mcp"
    assert "extAuthz" in route["policies"]
    assert "transformations" not in route["policies"]


# #36 (FR-012/SC-010): every MCP route's extAuthz MUST forward the HTTP request
# body to the OpenFGA bridge, or the caller-keyed per-tool check never runs (the
# bridge can't see the JSON-RPC tools/call name) and every MCP call silently
# passes on the coarse mcp_gateway:list check alone. This guards against the
# wiring regressing — especially on the inlined blocks that don't use the
# &mcpAuthzPolicy anchor (github/gitlab/knowledge-base).
EXPECTED_INCLUDE_REQUEST_BODY = {
    "maxRequestBytes": 65536,
    "allowPartialMessage": False,
    "packAsBytes": True,
}


# #49 (FR-011 SA invoke / FR-012 caller-keyed): AgentGateway's jwtAuth consumes
# the bearer and doesn't forward it to ext_authz, so the bridge detects service
# accounts from the `caipe.auth` gRPC metadata. The metadata expression MUST
# carry preferred_username (not just sub) or every SA is mis-graphed as user:.
@pytest.mark.parametrize("config_path", [CONFIG_PATH, RBAC_CONFIG_PATH], ids=["config", "caipe-rbac"])
def test_every_mcp_route_passes_preferred_username_in_metadata(config_path: Path) -> None:
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    routes = config["binds"][0]["listeners"][0]["routes"]
    mcp_routes = [
        route
        for route in routes
        if isinstance(route, dict)
        and route.get("matches", [{}])[0].get("path", {}).get("pathPrefix", "").startswith("/mcp/")
    ]
    assert mcp_routes, f"expected /mcp/* routes in {config_path.name}"
    for route in mcp_routes:
        path = route["matches"][0]["path"]["pathPrefix"]
        meta = route["policies"]["extAuthz"]["protocol"]["grpc"]["metadata"]["caipe.auth"]
        assert "jwt.preferred_username" in meta, (
            f"{config_path.name} {path}: caipe.auth metadata is missing preferred_username "
            f"— the bridge cannot detect service accounts: {meta}"
        )
        assert "jwt.sub" in meta, f"{config_path.name} {path}: caipe.auth metadata lost sub: {meta}"


@pytest.mark.parametrize("config_path", [CONFIG_PATH, RBAC_CONFIG_PATH], ids=["config", "caipe-rbac"])
def test_every_mcp_route_extauthz_forwards_request_body(config_path: Path) -> None:
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    routes = config["binds"][0]["listeners"][0]["routes"]

    mcp_routes = [
        route
        for route in routes
        if route.get("matches", [{}])[0].get("path", {}).get("pathPrefix", "").startswith("/mcp/")
    ]
    assert mcp_routes, "expected at least one /mcp/* route"

    for route in mcp_routes:
        ext_authz = route["policies"].get("extAuthz")
        assert ext_authz is not None, (
            f"route {route['matches'][0]['path']['pathPrefix']} has no extAuthz policy"
        )
        body_opts = ext_authz.get("includeRequestBody")
        assert body_opts == EXPECTED_INCLUDE_REQUEST_BODY, (
            f"route {route['matches'][0]['path']['pathPrefix']} extAuthz is missing or has "
            f"the wrong includeRequestBody (caller-keyed per-tool check would be skipped): {body_opts}"
        )
