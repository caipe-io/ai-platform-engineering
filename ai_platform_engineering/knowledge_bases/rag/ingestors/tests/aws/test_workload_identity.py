"""Generated cross-account profiles use workload identity without live AWS calls."""

from __future__ import annotations

import configparser
import os
from pathlib import Path
from types import ModuleType

import pytest
from botocore.session import Session

from ingestors.aws import ingestor as aws_ingestor


@pytest.fixture
def ingestor(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ModuleType:
  for key in (
    "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CREDENTIAL_SOURCE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  ):
    monkeypatch.delenv(key, raising=False)
  monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "initial-config"))
  monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "credentials"))
  monkeypatch.setattr(aws_ingestor, "AWS_ACCOUNT_LIST", "primary:111111111111,secondary:222222222222")
  monkeypatch.setattr(aws_ingestor, "CROSS_ACCOUNT_ROLE_NAME", "example-reader")
  expanduser = aws_ingestor.os.path.expanduser
  monkeypatch.setattr(aws_ingestor.os.path, "expanduser", lambda path: str(tmp_path / "credentials") if path == "~/.aws/credentials" else expanduser(path))
  monkeypatch.setattr(aws_ingestor.tempfile, "mkdtemp", lambda **_kwargs: str(tmp_path))
  return aws_ingestor


def generated_config(ingestor: ModuleType) -> configparser.ConfigParser:
  ingestor.setup_aws_profiles(ingestor.parse_account_list())
  config = configparser.ConfigParser()
  config.read(os.environ["AWS_CONFIG_FILE"])
  return config


def test_default_keeps_environment_credentials(ingestor: ModuleType) -> None:
  config = generated_config(ingestor)
  for name in ("primary", "secondary"):
    assert config[f"profile {name}"]["credential_source"] == "Environment"


@pytest.mark.parametrize("variable", ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"])
def test_container_identity_is_detected(ingestor: ModuleType, monkeypatch: pytest.MonkeyPatch, variable: str) -> None:
  monkeypatch.setenv(variable, "http://169.254.170.23/v1/credentials" if variable.endswith("FULL_URI") else "/v1/credentials")
  config = generated_config(ingestor)
  assert config["profile primary"]["credential_source"] == "EcsContainer"
  assert config["profile secondary"]["credential_source"] == "EcsContainer"


@pytest.mark.parametrize("source", ["Environment", "EcsContainer", "Ec2InstanceMetadata"])
def test_explicit_source_overrides_container_detection(ingestor: ModuleType, monkeypatch: pytest.MonkeyPatch, source: str) -> None:
  monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v1/credentials")
  monkeypatch.setenv("AWS_CREDENTIAL_SOURCE", source)
  assert generated_config(ingestor)["profile primary"]["credential_source"] == source


def test_irsa_chains_the_target_role_through_web_identity(ingestor: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
  monkeypatch.setenv("AWS_ROLE_ARN", "arn:aws:iam::111111111111:role/example-workload")
  monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/example/token")
  config = generated_config(ingestor)
  bootstrap = config["profile primary"]["source_profile"]
  assert config[f"profile {bootstrap}"]["role_arn"] == "arn:aws:iam::111111111111:role/example-workload"
  assert config[f"profile {bootstrap}"]["web_identity_token_file"] == "/var/run/example/token"
  assert config["profile secondary"]["source_profile"] == bootstrap
  assert config["profile primary"]["role_arn"] == "arn:aws:iam::111111111111:role/example-reader"
  assert not any("credential_source" in config[section] for section in config.sections())


def test_irsa_bootstrap_does_not_collide_with_an_account_alias(ingestor: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
  monkeypatch.setattr(ingestor, "AWS_ACCOUNT_LIST", "rag-workload-identity:111111111111")
  monkeypatch.setenv("AWS_ROLE_ARN", "arn:aws:iam::111111111111:role/example-workload")
  monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/example/token")
  config = generated_config(ingestor)
  bootstrap = config["profile rag-workload-identity"]["source_profile"]
  assert bootstrap != "rag-workload-identity"
  assert config[f"profile {bootstrap}"]["web_identity_token_file"] == "/var/run/example/token"


def test_unsupported_source_is_rejected(ingestor: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
  monkeypatch.setenv("AWS_CREDENTIAL_SOURCE", "UnknownProvider")
  with pytest.raises(ValueError, match="Unsupported AWS_CREDENTIAL_SOURCE"):
    generated_config(ingestor)


@pytest.mark.parametrize("variable", ["AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE"])
def test_irsa_values_cannot_add_config_sections(ingestor: ModuleType, monkeypatch: pytest.MonkeyPatch, variable: str) -> None:
  monkeypatch.setenv(variable, "example\n[profile injected]")
  with pytest.raises(ValueError, match=f"{variable} must be a single-line"):
    generated_config(ingestor)


def test_direct_credential_profiles_are_not_replaced(ingestor: ModuleType, tmp_path: Path) -> None:
  (tmp_path / "credentials").write_text("[primary]\naws_access_key_id = example\naws_secret_access_key = example\n")
  config = generated_config(ingestor)
  assert "profile primary" not in config
  assert "profile secondary" in config


def test_complete_irsa_configuration_takes_precedence(ingestor: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
  monkeypatch.setenv("AWS_ROLE_ARN", "arn:aws:iam::111111111111:role/example-workload")
  monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/example/token")
  monkeypatch.setenv("AWS_CREDENTIAL_SOURCE", "Ec2InstanceMetadata")
  monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v1/credentials")
  assert "source_profile" in generated_config(ingestor)["profile primary"]


@pytest.mark.parametrize("use_irsa", [False, True])
def test_aws_sdk_loads_the_generated_profile_graph(ingestor: ModuleType, monkeypatch: pytest.MonkeyPatch, use_irsa: bool) -> None:
  if use_irsa:
    monkeypatch.setenv("AWS_ROLE_ARN", "arn:aws:iam::111111111111:role/example-workload")
    monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/example/token")
  else:
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v1/credentials")
  generated_config(ingestor)
  # Configuration inspection only: no credential resolution or STS requests.
  profiles = Session(profile="primary").full_config["profiles"]
  if use_irsa:
    assert profiles[profiles["primary"]["source_profile"]]["web_identity_token_file"] == "/var/run/example/token"
  else:
    assert profiles["primary"]["credential_source"] == "EcsContainer"
