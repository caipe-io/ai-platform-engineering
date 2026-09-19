import importlib
import json
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

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
         patch("subprocess.run", return_value=mock_result) as mock_run:
        result = curl_tool.invoke({"command": "curl -s https://api.example.com/status"})
    assert result == '{"status": "ok"}'
    assert mock_run.call_args.args[0] == [
        "curl",
        "--globoff",
        "--max-redirs",
        "0",
        "-s",
        "--",
        "https://api.example.com/status",
    ]


def test_create_curl_tool_validates_every_url() -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    curl_tool = getattr(builtin_tools, "create_curl_tool")(allowed_domains="*.example.com")
    public_ip_records = [(2, 1, 6, "", ("93.184.216.34", 0))]

    with patch("dynamic_agents.services.builtin_tools.socket.getaddrinfo", return_value=public_ip_records), \
         patch("subprocess.run") as mock_run:
        result = curl_tool.invoke(
            {"command": "curl https://api.example.com/status https://outside.example.org/status"}
        )

    assert result == "ERROR: Domain 'outside.example.org' is not allowed. Allowed patterns: *.example.com"
    mock_run.assert_not_called()


def test_create_curl_tool_rejects_options_with_local_file_access() -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    curl_tool = getattr(builtin_tools, "create_curl_tool")(allowed_domains="*")
    commands = [
        "curl --output response.txt https://api.example.com/status",
        "curl --config settings.txt https://api.example.com/status",
        "curl --upload-file payload.txt https://api.example.com/status",
        "curl --form document=@payload.txt https://api.example.com/status",
        "curl --data-binary @payload.txt https://api.example.com/status",
        "curl --header @headers.txt https://api.example.com/status",
        "curl file:///etc/hosts",
    ]

    with patch("subprocess.run") as mock_run:
        results = [curl_tool.invoke({"command": command}) for command in commands]

    assert all(result.startswith("ERROR:") for result in results)
    mock_run.assert_not_called()


@pytest.mark.parametrize(
    "command",
    [
        "curl -o response.txt https://api.example.com/status",
        "curl -K settings.txt https://api.example.com/status",
        "curl -T payload.txt https://api.example.com/status",
        "curl -F document=@payload.txt https://api.example.com/status",
        "curl --location https://api.example.com/status",
        "curl --url https://api.example.com/status",
        "curl --proxy http://proxy.example.test https://api.example.com/status",
        "curl --data-urlencode name@payload.txt https://api.example.com/status",
        "curl --json @payload.json https://api.example.com/status",
        "curl --header=@headers.txt https://api.example.com/status",
    ],
)
def test_create_curl_tool_rejects_unsupported_or_file_capable_forms(command: str) -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    curl_tool = getattr(builtin_tools, "create_curl_tool")(
        allowed_domains="*", allow_non_public_urls=True
    )

    with patch("subprocess.run") as mock_run:
        result = curl_tool.invoke({"command": command})

    assert result.startswith("ERROR:")
    mock_run.assert_not_called()


def test_create_curl_tool_expands_only_allowlisted_combined_short_flags() -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    args, error = builtin_tools._prepare_curl_args(
        "curl -sSf https://api.example.com/items/{one,two}",
        "*",
        True,
        True,
    )

    assert error is None
    assert args == [
        "curl",
        "--globoff",
        "--max-redirs",
        "0",
        "-s",
        "-S",
        "-f",
        "--",
        "https://api.example.com/items/{one,two}",
    ]


def test_create_curl_tool_allows_inline_request_data() -> None:
    builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
    curl_tool = getattr(builtin_tools, "create_curl_tool")(allowed_domains="*")
    public_ip_records = [(2, 1, 6, "", ("93.184.216.34", 0))]
    mock_result = MagicMock(stdout='{"status":"ok"}', stderr="", returncode=0)

    with patch("dynamic_agents.services.builtin_tools.socket.getaddrinfo", return_value=public_ip_records), \
         patch("subprocess.run", return_value=mock_result) as mock_run:
        result = curl_tool.invoke(
            {
                "command": (
                    "curl -sS -X POST https://api.example.com/items "
                    "-H 'Content-Type: application/json' --data-raw '{\"name\":\"test\"}'"
                )
            }
        )

    assert result == '{"status":"ok"}'
    argv = mock_run.call_args.args[0]
    assert argv[-2:] == ["--", "https://api.example.com/items"]
    assert ["--globoff", "--max-redirs", "0"] == argv[1:4]


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl binary is not installed")
def test_create_curl_tool_runs_constrained_post_against_local_http_server() -> None:
    received: dict[str, object] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            content_length = int(self.headers.get("Content-Length", "0"))
            received.update(
                path=self.path,
                content_type=self.headers.get("Content-Type"),
                body=json.loads(self.rfile.read(content_length)),
            )
            payload = b'{"accepted":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        builtin_tools = importlib.import_module("dynamic_agents.services.builtin_tools")
        curl_tool = getattr(builtin_tools, "create_curl_tool")(
            allowed_domains="*",
            https_only=False,
            allow_non_public_urls=True,
        )
        result = curl_tool.invoke(
            {
                "command": (
                    f"curl -sS -X POST -H 'Content-Type: application/json' "
                    f"--data-raw '{{\"name\":\"example\"}}' http://127.0.0.1:{port}/items"
                )
            }
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result == '{"accepted":true}'
    assert received == {
        "path": "/items",
        "content_type": "application/json",
        "body": {"name": "example"},
    }


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

    with patch("dynamic_agents.services.builtin_tools.requests.get") as mock_get:
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
         patch("dynamic_agents.services.builtin_tools.requests.get", return_value=redirect_response):
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
         patch("dynamic_agents.services.builtin_tools.requests.get", return_value=redirect_response):
        result = fetch_url.invoke({"url": "https://docs.example.com/"})

    assert result.startswith("ERROR:")
    assert "Too many redirects" in result
