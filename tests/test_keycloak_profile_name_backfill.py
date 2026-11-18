"""Exercise the broker-name reconciler against a stateful Keycloak Admin API stub."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "charts/ai-platform-engineering/charts/keycloak/scripts/init-idp.sh"
SCRIPT_TEXT = SCRIPT.read_text()
BLOCK_START = SCRIPT_TEXT.index('PROFILE_KC_URL="${KC_URL}"')
BLOCK_END = SCRIPT_TEXT.index("\nPY_PROFILE_NAMES", BLOCK_START) + len("\nPY_PROFILE_NAMES")
RECONCILER_SHELL = SCRIPT_TEXT[BLOCK_START:BLOCK_END] + "\n"


@pytest.fixture
def admin_api() -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {
        "broker": [{"id": "unrelated", "name": "existing-groups", "config": {"syncMode": "FORCE"}}],
        "client": [{"id": "unrelated", "name": "existing-profile", "config": {"claim.name": "name"}}],
        "writes": [],
        "unavailable": False,
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: Any) -> None:
            pass

        def send_json(self, status: int, body: Any) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())

        def do_GET(self) -> None:
            if self.headers.get("Authorization") != "Bearer example-token":
                self.send_json(401, {"error": "unauthorized"})
                return
            path = urlsplit(self.path)
            if path.path.endswith("/clients"):
                assert parse_qs(path.query) == {"clientId": ["example-ui"]}
                self.send_json(200, [{"id": "example-client"}])
            elif state["unavailable"]:
                self.send_json(503, {"error": "unavailable"})
            else:
                self.send_json(200, state["client" if "/clients/" in path.path else "broker"])

        def mutate(self, create: bool) -> None:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            bucket = state["client" if "/clients/" in self.path else "broker"]
            state["writes"].append((self.command, self.path, body))
            if create:
                bucket.append({**body, "id": "mapper-" + str(len(bucket))})
            else:
                row = next(row for row in bucket if row["id"] == self.path.rsplit("/", 1)[1])
                row.clear()
                row.update(body)
            self.send_json(201 if create else 200, {})

        def do_POST(self) -> None:
            self.mutate(True)

        def do_PUT(self) -> None:
            self.mutate(False)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state["url"] = f"http://127.0.0.1:{server.server_port}"
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def run_reconciler(state: dict[str, Any]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/sh", "-c", RECONCILER_SHELL],
        env={**os.environ, "KC_URL": state["url"], "REALM": "example",
             "ALIAS": "example-provider", "KEYCLOAK_UI_CLIENT_ID": "example-ui",
             "AUTH": "Authorization: Bearer example-token",
             "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", "")},
        text=True, capture_output=True, timeout=10,
    )


def test_fresh_session_names_are_private_id_token_claims(admin_api: dict[str, Any]) -> None:
    result = run_reconciler(admin_api)
    assert result.returncode == 0, result.stderr
    broker = admin_api["broker"][1]
    assert broker["identityProviderMapper"] == "oidc-user-session-note-idp-mapper"
    assert broker["config"]["syncMode"] == "FORCE"
    assert broker["config"]["are.claim.values.regex"] == "true"
    assert json.loads(broker["config"]["claims"]) == [
        {"key": name, "value": ".+"} for name in ("given_name", "family_name", "firstname", "lastname")
    ]
    for mapper in admin_api["client"][1:]:
        config = mapper["config"]
        assert mapper["protocolMapper"] == "oidc-usersessionmodel-note-mapper"
        assert config["claim.name"] == "caipe_idp_" + config["user.session.note"]
        assert config["id.token.claim"] == "true"
        assert config["access.token.claim"] == "false"
        assert config["userinfo.token.claim"] == "false"
        assert config["introspection.token.claim"] == "false"
    assert len(admin_api["writes"]) == 5
    assert all("/mappers" in path or "/protocol-mappers/" in path for _, path, _ in admin_api["writes"])
    assert admin_api["broker"][0]["name"] == "existing-groups"
    assert admin_api["client"][0]["config"] == {"claim.name": "name"}


def test_upgrade_repairs_owned_mapper_drift_and_is_idempotent(admin_api: dict[str, Any]) -> None:
    assert run_reconciler(admin_api).returncode == 0
    admin_api["broker"][1]["config"]["syncMode"] = "IMPORT"
    admin_api["client"][1]["config"]["access.token.claim"] = "true"
    admin_api["writes"].clear()
    assert run_reconciler(admin_api).returncode == 0
    assert [method for method, _, _ in admin_api["writes"]] == ["PUT", "PUT"]
    assert admin_api["broker"][1]["config"]["syncMode"] == "FORCE"
    assert admin_api["client"][1]["config"]["access.token.claim"] == "false"
    admin_api["writes"].clear()
    assert run_reconciler(admin_api).returncode == 0
    assert admin_api["writes"] == []


def test_duplicate_mapper_is_reported_without_guessing(admin_api: dict[str, Any]) -> None:
    assert run_reconciler(admin_api).returncode == 0
    admin_api["broker"].append({**admin_api["broker"][1], "id": "duplicate"})
    admin_api["writes"].clear()
    result = run_reconciler(admin_api)
    assert result.returncode != 0
    assert "Duplicate profile mapper" in result.stderr
    assert admin_api["writes"] == []


def test_mapper_api_failure_fails_reconciliation(admin_api: dict[str, Any]) -> None:
    admin_api["unavailable"] = True
    result = run_reconciler(admin_api)
    assert result.returncode != 0
    assert "503" in result.stderr
    assert "example-token" not in result.stderr
