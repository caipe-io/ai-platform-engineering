#!/usr/bin/env python3
"""Local Keycloak users, browser PKCE login, and authenticated BFF requests."""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import hmac
import json
import os
import secrets
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Iterator


class AuthError(RuntimeError):
    """An actionable local authentication failure, without secret response data."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        raise AuthError("HTTP redirect refused; use the configured issuer or UI URL.")


def local_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise AuthError("Developer authentication requires a loopback HTTP(S) URL.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise AuthError("URLs must not contain credentials, queries, or fragments.")
    return url.rstrip("/")


def request_json(url: str, *, form: dict[str, str] | None = None, body: Any = None,
                 token: str | None = None, method: str | None = None) -> Any:
    headers = {"Accept": "application/json"}
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            content = response.read()
            return json.loads(content) if content else None
    except urllib.error.HTTPError as exc:
        raise AuthError(f"HTTP {exc.code}; check local credentials/configuration or run dev-login again.") from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise AuthError(f"Local authentication request failed ({type(exc).__name__}).") from None


def discovery(issuer: str) -> dict[str, Any]:
    data = request_json(issuer + "/.well-known/openid-configuration")
    if not isinstance(data, dict) or data.get("issuer") != issuer:
        raise AuthError("Keycloak discovery issuer does not match the configured issuer.")
    origin = urllib.parse.urlsplit(issuer)
    for name in ("authorization_endpoint", "token_endpoint", "userinfo_endpoint"):
        endpoint = urllib.parse.urlsplit(data.get(name, ""))
        if (endpoint.scheme, endpoint.netloc) != (origin.scheme, origin.netloc):
            raise AuthError("Keycloak discovery endpoints must use the configured issuer origin.")
    return data


def private_json(path: Path, data: Any) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(data, output)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def state_path(args: argparse.Namespace, name: str) -> Path:
    key = hashlib.sha256(f"{args.issuer}|{args.client_id}".encode()).hexdigest()[:16]
    return Path(args.state_dir).expanduser() / key / name


@contextmanager
def cache_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    fd = os.open(path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "w") as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def save_tokens(args: argparse.Namespace, data: dict[str, Any], old_refresh: str = "") -> None:
    if not data.get("access_token") or float(data.get("expires_in", 0)) <= 0:
        raise AuthError("Keycloak did not return a usable access token.")
    private_json(state_path(args, "session.json"), {
        "access_token": data["access_token"],
        "refresh_token": data.get("refresh_token") or old_refresh,
        "expires_at": time.time() + float(data["expires_in"]),
    })


def access_token(args: argparse.Namespace, metadata: dict[str, Any]) -> str:
    path = state_path(args, "session.json")
    with cache_lock(path):
        try:
            session = json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            raise AuthError("No saved login. Run make dev-login first.") from None
        if session["expires_at"] <= time.time() + 30:
            refresh = session.get("refresh_token")
            if not refresh:
                raise AuthError("Session expired. Run make dev-login again.")
            data = request_json(metadata["token_endpoint"], form={
                "grant_type": "refresh_token", "client_id": args.client_id, "refresh_token": refresh,
            })
            save_tokens(args, data, refresh)
            session = json.loads(path.read_text())
        return session["access_token"]


def login(args: argparse.Namespace, metadata: dict[str, Any]) -> None:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = secrets.token_urlsafe(32)
    result: dict[str, str] = {}

    class Callback(BaseHTTPRequestHandler):
        def setup(self) -> None:
            self.request.settimeout(5)
            super().setup()

        def log_message(self, *values: Any) -> None:
            pass  # Authorization codes must never enter HTTP access logs.

        def do_GET(self) -> None:
            parsed = urllib.parse.urlsplit(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            valid = parsed.path == "/callback" and hmac.compare_digest(params.get("state", [""])[0], state)
            valid = valid and params.get("iss", [args.issuer])[0] == args.issuer
            if not valid:
                self.send_error(400, "Invalid login callback")
                return
            if params.get("error") or not params.get("code"):
                result["error"] = "Login was denied or did not return a code."
            else:
                result["code"] = params["code"][0]
            body = b"<!doctype html><title>Keycloak sign-in response</title><p>Login response received. Return to your terminal.</p>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

    with HTTPServer(("127.0.0.1", args.callback_port), Callback) as server:
        server.timeout = 1
        redirect = f"http://127.0.0.1:{server.server_port}/callback"
        params = {"client_id": args.client_id, "response_type": "code", "scope": "openid profile email",
                  "redirect_uri": redirect, "state": state, "code_challenge": challenge,
                  "code_challenge_method": "S256", "prompt": "login"}
        if args.user:
            params["login_hint"] = args.user
        url = metadata["authorization_endpoint"] + "?" + urllib.parse.urlencode(params)
        print("Open this Keycloak login URL:\n" + url, flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        deadline = time.monotonic() + args.timeout
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if "code" not in result:
        raise AuthError(result.get("error", "Login timed out; run dev-login again."))
    data = request_json(metadata["token_endpoint"], form={
        "grant_type": "authorization_code", "client_id": args.client_id,
        "code": result["code"], "redirect_uri": redirect, "code_verifier": verifier,
    })
    identity = request_json(metadata["userinfo_endpoint"], token=data["access_token"])
    with cache_lock(state_path(args, "session.json")):
        save_tokens(args, data)
    print(f"Signed in as {identity.get('email') or identity['sub']}. Tokens saved privately.")


def seed_users(args: argparse.Namespace) -> None:
    """Provision opt-in local identities; product grants remain owned by the BFF."""
    if "/realms/" not in args.issuer:
        raise AuthError("Expected a Keycloak issuer ending in /realms/<realm>.")
    base, realm = args.issuer.rsplit("/realms/", 1)
    if not realm or "/" in realm or realm == "master":
        raise AuthError("Use a local application realm, not master.")
    deadline = time.monotonic() + args.timeout
    while True:
        try:
            discovery(args.issuer)
            break
        except AuthError:
            if time.monotonic() >= deadline:
                raise AuthError("Keycloak is not ready; inspect keycloak/keycloak-init logs.") from None
            time.sleep(1)
    admin = request_json(base + "/realms/master/protocol/openid-connect/token", form={
        "grant_type": "password", "client_id": "admin-cli",
        "username": os.getenv("KEYCLOAK_ADMIN", "admin"),
        "password": os.getenv("KEYCLOAK_ADMIN_PASSWORD", "admin"),
    })["access_token"]
    api = base + "/admin/realms/" + urllib.parse.quote(realm, safe="")
    clients = request_json(api + "/clients?" + urllib.parse.urlencode({"clientId": args.client_id}), token=admin)
    if (not clients or not clients[0].get("publicClient") or not clients[0].get("standardFlowEnabled")
            or clients[0].get("directAccessGrantsEnabled") or clients[0].get("serviceAccountsEnabled")
            or clients[0].get("attributes", {}).get("pkce.code.challenge.method") != "S256"):
        raise AuthError("Public PKCE CLI client is missing; run the canonical keycloak-init service.")
    path = state_path(args, "users.json")
    with cache_lock(path):
        credentials = json.loads(path.read_text()) if path.exists() else {}
        for username in ("test-user", "test-admin"):
            users = request_json(api + "/users?" + urllib.parse.urlencode({"username": username, "exact": "true"}), token=admin)
            if users:
                if users[0].get("attributes", {}).get("caipe.dev-auth") != ["true"]:
                    raise AuthError(f"{username} already exists and is unmanaged; no changes made to that account.")
                if username not in credentials:
                    raise AuthError(f"{username} is managed but its local password file is missing; reset it in Keycloak.")
                continue
            password = credentials.setdefault(username, secrets.token_urlsafe(24))
            private_json(path, credentials)
            request_json(api + "/users", token=admin, method="POST", body={
                "username": username, "email": username + "@example.test", "firstName": "Test",
                "lastName": "Admin" if username == "test-admin" else "User", "enabled": True,
                "emailVerified": True, "attributes": {"caipe.dev-auth": ["true"]},
                "credentials": [{"type": "password", "value": password, "temporary": False}],
            })
    print(f"Local test-user and test-admin are ready. Passwords: {path}")
    print("Admin permissions use the UI's test-admin@example.test bootstrap configuration.")


def api_request(args: argparse.Namespace, metadata: dict[str, Any]) -> None:
    path = args.path
    if not path.startswith("/api/") or "\\" in path or "#" in path:
        raise AuthError("Use a relative UI gateway path starting with /api/.")
    token = access_token(args, metadata)
    request = urllib.request.Request(args.ui_url + path, method=args.method,
                                     headers={"Authorization": "Bearer " + token})
    if args.data is not None:
        request.data = args.data.encode()
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=args.timeout) as response:
            while chunk := response.read1(4096):
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
    except urllib.error.HTTPError as exc:
        raise AuthError(f"UI gateway returned HTTP {exc.code}; check login and resource permissions.") from None
    except (urllib.error.URLError, TimeoutError) as exc:
        raise AuthError(f"UI gateway request failed ({type(exc).__name__}).") from None


def logout(args: argparse.Namespace) -> None:
    path = state_path(args, "session.json")
    with cache_lock(path):
        if path.exists():
            session = json.loads(path.read_text())
            # Revocation errors keep the cache so the user can retry.
            request_json(args.issuer + "/protocol/openid-connect/revoke", form={
                "client_id": args.client_id, "token": session.get("refresh_token") or session["access_token"],
                "token_type_hint": "refresh_token" if session.get("refresh_token") else "access_token",
            })
            path.unlink()
    print("Local login removed.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--issuer", default=os.getenv("DEV_AUTH_ISSUER", "http://localhost:7080/realms/caipe"))
    parser.add_argument("--client-id", default=os.getenv("DEV_AUTH_CLIENT_ID", "caipe-cli"))
    parser.add_argument("--ui-url", default=os.getenv("DEV_AUTH_UI_URL", "http://localhost:3000"))
    parser.add_argument("--state-dir", default=os.getenv("XDG_STATE_HOME", str(Path.home() / ".local/state")) + "/caipe/dev-auth")
    commands = parser.add_subparsers(dest="command", required=True)
    users = commands.add_parser("users", help="Create local test accounts without resetting existing passwords")
    users.add_argument("--timeout", type=int, default=120)
    sign_in = commands.add_parser("login", help="Sign in through the browser using authorization code + PKCE")
    sign_in.add_argument("--user", choices=["test-user", "test-admin"])
    sign_in.add_argument("--callback-port", type=int, default=8085)
    sign_in.add_argument("--timeout", type=int, default=180)
    sign_in.add_argument("--no-browser", action="store_true")
    commands.add_parser("status", help="Show authenticated identity without printing tokens")
    commands.add_parser("logout", help="Revoke the refresh token and remove the local login")
    api = commands.add_parser("api", help="Call the local UI gateway with your real user JWT")
    api.add_argument("path")
    api.add_argument("--method", default="GET", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    api.add_argument("--data")
    api.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    try:
        args.issuer = local_url(args.issuer)
        args.ui_url = local_url(args.ui_url)
        if args.command == "users":
            seed_users(args)
            return 0
        metadata = discovery(args.issuer)
        if args.command == "login":
            login(args, metadata)
        elif args.command == "api":
            api_request(args, metadata)
        elif args.command == "status":
            identity = request_json(metadata["userinfo_endpoint"], token=access_token(args, metadata))
            print(f"Signed in as {identity.get('email') or identity['sub']}.")
        else:
            logout(args)
        return 0
    except (AuthError, OSError, ValueError, KeyError, TypeError) as exc:
        message = str(exc) if isinstance(exc, AuthError) else f"Local authentication failed ({type(exc).__name__})."
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
