"""Keep A2A credentials on the configured origin, including SDK-selected transports."""

from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

import httpx


def agent_card_location(endpoint: str) -> tuple[str, str | None]:
    """Accept either an agent base URL or an explicit JSON Agent Card URL."""
    parsed = urlsplit(endpoint)
    if parsed.query:
        raise ValueError("Use an authentication header rather than an Agent Card URL query")
    if parsed.path.endswith(".json"):
        return urlunsplit((parsed.scheme, parsed.netloc, "", "", "")), parsed.path
    return endpoint, None


def _origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("A2A endpoints must be HTTP(S) URLs without embedded credentials")
    if parsed.fragment:
        raise ValueError("A2A endpoints must not contain a fragment")
    return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == "https" else 80)


class A2ADestinationPolicy:
    """Reject plaintext destinations unless deployment configuration trusts their exact origin."""

    def __init__(self, endpoint: str, allowed_http_origins: list[str]) -> None:
        self.origin = _origin(endpoint)
        trusted = {_origin(value) for value in allowed_http_origins}
        if self.origin[0] == "http" and self.origin not in trusted:
            raise ValueError("A2A requires HTTPS; configure REMOTE_A2A_ALLOWED_HTTP_ORIGINS for trusted local HTTP agents")

    def request_hook(self, headers: dict[str, str]) -> Callable[[httpx.Request], Awaitable[None]]:
        async def authorize(request: httpx.Request) -> None:
            # Card metadata cannot redirect caller JWTs or resolved secrets to another origin.
            if _origin(str(request.url)) != self.origin:
                raise ValueError("A2A Agent Card or redirect selected an untrusted origin")
            request.headers.update(headers)

        return authorize
