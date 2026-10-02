import importlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, call, patch

import pytest


def test_self_identity_returns_agent_id() -> None:
    create_self_identity_tool = getattr(
        importlib.import_module("dynamic_agents.services.builtin_tools"),
        "create_self_identity_tool",
    )

    identity_tool = create_self_identity_tool(
        agent_id="agent-123",
        name="Test Agent",
        description="A test dynamic agent",
        model_id="test-model",
        model_provider="test-provider",
        gradient_theme="ocean",
    )

    result = identity_tool.invoke({"thought": "verify identity"})

    assert result == {
        "id": "agent-123",
        "name": "Test Agent",
        "description": "A test dynamic agent",
        "model_id": "test-model",
        "model_provider": "test-provider",
        "gradient_theme": "ocean",
    }


def test_create_curl_tool_blocks_http() -> None:
    create_curl_tool = getattr(
        importlib.import_module("dynamic_agents.services.builtin_tools"),
        "create_curl_tool",
    )
    curl_tool = create_curl_tool(allowed_domains="*")
    result = curl_tool.invoke({"command": "curl -s http://example.com/api"})
    assert "not supported" in result.lower() or "ERROR" in result


def test_create_curl_tool_blocks_disallowed_domain() -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    create_curl_tool = getattr(builtin_tools, "create_curl_tool")
    curl_tool = create_curl_tool(allowed_domains="*.allowed.com")
    public_ip_records = [(2, 1, 6, "", ("93.184.216.34", 0))]
    with patch("dynamic_agents.services.builtin_tools.socket.getaddrinfo", return_value=public_ip_records):
        result = curl_tool.invoke({"command": "curl -s https://example.com/api"})
    assert "ERROR" in result
    assert result == "ERROR: Domain 'example.com' is not allowed. Allowed patterns: *.allowed.com"


def test_create_curl_tool_success() -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    create_curl_tool = getattr(builtin_tools, "create_curl_tool")
    curl_tool = create_curl_tool(allowed_domains="*")
    public_ip_records = [(2, 1, 6, "", ("93.184.216.34", 0))]
    mock_result = MagicMock()
    mock_result.stdout = '{"status": "ok"}'
    mock_result.stderr = ""
    mock_result.returncode = 0
    with patch("dynamic_agents.services.builtin_tools.socket.getaddrinfo", return_value=public_ip_records), \
         patch("subprocess.run", return_value=mock_result):
        result = curl_tool.invoke({"command": "curl -s https://api.example.com/status"})
    assert result == '{"status": "ok"}'


def test_curl_tool_in_builtin_tool_definitions() -> None:
    get_builtin_tool_definitions = getattr(
        importlib.import_module("dynamic_agents.services.builtin_tools"),
        "get_builtin_tool_definitions",
    )
    definitions = get_builtin_tool_definitions()
    ids = [d.id for d in definitions]
    assert "curl" in ids
    curl_def = next(d for d in definitions if d.id == "curl")
    assert curl_def.enabled_by_default is False
    assert any(f.name == "allowed_domains" for f in curl_def.config_fields)


def test_fetch_url_blocks_private_resolved_addresses(monkeypatch) -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    monkeypatch.setattr(
        builtin_tools,
        "socket",
        SimpleNamespace(SOCK_STREAM=1, getaddrinfo=lambda *args, **kwargs: [(2, 1, 6, "", ("169.254.169.254", 0))]),
        raising=False,
    )

    fetch_url = builtin_tools.create_fetch_url_tool(allowed_domains="*")

    with patch("dynamic_agents.services.builtin_tools._request_pinned_url") as mock_get:
        mock_response = Mock()
        mock_response.text = "metadata"
        mock_response.headers = {"content-type": "text/plain"}
        mock_response.raise_for_status = Mock()
        mock_get.return_value = mock_response

        result = fetch_url.invoke({"url": "https://metadata.example.com/latest/meta-data"})

    assert result.startswith("ERROR:")
    assert "publicly routable" in result
    mock_get.assert_not_called()


def test_create_curl_tool_blocks_private_resolved_addresses() -> None:
    """curl tool must reject URLs whose hostnames resolve to private IPs."""
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    curl_tool = getattr(builtin_tools, "create_curl_tool")(allowed_domains="*")

    with patch("dynamic_agents.services.builtin_tools.socket.getaddrinfo",
               return_value=[(2, 1, 6, "", ("10.0.0.1", 0))]):
        result = curl_tool.invoke({"command": "curl -s https://internal.corp/api"})

    assert "ERROR" in result
    assert "publicly routable" in result


def test_fetch_url_blocks_redirect_to_private_ip() -> None:
    """fetch_url must reject the chain if any redirect hop resolves to a private IP."""
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    fetch_url = getattr(builtin_tools, "create_fetch_url_tool")(allowed_domains="*")

    def fake_getaddrinfo(hostname, *args, **kwargs):
        if hostname == "docs.example.com":
            return [(2, 1, 6, "", ("93.184.216.34", 0))]
        return [(2, 1, 6, "", ("169.254.169.254", 0))]

    redirect_response = Mock()
    redirect_response.status_code = 302
    redirect_response.headers = {"location": "https://redirect.example.com/secret"}

    with patch("dynamic_agents.services.builtin_tools.socket.getaddrinfo", side_effect=fake_getaddrinfo), \
         patch("dynamic_agents.services.builtin_tools._request_pinned_url", return_value=redirect_response):
        result = fetch_url.invoke({"url": "https://docs.example.com/"})

    assert result.startswith("ERROR:")
    assert "publicly routable" in result


def test_fetch_url_blocks_too_many_redirects() -> None:
    """fetch_url must stop and error after exceeding _MAX_FETCH_REDIRECTS hops."""
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    fetch_url = getattr(builtin_tools, "create_fetch_url_tool")(allowed_domains="*")

    redirect_response = Mock()
    redirect_response.status_code = 302
    redirect_response.headers = {"location": "https://docs.example.com/next"}

    with patch("dynamic_agents.services.builtin_tools.socket.getaddrinfo",
               return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]), \
         patch("dynamic_agents.services.builtin_tools._request_pinned_url", return_value=redirect_response):
        result = fetch_url.invoke({"url": "https://docs.example.com/"})

    assert result.startswith("ERROR:")
    assert "Too many redirects" in result


def test_fetch_url_connects_to_the_validated_address() -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    response = Mock(
        status_code=200,
        headers={"content-type": "text/plain"},
        text="example response",
    )
    response.raise_for_status = Mock()

    with patch(
        "dynamic_agents.services.builtin_tools._resolve_host_addresses",
        return_value=["93.184.216.34"],
    ) as mock_resolve, patch(
        "dynamic_agents.services.builtin_tools._request_pinned_url",
        return_value=response,
    ) as mock_request:
        result = builtin_tools._fetch_url_content(
            "https://docs.example.com/guide",
            "text",
            30,
            "*.example.com",
        )

    assert result == "example response"
    mock_resolve.assert_called_once_with("docs.example.com")
    mock_request.assert_called_once_with(
        "https://docs.example.com/guide",
        "93.184.216.34",
        30,
    )


def test_pinned_adapter_preserves_https_server_identity() -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    adapter = builtin_tools._PinnedAddressAdapter("docs.example.com", "93.184.216.34")
    adapter.poolmanager = Mock()
    prepared_request = builtin_tools.requests.Request(
        "GET",
        "https://docs.example.com/guide",
    ).prepare()

    adapter.get_connection_with_tls_context(prepared_request, True)

    call = adapter.poolmanager.connection_from_host.call_args
    assert call.kwargs["host"] == "93.184.216.34"
    assert call.kwargs["scheme"] == "https"
    assert call.kwargs["pool_kwargs"]["assert_hostname"] == "docs.example.com"
    assert call.kwargs["pool_kwargs"]["server_hostname"] == "docs.example.com"


def test_pinned_request_uses_validated_address_and_original_host_header() -> None:
    received: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            received["host"] = self.headers.get("Host", "")
            received["path"] = self.path
            payload = b"pinned response"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
        port = server.server_address[1]
        original_getaddrinfo = builtin_tools.socket.getaddrinfo
        resolved_hosts: list[str] = []

        def recording_getaddrinfo(host: str, *args: object, **kwargs: object):
            resolved_hosts.append(host)
            if host == "rebind.example.test":
                raise AssertionError("the original hostname must not be resolved during the request")
            return original_getaddrinfo(host, *args, **kwargs)

        with patch(
            "dynamic_agents.services.builtin_tools.socket.getaddrinfo",
            side_effect=recording_getaddrinfo,
        ):
            response = builtin_tools._request_pinned_url(
                f"http://rebind.example.test:{port}/report",
                "127.0.0.1",
                5,
            )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert response.text == "pinned response"
    assert "rebind.example.test" not in resolved_hosts
    assert received == {
        "host": f"rebind.example.test:{port}",
        "path": "/report",
    }


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("http://[2001:db8::10]/", "[2001:db8::10]"),
        ("http://[2001:db8::10]:8080/", "[2001:db8::10]:8080"),
        ("https://docs.example.com:443/", "docs.example.com"),
        ("https://docs.example.com:8443/", "docs.example.com:8443"),
    ],
)
def test_host_header_preserves_ipv6_brackets_and_non_default_ports(
    url: str,
    expected: str,
) -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    assert builtin_tools._host_header(url) == expected


def test_fetch_url_revalidates_and_repins_every_redirect() -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    redirect = Mock(
        status_code=302,
        headers={"location": "https://cdn.example.com/final"},
    )
    final = Mock(
        status_code=200,
        headers={"content-type": "text/plain"},
        text="final response",
    )
    final.raise_for_status = Mock()

    with patch(
        "dynamic_agents.services.builtin_tools._validate_and_resolve_fetch_url",
        side_effect=[
            (True, "", "docs.example.com", "93.184.216.34"),
            (True, "", "cdn.example.com", "93.184.216.35"),
        ],
    ) as mock_validate, patch(
        "dynamic_agents.services.builtin_tools._request_pinned_url",
        side_effect=[redirect, final],
    ) as mock_request:
        result = builtin_tools._fetch_url_content(
            "https://docs.example.com/start",
            "text",
            30,
            "*.example.com",
        )

    assert result == "final response"
    assert mock_validate.call_args_list == [
        call("https://docs.example.com/start", "*.example.com"),
        call("https://cdn.example.com/final", "*.example.com"),
    ]
    assert mock_request.call_args_list == [
        call("https://docs.example.com/start", "93.184.216.34", 30),
        call("https://cdn.example.com/final", "93.184.216.35", 30),
    ]


def test_fetch_url_connection_failure_does_not_resolve_or_retry_a_fallback() -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    with patch(
        "dynamic_agents.services.builtin_tools._resolve_host_addresses",
        return_value=["93.184.216.34", "93.184.216.35"],
    ) as mock_resolve, patch(
        "dynamic_agents.services.builtin_tools._request_pinned_url",
        side_effect=builtin_tools.requests.exceptions.ConnectionError("connection failed"),
    ) as mock_request:
        result = builtin_tools._fetch_url_content(
            "https://docs.example.com/report",
            "text",
            30,
            "*.example.com",
        )

    assert result == "ERROR: Network error: connection failed"
    mock_resolve.assert_called_once_with("docs.example.com")
    mock_request.assert_called_once_with(
        "https://docs.example.com/report",
        "93.184.216.34",
        30,
    )
