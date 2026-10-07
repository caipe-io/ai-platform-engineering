# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by Codex Codex-sonnet-4-6

"""Smoke tests for charts/.../skills/caipe-skills.py.

The helper is shipped as a chart-data file (not a Python package) so we
import it via importlib.util from its on-disk path. We validate:

  * argparse wiring (no network)
  * credential resolution precedence: CLI > env > config file
  * base_url validation rejects non-http schemes and embedded creds
  * --page / --page-size bounds checking emits a JSON error envelope
  * missing API key emits the documented JSON error envelope (exit 0)
  * pagination defaults are page=1, page_size=50

Run with: PYTHONPATH=. uv run pytest tests/test_caipe_skills_helper.py -v
"""

from __future__ import annotations

import importlib.util
import io
import json
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

import pytest

HELPER_PATH = (
    Path(__file__).resolve().parents[1]
    / "charts"
    / "ai-platform-engineering"
    / "data"
    / "skills"
    / "caipe-skills.py"
)


def _load_helper() -> Any:
    """Import caipe-skills.py from its chart-data path as a fresh module."""
    spec = importlib.util.spec_from_file_location("caipe_skills_helper", HELPER_PATH)
    assert spec is not None and spec.loader is not None, (
        f"Could not load helper from {HELPER_PATH}"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def helper() -> Any:
    return _load_helper()


def _run(helper: Any, argv: list[str]) -> tuple[int, str]:
    """Run helper.main(argv) capturing stdout."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = helper.main(argv)
    return rc, buf.getvalue()


# ---------------------------------------------------------------------------
# Source file sanity (the helper must remain stdlib-only and importable)
# ---------------------------------------------------------------------------


def test_helper_file_exists():
    assert HELPER_PATH.exists(), f"missing chart helper: {HELPER_PATH}"
    # The helper is a PEP 723 inline-metadata script run via `uv run --script`,
    # not a plain `python3` script — switching to `uv run` gives us per-script
    # dependency declarations without shipping a separate install step.
    assert HELPER_PATH.read_text(encoding="utf-8").startswith(
        "#!/usr/bin/env -S uv run --script"
    )


def test_helper_uses_only_stdlib() -> None:
    """No third-party deps — keeps `python3 ~/.config/caipe/caipe-skills.py` working anywhere."""
    # The helper itself imports nothing third-party; this is a safety net
    # against a future refactor accidentally adding a dep.
    forbidden_in_source = ("import requests", "import httpx", "import aiohttp")
    src = HELPER_PATH.read_text(encoding="utf-8")
    for needle in forbidden_in_source:
        assert needle not in src, f"helper imports forbidden dep: {needle}"


# ---------------------------------------------------------------------------
# Credential & config resolution
# ---------------------------------------------------------------------------


def test_missing_api_key_emits_json_error_envelope(
    helper: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """No CLI key, no env var, no config file -> JSON error to stdout, exit 0."""
    monkeypatch.delenv("CAIPE_CATALOG_KEY", raising=False)
    monkeypatch.delenv("INCLUDE_CONTENT", raising=False)
    # Point HOME at an empty tmp dir so config-file resolution finds nothing.
    monkeypatch.setenv("HOME", str(tmp_path))

    rc, out = _run(helper, [])

    assert rc == 0
    payload = json.loads(out)
    assert "error" in payload
    assert "API key" in payload["error"]


def test_cli_api_key_overrides_env_and_config(
    helper: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setenv("CAIPE_CATALOG_KEY", "from-env")
    cfg_dir = tmp_path / ".config" / "caipe"
    cfg_dir.mkdir(parents=True)
    (cfg_dir / "config.json").write_text(json.dumps({"api_key": "from-config"}))
    monkeypatch.setenv("HOME", str(tmp_path))

    cli_key, base = helper._resolve_credentials("from-cli", None)
    assert cli_key == "from-cli"
    assert base  # default constant or HOME-config base; just assert non-empty


def test_config_api_key_overrides_env(
    helper: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Config file wins over the env var when both are present.

    See the docstring on ``_resolve_credentials`` — env vars only kick in
    when no config file is present, so a stray exported ``CAIPE_CATALOG_KEY``
    cannot silently shadow a key the user persisted to their config.
    """
    monkeypatch.setenv("CAIPE_CATALOG_KEY", "from-env")
    cfg_dir = tmp_path / ".config" / "caipe"
    cfg_dir.mkdir(parents=True)
    (cfg_dir / "config.json").write_text(json.dumps({"api_key": "from-config"}))
    monkeypatch.setenv("HOME", str(tmp_path))

    api_key, _ = helper._resolve_credentials(None, None)
    assert api_key == "from-config"


def test_config_api_key_used_when_cli_and_env_absent(
    helper: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.delenv("CAIPE_CATALOG_KEY", raising=False)
    cfg_dir = tmp_path / ".config" / "caipe"
    cfg_dir.mkdir(parents=True)
    (cfg_dir / "config.json").write_text(
        json.dumps({"api_key": "from-config", "base_url": "https://catalog.example.com"})
    )
    monkeypatch.setenv("HOME", str(tmp_path))

    api_key, base = helper._resolve_credentials(None, None)
    assert api_key == "from-config"
    assert base == "https://catalog.example.com"


def test_oversized_config_file_is_ignored(
    helper: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Config files > 64 KiB are ignored to defend against hostile dotfiles."""
    monkeypatch.delenv("CAIPE_CATALOG_KEY", raising=False)
    cfg_dir = tmp_path / ".config" / "caipe"
    cfg_dir.mkdir(parents=True)
    huge = "x" * (helper.CONFIG_FILE_MAX_BYTES + 1)
    (cfg_dir / "config.json").write_text(
        json.dumps({"api_key": "should-be-ignored", "padding": huge})
    )
    monkeypatch.setenv("HOME", str(tmp_path))

    api_key, _ = helper._resolve_credentials(None, None)
    assert api_key == ""


def test_malformed_config_file_is_ignored(
    helper: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.delenv("CAIPE_CATALOG_KEY", raising=False)
    cfg_dir = tmp_path / ".config" / "caipe"
    cfg_dir.mkdir(parents=True)
    (cfg_dir / "config.json").write_text("not json {")
    monkeypatch.setenv("HOME", str(tmp_path))

    api_key, _ = helper._resolve_credentials(None, None)
    assert api_key == ""


# ---------------------------------------------------------------------------
# URL validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://catalog.example.com",
        "http://localhost:8080",
        "https://catalog.example.com/prefix",
    ],
)
def test_validate_base_url_accepts_safe_http(helper: Any, url: str):
    assert helper._validate_base_url(url) == url.rstrip("/")


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com",
        "javascript:alert(1)",
        "https://user:pw@example.com",
        "not-a-url",
        "",
    ],
)
def test_validate_base_url_rejects_unsafe(helper: Any, url: str):
    assert helper._validate_base_url(url) is None


def test_invalid_base_url_emits_json_error_envelope(
    helper: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setenv("CAIPE_CATALOG_KEY", "key")
    monkeypatch.setenv("HOME", str(tmp_path))

    rc, out = _run(helper, ["--base-url", "file:///etc/passwd"])

    assert rc == 0
    payload = json.loads(out)
    assert "Invalid base_url" in payload["error"]


def test_http_error_response_body_is_withheld(
    helper: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
):
    monkeypatch.setenv("CAIPE_CATALOG_KEY", "key")
    monkeypatch.setenv("HOME", str(tmp_path))

    def fail_with_sensitive_body(url: str, *, api_key: str) -> str:
        raise urllib.error.HTTPError(
            url,
            403,
            "Forbidden",
            {},
            io.BytesIO(b'{"password":"super-secret","detail":"denied"}'),
        )

    monkeypatch.setattr(helper, "_fetch", fail_with_sensitive_body)

    rc, out = _run(helper, ["--base-url", "https://catalog.example.com"])

    captured = capsys.readouterr()
    assert rc == 1
    assert out == ""
    assert "catalog request failed" in captured.err
    assert "response body withheld" in captured.err
    assert "password" not in captured.err
    assert "super-secret" not in captured.err


# ---------------------------------------------------------------------------
# Pagination bounds
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "args,needle",
    [
        (["--page", "0"], "--page must be"),
        (["--page-size", "0"], "--page-size must be"),
        (["--page-size", "101"], "--page-size must be"),
    ],
)
def test_pagination_bounds_emit_error_envelope(
    helper: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    args: list[str],
    needle: str,
):
    monkeypatch.setenv("CAIPE_CATALOG_KEY", "key")
    monkeypatch.setenv("HOME", str(tmp_path))

    rc, out = _run(helper, args)

    assert rc == 0
    payload = json.loads(out)
    assert needle in payload["error"]


# ---------------------------------------------------------------------------
# Query string assembly
# ---------------------------------------------------------------------------


def test_build_query_string_defaults(helper: Any):
    qs = helper._build_query_string(
        "pipeline",
        source="github",
        repo=None,
        page=1,
        page_size=50,
        include_content=False,
    )
    # Order is stable (urlencode preserves the list order we pass in).
    assert qs == "source=github&q=pipeline&page=1&page_size=50"


def test_build_query_string_with_repo_and_include_content(helper: Any):
    qs = helper._build_query_string(
        "",
        source="github",
        repo="cnoe-io/skills",
        page=2,
        page_size=10,
        include_content=True,
    )
    assert "repo=cnoe-io%2Fskills" in qs
    assert "include_content=true" in qs
    assert "page=2" in qs
    assert "page_size=10" in qs


# ---------------------------------------------------------------------------
# Argparse smoke
# ---------------------------------------------------------------------------


def test_parser_accepts_positional_query(helper: Any):
    parser = helper._build_parser()
    args = parser.parse_args(["pipeline", "ci"])
    assert args.query == ["pipeline", "ci"]
    assert args.page == 1
    assert args.page_size == 50
    assert args.include_content is False


def test_parser_include_content_flag(helper: Any):
    parser = helper._build_parser()
    args = parser.parse_args(["--include-content", "my-skill"])
    assert args.include_content is True
    assert args.query == ["my-skill"]
