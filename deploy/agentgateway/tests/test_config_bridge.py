# assisted-by Codex Codex-sonnet-4-6

"""Tests for dynamic AgentGateway MCP config reconciliation."""

from __future__ import annotations

import copy
import importlib.util
import io
import json
import stat
import sys
import urllib.error
from pathlib import Path

import yaml
import pytest


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "config_bridge.py"
spec = importlib.util.spec_from_file_location("agentgateway_config_bridge", BRIDGE_PATH)
assert spec is not None and spec.loader is not None
bridge = importlib.util.module_from_spec(spec)
sys.modules["agentgateway_config_bridge"] = bridge
spec.loader.exec_module(bridge)


def _baseline_config() -> dict:
    return {
        "binds": [
            {
                "port": 4000,
                "listeners": [
                    {
                        "protocol": "HTTP",
                        "policies": {
                            "jwtAuth": {
                                "mode": "strict",
                                "issuer": "http://localhost:7080/realms/caipe",
                                "audiences": ["caipe-platform", "agentgateway"],
                                "jwks": {
                                    "url": "http://keycloak:7080/realms/caipe/protocol/openid-connect/certs"
                                },
                            }
                        },
                        "routes": [
                            {
                                "matches": [{"path": {"pathPrefix": "/mcp/rag"}}],
                                "policies": bridge.DEFAULT_MCP_ROUTE_POLICIES,
                                "backends": [
                                    {
                                        "mcp": {
                                            "targets": [
                                                {
                                                    "name": "rag",
                                                    "mcp": {"host": "http://rag-server:9446/mcp"},
                                                }
                                            ]
                                        }
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ],
        "config": {
            "adminAddr": "0.0.0.0:15000",
            "logging": {"level": "debug", "format": "json"},
        },
    }


def test_select_gateway_targets_uses_enabled_network_rows() -> None:
    targets = bridge.select_gateway_targets(
        [
            {
                "_id": "knowledge-base",
                "enabled": True,
                "transport": "http",
                "source": "agentgateway",
                "agentgateway_target_endpoint": "http://rag-server:9446/mcp",
                "credential_sources": [
                    {
                        "kind": "caller_token",
                        "target": "header",
                        "name": "X-CAIPE-Provider-Token",
                    }
                ],
            },
            {
                "_id": "disabled-target",
                "enabled": False,
                "transport": "http",
                "source": "agentgateway",
                "agentgateway_target_endpoint": "http://disabled:8000/mcp",
            },
            {
                "_id": "manual-target",
                "enabled": True,
                "transport": "http",
                "source": "manual",
                "endpoint": "http://mcp-manual:8000/mcp",
            },
            {
                "_id": "gateway-loop",
                "enabled": True,
                "transport": "http",
                "source": "manual",
                "endpoint": "http://agentgateway:4000/mcp/gateway-loop",
            },
            {
                "_id": "stdio-target",
                "enabled": True,
                "transport": "stdio",
                "source": "manual",
                "command": "node",
            },
            {
                "_id": "bad target",
                "enabled": True,
                "transport": "http",
                "source": "agentgateway",
                "agentgateway_target_endpoint": "http://bad:8000/mcp",
            },
            {
                "_id": "missing-upstream",
                "enabled": True,
                "transport": "http",
                "source": "agentgateway",
            },
        ]
    )

    assert targets == [
        bridge.McpGatewayTarget(
            id="knowledge-base",
            upstream_url="http://rag-server:9446/mcp",
            credential_sources=(
                {
                    "kind": "caller_token",
                    "target": "header",
                    "name": "X-CAIPE-Provider-Token",
                },
            ),
        ),
        bridge.McpGatewayTarget(
            id="manual-target",
            upstream_url="http://mcp-manual:8000/mcp",
            credential_sources=(),
        ),
    ]


def test_load_targets_from_bff_fetches_internal_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("AGENTGATEWAY_TARGETS_URL", "http://caipe-ui:3000/api/internal/agentgateway/mcp-targets")
    monkeypatch.setenv("AGENTGATEWAY_TARGETS_TOKEN", "bridge-token")
    captured: dict[str, object] = {}

    class Response(io.BytesIO):
        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> Response:
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["authorization"] = request.get_header("Authorization")
        return Response(
            json.dumps(
                {
                    "targets": [
                        {
                            "id": "knowledge-base",
                            "target_endpoint": "http://rag-server:9446/mcp",
                            "credential_sources": [
                                {
                                    "kind": "caller_token",
                                    "target": "header",
                                    "name": "X-CAIPE-Provider-Token",
                                }
                            ],
                        }
                    ]
                }
            ).encode("utf-8")
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    targets = bridge._load_targets_from_bff()

    assert captured == {
        "url": "http://caipe-ui:3000/api/internal/agentgateway/mcp-targets",
        "timeout": 5.0,
        "authorization": "Bearer bridge-token",
    }
    assert targets == [
        bridge.McpGatewayTarget(
            id="knowledge-base",
            upstream_url="http://rag-server:9446/mcp",
            credential_sources=(
                {
                    "kind": "caller_token",
                    "target": "header",
                    "name": "X-CAIPE-Provider-Token",
                },
            ),
        )
    ]


def test_merge_agentgateway_mcp_routes_adds_missing_route_without_mutating_baseline() -> None:
    baseline = _baseline_config()
    original = copy.deepcopy(baseline)

    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [
            bridge.McpGatewayTarget(
                id="knowledge-base",
                upstream_url="http://rag-server:9446/mcp",
                credential_sources=(
                    {
                        "kind": "caller_token",
                        "target": "header",
                        "name": "X-CAIPE-Provider-Token",
                        "fallback_client_credentials": True,
                    },
                ),
            )
        ],
    )

    assert baseline == original
    routes = rendered["binds"][0]["listeners"][0]["routes"]
    route_paths = [route["matches"][0]["path"]["pathPrefix"] for route in routes]
    # The baseline's /mcp/rag route is not in the desired set, so it is pruned;
    # only the desired knowledge-base route remains (reconciler owns /mcp/* routes).
    assert route_paths == ["/mcp/knowledge-base"]
    assert routes[0]["backends"][0]["mcp"]["targets"][0] == {
        "name": "knowledge-base",
        "mcp": {"host": "http://rag-server:9446/mcp"},
    }
    # knowledge-base carries the per-request provider-token transform (RAG OIDC),
    # shallow-merged onto the shared default route policies.
    assert routes[0]["policies"] == {
        **bridge.DEFAULT_MCP_ROUTE_POLICIES,
        **bridge.PROVIDER_TOKEN_BEARER_TRANSFORM,
    }


def test_merge_agentgateway_mcp_routes_prunes_removed_targets_and_keeps_non_mcp() -> None:
    # Baseline has two managed MCP routes (rag + jira) plus a non-MCP route.
    baseline = _baseline_config()
    listener_routes = baseline["binds"][0]["listeners"][0]["routes"]
    listener_routes.append(
        {
            "matches": [{"path": {"pathPrefix": "/mcp/jira"}}],
            "policies": bridge.DEFAULT_MCP_ROUTE_POLICIES,
            "backends": [
                {"mcp": {"targets": [{"name": "jira", "mcp": {"host": "http://mcp-jira:8000/mcp"}}]}}
            ],
        }
    )
    listener_routes.append({"matches": [{"path": {"pathPrefix": "/healthz"}}], "backends": []})

    # Desired set keeps only jira → /mcp/rag must be pruned, /healthz must survive.
    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [bridge.McpGatewayTarget(id="jira", upstream_url="http://mcp-jira:8000/mcp")],
    )

    routes = rendered["binds"][0]["listeners"][0]["routes"]
    route_paths = [route["matches"][0]["path"]["pathPrefix"] for route in routes]
    assert "/mcp/rag" not in route_paths
    assert "/mcp/jira" in route_paths
    assert "/healthz" in route_paths  # non-MCP routes are never pruned


def test_merge_agentgateway_mcp_routes_replaces_stale_route_target() -> None:
    baseline = _baseline_config()
    baseline["binds"][0]["listeners"][0]["routes"].append(
        {
            "matches": [{"path": {"pathPrefix": "/mcp/knowledge-base"}}],
            "policies": bridge.DEFAULT_MCP_ROUTE_POLICIES,
            "backends": [
                {
                    "mcp": {
                        "targets": [
                            {
                                "name": "knowledge-base",
                                "mcp": {"host": "http://old-rag:9446/mcp"},
                            }
                        ]
                    }
                }
            ],
        }
    )

    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [
            bridge.McpGatewayTarget(
                id="knowledge-base",
                upstream_url="http://rag-server:9446/mcp",
            )
        ],
    )

    routes = rendered["binds"][0]["listeners"][0]["routes"]
    matching_routes = [
        route
        for route in routes
        if route["matches"][0]["path"]["pathPrefix"] == "/mcp/knowledge-base"
    ]
    assert len(matching_routes) == 1
    assert matching_routes[0]["backends"][0]["mcp"]["targets"][0]["mcp"]["host"] == (
        "http://rag-server:9446/mcp"
    )


def test_merge_agentgateway_mcp_routes_drops_stale_backend_auth_for_transform_servers() -> None:
    # GitHub/GitLab moved from a static backendAuth PAT to a per-request
    # transformation. A stale backendAuth preserved from the live config must be
    # dropped so callers authenticate with their own (or the org fallback) token.
    baseline = _baseline_config()
    baseline["binds"][0]["listeners"][0]["routes"].append(
        {
            "matches": [{"path": {"pathPrefix": "/mcp/github"}}],
            "policies": bridge.DEFAULT_MCP_ROUTE_POLICIES,
            "backends": [
                {
                    "mcp": {
                        "targets": [
                            {
                                "name": "github",
                                "mcp": {"host": "http://old-github:8082/mcp"},
                                "policies": {
                                    "backendAuth": {
                                        "key": "$GITHUB_PERSONAL_ACCESS_TOKEN",
                                    },
                                },
                            }
                        ]
                    }
                }
            ],
        }
    )

    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [
            bridge.McpGatewayTarget(
                id="github",
                upstream_url="http://github-mcp-server:8082/mcp",
                credential_sources=(
                    {
                        "kind": "provider_connection",
                        "target": "header",
                        "name": "X-CAIPE-Provider-Token",
                        "provider": "github",
                    },
                ),
            )
        ],
    )
    route = next(
        route
        for route in rendered["binds"][0]["listeners"][0]["routes"]
        if route["matches"][0]["path"]["pathPrefix"] == "/mcp/github"
    )
    target = route["backends"][0]["mcp"]["targets"][0]
    assert target["mcp"]["host"] == "http://github-mcp-server:8082/mcp"
    assert "policies" not in target
    transform = route["policies"]["transformations"]["request"]["set"]
    assert transform["authorization"] == (
        '"Bearer " + default(request.headers["x-caipe-provider-token"], "")'
    )
    assert "extAuthz" in route["policies"]
    assert "authorization" in route["policies"]


def test_merge_agentgateway_mcp_routes_applies_provider_token_transform() -> None:
    baseline = _baseline_config()

    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [
            bridge.McpGatewayTarget(
                id="gitlab",
                upstream_url="http://mcp-gitlab:8000/mcp",
                credential_sources=(
                    {
                        "kind": "provider_connection",
                        "target": "header",
                        "name": "X-CAIPE-Provider-Token",
                        "provider": "gitlab",
                    },
                ),
            )
        ],
    )

    route = next(
        route
        for route in rendered["binds"][0]["listeners"][0]["routes"]
        if route["matches"][0]["path"]["pathPrefix"] == "/mcp/gitlab"
    )
    target = route["backends"][0]["mcp"]["targets"][0]
    assert "policies" not in target
    transform = route["policies"]["transformations"]["request"]["set"]
    assert transform["authorization"] == (
        '"Bearer " + default(request.headers["x-caipe-provider-token"], "")'
    )
    assert transform["x-caipe-provider-token"] == (
        'default(request.headers["x-caipe-provider-token"], "")'
    )
    # The per-route transform override must NOT drop the base extAuthz body
    # forwarding (#36) — it's only shallow-merged on top, so includeRequestBody
    # is inherited and the caller-keyed per-tool check still works on this route.
    assert route["policies"]["extAuthz"]["includeRequestBody"] == {
        "maxRequestBytes": 65536,
        "allowPartialMessage": False,
        "packAsBytes": True,
    }


def test_default_mcp_route_policies_forward_request_body() -> None:
    # #36: the bridge can only run the caller-keyed per-tool check if the gateway
    # forwards the request body. Lock the policy shape so a future edit can't
    # silently drop it. packAsBytes -> CheckRequest.http.raw_body (read first by
    # the bridge); allowPartialMessage False so json.loads sees a complete body.
    ext_authz = bridge.DEFAULT_MCP_ROUTE_POLICIES["extAuthz"]
    assert ext_authz["includeRequestBody"] == {
        "maxRequestBytes": 65536,
        "allowPartialMessage": False,
        "packAsBytes": True,
    }


def test_default_ext_authz_host_defaults_to_compose_service() -> None:
    # The default matches the Docker Compose service name so local dev keeps
    # working with no extra env. The Helm chart overrides it (see below).
    assert bridge.DEFAULT_MCP_ROUTE_POLICIES["extAuthz"]["host"] == "openfga-authz-bridge:9100"


def test_ext_authz_host_honors_env_override(monkeypatch) -> None:
    # Regression: in a release-name-prefixed Helm deploy the authz bridge is
    # `<release>-openfga-authz-bridge`. The bare default resolves to nothing, so
    # the fail-closed `denyWithStatus: 403` rejected every discovered-server MCP
    # call. The chart now passes AGENTGATEWAY_AUTHZ_HOST; the module must read it.
    monkeypatch.setenv("AGENTGATEWAY_AUTHZ_HOST", "caipe-openfga-authz-bridge:9100")
    module_name = "agentgateway_config_bridge_reload"
    spec = importlib.util.spec_from_file_location(module_name, BRIDGE_PATH)
    assert spec is not None and spec.loader is not None
    reloaded = importlib.util.module_from_spec(spec)
    # Register before exec so the module's dataclasses can resolve cls.__module__.
    sys.modules[module_name] = reloaded
    try:
        spec.loader.exec_module(reloaded)
        assert (
            reloaded.DEFAULT_MCP_ROUTE_POLICIES["extAuthz"]["host"]
            == "caipe-openfga-authz-bridge:9100"
        )
    finally:
        sys.modules.pop(module_name, None)


def test_merge_agentgateway_mcp_routes_applies_knowledge_base_transform() -> None:
    # knowledge-base (RAG) enforces its own OIDC auth, so the bridge must apply the
    # same X-CAIPE-Provider-Token -> Authorization rewrite used by github/gitlab.
    baseline = _baseline_config()

    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [
            bridge.McpGatewayTarget(
                id="knowledge-base",
                upstream_url="http://rag-server:9446/mcp",
                credential_sources=(
                    {
                        "kind": "caller_token",
                        "target": "header",
                        "name": "X-CAIPE-Provider-Token",
                        "fallback_client_credentials": True,
                    },
                ),
            )
        ],
    )

    route = next(
        route
        for route in rendered["binds"][0]["listeners"][0]["routes"]
        if route["matches"][0]["path"]["pathPrefix"] == "/mcp/knowledge-base"
    )
    transform = route["policies"]["transformations"]["request"]["set"]
    assert transform["authorization"] == (
        '"Bearer " + default(request.headers["x-caipe-provider-token"], "")'
    )


def test_merge_agentgateway_mcp_routes_uses_header_credential_sources() -> None:
    baseline = _baseline_config()

    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [
            bridge.McpGatewayTarget(
                id="custom-docs",
                upstream_url="http://custom-docs:8080/mcp",
                credential_sources=(
                    {
                        "kind": "secret_ref",
                        "target": "header",
                        "name": "X-API-Key",
                        "secret_ref": "cred-custom-docs",
                    },
                ),
            )
        ],
    )

    route = next(
        route
        for route in rendered["binds"][0]["listeners"][0]["routes"]
        if route["matches"][0]["path"]["pathPrefix"] == "/mcp/custom-docs"
    )
    transform = route["policies"]["transformations"]["request"]["set"]
    assert transform["x-api-key"] == 'default(request.headers["x-api-key"], "")'
    assert "secret_ref" not in str(route)
    assert "cred-custom-docs" not in str(route)


def test_scheduler_route_forwards_opaque_caller_token_header() -> None:
    rendered = bridge.merge_agentgateway_mcp_routes(
        _baseline_config(),
        [
            bridge.McpGatewayTarget(
                id="scheduler",
                upstream_url="http://mcp-scheduler:8000/mcp",
                credential_sources=(
                    {
                        "kind": "caller_token",
                        "target": "header",
                        "name": "X-CAIPE-Caller-Token",
                    },
                ),
            )
        ],
    )

    route = next(
        route
        for route in rendered["binds"][0]["listeners"][0]["routes"]
        if route["matches"][0]["path"]["pathPrefix"] == "/mcp/scheduler"
    )
    transform = route["policies"]["transformations"]["request"]["set"]
    assert transform["x-caipe-caller-token"] == (
        'default(request.headers["x-caipe-caller-token"], "")'
    )
    assert "authorization" not in transform


def test_merge_agentgateway_mcp_routes_skips_credential_transforms_when_cleared() -> None:
    baseline = _baseline_config()
    builtins = {
        "jira": {
            "matches": [{"path": {"pathPrefix": "/mcp/jira"}}],
            "policies": copy.deepcopy(bridge.DEFAULT_MCP_ROUTE_POLICY_OVERRIDES["jira"])
            | copy.deepcopy(bridge.DEFAULT_MCP_ROUTE_POLICIES),
            "backends": [{"mcp": {"targets": [{"name": "jira", "mcp": {"host": "http://mcp-jira:8000/mcp"}}]}}],
        }
    }

    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [bridge.McpGatewayTarget(id="jira", upstream_url="http://mcp-jira:8000/mcp")],
        builtin_routes=builtins,
    )

    route = next(
        route
        for route in rendered["binds"][0]["listeners"][0]["routes"]
        if route["matches"][0]["path"]["pathPrefix"] == "/mcp/jira"
    )
    assert "transformations" not in route["policies"]
    assert "extAuthz" in route["policies"]


def test_merge_agentgateway_mcp_routes_skips_dynamic_credential_transforms_when_cleared() -> None:
    baseline = _baseline_config()

    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [
            bridge.McpGatewayTarget(
                id="custom-jira",
                upstream_url="http://custom-jira:8000/mcp",
            )
        ],
    )

    route = next(
        route
        for route in rendered["binds"][0]["listeners"][0]["routes"]
        if route["matches"][0]["path"]["pathPrefix"] == "/mcp/custom-jira"
    )
    assert "transformations" not in route.get("policies", {})
    assert "extAuthz" in route["policies"]


def test_merge_agentgateway_mcp_routes_uses_provider_token_source_for_authorization() -> None:
    baseline = _baseline_config()

    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [
            bridge.McpGatewayTarget(
                id="custom-github",
                upstream_url="http://custom-github:8080/mcp",
                credential_sources=(
                    {
                        "kind": "provider_connection",
                        "target": "header",
                        "name": "X-CAIPE-Provider-Token",
                        "provider": "github",
                    },
                ),
            )
        ],
    )

    route = next(
        route
        for route in rendered["binds"][0]["listeners"][0]["routes"]
        if route["matches"][0]["path"]["pathPrefix"] == "/mcp/custom-github"
    )
    transform = route["policies"]["transformations"]["request"]["set"]
    assert transform["authorization"] == (
        '"Bearer " + default(request.headers["x-caipe-provider-token"], "")'
    )
    assert "provider_connection" not in str(route)


def test_write_config_atomically_publishes_agentgateway_readable_file(tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"

    changed = bridge.write_config_atomically(config_path, _baseline_config())

    mode = stat.S_IMODE(config_path.stat().st_mode)
    assert changed is True
    assert mode == 0o644


def test_write_config_atomically_repairs_existing_unreadable_file(tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    bridge.write_config_atomically(config_path, _baseline_config())
    config_path.chmod(0o600)

    changed = bridge.write_config_atomically(config_path, _baseline_config())

    mode = stat.S_IMODE(config_path.stat().st_mode)
    assert changed is False
    assert mode == 0o644


def test_ensure_published_config_mode_skips_existing_readable_file(
    tmp_path: Path, monkeypatch
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text('{"binds": []}\n', encoding="utf-8")
    config_path.chmod(0o644)

    def fail_chmod(_self: Path, _mode: int) -> None:
        raise AssertionError("chmod should not run when mode is already correct")

    monkeypatch.setattr(type(config_path), "chmod", fail_chmod)

    assert bridge._ensure_published_config_mode(config_path) is False


def test_seed_config_from_bootstrap_publishes_agentgateway_readable_file(tmp_path: Path) -> None:
    config_path = tmp_path / "generated" / "config.yaml"
    bootstrap_path = tmp_path / "bootstrap.yaml"
    bootstrap_path.write_text('{"binds": []}\n', encoding="utf-8")

    changed = bridge.seed_config_from_bootstrap(config_path, bootstrap_path)

    mode = stat.S_IMODE(config_path.stat().st_mode)
    assert changed is True
    assert mode == 0o644


SHIPPED_CONFIG_PATH = BRIDGE_PATH.parent / "config.yaml"


def _builtin_route(server_id: str, host: str) -> dict:
    return {
        "matches": [{"path": {"pathPrefix": f"/mcp/{server_id}"}}],
        "policies": copy.deepcopy(bridge.DEFAULT_MCP_ROUTE_POLICIES),
        "backends": [{"mcp": {"targets": [{"name": server_id, "mcp": {"host": host}}]}}],
    }


def test_load_builtin_mcp_routes_parses_shipped_config() -> None:
    builtins = bridge.load_builtin_mcp_routes(SHIPPED_CONFIG_PATH)

    # Every shipped /mcp/<id> route must be recognised as a protected built-in.
    assert {"argocd", "confluence", "gitlab", "jira", "knowledge-base", "slack"} <= set(builtins)
    assert "github" not in builtins
    # gitlab carries its per-request provider-token transform straight from the
    # bootstrap definition (YAML anchors/aliases resolved by the parser).
    gitlab = builtins["gitlab"]
    assert gitlab["policies"]["transformations"]["request"]["set"]["authorization"] == (
        '"Bearer " + default(request.headers["x-caipe-provider-token"], "")'
    )
    jira = builtins["jira"]
    jira_transform = jira["policies"]["transformations"]["request"]["set"]
    assert jira_transform["authorization"] == (
        '"Bearer " + default(request.headers["x-caipe-provider-token"], "")'
    )
    assert jira_transform["x-caipe-provider-token"] == (
        'default(request.headers["x-caipe-provider-token"], "")'
    )
    confluence = builtins["confluence"]
    confluence_transform = confluence["policies"]["transformations"]["request"]["set"]
    assert confluence_transform["authorization"] == jira_transform["authorization"]
    assert confluence_transform["x-caipe-provider-token"] == jira_transform["x-caipe-provider-token"]


def test_load_builtin_mcp_routes_missing_path_returns_empty() -> None:
    assert bridge.load_builtin_mcp_routes(None) == {}
    assert bridge.load_builtin_mcp_routes(Path("/does/not/exist.yaml")) == {}


# #36 (FR-012/SC-010): the caller-keyed (and agent→tool) per-tool checks only run
# when the bridge receives the HTTP request body, which requires the extAuthz
# policy's `includeRequestBody`. Built-in routes are re-rendered from the
# bootstrap config.yaml definition (NOT from DEFAULT_MCP_ROUTE_POLICIES), so a
# bare bootstrap route would silently ship without body-forwarding. The earlier
# static-file-only test missed exactly this — testing-manager found 5 builtin
# routes bare in the LIVE GENERATED config. This asserts against the GENERATED
# output (what config-bridge actually writes) for every shipped built-in.
EXPECTED_INCLUDE_REQUEST_BODY = {
    "maxRequestBytes": 65536,
    "allowPartialMessage": False,
    "packAsBytes": True,
}

# The rbac/outshift host-specific variant feeds the chart/prod gateway and repeats
# the same builtin routes — assert generated parity there too (#36).
RBAC_CONFIG_PATH = BRIDGE_PATH.parent / "config.caipe-rbac.yaml"


@pytest.mark.parametrize(
    "config_path", [SHIPPED_CONFIG_PATH, RBAC_CONFIG_PATH], ids=["config", "caipe-rbac"]
)
def test_generated_config_forwards_request_body_on_every_builtin_route(config_path: Path) -> None:
    import yaml

    baseline = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    builtins = bridge.load_builtin_mcp_routes(config_path)
    assert builtins, f"expected built-in MCP routes from {config_path.name}"

    # No dynamic BFF targets — exercises the builtin re-render path
    # (config_bridge deep-copies builtins verbatim from bootstrap, bypassing
    # DEFAULT_MCP_ROUTE_POLICIES), which is where the 5 bare routes were found in
    # the live (stale) container.
    rendered = bridge.merge_agentgateway_mcp_routes(baseline, [], builtin_routes=builtins)
    routes = rendered["binds"][0]["listeners"][0]["routes"]

    mcp_routes = [
        route
        for route in routes
        if isinstance(route, dict)
        and route.get("matches", [{}])[0].get("path", {}).get("pathPrefix", "").startswith("/mcp/")
    ]
    assert mcp_routes, f"expected /mcp/* routes in the generated config from {config_path.name}"

    missing = []
    for route in mcp_routes:
        path = route["matches"][0]["path"]["pathPrefix"]
        ext_authz = route.get("policies", {}).get("extAuthz")
        body_opts = ext_authz.get("includeRequestBody") if isinstance(ext_authz, dict) else None
        if body_opts != EXPECTED_INCLUDE_REQUEST_BODY:
            missing.append((path, body_opts))

    assert not missing, (
        f"generated config from {config_path.name} has /mcp/* routes missing "
        f"includeRequestBody — the per-tool caller-keyed check would be skipped on these: {missing}"
    )
    # Belt-and-suspenders: the specific servers testing-manager flagged.
    rendered_paths = {r["matches"][0]["path"]["pathPrefix"] for r in mcp_routes}
    for sid in ("sharepoint", "slack", "splunk", "victorops", "webex", "knowledge-base"):
        assert f"/mcp/{sid}" in rendered_paths, (
            f"/mcp/{sid} missing from generated config ({config_path.name})"
        )


def test_merge_preserves_builtin_routes_when_dynamic_targets_empty() -> None:
    # Empty dynamic targets must NOT wipe the shipped built-in routes — this is
    # the regression that left AgentGateway serving zero MCP routes.
    builtins = {
        "jira": _builtin_route("jira", "http://mcp-jira:8000/mcp"),
        "github": _builtin_route("github", "http://github-mcp-server:8082/mcp"),
    }
    baseline = _baseline_config()  # baseline only has /mcp/rag (a dynamic route)

    rendered = bridge.merge_agentgateway_mcp_routes(baseline, [], builtin_routes=builtins)

    routes = rendered["binds"][0]["listeners"][0]["routes"]
    paths = {route["matches"][0]["path"]["pathPrefix"] for route in routes}
    assert "/mcp/jira" in paths
    assert "/mcp/github" in paths
    assert "/mcp/rag" not in paths  # dynamic route absent from the BFF payload is still pruned


def test_merge_restores_builtin_even_when_baseline_lost_it() -> None:
    # Baseline (live config) has already been wiped down to no routes, but the
    # built-in must come back from its bootstrap definition.
    builtins = {"argocd": _builtin_route("argocd", "http://mcp-argocd:8000/mcp")}
    baseline = _baseline_config()
    baseline["binds"][0]["listeners"][0]["routes"] = []

    rendered = bridge.merge_agentgateway_mcp_routes(baseline, [], builtin_routes=builtins)

    routes = rendered["binds"][0]["listeners"][0]["routes"]
    argocd = next(r for r in routes if r["matches"][0]["path"]["pathPrefix"] == "/mcp/argocd")
    assert argocd["backends"][0]["mcp"]["targets"][0]["mcp"]["host"] == "http://mcp-argocd:8000/mcp"


def test_merge_dynamic_target_defers_to_builtin_definition() -> None:
    # A dynamic target sharing an id with a built-in must not produce a duplicate route;
    # the authoritative bootstrap definition wins.
    builtins = {"jira": _builtin_route("jira", "http://mcp-jira:8000/mcp")}
    baseline = _baseline_config()
    baseline["binds"][0]["listeners"][0]["routes"] = []

    rendered = bridge.merge_agentgateway_mcp_routes(
        baseline,
        [bridge.McpGatewayTarget(id="jira", upstream_url="http://rogue-jira:9999/mcp")],
        builtin_routes=builtins,
    )

    routes = rendered["binds"][0]["listeners"][0]["routes"]
    jira_routes = [r for r in routes if r["matches"][0]["path"]["pathPrefix"] == "/mcp/jira"]
    assert len(jira_routes) == 1
    assert jira_routes[0]["backends"][0]["mcp"]["targets"][0]["mcp"]["host"] == (
        "http://mcp-jira:8000/mcp"
    )


def test_reconcile_keeps_existing_config_when_admin_config_is_unavailable(
    tmp_path: Path, monkeypatch
) -> None:
    config_path = tmp_path / "generated" / "config.yaml"
    config_path.parent.mkdir()
    existing_config = '{"binds":[{"listeners":[{"routes":[{"matches":[{"path":{"pathPrefix":"/mcp/github"}}],"backends":[{"mcp":{"targets":[{"name":"github","policies":{"backendAuth":{"key":"$GITHUB_PERSONAL_ACCESS_TOKEN"}}}]}}]}]}]}]}\n'
    config_path.write_text(existing_config, encoding="utf-8")

    monkeypatch.setattr(bridge, "_load_targets", lambda: [])

    def fail_fetch(_admin_config_url: str) -> dict:
        raise urllib.error.URLError("agentgateway admin unavailable")

    monkeypatch.setattr(bridge, "fetch_agentgateway_config", fail_fetch)

    result = bridge.reconcile_once(
        config_path=config_path,
        admin_config_url="http://agentgateway:15000/config",
    )

    assert result["skipped"] is True
    assert result["reason"] == "admin_unavailable"
    assert config_path.read_text(encoding="utf-8") == existing_config
    assert bridge._reconcile_ok_path(config_path).is_file()


def test_seed_config_from_bootstrap_marks_reconcile_ok(tmp_path: Path) -> None:
    config_path = tmp_path / "generated" / "config.yaml"
    bootstrap_path = tmp_path / "bootstrap.yaml"
    bootstrap_path.write_text('{"binds": []}\n', encoding="utf-8")

    changed = bridge.seed_config_from_bootstrap(config_path, bootstrap_path)

    assert changed is True
    assert bridge._reconcile_ok_path(config_path).is_file()


def test_apply_agentgateway_logging_defaults_to_info() -> None:
    config = _baseline_config()
    assert config["config"]["logging"]["level"] == "debug"

    bridge.apply_agentgateway_logging(config)

    assert config["config"]["logging"]["level"] == "info"
    assert config["config"]["logging"]["format"] == "json"


def test_apply_agentgateway_logging_honors_env(monkeypatch) -> None:
    monkeypatch.setenv("AGENTGATEWAY_LOG_LEVEL", "warn")
    config = _baseline_config()

    bridge.apply_agentgateway_logging(config)

    assert config["config"]["logging"]["level"] == "warn"


def test_reconcile_once_enforces_logging_level(tmp_path: Path, monkeypatch) -> None:
    config_path = tmp_path / "generated" / "config.yaml"
    config_path.parent.mkdir()
    config_path.write_text("binds: []\n", encoding="utf-8")

    monkeypatch.setattr(bridge, "_load_targets", lambda: [])
    monkeypatch.setattr(
        bridge,
        "fetch_agentgateway_config",
        lambda _admin_config_url: _baseline_config(),
    )

    bridge.reconcile_once(config_path=config_path, admin_config_url="http://agentgateway:15000/config")

    rendered = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert rendered["config"]["logging"]["level"] == "info"
