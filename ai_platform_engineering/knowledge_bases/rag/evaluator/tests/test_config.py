from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from deepeval_eval.core.config import (
    AgenticSettings,
    CaipeClientSettings,
    DatabaseSettings,
    LLMSettings,
    ensure_dirs,
    get_eval_config,
    get_max_concurrent_jobs,
    resolve_llm_settings,
)


def test_ensure_dirs_positive(tmp_path: Path) -> None:
    dir1 = tmp_path / "a" / "b"
    dir2 = tmp_path / "c"
    ensure_dirs(dir1, dir2)
    assert dir1.exists() and dir1.is_dir()
    assert dir2.exists() and dir2.is_dir()


def test_ensure_dirs_negative(tmp_path: Path) -> None:
    existing = tmp_path / "existing"
    existing.mkdir()
    ensure_dirs(existing)
    assert existing.exists()


def test_llm_settings_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "OPENAI_ENDPOINT",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "OPENAI_API_KEY",
        "OPENAI_MODEL_NAME",
        "OPENAI_MODEL",
    ):
        monkeypatch.delenv(key, raising=False)
    settings = LLMSettings(_env_file=None)
    assert settings.base_url == "http://localhost:8000/v1"
    assert settings.api_key.get_secret_value() == "mock-key"
    assert settings.model == "gpt-4o-mini"


def test_llm_settings_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_ENDPOINT", "http://custom-endpoint/v1/")
    monkeypatch.setenv("OPENAI_API_KEY", "secret-token")
    monkeypatch.setenv("OPENAI_MODEL_NAME", "custom-llm")

    settings = LLMSettings(_env_file=None)
    assert settings.base_url == "http://custom-endpoint/v1"  # Trailing slash normalized
    assert settings.api_key.get_secret_value() == "secret-token"
    assert settings.model == "custom-llm"


def test_agentic_settings_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "CAIPE_AGENT_ID",
        "AGENT_ID",
        "CAIPE_AGENT_URL",
        "CAIPE_API_URL",
        "AGENT_URL",
        "INSECURE_SSL",
        "OIDC_VERIFY_SSL",
        "CAIPE_OIDC_VERIFY_SSL",
        "CAIPE_SA_CLIENT_ID",
        "CAIPE_SA_CLIENT_SECRET",
        "CAIPE_SA_TOKEN_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    settings = AgenticSettings(_env_file=None)
    assert settings.agent_id == "hello-world"
    assert settings.agent_url == "http://localhost:8001"
    assert settings.insecure is False


def test_agentic_settings_service_account_aliases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CAIPE_AGENT_URL", raising=False)
    monkeypatch.delenv("AGENT_URL", raising=False)
    monkeypatch.setenv("CAIPE_API_URL", "https://caipe.example.org")
    monkeypatch.setenv("CAIPE_SA_CLIENT_ID", "sa-test-id")
    monkeypatch.setenv("CAIPE_SA_CLIENT_SECRET", "sa-test-secret")
    monkeypatch.setenv(
        "CAIPE_SA_TOKEN_URL",
        "https://caipe.example.org/realms/caipe/protocol/openid-connect/token",
    )

    settings = AgenticSettings(_env_file=None)
    assert settings.agent_url == "https://caipe.example.org"
    assert settings.client_id == "sa-test-id"
    assert settings.client_secret is not None
    assert settings.client_secret.get_secret_value() == "sa-test-secret"
    assert (
        settings.oidc_token_url
        == "https://caipe.example.org/realms/caipe/protocol/openid-connect/token"
    )


def test_agentic_settings_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAIPE_AGENT_ID", "custom-agent")
    monkeypatch.setenv("CAIPE_AGENT_URL", "http://supervisor:9000/")
    monkeypatch.setenv("INSECURE_SSL", "false")

    settings = AgenticSettings()
    assert settings.agent_id == "custom-agent"
    assert settings.agent_url == "http://supervisor:9000"  # Trailing slash normalized
    assert settings.insecure is False


def test_agentic_settings_when_agent_base_url_env_provided_sets_agent_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key in (
        "CAIPE_AGENT_URL",
        "CAIPE_API_URL",
        "AGENT_URL",
        "CAIPE_AGENT_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("AGENT_BASE_URL", "http://example-base:3000")

    settings = AgenticSettings(_env_file=None)
    assert settings.agent_url == "http://example-base:3000"


def test_agentic_settings_when_caipe_agent_base_url_env_provided_sets_agent_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key in (
        "CAIPE_AGENT_URL",
        "CAIPE_API_URL",
        "AGENT_URL",
        "AGENT_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("CAIPE_AGENT_BASE_URL", "http://caipe-base:3000")

    settings = AgenticSettings(_env_file=None)
    assert settings.agent_url == "http://caipe-base:3000"


def test_caipe_client_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CAIPE_BASE_URL", "https://api.caipe.com/rag/")
    monkeypatch.setenv("CAIPE_AUTH_TOKEN", "bearer-123")

    settings = CaipeClientSettings()
    assert settings.base_url == "https://api.caipe.com/rag"
    assert settings.auth_token is not None
    assert settings.auth_token.get_secret_value() == "bearer-123"


def test_database_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/evaldb")

    settings = DatabaseSettings()
    assert settings.connection_string is not None
    assert (
        settings.connection_string.get_secret_value()
        == "postgresql://user:pass@localhost:5432/evaldb"
    )


def test_database_settings_individual_env_vars(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("POSTGRES_HOST", "db.example.com")
    monkeypatch.setenv("POSTGRES_PORT", "5433")
    monkeypatch.setenv("POSTGRES_DB", "eval_db")
    monkeypatch.setenv("POSTGRES_USER", "eval_user")
    monkeypatch.setenv("POSTGRES_PASSWORD", "eval_pass")

    settings = DatabaseSettings(_env_file=None)
    assert settings.postgres_host == "db.example.com"
    assert settings.postgres_port == "5433"
    assert settings.postgres_db == "eval_db"
    assert settings.postgres_user == "eval_user"
    assert settings.postgres_password.get_secret_value() == "eval_pass"


def test_eval_config_singleton() -> None:
    cfg1 = get_eval_config()
    cfg2 = get_eval_config()
    assert cfg1 is cfg2


def test_resolve_llm_settings_legacy_bridge(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_ENDPOINT", "http://localhost:8000")
    monkeypatch.setenv("OPENAI_API_KEY", "testkey")
    monkeypatch.setenv("OPENAI_MODEL_NAME", "testmodel")

    url, key, model = resolve_llm_settings()
    assert url == "http://localhost:8000"
    assert key == "testkey"
    assert model == "testmodel"


def test_eval_config_question_set_id_validators(tmp_path: Path):
    from pydantic import ValidationError

    from deepeval_eval.core.config import EvalConfig

    q_file = tmp_path / "questions.jsonl"
    q_file.write_text("{}\n", encoding="utf-8")
    with pytest.raises(
        ValidationError, match="Specify either --questions-file or --question-set-id"
    ):
        EvalConfig(questions_file=q_file, question_set_id=1)

    with pytest.raises(
        ValidationError, match="--question-set-id requires a database connection"
    ):
        EvalConfig(
            questions_file=None,
            question_set_id=1,
            db={"postgres_host": None, "connection_string": None},
        )

    cfg = EvalConfig(
        questions_file=None,
        question_set_id=1,
        db={"postgres_host": "localhost"},
    )
    assert cfg.question_set_id == 1


def test_get_max_concurrent_jobs_valid_env_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify get_max_concurrent_jobs parses integer values from EVAL_MAX_CONCURRENT_JOBS."""
    monkeypatch.setenv("EVAL_MAX_CONCURRENT_JOBS", "4")
    assert get_max_concurrent_jobs() == 4


def test_get_max_concurrent_jobs_invalid_env_value_returns_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify get_max_concurrent_jobs defaults to 1 for invalid string inputs."""
    monkeypatch.setenv("EVAL_MAX_CONCURRENT_JOBS", "invalid_number")
    assert get_max_concurrent_jobs() == 1


def test_eval_config_flat_properties_getter_and_setter(tmp_path: Path) -> None:
    """Verify EvalConfig flat compatibility properties propagate to child settings models."""
    from deepeval_eval.core.config import EvalConfig

    cfg = EvalConfig(questions_file=tmp_path / "q.jsonl")
    cfg.agent_id = "agent-x"
    cfg.agent_url = "http://agent-x:8000"
    cfg.datasource_id = "ds-1"
    cfg.insecure = False
    cfg.llm_base_url = "http://llm:8000"
    cfg.llm_api_key = "new-key"
    cfg.llm_model = "gpt-4"

    assert cfg.agent_id == "agent-x"
    assert cfg.agent_url == "http://agent-x:8000"
    assert cfg.datasource_id == "ds-1"
    assert cfg.insecure is False
    assert cfg.llm_base_url == "http://llm:8000"
    assert cfg.llm_api_key == "new-key"
    assert cfg.llm_model == "gpt-4"


def test_eval_config_to_config_args_sanitizes_secrets(tmp_path: Path) -> None:
    """Verify to_config_args filters out secret keys/tokens and serializes Paths to strings."""
    from deepeval_eval.core.config import EvalConfig

    cfg = EvalConfig(
        questions_file=tmp_path / "q.jsonl",
        datasource_id="ds-main",
        agent_url="http://agent:8001",
        agent_id="main-agent",
    )
    args_dict = cfg.to_config_args()
    assert args_dict["datasource_id"] == "ds-main"
    assert args_dict["agent_url"] == "http://agent:8001"
    assert args_dict["agent_id"] == "main-agent"
    assert "api_key" not in args_dict


def test_resolve_agentic_config_helpers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify resolve_agent_url, resolve_agent_id, and load_agentic_config return expected values."""
    from deepeval_eval.core.config import (
        load_agentic_config,
        resolve_agent_id,
        resolve_agent_url,
        resolve_caipe_base_url,
        resolve_insecure_ssl,
    )

    monkeypatch.delenv("OIDC_VERIFY_SSL", raising=False)
    monkeypatch.delenv("CAIPE_OIDC_VERIFY_SSL", raising=False)
    monkeypatch.delenv("INSECURE_SSL", raising=False)

    assert resolve_agent_url("http://custom:8001") == "http://custom:8001"
    assert resolve_agent_id("agent-custom") == "agent-custom"
    assert resolve_caipe_base_url("http://caipe:8080") == "http://caipe:8080"
    assert resolve_insecure_ssl(explicit_val=False) is False

    loaded = load_agentic_config(
        agent_api_url="http://api:9000",
        agent_id="agent-load",
        insecure=False,
        datasource_id="ds-loaded",
    )
    assert loaded.agent_url == "http://api:9000"
    assert loaded.agent_id == "agent-load"
    assert loaded.insecure is False
    assert loaded.datasource_id == "ds-loaded"


def test_eval_config_delinked_experiment_name_and_run_id() -> None:
    """Verify experiment_name and run_id are independent fields on EvalConfig and exported in to_config_args."""
    from deepeval_eval.core.config import EvalConfig

    cfg = EvalConfig(experiment_name="exp-v1", run_id="run-100")
    assert cfg.experiment_name == "exp-v1"
    assert cfg.run_id == "run-100"

    cfg.experiment_name = "exp-v2"
    assert cfg.experiment_name == "exp-v2"
    assert cfg.run_id == "run-100"  # run_id is NOT mutated

    args = cfg.to_config_args()
    assert args.get("experiment_name") == "exp-v2"
    assert args.get("run_id") == "run-100"


def test_default_directories_outside_src() -> None:
    """Verify that default directory constants reside at PROJECT_ROOT outside the src folder."""
    from deepeval_eval.core.config import (
        DEFAULT_CACHE_DIR,
        DEFAULT_DATA_DIR,
        DEFAULT_RESULTS_DIR,
        PROJECT_ROOT,
    )

    assert "src" not in DEFAULT_RESULTS_DIR.parts[-2:]
    assert "src" not in DEFAULT_DATA_DIR.parts[-2:]
    assert "src" not in DEFAULT_CACHE_DIR.parts[-2:]

    expected_data = (
        (PROJECT_ROOT / "data")
        if (PROJECT_ROOT / "data").exists()
        else Path(tempfile.gettempdir()) / "data"
    )
    expected_cache = (
        (PROJECT_ROOT / "cache")
        if (PROJECT_ROOT / "cache").exists()
        else Path(tempfile.gettempdir()) / "cache"
    )
    expected_results = (
        (PROJECT_ROOT / "results")
        if (PROJECT_ROOT / "results").exists()
        else Path(tempfile.gettempdir()) / "results"
    )

    assert DEFAULT_DATA_DIR == expected_data
    assert DEFAULT_CACHE_DIR == expected_cache
    assert DEFAULT_RESULTS_DIR == expected_results


def test_resolve_default_dir_hierarchy(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Verify _resolve_default_dir prioritizes env var > existing local dir > system tempdir fallback."""
    from deepeval_eval.core.config import _resolve_default_dir

    # Env var set
    monkeypatch.setenv("TEST_EVAL_DIR", str(tmp_path / "custom"))
    assert _resolve_default_dir("TEST_EVAL_DIR", "custom") == tmp_path / "custom"

    # Env var unset, local path fallback
    monkeypatch.delenv("TEST_EVAL_DIR", raising=False)
    resolved = _resolve_default_dir("TEST_EVAL_DIR", "nonexistent_subpath_xyz")
    assert resolved == Path(tempfile.gettempdir()) / "nonexistent_subpath_xyz"


def test_eval_config_log_file_prefix_fallback_hierarchy() -> None:
    """Verify EvalConfig.log_file_prefix evaluates 3-option fallback hierarchy correctly."""
    from deepeval_eval.core.config import EvalConfig

    # Option 1: experiment_name overrides dataset_name & datasource_id
    cfg1 = EvalConfig(
        experiment_name="exp-alpha",
        dataset_name="hotpotqa",
        agentic_settings={"datasource_id": "ds-1"},
    )
    assert cfg1.log_file_prefix == "deepeval_exp-alpha"

    # Option 2: dataset_name used when experiment_name is None
    cfg2 = EvalConfig(
        experiment_name=None,
        dataset_name="hotpotqa",
        agentic_settings={"datasource_id": "ds-1"},
    )
    assert cfg2.log_file_prefix == "deepeval_hotpotqa"

    # Option 3: Already starting with deepeval_ avoids double-prefixing
    cfg3 = EvalConfig(experiment_name="deepeval_custom_benchmark")
    assert cfg3.log_file_prefix == "deepeval_custom_benchmark"


def test_eval_config_remap_flat_kwargs_populates_child_settings_models() -> None:
    from deepeval_eval.core.config import EvalConfig

    cfg = EvalConfig(
        llm_base_url="http://custom-llm:8000",
        llm_api_key="custom-key",
        llm_model="custom-model",
        agent_id="my-agent",
        agent_url="http://my-agent:8000",
        datasource_id="ds-remap",
        insecure=True,
        rag_url="http://rag:9446",
        auth_token="rag-token",
    )
    assert cfg.llm.base_url == "http://custom-llm:8000"
    assert cfg.llm.api_key.get_secret_value() == "custom-key"
    assert cfg.llm.model == "custom-model"
    assert cfg.agentic_settings.agent_id == "my-agent"
    assert cfg.agentic_settings.agent_url == "http://my-agent:8000"
    assert cfg.agentic_settings.datasource_id == "ds-remap"
    assert cfg.agentic_settings.insecure is True
    assert cfg.caipe.base_url == "http://rag:9446"
    assert cfg.caipe.auth_token.get_secret_value() == "rag-token"


def test_eval_config_oracle_testing_sets_retrieval_and_ground_truth() -> None:
    from deepeval_eval.core.config import EvalConfig

    cfg = EvalConfig(oracle_testing=True)
    assert cfg.oracle_retrieval is True
    assert cfg.answer_mode == "ground_truth"


def test_settings_ssl_verify_env_parsers(monkeypatch: pytest.MonkeyPatch) -> None:
    from deepeval_eval.core.config import (
        AgenticSettings,
        AuthSettings,
        CaipeClientSettings,
    )

    # Test AgenticSettings and CaipeClientSettings when OIDC_VERIFY_SSL is "false"
    monkeypatch.setenv("OIDC_VERIFY_SSL", "false")
    agentic = AgenticSettings(_env_file=None)
    assert agentic.insecure is True

    caipe = CaipeClientSettings(_env_file=None)
    assert caipe.insecure is True

    # Test AuthSettings when INSECURE_SSL is "true"
    monkeypatch.setenv("INSECURE_SSL", "true")
    auth = AuthSettings(_env_file=None)
    assert auth.oidc_verify_ssl is False


def test_load_agentic_config_with_all_optional_parameters() -> None:
    from deepeval_eval.core.config import load_agentic_config

    cfg = load_agentic_config(
        agent_api_url="http://agent:9000",
        agent_id="test-agent-id",
        insecure=True,
        trace_log=True,
        timeout=150.0,
        fail_on_error=True,
        datasource_id="ds-full",
    )
    assert cfg.agent_url == "http://agent:9000"
    assert cfg.agent_id == "test-agent-id"
    assert cfg.insecure is True
    assert cfg.trace_log is True
    assert cfg.timeout == 150.0
    assert cfg.fail_on_error is True
    assert cfg.datasource_id == "ds-full"


def test_resolve_caipe_auth_token_with_and_without_explicit_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deepeval_eval.core.config import resolve_caipe_auth_token

    monkeypatch.setenv("CAIPE_AUTH_TOKEN", "env-token-xyz")
    assert resolve_caipe_auth_token("explicit-tok") == "explicit-tok"
    assert resolve_caipe_auth_token(None) == "env-token-xyz"


def test_eval_config_to_config_args_removes_nested_secret_and_token_keys(
    tmp_path: Path,
) -> None:
    from deepeval_eval.core.config import EvalConfig

    cfg = EvalConfig(
        questions_file=tmp_path / "q.jsonl",
        prompt_args={
            "safe_param": "val",
            "nested_token": "secret123",
            "password_field": "pass",
        },
    )
    args = cfg.to_config_args()
    assert args["prompt_args"] == {"safe_param": "val"}


def test_settings_ssl_verify_object_input_parsing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _parse_ssl_verify and _parse_insecure_ssl handle non-dict data object input."""
    from types import SimpleNamespace

    from deepeval_eval.core.config import (
        AgenticSettings,
        AuthSettings,
        CaipeClientSettings,
    )

    monkeypatch.setenv("OIDC_VERIFY_SSL", "false")
    data_obj = SimpleNamespace()
    parsed_agentic = AgenticSettings._parse_ssl_verify(data_obj)
    assert getattr(parsed_agentic, "insecure", None) is True

    parsed_caipe = CaipeClientSettings._parse_ssl_verify(data_obj)
    assert getattr(parsed_caipe, "insecure", None) is True

    monkeypatch.setenv("INSECURE_SSL", "true")
    parsed_auth = AuthSettings._parse_insecure_ssl(data_obj)
    assert getattr(parsed_auth, "oidc_verify_ssl", None) is False


def test_eval_config_remap_flat_kwargs_with_nested_settings_instances() -> None:
    """Verify _remap_flat_kwargs handles pre-instantiated Settings models in data dict."""
    from deepeval_eval.core.config import (
        AgenticSettings,
        CaipeClientSettings,
        EvalConfig,
        LLMSettings,
    )

    data = {
        "llm": LLMSettings(base_url="http://existing-llm:8000"),
        "llm_model": "new-model-override",
        "agentic_settings": AgenticSettings(agent_id="existing-agent"),
        "agent_url": "http://override-agent:9000",
        "caipe": CaipeClientSettings(base_url="http://existing-rag:9446"),
        "rag_url": "http://override-rag:9446",
    }
    remapped = EvalConfig._remap_flat_kwargs(data)
    assert remapped["llm"]["model"] == "new-model-override"
    assert remapped["agentic_settings"]["agent_url"] == "http://override-agent:9000"
    assert remapped["caipe"]["base_url"] == "http://override-rag:9446"


def test_resolve_insecure_ssl_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify resolve_insecure_ssl falls back to default_val when AgenticSettings().insecure is None."""
    from deepeval_eval.core.config import resolve_insecure_ssl

    with patch("deepeval_eval.core.config.AgenticSettings") as mock_settings:
        mock_instance = MagicMock()
        mock_instance.insecure = None
        mock_settings.return_value = mock_instance

        assert resolve_insecure_ssl(explicit_val=None, default_val=True) is True
        assert resolve_insecure_ssl(explicit_val=None, default_val=False) is False
