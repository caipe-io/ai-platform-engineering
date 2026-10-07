"""Developer helpers use real OIDC identities and never supply admin context."""

import argparse
import base64
import hashlib
import importlib.util
import io
import json
import stat
import threading
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest

SPEC = importlib.util.spec_from_file_location("dev_auth", Path(__file__).parents[1] / "scripts/dev_auth.py")
assert SPEC and SPEC.loader
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)


@pytest.fixture
def args(tmp_path: Path) -> argparse.Namespace:
    return argparse.Namespace(issuer="http://localhost:7080/realms/example", client_id="example-cli",
                              state_dir=str(tmp_path), ui_url="http://localhost:3000", callback_port=0,
                              user="test-user", no_browser=False, timeout=3)


@pytest.fixture
def metadata(args: argparse.Namespace) -> dict[str, str]:
    return {name: args.issuer + "/protocol/openid-connect/" + endpoint for name, endpoint in
            [("authorization_endpoint", "auth"), ("token_endpoint", "token"), ("userinfo_endpoint", "userinfo")]}


@pytest.mark.parametrize("url", ["https://example.test", "http://localhost@remote.example.test",
                                "http://admin:password@localhost", "http://localhost?q=1", "http://localhost#x"])
def test_remote_or_credential_urls_rejected(url: str) -> None:
    with pytest.raises(auth.AuthError):
        auth.local_url(url)


@pytest.mark.parametrize("change", [{"issuer": "http://localhost:7080/realms/other"},
                                   {"token_endpoint": "https://remote.example.test/token"}])
def test_discovery_rejects_issuer_or_origin_mismatch(monkeypatch: pytest.MonkeyPatch, args: argparse.Namespace,
                                                  metadata: dict[str, str], change: dict[str, str]) -> None:
    monkeypatch.setattr(auth, "request_json", lambda *a, **kw: {"issuer": args.issuer, **metadata, **change})
    with pytest.raises(auth.AuthError):
        auth.discovery(args.issuer)


def test_tokens_are_private_and_refresh_rotation_is_saved(monkeypatch: pytest.MonkeyPatch, args: argparse.Namespace,
                                                       metadata: dict[str, str]) -> None:
    auth.save_tokens(args, {"access_token": "old-access", "refresh_token": "old-refresh", "expires_in": 1})
    path = auth.state_path(args, "session.json")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    calls: list[dict[str, Any]] = []

    def refresh(url: str, **kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 120}

    monkeypatch.setattr(auth, "request_json", refresh)
    assert auth.access_token(args, metadata) == "new-access"
    assert auth.access_token(args, metadata) == "new-access"
    assert len(calls) == 1
    assert calls[0]["form"] == {"grant_type": "refresh_token", "client_id": args.client_id, "refresh_token": "old-refresh"}
    assert json.loads(path.read_text())["refresh_token"] == "new-refresh"


def test_missing_login_is_actionable(args: argparse.Namespace, metadata: dict[str, str]) -> None:
    with pytest.raises(auth.AuthError, match="dev-login"):
        auth.access_token(args, metadata)


def test_expired_login_without_refresh_requires_login(args: argparse.Namespace, metadata: dict[str, str]) -> None:
    auth.save_tokens(args, {"access_token": "old-access", "expires_in": 1})
    with pytest.raises(auth.AuthError, match="expired"):
        auth.access_token(args, metadata)


def test_cache_is_isolated_by_issuer_and_client(args: argparse.Namespace) -> None:
    first = auth.state_path(args, "session.json")
    args.client_id = "secondary-cli"
    assert auth.state_path(args, "session.json") != first
    args.client_id = "example-cli"
    args.issuer += "-secondary"
    assert auth.state_path(args, "session.json") != first


def test_browser_login_checks_state_issuer_and_pkce(monkeypatch: pytest.MonkeyPatch, args: argparse.Namespace,
                                                 metadata: dict[str, str], capsys: pytest.CaptureFixture[str]) -> None:
    thread: threading.Thread | None = None
    browser_params: dict[str, list[str]] = {}

    def browser(url: str) -> None:
        nonlocal thread, browser_params
        browser_params = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)

        def callback() -> None:
            redirect = browser_params["redirect_uri"][0]
            for values in ({"state": "wrong-state"}, {"state": browser_params["state"][0], "iss": "wrong-issuer"}):
                with pytest.raises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(redirect + "?" + urllib.parse.urlencode(values), timeout=2)
                assert error.value.code == 400
            values = {"state": browser_params["state"][0], "iss": args.issuer, "code": "test-code"}
            with urllib.request.urlopen(redirect + "?" + urllib.parse.urlencode(values), timeout=2) as response:
                assert response.status == 200

        thread = threading.Thread(target=callback)
        thread.start()

    def exchange(url: str, **kwargs: Any) -> dict[str, Any]:
        if url == metadata["userinfo_endpoint"]:
            return {"sub": "test-subject", "email": "test-user@example.test"}
        form = kwargs["form"]
        assert form["grant_type"] == "authorization_code"
        assert form["code"] == "test-code"
        assert "client_secret" not in form
        expected = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest()).decode().rstrip("=")
        assert browser_params["code_challenge"] == [expected]
        assert browser_params["code_challenge_method"] == ["S256"]
        return {"access_token": "private-access", "refresh_token": "private-refresh", "expires_in": 120}

    monkeypatch.setattr(auth.webbrowser, "open", browser)
    monkeypatch.setattr(auth, "request_json", exchange)
    auth.login(args, metadata)
    assert thread
    thread.join(3)
    output = capsys.readouterr()
    assert "private-access" not in output.out + output.err
    assert "private-refresh" not in output.out + output.err
    assert "test-code" not in output.out + output.err
    assert "test-user@example.test" in output.out


def test_login_timeout_writes_no_session(args: argparse.Namespace, metadata: dict[str, str]) -> None:
    args.no_browser, args.timeout = True, 0
    with pytest.raises(auth.AuthError, match="timed out"):
        auth.login(args, metadata)
    assert not auth.state_path(args, "session.json").exists()


def test_user_setup_is_idempotent_and_never_resets_passwords(monkeypatch: pytest.MonkeyPatch,
                                                          args: argparse.Namespace) -> None:
    users: dict[str, Any] = {}
    posts: list[dict[str, Any]] = []
    monkeypatch.setattr(auth, "discovery", lambda _: {})

    def admin_request(url: str, **kwargs: Any) -> Any:
        if url.endswith("/token"):
            return {"access_token": "admin-access"}
        if "/clients?" in url:
            return [{"publicClient": True, "standardFlowEnabled": True,
                     "attributes": {"pkce.code.challenge.method": "S256"}}]
        if kwargs.get("method") == "POST":
            user = kwargs["body"]
            users[user["username"]] = user
            posts.append(user)
            return None
        username = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["username"][0]
        return [users[username]] if username in users else []

    monkeypatch.setattr(auth, "request_json", admin_request)
    auth.seed_users(args)
    credentials = auth.state_path(args, "users.json").read_text()
    auth.seed_users(args)
    assert len(posts) == 2
    assert credentials == auth.state_path(args, "users.json").read_text()
    assert all(len(user["credentials"][0]["value"]) >= 24 for user in posts)
    assert all("realmRoles" not in user and "is_admin" not in user for user in posts)
    users["test-user"]["attributes"] = {}
    with pytest.raises(auth.AuthError, match="unmanaged"):
        auth.seed_users(args)
    assert len(posts) == 2


def test_api_sends_only_user_bearer_and_relays_chunks(monkeypatch: pytest.MonkeyPatch, args: argparse.Namespace,
                                                  metadata: dict[str, str]) -> None:
    auth.save_tokens(args, {"access_token": "user-access", "expires_in": 120})
    args.path, args.method, args.data = "/api/dynamic-agents", "GET", None
    output = io.BytesIO()
    monkeypatch.setattr(auth.sys, "stdout", argparse.Namespace(buffer=output))

    class Response(io.BytesIO):
        def read1(self, size: int) -> bytes:
            return self.read(3)

    class Opener:
        def open(self, request: urllib.request.Request, **kwargs: Any) -> Response:
            assert request.full_url == args.ui_url + args.path
            assert request.get_header("Authorization") == "Bearer user-access"
            assert not request.get_header("X-user-context")
            return Response(b"event: output\ndata: partial\n\n")

    monkeypatch.setattr(auth.urllib.request, "build_opener", lambda *args: Opener())
    auth.api_request(args, metadata)
    assert output.getvalue() == b"event: output\ndata: partial\n\n"


def test_redirect_is_refused_without_forwarding_credentials() -> None:
    with pytest.raises(auth.AuthError, match="redirect refused"):
        auth.NoRedirect().redirect_request(None, None, None, 302, "redirect", {}, "http://localhost:1234/")


@pytest.mark.parametrize("path", ["https://example.test/api/users", "//example.test/api/users", "/other"])
def test_api_rejects_non_gateway_paths(args: argparse.Namespace, metadata: dict[str, str], path: str) -> None:
    args.path = path
    with pytest.raises(auth.AuthError, match="relative UI gateway"):
        auth.api_request(args, metadata)


def test_concurrent_refresh_exchanges_only_once(monkeypatch: pytest.MonkeyPatch, args: argparse.Namespace,
                                               metadata: dict[str, str]) -> None:
    auth.save_tokens(args, {"access_token": "old-access", "refresh_token": "old-refresh", "expires_in": 1})
    calls = []

    def refresh(url: str, **kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 120}

    monkeypatch.setattr(auth, "request_json", refresh)
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(lambda _: auth.access_token(args, metadata), range(4))) == ["new-access"] * 4
    assert len(calls) == 1


def test_failed_refresh_preserves_session(monkeypatch: pytest.MonkeyPatch, args: argparse.Namespace,
                                          metadata: dict[str, str]) -> None:
    auth.save_tokens(args, {"access_token": "old-access", "refresh_token": "old-refresh", "expires_in": 1})
    path = auth.state_path(args, "session.json")
    before = path.read_bytes()

    def denied(*a: Any, **kw: Any) -> None:
        raise auth.AuthError("HTTP 400; run dev-login again.")

    monkeypatch.setattr(auth, "request_json", denied)
    with pytest.raises(auth.AuthError, match="dev-login"):
        auth.access_token(args, metadata)
    assert path.read_bytes() == before


@pytest.mark.parametrize("failed", [False, True])
def test_logout_revokes_refresh_and_removes_cache_only_on_success(monkeypatch: pytest.MonkeyPatch,
                                                                args: argparse.Namespace, failed: bool) -> None:
    auth.save_tokens(args, {"access_token": "private-access", "refresh_token": "private-refresh", "expires_in": 120})
    path = auth.state_path(args, "session.json")

    def revoke(url: str, **kwargs: Any) -> None:
        assert url == args.issuer + "/protocol/openid-connect/revoke"
        assert kwargs["form"] == {"client_id": args.client_id, "token": "private-refresh", "token_type_hint": "refresh_token"}
        if failed:
            raise auth.AuthError("HTTP 503")

    monkeypatch.setattr(auth, "request_json", revoke)
    if failed:
        with pytest.raises(auth.AuthError, match="503"):
            auth.logout(args)
        assert path.exists()
    else:
        auth.logout(args)
        assert not path.exists()
        auth.logout(args)  # Already logged out is idempotent.


@pytest.mark.parametrize("status", [401, 403])
def test_api_auth_errors_do_not_echo_secret_response(monkeypatch: pytest.MonkeyPatch, args: argparse.Namespace,
                                                     metadata: dict[str, str], status: int) -> None:
    auth.save_tokens(args, {"access_token": "private-access", "expires_in": 120})
    args.path, args.method, args.data = "/api/dynamic-agents", "GET", None

    class Opener:
        def open(self, request: urllib.request.Request, **kwargs: Any) -> None:
            raise urllib.error.HTTPError(request.full_url, status, "private-access", {}, io.BytesIO(b"private-access"))

    monkeypatch.setattr(auth.urllib.request, "build_opener", lambda *a: Opener())
    with pytest.raises(auth.AuthError, match=str(status)) as error:
        auth.api_request(args, metadata)
    assert "private-access" not in str(error.value)
