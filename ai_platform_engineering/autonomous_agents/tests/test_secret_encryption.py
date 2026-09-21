"""Tests for the Webex-compatible AWS KMS envelope encryption scheme."""

from __future__ import annotations

import base64
import copy
import json

import pytest

from autonomous_agents.services.secret_encryption import (
    AwsKmsWebhookSecretProtector,
    WebhookSecretEncryptionError,
    secret_ref_id,
)


class _FakeKmsClient:
    """Minimal synchronous boto3 KMS surface used through asyncio.to_thread."""

    def __init__(self) -> None:
        self._keys: dict[bytes, tuple[bytes, dict[str, str]]] = {}
        self.generate_calls: list[dict] = []
        self.decrypt_calls: list[dict] = []

    def generate_data_key(self, **kwargs):
        self.generate_calls.append(kwargs)
        plaintext = bytes(range(32))
        blob = f"wrapped-key-{len(self._keys)}".encode()
        self._keys[blob] = (plaintext, dict(kwargs["EncryptionContext"]))
        return {"Plaintext": plaintext, "CiphertextBlob": blob}

    def decrypt(self, **kwargs):
        self.decrypt_calls.append(kwargs)
        plaintext, expected_context = self._keys[bytes(kwargs["CiphertextBlob"])]
        if kwargs["EncryptionContext"] != expected_context:
            raise RuntimeError("encryption context mismatch")
        return {"Plaintext": plaintext}


@pytest.fixture
def kms() -> _FakeKmsClient:
    return _FakeKmsClient()


@pytest.fixture
def protector(kms: _FakeKmsClient) -> AwsKmsWebhookSecretProtector:
    return AwsKmsWebhookSecretProtector(
        cmk_id="alias/test-credentials",
        region="us-test-1",
        kms_client=kms,
    )


async def test_round_trip_uses_webex_credential_envelope_shape(
    protector: AwsKmsWebhookSecretProtector, kms: _FakeKmsClient
):
    envelope = await protector.encrypt("task-1", "github-hook-secret")

    assert envelope == {
        **envelope,
        "secretRefId": secret_ref_id("task-1"),
        "algorithm": "AES-256-GCM",
        "keyProvider": "aws-kms",
        "cmkId": "alias/test-credentials",
    }
    payload = json.loads(base64.b64decode(envelope["ciphertext"]))
    assert set(payload) == {"ciphertext", "iv", "tag"}
    assert "github-hook-secret" not in repr(envelope)
    assert await protector.decrypt("task-1", envelope) == "github-hook-secret"

    expected_context = {
        "purpose": "credential-secret",
        "secretRefId": secret_ref_id("task-1"),
    }
    assert kms.generate_calls[0]["EncryptionContext"] == expected_context
    assert kms.decrypt_calls[0]["EncryptionContext"] == expected_context


async def test_envelope_is_bound_to_task_id(
    protector: AwsKmsWebhookSecretProtector,
):
    envelope = await protector.encrypt("task-1", "secret")

    with pytest.raises(WebhookSecretEncryptionError, match="does not belong"):
        await protector.decrypt("task-2", envelope)


async def test_tampered_ciphertext_fails_authentication(
    protector: AwsKmsWebhookSecretProtector,
):
    envelope = await protector.encrypt("task-1", "secret")
    tampered = copy.deepcopy(envelope)
    payload = json.loads(base64.b64decode(tampered["ciphertext"]))
    ciphertext = bytearray(base64.b64decode(payload["ciphertext"]))
    ciphertext[0] ^= 1
    payload["ciphertext"] = base64.b64encode(ciphertext).decode()
    tampered["ciphertext"] = base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()

    with pytest.raises(WebhookSecretEncryptionError, match="authentication failed"):
        await protector.decrypt("task-1", tampered)


async def test_malformed_envelope_fails_closed(
    protector: AwsKmsWebhookSecretProtector,
):
    envelope = await protector.encrypt("task-1", "secret")
    envelope["encryptedDek"] = "not-valid-base64!"

    with pytest.raises(WebhookSecretEncryptionError, match="encryptedDek"):
        await protector.decrypt("task-1", envelope)
