from __future__ import annotations

import pytest
from pydantic import ValidationError

from harness_engine.config import Settings


def test_engine_uses_canonical_caipe_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MONGODB_URI", "mongodb://database.example.test:27017")
    monkeypatch.setenv("MONGODB_DATABASE", "example")
    settings = Settings(_env_file=None)
    assert settings.storage_backend == "mongodb"
    assert settings.mongodb_uri == "mongodb://database.example.test:27017"
    assert settings.mongodb_database == "example"


@pytest.mark.parametrize("setting", ["MONGODB_URI", "MONGODB_DATABASE"])
def test_rejects_an_independent_engine_storage_binding(
    setting: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(setting, "mongodb://canonical.example.test" if setting == "MONGODB_URI" else "canonical")
    monkeypatch.setenv(f"HARNESS_ENGINE_{setting}", "mongodb://different.example.test" if setting == "MONGODB_URI" else "different")
    with pytest.raises(ValidationError, match="migrate existing provider collections"):
        Settings(_env_file=None)


def test_explicit_legacy_storage_is_not_silently_reset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MONGODB_DATABASE", raising=False)
    monkeypatch.setenv("HARNESS_ENGINE_MONGODB_DATABASE", "existing")
    assert Settings(_env_file=None).mongodb_database == "existing"


def test_separate_service_credentials_do_not_create_a_different_database_binding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MONGODB_URI", "mongodb://reader:example@database.example.test:27017/?authSource=admin")
    monkeypatch.setenv("HARNESS_ENGINE_MONGODB_URI", "mongodb://writer:example@database.example.test/?tls=true")
    assert Settings(_env_file=None).storage_binding
