import os
from unittest.mock import patch

from mcp_cloudability.api.client import _auth_headers


AUTH_ENV = {
    "CLOUDABILITY_API_KEY",
    "CLOUDABILITY_API_PUBLIC_KEY",
    "CLOUDABILITY_API_PRIVATE_KEY",
    "CLOUDABILITY_PUBLIC_KEY",
    "CLOUDABILITY_PRIVATE_KEY",
    "CLOUDABILITY_API_KEY_PUBLIC_KEY",
    "CLOUDABILITY_API_KEY_PRIVATE_KEY",
    "CLOUDABILITY_API_KEY_ID",
    "CLOUDABILITY_API_KEY_SECRET",
    "APPTIO_OPENTOKEN",
    "CLOUDABILITY_APPTIO_OPENTOKEN",
    "APPTIO_ENVIRONMENT_ID",
    "CLOUDABILITY_ENVIRONMENT_ID",
}


def test_auth_headers_use_cloudability_api_key_pair():
    with patch.dict(
        os.environ,
        {
            "CLOUDABILITY_API_PUBLIC_KEY": "public",
            "CLOUDABILITY_API_PRIVATE_KEY": "private",
        },
        clear=False,
    ):
        for name in AUTH_ENV - {"CLOUDABILITY_API_PUBLIC_KEY", "CLOUDABILITY_API_PRIVATE_KEY"}:
            os.environ.pop(name, None)

        headers, auth, mode = _auth_headers()

    assert mode == "api-key-pair"
    assert headers == {"Accept": "application/json"}
    assert auth is not None
    assert auth._auth_header == "Basic cHVibGljOnByaXZhdGU="


def test_auth_headers_keep_legacy_single_api_key():
    with patch.dict(os.environ, {"CLOUDABILITY_API_KEY": "legacy"}, clear=False):
        for name in AUTH_ENV - {"CLOUDABILITY_API_KEY"}:
            os.environ.pop(name, None)

        headers, auth, mode = _auth_headers()

    assert mode == "api-key"
    assert headers == {"Accept": "application/json"}
    assert auth is not None
    assert auth._auth_header == "Basic bGVnYWN5Og=="


def test_auth_headers_use_opentoken_with_environment_id():
    with patch.dict(
        os.environ,
        {
            "APPTIO_OPENTOKEN": "token",
            "APPTIO_ENVIRONMENT_ID": "environment",
        },
        clear=False,
    ):
        for name in AUTH_ENV - {"APPTIO_OPENTOKEN", "APPTIO_ENVIRONMENT_ID"}:
            os.environ.pop(name, None)

        headers, auth, mode = _auth_headers()

    assert mode == "apptio-opentoken"
    assert auth is None
    assert headers["Accept"] == "application/json"
    assert headers["apptio-opentoken"] == "token"
    assert headers["apptio-environmentid"] == "environment"
