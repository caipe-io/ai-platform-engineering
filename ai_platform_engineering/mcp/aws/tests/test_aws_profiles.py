import configparser
import importlib.util
from pathlib import Path
from types import ModuleType

import pytest


SERVER_PATH = Path(__file__).parents[1] / "server.py"
PROFILE_NAMES = ("primary", "secondary")


def _load_server() -> ModuleType:
    spec = importlib.util.spec_from_file_location("mcp_aws_server", SERVER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ModuleType:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.setenv("AWS_ACCOUNT_LIST", "primary:111111111111,secondary:222222222222")
    monkeypatch.setenv("CROSS_ACCOUNT_ROLE_NAME", "example-read-only")
    for name in (
        "AWS_CREDENTIAL_SOURCE",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_ROLE_ARN",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
    ):
        monkeypatch.delenv(name, raising=False)
    return _load_server()


def _config(tmp_path: Path) -> configparser.ConfigParser:
    config = configparser.ConfigParser(interpolation=None)
    with (tmp_path / ".aws" / "config").open(encoding="utf-8") as config_file:
        config.read_file(config_file)
    return config


def _set_irsa(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    token_file = tmp_path / "token"
    token_file.write_text("example-token", encoding="utf-8")
    monkeypatch.setenv("AWS_ROLE_ARN", "arn:aws:iam::333333333333:role/example-workload")
    monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", str(token_file))


def _assert_credential_source(config: configparser.ConfigParser, source: str) -> None:
    assert set(config.sections()) == {f"profile {name}" for name in PROFILE_NAMES}
    for name in PROFILE_NAMES:
        profile = config[f"profile {name}"]
        assert profile["credential_source"] == source
        assert "source_profile" not in profile


def test_profiles_default_to_environment_credentials(server: ModuleType, tmp_path: Path) -> None:
    accounts = server._setup_aws_profiles()

    assert accounts == [
        {"name": "primary", "id": "111111111111"},
        {"name": "secondary", "id": "222222222222"},
    ]
    config = _config(tmp_path)
    _assert_credential_source(config, "Environment")
    assert config["profile primary"]["role_arn"] == "arn:aws:iam::111111111111:role/example-read-only"
    assert config["profile secondary"]["role_arn"] == "arn:aws:iam::222222222222:role/example-read-only"


@pytest.mark.parametrize("uri_name", ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"])
def test_profiles_auto_detect_container_identity(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uri_name: str,
) -> None:
    monkeypatch.setenv(uri_name, "http://credentials.example.test/v1/credentials" if uri_name.endswith("FULL_URI") else "/v1/credentials")

    server._setup_aws_profiles()

    _assert_credential_source(_config(tmp_path), "EcsContainer")


def test_profiles_chain_through_irsa_web_identity(server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _set_irsa(monkeypatch, tmp_path)

    server._setup_aws_profiles()

    config = _config(tmp_path)
    assert set(config.sections()) == {"profile mcp-workload-identity", "profile primary", "profile secondary"}
    source = config["profile mcp-workload-identity"]
    assert source["role_arn"] == "arn:aws:iam::333333333333:role/example-workload"
    assert source["web_identity_token_file"] == str(tmp_path / "token")
    assert source["role_session_name"] == "mcp-aws"
    for name in PROFILE_NAMES:
        profile = config[f"profile {name}"]
        assert profile["source_profile"] == "mcp-workload-identity"
        assert "credential_source" not in profile


@pytest.mark.parametrize("source", ["Environment", "EcsContainer", "Ec2InstanceMetadata"])
def test_explicit_source_overrides_container_and_irsa(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, source: str,
) -> None:
    _set_irsa(monkeypatch, tmp_path)
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://credentials.example.test/v1/credentials")
    monkeypatch.setenv("AWS_CREDENTIAL_SOURCE", f" {source} ")

    server._setup_aws_profiles()

    _assert_credential_source(_config(tmp_path), source)


@pytest.mark.parametrize("uri_name", ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"])
def test_container_identity_overrides_stale_irsa(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uri_name: str,
) -> None:
    _set_irsa(monkeypatch, tmp_path)
    monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", str(tmp_path / "missing-token"))
    monkeypatch.setenv(uri_name, "http://credentials.example.test/v1/credentials" if uri_name.endswith("FULL_URI") else "/v1/credentials")

    server._setup_aws_profiles()

    _assert_credential_source(_config(tmp_path), "EcsContainer")


@pytest.mark.parametrize("use_irsa", [False, True])
def test_invalid_credential_source_is_rejected(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, use_irsa: bool,
) -> None:
    if use_irsa:
        _set_irsa(monkeypatch, tmp_path)
    monkeypatch.setenv("AWS_CREDENTIAL_SOURCE", "ArbitraryProvider")

    with pytest.raises(ValueError, match="Unsupported AWS_CREDENTIAL_SOURCE"):
        server._setup_aws_profiles()
    assert not (tmp_path / ".aws" / "config").exists()


@pytest.mark.parametrize("name", ["AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE"])
@pytest.mark.parametrize("newline", ["\n", "\r"])
def test_web_identity_values_must_be_single_line(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, name: str, newline: str,
) -> None:
    _set_irsa(monkeypatch, tmp_path)
    monkeypatch.setenv(name, f"example{newline}[profile injected]")

    with pytest.raises(ValueError, match=f"{name} must be a single-line"):
        server._setup_aws_profiles()
    assert not (tmp_path / ".aws" / "config").exists()


@pytest.mark.parametrize("missing", ["AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE"])
def test_incomplete_irsa_configuration_preserves_existing_config(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, missing: str,
) -> None:
    _set_irsa(monkeypatch, tmp_path)
    monkeypatch.delenv(missing)
    config_file = tmp_path / ".aws" / "config"
    config_file.parent.mkdir()
    config_file.write_text("[profile existing]\nregion = us-east-1\n", encoding="utf-8")

    with pytest.raises(ValueError, match="must be set together for IRSA"):
        server._setup_aws_profiles()
    assert config_file.read_text(encoding="utf-8") == "[profile existing]\nregion = us-east-1\n"


@pytest.mark.parametrize("missing", ["AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE"])
def test_container_identity_tolerates_incomplete_legacy_irsa(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, missing: str,
) -> None:
    _set_irsa(monkeypatch, tmp_path)
    monkeypatch.delenv(missing)
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://credentials.example.test/v1/credentials")

    server._setup_aws_profiles()

    _assert_credential_source(_config(tmp_path), "EcsContainer")


@pytest.mark.parametrize("source", [None, "Environment", "EcsContainer", "Ec2InstanceMetadata"])
def test_selected_provider_ignores_malformed_irsa_settings(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, source: str | None,
) -> None:
    monkeypatch.setenv("AWS_ROLE_ARN", "example\n[profile unused]")
    monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "example\n[profile unused]")
    if source is None:
        monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://credentials.example.test/v1/credentials")
    else:
        monkeypatch.setenv("AWS_CREDENTIAL_SOURCE", source)

    server._setup_aws_profiles()

    _assert_credential_source(_config(tmp_path), source or "EcsContainer")


@pytest.mark.parametrize("prefix,suffix", [(" ", ""), ("", " "), ("\t", ""), ("", "\t")])
def test_irsa_rejects_token_paths_that_would_be_trimmed(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, prefix: str, suffix: str,
) -> None:
    _set_irsa(monkeypatch, tmp_path)
    monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", f"{prefix}{tmp_path / 'token'}{suffix}")

    with pytest.raises(ValueError, match="AWS_WEB_IDENTITY_TOKEN_FILE must not start or end with whitespace"):
        server._setup_aws_profiles()
    assert not (tmp_path / ".aws" / "config").exists()


def test_irsa_reserved_profile_collision_preserves_existing_config(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _set_irsa(monkeypatch, tmp_path)
    monkeypatch.setenv("AWS_ACCOUNT_LIST", "primary:111111111111,mcp-workload-identity:222222222222")
    config_file = tmp_path / ".aws" / "config"
    config_file.parent.mkdir()
    config_file.write_text("[profile existing]\nregion = us-east-1\n", encoding="utf-8")

    with pytest.raises(ValueError, match="name 'mcp-workload-identity' is reserved when IRSA is used"):
        server._setup_aws_profiles()
    assert config_file.read_text(encoding="utf-8") == "[profile existing]\nregion = us-east-1\n"


@pytest.mark.parametrize("source", ["Environment", "EcsContainer"])
def test_internal_profile_name_is_allowed_without_irsa(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, source: str,
) -> None:
    monkeypatch.setenv("AWS_CREDENTIAL_SOURCE", source)
    monkeypatch.setenv("AWS_ACCOUNT_LIST", "mcp-workload-identity:111111111111")

    server._setup_aws_profiles()

    config = _config(tmp_path)
    assert config.sections() == ["profile mcp-workload-identity"]
    assert config["profile mcp-workload-identity"]["role_arn"] == "arn:aws:iam::111111111111:role/example-read-only"
    assert config["profile mcp-workload-identity"]["credential_source"] == source


@pytest.mark.parametrize("account_list", ["", " , "])
def test_without_accounts_no_config_is_written(
    server: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, account_list: str,
) -> None:
    monkeypatch.setenv("AWS_ACCOUNT_LIST", account_list)

    assert server._setup_aws_profiles() == []
    assert not (tmp_path / ".aws").exists()
