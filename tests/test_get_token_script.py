# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by Codex Codex-sonnet-4-6

"""Tests for the RAG token helper script."""

from __future__ import annotations

import importlib.util
import stat
import sys
from pathlib import Path
from typing import Any

import pytest


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "ai_platform_engineering"
    / "knowledge_bases"
    / "rag"
    / "scripts"
    / "get_token.py"
)


def _load_script() -> Any:
    spec = importlib.util.spec_from_file_location("rag_get_token_script", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_write_token_file_uses_owner_only_mode(tmp_path: Path) -> None:
    script = _load_script()
    output_file = tmp_path / "token.txt"

    script.write_token_file(str(output_file), "secret-token")

    assert output_file.read_text(encoding="utf-8") == "secret-token\n"
    assert stat.S_IMODE(output_file.stat().st_mode) == 0o600


def test_main_writes_token_without_printing_it(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    script = _load_script()
    output_file = tmp_path / "token.txt"
    monkeypatch.setattr(script, "get_token", lambda issuer, client_id, client_secret: "secret-token")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "get_token.py",
            "--issuer",
            "https://issuer.example.com",
            "--client-id",
            "client",
            "--client-secret",
            "client-secret",
            "--output-file",
            str(output_file),
        ],
    )

    rc = script.main()

    captured = capsys.readouterr()
    assert rc == 0
    assert captured.out == ""
    assert "secret-token" not in captured.err
    assert output_file.read_text(encoding="utf-8") == "secret-token\n"


def test_main_reports_missing_required_args_generically(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    script = _load_script()
    for name in (
        "OIDC_ISSUER",
        "INGESTOR_OIDC_ISSUER",
        "INGESTOR_OIDC_CLIENT_ID",
        "OIDC_CLIENT_ID",
        "INGESTOR_OIDC_CLIENT_SECRET",
        "OIDC_CLIENT_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "get_token.py",
            "--issuer",
            "https://issuer.example.com",
            "--client-id",
            "client",
        ],
    )

    rc = script.main()

    captured = capsys.readouterr()
    assert rc == 1
    assert captured.err.splitlines()[0] == "Error: one or more required arguments are missing."
