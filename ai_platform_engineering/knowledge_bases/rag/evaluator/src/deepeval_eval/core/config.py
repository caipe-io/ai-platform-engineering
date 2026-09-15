from __future__ import annotations

import os
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, Self

from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

os.environ.setdefault("DEEPEVAL_DISABLE_DOTENV", "1")
os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "1")

ENV_FILE: str | None = (
    None if os.environ.get("DEEPEVAL_DISABLE_DOTENV") == "1" else ".env"
)

PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _resolve_default_dir(env_var: str, subpath: str) -> Path:
    """Resolve default directory using env var, existing local project directory, or system tempdir fallback."""
    if env_val := os.environ.get(env_var):
        return Path(env_val)
    local_dir = PROJECT_ROOT / subpath
    if local_dir.exists():
        return local_dir
    return Path(tempfile.gettempdir()) / subpath


DEFAULT_DATA_DIR = _resolve_default_dir("EVAL_DATA_DIR", "data")
DEFAULT_CACHE_DIR = _resolve_default_dir("EVAL_CACHE_DIR", "cache")
DEFAULT_RESULTS_DIR = _resolve_default_dir("EVAL_RESULTS_DIR", "results")
DEFAULT_SEARCH_TOOL_NAME = "knowledge-base_search"
DEFAULT_FETCH_TOOL_NAME = "knowledge-base_fetch_document"
DEFAULT_GATE_CONFIG = (
    PROJECT_ROOT / "gate_thresholds.yaml"
    if (PROJECT_ROOT / "gate_thresholds.yaml").is_file()
    else None
)


def get_max_concurrent_jobs() -> int:
    """Resolve maximum concurrent evaluation jobs from environment settings (default: 1)."""
    raw = os.environ.get("EVAL_MAX_CONCURRENT_JOBS") or os.environ.get(
        "MAX_CONCURRENT_JOBS", "1"
    )
    try:
        val = int(raw)
        return max(1, val)
    except ValueError:
        return 1


def get_max_in_memory_jobs() -> int:
    """Resolve maximum in-memory cached evaluation jobs from environment settings (default: 50)."""
    raw = os.environ.get("EVAL_IN_MEMORY_JOBS_MAX", "50")
    try:
        val = int(raw)
        return max(1, val)
    except ValueError:
        return 50


def get_job_purge_rate() -> float:
    """Resolve in-memory job eviction purge rate (ratio 0.0-1.0) from environment settings (default: 0.10 / 10%)."""
    raw = os.environ.get("EVAL_IN_MEMORY_JOBS_EVICTION_RATE", "0.10")
    try:
        val_str = str(raw).strip().rstrip("%")
        val = float(val_str)
        if val > 1.0:
            val = val / 100.0
        if 0.0 < val <= 1.0:
            return val
        return 0.10
    except (ValueError, TypeError):
        return 0.10


def ensure_dirs(*paths: Path) -> None:
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)


class LLMSettings(BaseSettings):
    """LLM Provider Configuration with explicit environment alias fallback order."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    base_url: str = Field(
        default="http://localhost:8000/v1",
        validation_alias=AliasChoices(
            "OPENAI_ENDPOINT", "OPENAI_BASE_URL", "OPENAI_API_BASE"
        ),
    )
    api_key: SecretStr = Field(
        default=SecretStr("mock-key"),
        validation_alias=AliasChoices("OPENAI_API_KEY", "DEEPEVAL_PER_REQUEST_API_KEY"),
    )
    model: str = Field(
        default="gpt-4o-mini",
        validation_alias=AliasChoices("OPENAI_MODEL_NAME", "OPENAI_MODEL"),
    )

    @field_validator("base_url", mode="after")
    def normalize_base_url(cls, v: str | None) -> str | None:
        return v.rstrip("/") if isinstance(v, str) else v


class AgenticSettings(BaseSettings):
    """CAIPE & Agentic RAG settings."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    agent_id: str = Field(
        default="hello-world",
        validation_alias=AliasChoices("CAIPE_AGENT_ID", "AGENT_ID"),
    )
    agent_url: str = Field(
        default="http://localhost:8001",
        validation_alias=AliasChoices(
            "CAIPE_AGENT_BASE_URL",
            "AGENT_BASE_URL",
            "CAIPE_AGENT_URL",
            "CAIPE_API_URL",
            "AGENT_URL",
        ),
    )
    insecure: bool = Field(default=False, validation_alias=AliasChoices("INSECURE_SSL"))
    trace_log: bool = Field(
        default=False, validation_alias=AliasChoices("CAIPE_TRACE_LOG")
    )
    datasource_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "CAIPE_DATASOURCE_ID", "ENTERPRISE_CAIPE_DATASOURCE_ID"
        ),
    )
    timeout: float = 200.0
    fail_on_error: bool = False
    client_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "CAIPE_SA_CLIENT_ID", "CAIPE_CLIENT_ID", "CLIENT_ID"
        ),
    )
    client_secret: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "CAIPE_SA_CLIENT_SECRET", "CAIPE_CLIENT_SECRET", "CLIENT_SECRET"
        ),
    )
    oidc_token_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "CAIPE_SA_TOKEN_URL",
            "CAIPE_OIDC_TOKEN_URL",
            "CAIPE_KEYCLOAK_URL",
            "KEYCLOAK_URL",
        ),
    )
    auth_token: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "CAIPE_OIDC_TOKEN", "BEARER_TOKEN", "DEEPEVAL_API_KEY"
        ),
    )
    search_tool_name: str | None = Field(
        default=DEFAULT_SEARCH_TOOL_NAME,
        validation_alias=AliasChoices("CAIPE_SEARCH_TOOL_NAME", "SEARCH_TOOL_NAME"),
    )
    fetch_tool_name: str | None = Field(
        default=DEFAULT_FETCH_TOOL_NAME,
        validation_alias=AliasChoices("CAIPE_FETCH_TOOL_NAME", "FETCH_TOOL_NAME"),
    )

    @model_validator(mode="before")
    @classmethod
    def _parse_ssl_verify(cls, data: Any) -> Any:
        if isinstance(data, dict):
            verify_ssl = data.get("OIDC_VERIFY_SSL") or os.getenv("OIDC_VERIFY_SSL", "")
            if str(verify_ssl).strip().lower() in ("false", "0", "no", "off"):
                data["insecure"] = True
        elif os.getenv("OIDC_VERIFY_SSL", "").strip().lower() in (
            "false",
            "0",
            "no",
            "off",
        ):
            if hasattr(data, "__dict__"):
                setattr(data, "insecure", True)
        return data

    @field_validator("agent_url", mode="after")
    def normalize_agent_url(cls, v: str | None) -> str | None:
        return v.rstrip("/") if isinstance(v, str) else v


class CaipeClientSettings(BaseSettings):
    """CAIPE RAG Server REST client settings."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    base_url: str = Field(
        default="http://localhost:9446",
        validation_alias=AliasChoices(
            "CAIPE_BASE_URL",
            "CAIPE_API_URL",
            "RAG_URL",
            "RAG_SERVER_URL",
            "CAIPE_RAG_URL",
        ),
    )
    auth_token: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "CAIPE_AUTH_TOKEN", "AUTH_TOKEN", "CAIPE_OIDC_TOKEN"
        ),
    )
    insecure: bool = Field(
        default=False,
        validation_alias=AliasChoices("INSECURE_SSL", "OIDC_INSECURE_SSL"),
    )
    keycloak_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "CAIPE_SA_TOKEN_URL",
            "KEYCLOAK_URL",
            "CAIPE_KEYCLOAK_URL",
            "CAIPE_OIDC_TOKEN_URL",
        ),
    )
    client_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("CAIPE_SA_CLIENT_ID", "CAIPE_CLIENT_ID"),
    )
    client_secret: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("CAIPE_SA_CLIENT_SECRET", "CAIPE_CLIENT_SECRET"),
    )

    @model_validator(mode="before")
    @classmethod
    def _parse_ssl_verify(cls, data: Any) -> Any:
        if isinstance(data, dict):
            verify_ssl = data.get("OIDC_VERIFY_SSL") or os.getenv("OIDC_VERIFY_SSL", "")
            if str(verify_ssl).strip().lower() in ("false", "0", "no", "off"):
                data["insecure"] = True
        elif os.getenv("OIDC_VERIFY_SSL", "").strip().lower() in (
            "false",
            "0",
            "no",
            "off",
        ):
            if hasattr(data, "__dict__"):
                setattr(data, "insecure", True)
        return data

    @field_validator("base_url", mode="after")
    def normalize_base_url(cls, v: str | None) -> str | None:
        return v.rstrip("/") if isinstance(v, str) else v


class DatabaseSettings(BaseSettings):
    """PostgreSQL Database Connection Settings."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    connection_string: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "DATABASE_URL",
            "LANGGRAPH_CHECKPOINT_POSTGRES_DSN",
            "POSTGRES_DSN",
            "DB_CONNECTION_STRING",
        ),
    )
    postgres_host: str | None = Field(
        default=None,
        validation_alias=AliasChoices("POSTGRES_HOST", "PGHOST", "DB_HOST"),
    )
    postgres_port: str = Field(
        default="5432",
        validation_alias=AliasChoices("POSTGRES_PORT", "PGPORT", "DB_PORT"),
    )
    postgres_db: str = Field(
        default="evaluator",
        validation_alias=AliasChoices("POSTGRES_DB", "PGDATABASE", "DB_NAME"),
    )
    postgres_user: str = Field(
        default="evaluator",
        validation_alias=AliasChoices("POSTGRES_USER", "PGUSER", "DB_USER"),
    )
    postgres_password: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("POSTGRES_PASSWORD", "PGPASSWORD", "DB_PASSWORD"),
    )
    pgsslmode: str = Field(
        default="prefer",
        validation_alias=AliasChoices("PGSSLMODE"),
    )


class AuthSettings(BaseSettings):
    """Authentication and OIDC Provider Settings."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("DEEPEVAL_API_KEY", "API_KEY"),
    )
    oidc_issuer_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OIDC_ISSUER_URL", "OIDC_ISSUER"),
    )
    oidc_audience: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OIDC_AUDIENCE", "OIDC_CLIENT_ID"),
    )
    oidc_discovery_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OIDC_DISCOVERY_URL"),
    )
    oidc_jwks_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OIDC_JWKS_URL"),
    )
    oidc_verify_ssl: bool = Field(
        default=True,
        validation_alias=AliasChoices("OIDC_VERIFY_SSL"),
    )

    @model_validator(mode="before")
    @classmethod
    def _parse_insecure_ssl(cls, data: Any) -> Any:
        if isinstance(data, dict):
            insecure = data.get("INSECURE_SSL") or os.getenv("INSECURE_SSL", "")
            if str(insecure).strip().lower() in ("true", "1", "yes", "on"):
                data["oidc_verify_ssl"] = False
        elif os.getenv("INSECURE_SSL", "").strip().lower() in (
            "true",
            "1",
            "yes",
            "on",
        ):
            if hasattr(data, "__dict__"):
                setattr(data, "oidc_verify_ssl", False)
        return data

    oidc_strict_claims: bool = Field(
        default=False,
        validation_alias=AliasChoices("OIDC_STRICT_CLAIMS"),
    )
    allow_unauthenticated_access: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "ALLOW_UNAUTHENTICATED_ACCESS", "CAIPE_UNSAFE_RBAC_BYPASS"
        ),
    )
    obo_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices("EVALUATOR_OBO_ENABLED"),
    )
    obo_client_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EVALUATOR_OBO_CLIENT_ID"),
    )
    obo_client_secret: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("EVALUATOR_OBO_CLIENT_SECRET"),
    )
    obo_token_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EVALUATOR_OBO_TOKEN_URL"),
    )
    obo_audience: str = Field(
        default="caipe-platform",
        validation_alias=AliasChoices("EVALUATOR_OBO_AUDIENCE"),
    )


class EvalConfig(BaseSettings):
    """Centralized execution config for evaluation pipelines."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    dataset_name: str = "enterprise"
    answer_mode: Literal["generate", "ground_truth"] = "generate"
    data_dir: Path = DEFAULT_DATA_DIR
    results_dir: Path = DEFAULT_RESULTS_DIR
    gate_config: Path | None = Field(
        default=DEFAULT_GATE_CONFIG,
        validation_alias=AliasChoices("DEEPEVAL_GATE_CONFIG", "GATE_CONFIG"),
    )
    questions_file: Path | None = None
    question_set_id: int | None = None
    prompt_style: str | None = "generation"
    prompt_config: Path | None = Field(
        default=None,
        validation_alias=AliasChoices("DEEPEVAL_PROMPT_CONFIG", "PROMPT_CONFIG"),
    )
    prompt_args: dict[str, Any] = Field(default_factory=dict)
    metric_set: str | None = Field(
        default=None,
        validation_alias=AliasChoices("DEEPEVAL_METRIC_SET", "METRIC_SET"),
    )
    metrics: list[str] | None = Field(
        default=None,
        validation_alias=AliasChoices("DEEPEVAL_METRICS", "METRICS"),
    )
    search_tool_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices("CAIPE_SEARCH_TOOL_NAME", "SEARCH_TOOL_NAME"),
    )
    fetch_tool_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices("CAIPE_FETCH_TOOL_NAME", "FETCH_TOOL_NAME"),
    )

    combine_with_level: bool | None = None
    max_items: int | None = None
    limit_per_category: int | None = None
    top_k: int = 3
    max_context_chars: int = 12000
    fail_on_error: bool = False
    show_indicator: bool = Field(
        default=False,
        validation_alias=AliasChoices("DEEPEVAL_SHOW_INDICATOR", "SHOW_INDICATOR"),
    )

    # Sub-settings
    llm: LLMSettings = Field(default_factory=LLMSettings)
    agentic_settings: AgenticSettings = Field(default_factory=AgenticSettings)
    caipe: CaipeClientSettings = Field(default_factory=CaipeClientSettings)
    db: DatabaseSettings = Field(default_factory=DatabaseSettings)
    auth: AuthSettings = Field(default_factory=AuthSettings)

    agentic: bool = True
    trace_log: bool = False
    oracle_retrieval: bool = False
    oracle_testing: bool = False
    gate: bool = False

    question_ids: str | None = None
    question_indices: str | None = None
    batch_id: str | None = None
    run_id: str | None = None
    experiment_name: str | None = None

    # Dynamic MCP custom search tool lifecycle
    dynamic_tool: bool = False
    semantic_weight: float = Field(default=0.5, ge=0.0, le=1.0)
    extra_filters: dict[str, Any] = Field(default_factory=dict)
    tool_description: str | None = None

    # Submitter and OBO user proxying identity fields
    submitter_subject: str | None = None
    submitter_email: str | None = None
    submitter_role: str | None = None
    user_subject: str | None = None
    user_token: str | None = None

    @model_validator(mode="after")
    def _validate_question_set_source(self) -> Self:
        if self.questions_file is not None and self.question_set_id is not None:
            raise ValueError(
                "Specify either --questions-file or --question-set-id, not both."
            )
        if self.question_set_id is not None:
            db = self.db
            has_dsn = db.connection_string is not None
            has_host = (
                isinstance(db.postgres_host, str) and db.postgres_host.strip() != ""
            )
            if not has_dsn and not has_host:
                raise ValueError(
                    "--question-set-id requires a database connection. "
                    "Set POSTGRES_HOST (or DATABASE_URL / POSTGRES_DSN) and related "
                    "env vars before running."
                )
        return self

    @model_validator(mode="before")
    @classmethod
    def _remap_flat_kwargs(cls, data: Any) -> Any:
        if isinstance(data, dict):
            llm_kwargs = {}
            for flat_k, target_k in [
                ("llm_base_url", "base_url"),
                ("llm_api_key", "api_key"),
                ("llm_model", "model"),
            ]:
                if flat_k in data and data[flat_k] is not None:
                    val = data.pop(flat_k)
                    if target_k == "api_key" and isinstance(val, str):
                        val = SecretStr(val)
                    llm_kwargs[target_k] = val
            if llm_kwargs:
                existing_llm = data.get("llm", {})
                if isinstance(existing_llm, LLMSettings):
                    existing_llm = existing_llm.model_dump()
                elif not isinstance(existing_llm, dict):
                    existing_llm = {}
                existing_llm.update(llm_kwargs)
                data["llm"] = existing_llm

            agentic_kwargs = {}
            for flat_k, target_k in [
                ("agent_id", "agent_id"),
                ("agent_url", "agent_url"),
                ("datasource_id", "datasource_id"),
                ("insecure", "insecure"),
            ]:
                if flat_k in data and data[flat_k] is not None:
                    agentic_kwargs[target_k] = data.pop(flat_k)
            if agentic_kwargs:
                existing_agentic = data.get("agentic_settings", {})
                if isinstance(existing_agentic, AgenticSettings):
                    existing_agentic = existing_agentic.model_dump()
                elif not isinstance(existing_agentic, dict):
                    existing_agentic = {}
                existing_agentic.update(agentic_kwargs)
                data["agentic_settings"] = existing_agentic

            caipe_kwargs = {}
            for flat_k, target_k in [
                ("rag_url", "base_url"),
                ("auth_token", "auth_token"),
            ]:
                if flat_k in data and data[flat_k] is not None:
                    val = data.pop(flat_k)
                    if target_k == "auth_token" and isinstance(val, str):
                        val = SecretStr(val)
                    caipe_kwargs[target_k] = val
            if caipe_kwargs:
                existing_caipe = data.get("caipe", {})
                if isinstance(existing_caipe, CaipeClientSettings):
                    existing_caipe = existing_caipe.model_dump()
                elif not isinstance(existing_caipe, dict):
                    existing_caipe = {}
                existing_caipe.update(caipe_kwargs)
                data["caipe"] = existing_caipe
        return data

    @model_validator(mode="after")
    def _resolve_oracle_testing(self) -> Self:
        if self.oracle_testing:
            self.oracle_retrieval = True
            self.answer_mode = "ground_truth"
        return self

    @property
    def log_file_prefix(self) -> str:
        """Resolve unified evaluation output log file prefix using 3-option fallback sequence."""
        base = (
            self.experiment_name
            or self.dataset_name
            or self.datasource_id
            or "enterprise"
        )
        if not base.startswith("deepeval_"):
            return f"deepeval_{base}"
        return base

    @property
    def datasource_id(self) -> str | None:
        return self.agentic_settings.datasource_id

    @datasource_id.setter
    def datasource_id(self, val: str | None) -> None:
        self.agentic_settings.datasource_id = val

    @property
    def agent_url(self) -> str:
        return self.agentic_settings.agent_url

    @agent_url.setter
    def agent_url(self, val: str) -> None:
        self.agentic_settings.agent_url = val

    @property
    def agent_id(self) -> str:
        return self.agentic_settings.agent_id

    @agent_id.setter
    def agent_id(self, val: str) -> None:
        self.agentic_settings.agent_id = val

    @property
    def insecure(self) -> bool:
        return self.agentic_settings.insecure

    @insecure.setter
    def insecure(self, val: bool) -> None:
        self.agentic_settings.insecure = val

    @property
    def llm_base_url(self) -> str:
        return self.llm.base_url

    @llm_base_url.setter
    def llm_base_url(self, val: str) -> None:
        self.llm.base_url = val

    @property
    def llm_api_key(self) -> str:
        return self.llm.api_key.get_secret_value()

    @llm_api_key.setter
    def llm_api_key(self, val: str) -> None:
        self.llm.api_key = SecretStr(val)

    @property
    def llm_model(self) -> str:
        return self.llm.model

    @llm_model.setter
    def llm_model(self, val: str) -> None:
        self.llm.model = val

    def to_config_args(self) -> dict[str, Any]:
        """Convert model fields to a safe, log-friendly dictionary omitting secret fields and converting Paths."""
        res: dict[str, Any] = {}
        for k, v in self.model_dump().items():
            k_lower = k.lower()
            if v is None or k.startswith("_") or isinstance(v, SecretStr):
                continue
            if any(
                sens in k_lower
                for sens in ("key", "secret", "token", "password", "dsn")
            ):
                continue
            if isinstance(v, Path):
                res[k] = str(v)
            elif isinstance(v, dict):
                sub_dict = {}
                for sub_k, sub_v in v.items():
                    sub_lower = sub_k.lower()
                    if sub_v is None or isinstance(sub_v, SecretStr):
                        continue
                    if any(
                        sens in sub_lower
                        for sens in ("key", "secret", "token", "password", "dsn")
                    ):
                        continue
                    sub_dict[sub_k] = sub_v
                res[k] = sub_dict

            else:
                res[k] = v
        res["datasource_id"] = self.datasource_id
        res["agent_url"] = self.agent_url
        res["agent_id"] = self.agent_id
        res["run_id"] = self.run_id
        res["experiment_name"] = self.experiment_name
        return res


@lru_cache
def get_eval_config() -> EvalConfig:
    """Cached application settings singleton."""
    return EvalConfig()


# Backward compatibility bridges
def resolve_llm_settings(
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
) -> tuple[str, str, str]:
    cfg = LLMSettings(
        **{
            k: v
            for k, v in {
                "base_url": base_url,
                "api_key": SecretStr(api_key) if api_key else None,
                "model": model,
            }.items()
            if v is not None
        }
    )
    return cfg.base_url, cfg.api_key.get_secret_value(), cfg.model


def resolve_caipe_base_url(explicit_url: str | None = None) -> str:
    return CaipeClientSettings(
        **({"base_url": explicit_url} if explicit_url else {})
    ).base_url


def resolve_caipe_auth_token(explicit_token: str | None = None) -> str | None:
    token = CaipeClientSettings(
        **({"auth_token": SecretStr(explicit_token)} if explicit_token else {})
    ).auth_token
    return token.get_secret_value() if token else None


def resolve_insecure_ssl(
    explicit_val: bool | None = None, default_val: bool = True
) -> bool:
    if explicit_val is not None:
        return explicit_val
    settings_val = AgenticSettings().insecure
    return settings_val if settings_val is not None else default_val


def resolve_agent_url(explicit_url: str | None = None) -> str:
    return AgenticSettings(
        **({"agent_url": explicit_url} if explicit_url else {})
    ).agent_url


def resolve_agent_id(explicit_agent_id: str | None = None) -> str:
    return AgenticSettings(
        **({"agent_id": explicit_agent_id} if explicit_agent_id else {})
    ).agent_id


def load_agentic_config(
    agent_api_url: str | None = None,
    agent_id: str | None = None,
    insecure: bool | None = None,
    trace_log: bool | None = None,
    timeout: float | None = None,
    fail_on_error: bool | None = None,
    datasource_id: str | None = None,
) -> AgenticSettings:
    """Centralized Agentic RAG configuration loader."""
    kwargs: dict[str, Any] = {}
    if agent_api_url is not None:
        kwargs["agent_url"] = agent_api_url
    if agent_id is not None:
        kwargs["agent_id"] = agent_id
    if insecure is not None:
        kwargs["insecure"] = insecure
    if trace_log is not None:
        kwargs["trace_log"] = trace_log
    if timeout is not None:
        kwargs["timeout"] = timeout
    if fail_on_error is not None:
        kwargs["fail_on_error"] = fail_on_error
    if datasource_id is not None:
        kwargs["datasource_id"] = datasource_id

    return AgenticSettings(**kwargs)
