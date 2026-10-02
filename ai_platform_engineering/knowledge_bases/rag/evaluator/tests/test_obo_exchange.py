from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from deepeval_eval.auth.obo_exchange import (
    OboExchangeError,
    exchange_token_for_user,
    is_obo_enabled,
)


def test_is_obo_enabled_flag_true_returns_true(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify is_obo_enabled returns True when EVALUATOR_OBO_ENABLED is 1/true."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    assert is_obo_enabled() is True


def test_is_obo_enabled_flag_false_returns_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify is_obo_enabled returns False when EVALUATOR_OBO_ENABLED is false/empty."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "false")
    assert is_obo_enabled() is False

    monkeypatch.delenv("EVALUATOR_OBO_ENABLED", raising=False)
    assert is_obo_enabled() is False


def test_exchange_token_for_user_disabled_raises_obo_exchange_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify exchange_token_for_user raises OboExchangeError when OBO is disabled."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "false")
    with pytest.raises(OboExchangeError, match="EVALUATOR_OBO_ENABLED is not enabled"):
        exchange_token_for_user("user-sub-123")


def test_exchange_token_for_user_missing_subject_raises_obo_exchange_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify exchange_token_for_user raises OboExchangeError on empty subject."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    with pytest.raises(OboExchangeError, match="User subject cannot be empty"):
        exchange_token_for_user("")


def test_exchange_token_for_user_missing_credentials_raises_obo_exchange_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify exchange_token_for_user raises OboExchangeError when client credentials are missing."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    monkeypatch.delenv("EVALUATOR_OBO_CLIENT_ID", raising=False)
    monkeypatch.delenv("EVALUATOR_OBO_CLIENT_SECRET", raising=False)
    with pytest.raises(OboExchangeError, match="OBO credentials not configured"):
        exchange_token_for_user("user-sub-123")


def test_exchange_token_for_user_valid_response_returns_access_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify exchange_token_for_user returns exchanged access_token on HTTP 200."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    monkeypatch.setenv("EVALUATOR_OBO_CLIENT_ID", "caipe-evaluator-obo")
    monkeypatch.setenv("EVALUATOR_OBO_CLIENT_SECRET", "caipe-evaluator-obo-dev-secret")
    monkeypatch.setenv(
        "EVALUATOR_OBO_TOKEN_URL",
        "http://localhost:7080/realms/caipe/protocol/openid-connect/token",
    )

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "access_token": "exchanged-user-token-xyz",
        "token_type": "Bearer",
        "expires_in": 300,
    }

    with patch("requests.post", return_value=mock_resp) as mock_post:
        token = exchange_token_for_user("user-sub-123", audience="caipe-ui")
        assert token == "exchanged-user-token-xyz"
        mock_post.assert_called_once()
        _, kwargs = mock_post.call_args
        assert (
            kwargs["data"]["grant_type"]
            == "urn:ietf:params:oauth:grant-type:token-exchange"
        )
        assert kwargs["data"]["requested_subject"] == "user-sub-123"
        assert kwargs["data"]["client_id"] == "caipe-evaluator-obo"
        assert kwargs["data"]["client_secret"] == "caipe-evaluator-obo-dev-secret"
        assert kwargs["data"]["audience"] == "caipe-ui"


def test_exchange_token_for_user_http_error_raises_obo_exchange_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify exchange_token_for_user raises OboExchangeError when Keycloak returns 400/403."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    monkeypatch.setenv("EVALUATOR_OBO_CLIENT_ID", "caipe-evaluator-obo")
    monkeypatch.setenv("EVALUATOR_OBO_CLIENT_SECRET", "caipe-evaluator-obo-dev-secret")
    monkeypatch.setenv(
        "EVALUATOR_OBO_TOKEN_URL",
        "http://localhost:7080/realms/caipe/protocol/openid-connect/token",
    )

    mock_resp = MagicMock()
    mock_resp.status_code = 400
    mock_resp.text = '{"error": "not_allowed", "error_description": "Client not allowed to exchange"}'
    mock_resp.raise_for_status.side_effect = Exception("HTTP 400 Client Error")

    with patch("requests.post", return_value=mock_resp):
        with pytest.raises(OboExchangeError, match="HTTP 400 Client Error"):
            exchange_token_for_user("user-sub-123")


def test_exchange_token_for_user_missing_token_field_raises_obo_exchange_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify exchange_token_for_user raises OboExchangeError when response lacks access_token."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    monkeypatch.setenv("EVALUATOR_OBO_CLIENT_ID", "caipe-evaluator-obo")
    monkeypatch.setenv("EVALUATOR_OBO_CLIENT_SECRET", "caipe-evaluator-obo-dev-secret")
    monkeypatch.setenv(
        "EVALUATOR_OBO_TOKEN_URL",
        "http://localhost:7080/realms/caipe/protocol/openid-connect/token",
    )

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"token_type": "Bearer"}

    with patch("requests.post", return_value=mock_resp):
        with pytest.raises(OboExchangeError, match="did not contain access_token"):
            exchange_token_for_user("user-sub-123")


def test_resolve_obo_config_explicit_secret_str_resolves_secret_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _resolve_obo_config correctly extracts secret value when client_secret is SecretStr."""
    from pydantic import SecretStr

    from deepeval_eval.auth.obo_exchange import _resolve_obo_config

    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    config = _resolve_obo_config(
        client_id="custom-obo-client",
        client_secret=SecretStr("custom-secret-val"),
        token_url="http://localhost:7080/token",
    )
    assert config.client_id == "custom-obo-client"
    assert config.client_secret is not None
    assert config.client_secret.get_secret_value() == "custom-secret-val"


def test_resolve_obo_config_explicit_str_secret_resolves_secret_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _resolve_obo_config wraps string client_secret in SecretStr."""
    from deepeval_eval.auth.obo_exchange import _resolve_obo_config

    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    config = _resolve_obo_config(
        client_id="custom-obo-client",
        client_secret="plain-secret-str",
        token_url="http://localhost:7080/token",
    )
    assert config.client_secret is not None
    assert config.client_secret.get_secret_value() == "plain-secret-str"


def test_resolve_obo_config_fallback_to_evaluator_oidc_issuer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _resolve_obo_config derives token_url from EVALUATOR_OIDC_ISSUER when direct token_url is unset."""
    from deepeval_eval.auth.obo_exchange import _resolve_obo_config

    monkeypatch.delenv("EVALUATOR_OBO_TOKEN_URL", raising=False)
    monkeypatch.delenv("EVALUATOR_OIDC_TOKEN_URL", raising=False)
    monkeypatch.delenv("CAIPE_SA_TOKEN_URL", raising=False)
    monkeypatch.setenv("EVALUATOR_OIDC_ISSUER", "http://localhost:7080/realms/caipe/")

    config = _resolve_obo_config()
    assert (
        config.token_url
        == "http://localhost:7080/realms/caipe/protocol/openid-connect/token"
    )


def test_resolve_obo_config_fallback_to_keycloak_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _resolve_obo_config derives token_url from KEYCLOAK_URL when other token URLs are unset."""
    from deepeval_eval.auth.obo_exchange import _resolve_obo_config

    monkeypatch.delenv("EVALUATOR_OBO_TOKEN_URL", raising=False)
    monkeypatch.delenv("EVALUATOR_OIDC_TOKEN_URL", raising=False)
    monkeypatch.delenv("CAIPE_SA_TOKEN_URL", raising=False)
    monkeypatch.delenv("EVALUATOR_OIDC_ISSUER", raising=False)
    monkeypatch.setenv("KEYCLOAK_URL", "http://localhost:7080")

    config = _resolve_obo_config()
    assert (
        config.token_url
        == "http://localhost:7080/realms/caipe/protocol/openid-connect/token"
    )


def test_resolve_obo_config_fallback_to_caipe_sa_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _resolve_obo_config falls back to CAIPE_SA_CLIENT_ID and CAIPE_SA_CLIENT_SECRET."""
    from deepeval_eval.auth.obo_exchange import _resolve_obo_config

    monkeypatch.delenv("EVALUATOR_OBO_CLIENT_ID", raising=False)
    monkeypatch.delenv("EVALUATOR_OIDC_CLIENT_ID", raising=False)
    monkeypatch.delenv("EVALUATOR_OBO_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("EVALUATOR_OIDC_CLIENT_SECRET", raising=False)
    monkeypatch.setenv("CAIPE_SA_CLIENT_ID", "sa-caipe-fallback")
    monkeypatch.setenv("CAIPE_SA_CLIENT_SECRET", "sa-caipe-secret")

    config = _resolve_obo_config()
    assert config.client_id == "sa-caipe-fallback"
    assert config.client_secret is not None
    assert config.client_secret.get_secret_value() == "sa-caipe-secret"


def test_resolve_obo_config_verify_ssl_false_env_resolves_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _resolve_obo_config sets verify_ssl=False when OIDC_VERIFY_SSL=false."""
    from deepeval_eval.auth.obo_exchange import _resolve_obo_config

    monkeypatch.setenv("OIDC_VERIFY_SSL", "false")
    config = _resolve_obo_config()
    assert config.verify_ssl is False


def test_resolve_obo_config_explicit_verify_ssl_overrides_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _resolve_obo_config respects explicitly passed verify_ssl argument over env."""
    from deepeval_eval.auth.obo_exchange import _resolve_obo_config

    monkeypatch.setenv("OIDC_VERIFY_SSL", "false")
    config = _resolve_obo_config(verify_ssl=True)
    assert config.verify_ssl is True
