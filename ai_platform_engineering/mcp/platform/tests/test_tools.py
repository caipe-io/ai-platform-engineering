from types import SimpleNamespace

import pytest

from mcp_platform import tools


def test_initiator_token_precedes_execution_identity(monkeypatch: pytest.MonkeyPatch) -> None:
  request = SimpleNamespace(
    headers={
      "authorization": "Bearer service-account-token",
      "x-caipe-initiator-token": "human-token",
    }
  )
  monkeypatch.setattr(tools, "get_http_request", lambda: request)

  assert tools._initiator_token() == "human-token"
  assert tools._headers()["Authorization"] == "Bearer human-token"


def test_initiator_token_uses_authorization_for_direct_clients(monkeypatch: pytest.MonkeyPatch) -> None:
  request = SimpleNamespace(headers={"authorization": "Bearer user-token"})
  monkeypatch.setattr(tools, "get_http_request", lambda: request)

  assert tools._initiator_token() == "user-token"


def test_initiator_token_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
  request = SimpleNamespace(headers={})
  monkeypatch.setattr(tools, "get_http_request", lambda: request)
  monkeypatch.delenv("CAIPE_ACCESS_TOKEN", raising=False)

  with pytest.raises(ValueError, match="authenticated user token"):
    tools._initiator_token()
