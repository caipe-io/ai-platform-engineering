from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest
import requests
from pydantic import SecretStr

from deepeval_eval.auth.token_manager import OidcTokenManager


def test_get_token_with_static_token_returns_static_token() -> None:
    manager = OidcTokenManager(static_token="example-static-jwt")
    assert manager.get_token() == "example-static-jwt"
    assert manager.get_auth_headers() == {"Authorization": "Bearer example-static-jwt"}


def test_get_token_with_secret_str_static_token() -> None:
    manager = OidcTokenManager(static_token=SecretStr("secret-static-jwt"))
    assert manager.get_token() == "secret-static-jwt"


def test_get_token_with_client_credentials_success() -> None:
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "access_token": "mocked-sa-token",
        "expires_in": 3600,
    }
    mock_resp.raise_for_status = MagicMock()

    with patch("requests.post", return_value=mock_resp) as mock_post:
        manager = OidcTokenManager(
            token_url="https://auth.example.org/token",
            client_id="test-client-id",
            client_secret="test-client-secret",
        )
        token = manager.get_token()
        assert token == "mocked-sa-token"
        assert manager.get_auth_headers() == {"Authorization": "Bearer mocked-sa-token"}
        mock_post.assert_called_once()


def test_get_token_proactive_refresh_when_expired() -> None:
    mock_resp1 = MagicMock(spec=requests.Response)
    mock_resp1.ok = True
    mock_resp1.status_code = 200
    mock_resp1.json.return_value = {
        "access_token": "token-v1",
        "expires_in": 60,
    }

    mock_resp2 = MagicMock(spec=requests.Response)
    mock_resp2.ok = True
    mock_resp2.status_code = 200
    mock_resp2.json.return_value = {
        "access_token": "token-v2",
        "expires_in": 300,
    }

    with patch("requests.post", side_effect=[mock_resp1, mock_resp2]) as mock_post:
        manager = OidcTokenManager(
            token_url="https://auth.example.org/token",
            client_id="test-client-id",
            client_secret="test-client-secret",
        )
        t1 = manager.get_token()
        assert t1 == "token-v1"
        assert mock_post.call_count == 1

        # Simulate time passing beyond expiry
        manager._token_expiry = time.time() - 10

        t2 = manager.get_token()
        assert t2 == "token-v2"
        assert mock_post.call_count == 2


def test_force_refresh_invalidates_and_fetches_new_token() -> None:
    mock_resp1 = MagicMock(spec=requests.Response)
    mock_resp1.ok = True
    mock_resp1.status_code = 200
    mock_resp1.json.return_value = {
        "access_token": "token-before-401",
        "expires_in": 3600,
    }

    mock_resp2 = MagicMock(spec=requests.Response)
    mock_resp2.ok = True
    mock_resp2.status_code = 200
    mock_resp2.json.return_value = {
        "access_token": "token-after-401-refresh",
        "expires_in": 3600,
    }

    with patch("requests.post", side_effect=[mock_resp1, mock_resp2]) as mock_post:
        manager = OidcTokenManager(
            token_url="https://auth.example.org/token",
            client_id="test-client-id",
            client_secret="test-client-secret",
        )
        t1 = manager.get_token()
        assert t1 == "token-before-401"
        assert mock_post.call_count == 1

        # Simulate 401 recovery trigger
        t2 = manager.force_refresh()
        assert t2 == "token-after-401-refresh"
        assert mock_post.call_count == 2


def test_fetch_fresh_token_raises_on_missing_credentials() -> None:
    with patch.dict("os.environ", {}, clear=True):
        manager = OidcTokenManager()
        with pytest.raises(
            RuntimeError, match="client_id and client_secret must be configured"
        ):
            manager.fetch_fresh_token()


def test_fetch_fresh_token_raises_on_http_error() -> None:
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = False
    mock_resp.status_code = 401
    mock_resp.raise_for_status.side_effect = requests.HTTPError("Unauthorized")

    with patch("requests.post", return_value=mock_resp):
        manager = OidcTokenManager(
            token_url="https://auth.example.org/token",
            client_id="test-client-id",
            client_secret="test-client-secret",
        )
        with pytest.raises(RuntimeError, match="Failed to fetch OIDC token"):
            manager.fetch_fresh_token()


def test_get_auth_headers_empty_when_no_token_available() -> None:
    with patch.dict("os.environ", {}, clear=True):
        manager = OidcTokenManager()
        assert manager.get_token() is None
        assert manager.get_auth_headers() == {}


def test_evaluator_oidc_env_var_resolution() -> None:
    env = {
        "EVALUATOR_OIDC_CLIENT_ID": "eval-client",
        "EVALUATOR_OIDC_CLIENT_SECRET": "eval-secret",
        "EVALUATOR_OIDC_ISSUER": "http://keycloak.example.com/realms/caipe",
    }
    with patch.dict("os.environ", env, clear=True):
        manager = OidcTokenManager()
        assert manager.client_id == "eval-client"
        assert manager.client_secret == "eval-secret"
        assert (
            manager.token_url
            == "http://keycloak.example.com/realms/caipe/protocol/openid-connect/token"
        )
        assert manager.has_client_credentials is True


def test_fetch_fresh_token_raises_when_access_token_missing_in_response() -> None:
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"not_access_token": "value"}
    mock_resp.raise_for_status = MagicMock()

    with patch("requests.post", return_value=mock_resp):
        manager = OidcTokenManager(
            token_url="https://auth.example.org/token",
            client_id="test-client-id",
            client_secret="test-client-secret",
        )
        with pytest.raises(
            RuntimeError, match="Token endpoint response did not contain access_token"
        ):
            manager.fetch_fresh_token()


def test_get_token_dynamic_environment_fallbacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with patch.dict("os.environ", {}, clear=True):
        manager = OidcTokenManager()
        # 1. Fallback to CAIPE_OIDC_TOKEN
        monkeypatch.setenv("CAIPE_OIDC_TOKEN", "env-caipe-token")
        assert manager.get_token() == "env-caipe-token"
        assert manager.get_token() == "env-caipe-token"  # Returns cached token

        # Reset cache and test BEARER_TOKEN
        manager._cached_token = None
        monkeypatch.delenv("CAIPE_OIDC_TOKEN", raising=False)
        monkeypatch.setenv("BEARER_TOKEN", "env-bearer-token")
        assert manager.get_token() == "env-bearer-token"

        # Reset cache and test DEEPEVAL_API_KEY
        manager._cached_token = None
        monkeypatch.delenv("BEARER_TOKEN", raising=False)
        monkeypatch.setenv("DEEPEVAL_API_KEY", "env-deepeval-key")
        assert manager.get_token() == "env-deepeval-key"


def test_force_refresh_without_client_credentials_falls_back_to_get_token() -> None:
    with patch.dict(
        "os.environ", {"CAIPE_OIDC_TOKEN": "env-refreshed-token"}, clear=True
    ):
        manager = OidcTokenManager(client_id=None, client_secret=None)
        assert manager.has_client_credentials is False
        assert manager.force_refresh() == "env-refreshed-token"


def test_oidc_token_manager_for_user_subject_fetches_obo_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify OidcTokenManager.for_user_subject delegates to exchange_token_for_user when OBO is enabled."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    monkeypatch.setenv("EVALUATOR_OBO_CLIENT_ID", "caipe-evaluator-obo")
    monkeypatch.setenv("EVALUATOR_OBO_CLIENT_SECRET", "caipe-evaluator-obo-dev-secret")
    monkeypatch.setenv(
        "EVALUATOR_OBO_TOKEN_URL",
        "http://keycloak.example.com/realms/caipe/protocol/openid-connect/token",
    )

    with patch(
        "deepeval_eval.auth.token_manager.exchange_token_for_user",
        return_value="exchanged-user-token-123",
    ) as mock_exchange:
        manager = OidcTokenManager.for_user_subject(
            subject="alice-user-sub",
        )
        token = manager.get_token()
        assert token == "exchanged-user-token-123"
        mock_exchange.assert_called_once()
        assert manager.get_auth_headers() == {
            "Authorization": "Bearer exchanged-user-token-123"
        }
