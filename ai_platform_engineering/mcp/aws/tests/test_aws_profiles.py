import importlib.util
from pathlib import Path

import pytest


SERVER_PATH = Path(__file__).parents[1] / "server.py"


def _load_server():
    spec = importlib.util.spec_from_file_location("mcp_aws_server", SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def server(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("AWS_ACCOUNT_LIST", "dev:111111111111,prod:222222222222")
    monkeypatch.delenv("AWS_CREDENTIAL_SOURCE", raising=False)
    monkeypatch.delenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", raising=False)
    monkeypatch.delenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", raising=False)
    monkeypatch.delenv("AWS_ROLE_ARN", raising=False)
    monkeypatch.delenv("AWS_WEB_IDENTITY_TOKEN_FILE", raising=False)
    return _load_server()


def _config(tmp_path):
    return (tmp_path / ".aws" / "config").read_text()


def test_profiles_default_to_environment_credentials(server, tmp_path):
    server._setup_aws_profiles()

    config = _config(tmp_path)
    assert config.count("credential_source = Environment") == 2


def test_profiles_auto_detect_eks_pod_identity(server, monkeypatch, tmp_path):
    monkeypatch.setenv(
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "http://169.254.170.23/v1/credentials",
    )

    server._setup_aws_profiles()

    config = _config(tmp_path)
    assert config.count("credential_source = EcsContainer") == 2
    assert "AWS_ACCESS_KEY_ID" not in config


def test_profiles_chain_through_irsa_web_identity(server, monkeypatch, tmp_path):
    monkeypatch.setenv("AWS_ROLE_ARN", "arn:aws:iam::111111111111:role/mcp-aws")
    monkeypatch.setenv(
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
    )

    server._setup_aws_profiles()

    config = _config(tmp_path)
    assert "[profile mcp-workload-identity]" in config
    assert "web_identity_token_file = /var/run/secrets/eks.amazonaws.com/serviceaccount/token" in config
    assert config.count("source_profile = mcp-workload-identity") == 2
    assert "credential_source" not in config


def test_explicit_credential_source_override(server, monkeypatch, tmp_path):
    monkeypatch.setenv("AWS_CREDENTIAL_SOURCE", "Ec2InstanceMetadata")

    server._setup_aws_profiles()

    assert _config(tmp_path).count("credential_source = Ec2InstanceMetadata") == 2


def test_invalid_credential_source_is_rejected(server, monkeypatch):
    monkeypatch.setenv("AWS_CREDENTIAL_SOURCE", "ArbitraryProvider")

    with pytest.raises(ValueError, match="Unsupported AWS_CREDENTIAL_SOURCE"):
        server._setup_aws_profiles()


def test_web_identity_values_must_be_single_line(server, monkeypatch):
    monkeypatch.setenv("AWS_ROLE_ARN", "arn:aws:iam::111111111111:role/mcp-aws\n[profile injected]")
    monkeypatch.setenv("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/token")

    with pytest.raises(ValueError, match="AWS_ROLE_ARN must be a single-line"):
        server._setup_aws_profiles()
