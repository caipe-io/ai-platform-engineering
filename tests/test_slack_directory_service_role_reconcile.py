"""Exercise the directory role bootstrap against an isolated Keycloak API double."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any

import pytest


@pytest.mark.parametrize("binding_fails", [False, True])
def test_directory_role_reconcile_grants_only_the_service_account(binding_fails: bool) -> None:
    state: dict[str, Any] = {
        "client": {"id": "example-client-id", "clientId": "example-ui", "protocolMappers": []},
        "role": None,
        "assignments": [],
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            path = self.path.split("?")[0]
            if path.endswith("/client-scopes"):
                payload: Any = [{"id": "example-scope", "name": "slack:directory:read"}]
            elif path.endswith("/clients"):
                payload = [state["client"]]
            elif path.endswith("/service-account-user"):
                payload = {"id": "example-service-account"}
            elif path.endswith("/roles/slack-directory-service"):
                if state["role"] is None:
                    self.send_error(404)
                    return
                payload = state["role"]
            else:
                payload = state["client"]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())

        def do_PUT(self) -> None:
            if binding_fails and "/default-client-scopes/" in self.path:
                self.send_error(500)
                return
            size = int(self.headers.get("Content-Length", "0"))
            if size:
                state["client"] = json.loads(self.rfile.read(size))
            self.send_response(204)
            self.end_headers()

        def do_POST(self) -> None:
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path.endswith("/roles"):
                state["role"] = {"id": "example-role", **payload}
            else:
                state["assignments"].append((self.path, payload))
            self.send_response(204)
            self.end_headers()

        def log_message(self, _format: str, *_args: object) -> None:
            return

    script_path = Path(__file__).resolve().parents[1] / "charts/ai-platform-engineering/charts/keycloak/scripts/init-idp.sh"
    source = script_path.read_text()
    name = "_ensure_caipe_ui_slack_admin_client_credentials"
    function = source.split(f"{name}() {{", 1)[1].split(f"\n{name}\n", 1)[0]
    command = f"{name}() {{{function}\n{name}\n"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        environment = {
            **os.environ,
            "PATH": f"{Path(sys.executable).parent}:{os.environ['PATH']}",
            "KC_URL": f"http://127.0.0.1:{server.server_port}",
            "REALM": "example", "AUTH": "Authorization: Bearer example-admin-token",
            "OIDC_CLIENT_ID": "example-ui", "SLACK_BOT_ADMIN_AUDIENCE": "example-bot-admin",
        }
        for _ in range(2):
            result = subprocess.run(["bash", "-c", command], env=environment, capture_output=True, text=True, timeout=15)
            if binding_fails:
                assert result.returncode != 0
                assert "Failed to bind slack:directory:read" in result.stdout
                assert not state["assignments"]
                assert not state["client"].get("serviceAccountsEnabled")
                return
            assert result.returncode == 0, result.stderr
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    mapper = next(row for row in state["client"]["protocolMappers"] if row["name"] == "slack-directory-service-roles")
    assert mapper["config"]["usermodel.clientRoleMapping.clientId"] == "example-ui"
    assert mapper["config"]["claim.name"] == "slack_bot_admin_roles"
    assert mapper["config"]["access.token.claim"] == "true"
    assert len([row for row in state["client"]["protocolMappers"] if row["name"] == mapper["name"]]) == 1
    account_assignments = [(path, roles) for path, roles in state["assignments"] if "/users/" in path]
    assert len(account_assignments) == 2
    assert all("/users/example-service-account/role-mappings/clients/example-client-id" in path for path, _ in account_assignments)
    assert all([role["name"] for role in roles] == ["slack-directory-service"] for _, roles in account_assignments)
    assert state["client"]["serviceAccountsEnabled"] is True
