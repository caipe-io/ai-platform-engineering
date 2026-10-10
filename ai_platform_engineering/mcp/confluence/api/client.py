"""Atlassian Confluence API client

This module provides a client for interacting with the Confluence API.
It handles authentication, request formatting, and response parsing.

Authentication modes:
- Bearer (OAuth 2.0): used when X-CAIPE-Provider-Token is forwarded by the
  agentgateway. Requests are routed to the Atlassian API gateway
  (https://api.atlassian.com/ex/confluence/<cloudId>). No static email needed.
- Basic: used when a static ATLASSIAN_TOKEN / CONFLUENCE_API_TOKEN env var is
  configured. Requires ATLASSIAN_EMAIL to form the Basic auth credential.
"""

# assisted-by claude code claude-sonnet-4-6

import asyncio
import base64
import hashlib
import logging
import os
import time
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv
from mcp_agent_auth.token import get_request_token

# Load environment variables
load_dotenv()

# Atlassian 3LO OAuth access tokens (delivered via the CAIPE credential exchange
# on X-CAIPE-Provider-Token) must target the Atlassian API gateway rather than
# the site URL. Static API tokens (Basic auth) continue to target the site URL.
ATLASSIAN_OAUTH_GATEWAY = "https://api.atlassian.com"
ATLASSIAN_ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources"
# Cache resolved cloud ids per access token so we do not call accessible-resources
# on every tool invocation. Keyed by a sha256 of the token; short TTL bounds drift.
_CLOUD_ID_CACHE: Dict[str, Tuple[str, float]] = {}
_CLOUD_ID_CACHE_TTL_S = 600.0

# Configure logging
log_level = os.getenv("LOG_LEVEL", "INFO").upper()
numeric_level = getattr(logging, log_level, logging.INFO)
logging.basicConfig(
    level=numeric_level,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger("confluence_mcp")


def get_provider_header_token() -> Optional[str]:
    """Retrieve a CAIPE exchanged provider token without consuming the MCP auth JWT."""
    try:
        from fastmcp.server.dependencies import get_http_request

        req = get_http_request()
        token = req.headers.get("x-caipe-provider-token", "").strip()
        return token or None
    except RuntimeError:
        # No active HTTP request (STDIO mode).
        return None


def _request_has_caipe_provider_header() -> bool:
    """True when AgentGateway forwarded the provider-token route (value may be empty)."""
    try:
        from fastmcp.server.dependencies import get_http_request

        req = get_http_request()
        return "x-caipe-provider-token" in req.headers
    except RuntimeError:
        return False


def _caipe_provider_oauth_required() -> bool:
    """Return True when caller OAuth is required but no exchanged token was forwarded."""
    if get_provider_header_token():
        return False
    return _request_has_caipe_provider_header()


def get_env() -> Optional[str]:
    """Retrieve the Atlassian API token from request header or environment."""
    token = (
        get_request_token("ATLASSIAN_TOKEN")
        or get_request_token("ATLASSIAN_API_TOKEN")
        or get_request_token("CONFLUENCE_API_TOKEN")
        or get_request_token("CONFLUENCE_TOKEN")
    )
    if not token:
        for env_name in ("ATLASSIAN_TOKEN", "ATLASSIAN_API_TOKEN", "CONFLUENCE_API_TOKEN", "CONFLUENCE_TOKEN"):
            env_token = os.getenv(env_name)
            if env_token:
                return env_token
    if not token:
        logger.warning("ATLASSIAN_TOKEN is not set and no Authorization header provided.")
    return token


def _is_atlassian_gateway_url(url: str) -> bool:
    """Return True when url already targets the Atlassian API gateway."""
    return (urlparse(url).hostname or "").lower() == "api.atlassian.com"


def validate_prerequisites(
    token: Optional[str] = None,
) -> Tuple[bool, Dict[str, Any]]:
    """Validate required Confluence credentials and determine auth scheme."""
    provider_header_token = get_provider_header_token()
    caipe_gateway_caller = _caipe_provider_oauth_required() and not token

    if caipe_gateway_caller:
        logger.error(
            "Caller-scoped Atlassian OAuth required but X-CAIPE-Provider-Token is missing."
        )
        return (
            False,
            {
                "error": (
                    "Atlassian account not connected. Connect Atlassian in CAIPE Credentials, "
                    "then start a new chat."
                )
            },
        )

    resolved_token = token or provider_header_token
    if not resolved_token:
        resolved_token = get_env()

    auth_scheme = "bearer" if provider_header_token and not token else "basic"

    if not resolved_token:
        logger.error("No API token available. Request cannot proceed.")
        return (
            False,
            {"error": "Token is required. Please set the ATLASSIAN_TOKEN environment variable."},
        )

    resolved_url = str(
        os.getenv("CONFLUENCE_API_URL") or os.getenv("ATLASSIAN_API_URL") or os.getenv("CONFLUENCE_URL") or ""
    )
    if not resolved_url:
        logger.error("No Confluence API URL available. Request cannot proceed.")
        return (
            False,
            {
                "error": (
                    "CONFLUENCE_API_URL is required. Please set the CONFLUENCE_API_URL "
                    "environment variable (e.g., https://your-domain.atlassian.net)."
                )
            },
        )

    if auth_scheme == "basic":
        resolved_email = str(
            os.getenv("ATLASSIAN_EMAIL") or os.getenv("CONFLUENCE_EMAIL")
            or os.getenv("CONFLUENCE_USER") or os.getenv("CONFLUENCE_USERNAME") or ""
        )
        if not resolved_email:
            logger.error("No email available for Basic auth. Request cannot proceed.")
            return (
                False,
                {"error": "ATLASSIAN_EMAIL is required. Please set the ATLASSIAN_EMAIL environment variable."},
            )
    else:
        resolved_email = ""

    return True, {
        "token": resolved_token,
        "email": resolved_email,
        "url": resolved_url,
        "auth_scheme": auth_scheme,
    }


async def resolve_oauth_base_url(token: str, timeout: int = 10, site_url: str = "") -> Optional[str]:
    """Resolve the Atlassian API gateway base URL for an OAuth (provider) token.

    Atlassian 3LO access tokens must be used against
    ``https://api.atlassian.com/ex/confluence/<cloudId>`` rather than the site URL.
    The cloud id is read from an explicit ``ATLASSIAN_OAUTH_CLOUD_ID`` override
    when set, otherwise resolved from the accessible-resources endpoint and
    cached per token.

    Match the configured site rather than selecting an arbitrary accessible
    site. Returns ``None`` when resolution is unavailable or ambiguous.
    """
    explicit_cloud_id = os.getenv("ATLASSIAN_OAUTH_CLOUD_ID")
    if explicit_cloud_id:
        return f"{ATLASSIAN_OAUTH_GATEWAY}/ex/confluence/{explicit_cloud_id}"

    site_host = urlparse(site_url).hostname
    cache_key = hashlib.sha256(f"{token}:{site_host or ''}".encode()).hexdigest()
    cached = _CLOUD_ID_CACHE.get(cache_key)
    now = time.monotonic()
    if cached and cached[1] > now:
        return f"{ATLASSIAN_OAUTH_GATEWAY}/ex/confluence/{cached[0]}"

    try:
        async with httpx.AsyncClient(timeout=timeout) as resolver_client:
            response = await resolver_client.get(
                ATLASSIAN_ACCESSIBLE_RESOURCES_URL,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
    except httpx.RequestError as exc:
        logger.error(f"confluence: failed to resolve Atlassian cloud id: {exc}")
        return None

    if response.status_code != 200:
        logger.error(
            "confluence: accessible-resources returned %s; cannot resolve cloud id for the OAuth token",
            response.status_code,
        )
        return None

    try:
        resources = response.json()
    except ValueError:
        logger.error("confluence: accessible-resources response was not valid JSON")
        return None

    if not isinstance(resources, list) or not resources:
        logger.error("confluence: OAuth token has no accessible Atlassian sites (empty accessible-resources)")
        return None

    candidates = [r for r in resources if isinstance(r, dict) and r.get("id")]
    if site_host:
        candidates = [r for r in candidates if urlparse(str(r.get("url", ""))).hostname == site_host]
    cloud_ids = {str(resource["id"]) for resource in candidates}
    if len(cloud_ids) != 1:
        logger.error("confluence: cannot unambiguously resolve the configured site")
        return None
    cloud_id = cloud_ids.pop()
    if not cloud_id:
        logger.error("confluence: accessible-resources entry missing an id")
        return None

    _CLOUD_ID_CACHE[cache_key] = (cloud_id, now + _CLOUD_ID_CACHE_TTL_S)
    return f"{ATLASSIAN_OAUTH_GATEWAY}/ex/confluence/{cloud_id}"


def api_request_url(base_url: str, path: str) -> str:
    """Normalize site/gateway prefixes without dropping the Confluence wiki route."""
    parsed = urlparse(base_url)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("Configure an absolute Confluence site or API base URL")
    if urlparse(path).scheme or path.startswith("//") or ".." in path.split("/"):
        raise ValueError("API path must be relative to the configured Confluence site")
    root = base_url.rstrip("/")
    # Preserve an explicitly configured Server/Data Center REST context.
    context = "" if root.endswith("/rest/api") and not root.endswith("/wiki/rest/api") and not _is_atlassian_gateway_url(root) else "/wiki"
    for suffix in ("/wiki/rest/api", "/wiki/api/v2", "/rest/api", "/api/v2", "/wiki"):
        if root.endswith(suffix):
            root = root[:-len(suffix)]
            break
    clean_path = path.lstrip("/")
    if clean_path.startswith("wiki/"):
        return f"{root}/{clean_path}"
    if clean_path.startswith(("rest/api/", "api/v2/")):
        return f"{root}{context}/{clean_path}"
    return f"{root}{context}/rest/api/{clean_path}"


def response_error(status: int) -> Dict[str, Any]:
    """Classify provider errors without treating them as successful reads."""
    codes = {401: "authentication_or_scope", 403: "permission_denied", 404: "not_found_or_restricted", 410: "retired_endpoint", 429: "rate_limited"}
    actions = {
        401: "Verify the API route and token grants, then reconnect Confluence if needed. A browser session does not authenticate this connector.",
        403: "Verify the connected user's space/page permission and the app's granted scopes.",
        404: "Verify the page ID and visibility for the connected user; absence cannot be distinguished from restriction.",
        410: "Use the supported CQL search with body expansion for page reads.",
    }
    return {
        "error": f"Confluence request failed (HTTP {status})",
        "code": codes.get(status, "upstream_error"),
        "status": status,
        "retryable": status in {429, 502, 503, 504},
        "action": actions.get(status, "Retry the read after the provider recovers."),
    }


async def make_api_request(
    path: str,
    method: str = "GET",
    token: Optional[str] = None,
    params: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None,
    timeout: int = 30,
) -> Tuple[bool, Dict[str, Any]]:
    """Request JSON using caller credentials; retry safe reads only."""
    ok, prerequisites = validate_prerequisites(token=token)
    if not ok:
        return False, prerequisites
    resolved_token = str(prerequisites["token"])
    url = str(prerequisites["url"])
    auth_scheme = str(prerequisites.get("auth_scheme") or "basic")
    if auth_scheme == "bearer" and not _is_atlassian_gateway_url(url):
        gateway = await resolve_oauth_base_url(resolved_token, timeout=timeout, site_url=url)
        if not gateway:
            return False, {"error": "Cannot resolve the configured Confluence site for this OAuth connection", "code": "site_resolution", "retryable": False}
        url = gateway
    try:
        request_url = api_request_url(url, path)
    except ValueError as exc:
        return False, {"error": str(exc), "code": "invalid_route", "retryable": False}
    method = method.upper()
    if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        return False, {"error": f"Unsupported method: {method}"}
    if auth_scheme == "bearer":
        authorization = f"Bearer {resolved_token}"
    else:
        credential = f"{prerequisites['email']}:{resolved_token}"
        authorization = "Basic " + base64.b64encode(credential.encode()).decode()
    headers = {"Authorization": authorization, "Accept": "application/json"}
    retries = 2 if method == "GET" else 0
    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(retries + 1):
            try:
                kwargs: Dict[str, Any] = {"headers": headers, "params": params}
                if method in {"POST", "PUT", "PATCH"}:
                    kwargs["json"] = data
                response = await client.request(method, request_url, **kwargs)
                if response.status_code in {429, 502, 503, 504} and attempt < retries:
                    try:
                        delay = min(10.0, max(0.0, float(response.headers.get("Retry-After", attempt + 1))))
                    except ValueError:
                        delay = float(attempt + 1)
                    await asyncio.sleep(delay)
                    continue
                if response.status_code not in {200, 201, 202, 204}:
                    logger.warning("confluence: %s %s returned HTTP %s", method, path, response.status_code)
                    error = response_error(response.status_code)
                    error["retryable"] = method == "GET" and error["retryable"]
                    return False, error
                if response.status_code == 204 and method != "GET":
                    return True, {"status": "success"}
                try:
                    payload = response.json()
                except ValueError:
                    return False, {"error": "Confluence returned invalid JSON; no page content was read", "code": "invalid_response", "retryable": False}
                if not isinstance(payload, dict):
                    return False, {"error": "Confluence returned an unexpected response shape", "code": "invalid_response", "retryable": False}
                return True, payload
            except (httpx.NetworkError, httpx.RemoteProtocolError, httpx.TimeoutException) as exc:
                logger.warning("confluence: %s %s failed (%s)", method, path, type(exc).__name__)
                if attempt < retries:
                    await asyncio.sleep(attempt + 1)
                    continue
                return False, {"error": "Confluence is temporarily unavailable", "code": "transport_error", "retryable": method == "GET"}
            except httpx.RequestError as exc:
                logger.warning("confluence: request failed (%s)", type(exc).__name__)
                return False, {"error": "Confluence request could not be sent", "code": "request_error", "retryable": False}
    return False, {"error": "Confluence retry budget exhausted", "retryable": True}
