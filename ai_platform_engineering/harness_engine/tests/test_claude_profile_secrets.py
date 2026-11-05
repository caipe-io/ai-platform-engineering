from __future__ import annotations

import json
import traceback
from pathlib import Path

import pytest
from pydantic import SecretStr, ValidationError

from harness_engine.claude_worker import create_worker_app
from harness_engine.config import Settings
from harness_engine.repository import InMemoryRunRepository
from tests.test_claude_sandbox import policy

SENTINEL = "sandbox-private-sentinel-not-for-logs-1234567890"


def profile_json(tmp_path: Path) -> str:
    return json.dumps({"safe": {"model": "claude-example", "sandbox": {
        **policy(tmp_path), "url": "wss://portal.example.test/api/acp/connections/primary/stdio", "token": SENTINEL,
    }}})


@pytest.mark.parametrize("copied", [False, True])
def test_sdk_profile_credentials_are_redacted_from_settings_representations(tmp_path: Path, copied: bool) -> None:
    raw = profile_json(tmp_path)
    settings = Settings().model_copy(update={"claude_sdk_profiles_json": raw}) if copied else Settings(claude_sdk_profiles_json=raw)
    assert isinstance(settings.claude_sdk_profiles_json, SecretStr)
    assert SENTINEL not in repr(settings)
    assert SENTINEL not in repr(settings.model_dump())
    assert SENTINEL not in settings.model_dump_json()
    assert settings.claude_sdk_profiles()["safe"].sandbox.token.get_secret_value() == SENTINEL


@pytest.mark.parametrize("malformed_json", [False, True])
def test_invalid_nested_profile_startup_trace_does_not_contain_service_credentials(tmp_path: Path, malformed_json: bool) -> None:
    raw = profile_json(tmp_path)
    if malformed_json:
        raw += "!"
    else:
        parsed = json.loads(raw)
        parsed["safe"]["sandbox"]["workspace_root"] = "/"
        raw = json.dumps(parsed)
    configured = Settings().model_copy(update={"claude_sdk_profiles_json": raw})
    with pytest.raises(ValueError, match="CLAUDE_SDK_PROFILES_JSON is invalid") as error:
        create_worker_app(settings=configured, repository=InMemoryRunRepository())
    assert SENTINEL not in "".join(traceback.format_exception(error.value))
    assert error.value.__suppress_context__


def test_settings_model_validator_trace_hides_original_secret_input(tmp_path: Path) -> None:
    raw = profile_json(tmp_path)
    with pytest.raises(ValidationError) as error:
        Settings(claude_sdk_profiles_json=raw, sandbox_portal_url="http://insecure.example.test")
    assert SENTINEL not in "".join(traceback.format_exception(error.value))


def test_worker_profile_string_copy_keeps_existing_redaction(settings: Settings) -> None:
    copied = settings.model_copy(update={"claude_worker_profiles_json": json.dumps({"primary": {"token": SENTINEL}})})
    assert isinstance(copied.claude_worker_profiles_json, SecretStr)
    assert SENTINEL not in repr(copied)
    assert SENTINEL not in copied.model_dump_json()
    with pytest.raises(ValueError) as error:
        copied.claude_worker_profiles()
    assert SENTINEL not in "".join(traceback.format_exception(error.value))
