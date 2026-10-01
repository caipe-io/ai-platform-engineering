"""KMS envelope encryption for per-task webhook secrets.

This intentionally matches the UI credential store used by integrations such
as Webex OAuth: a fresh AES-256-GCM data key protects each secret, and AWS KMS
wraps that data key with the configured customer-managed key.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any, Protocol, TypedDict

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class WebhookSecretEncryptionError(RuntimeError):
    """Raised when a webhook secret cannot be encrypted or decrypted."""


class WebhookSecretEnvelope(TypedDict):
    """Mongo-safe envelope compatible with the UI credential store shape."""

    secretRefId: str
    algorithm: str
    ciphertext: str
    encryptedDek: str
    keyProvider: str
    cmkId: str | None


class WebhookSecretProtector(Protocol):
    """Encrypt and decrypt webhook secrets without exposing storage details."""

    async def encrypt(self, task_id: str, plaintext: str) -> WebhookSecretEnvelope:
        pass

    async def decrypt(self, task_id: str, envelope: dict[str, Any]) -> str:
        pass


_ALGORITHM = "AES-256-GCM"
_KEY_PROVIDER = "aws-kms"
_PURPOSE = "credential-secret"
_TAG_BYTES = 16


def secret_ref_id(task_id: str) -> str:
    """Return the stable AAD/KMS-context id for one task's webhook secret."""
    return f"autonomous-task:{task_id}:webhook-secret"


def _encryption_context(ref_id: str) -> dict[str, str]:
    return {"purpose": _PURPOSE, "secretRefId": ref_id}


def _encode_json(value: dict[str, str]) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


def _decode_base64(value: Any, field: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise WebhookSecretEncryptionError(f"Webhook secret envelope has an invalid {field}")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise WebhookSecretEncryptionError(f"Webhook secret envelope has an invalid {field}") from exc


class AwsKmsWebhookSecretProtector:
    """AES-256-GCM envelope encryption backed by AWS KMS GenerateDataKey."""

    def __init__(
        self,
        *,
        cmk_id: str,
        region: str | None = None,
        kms_client: Any | None = None,
    ) -> None:
        if not cmk_id.strip():
            raise ValueError("cmk_id must not be blank")
        self.cmk_id = cmk_id.strip()
        self.region = region.strip() if region and region.strip() else None
        self._kms_client = kms_client

    def _client(self) -> Any:
        if self._kms_client is None:
            # Deferred so deployments that only use the global WEBHOOK_SECRET
            # do not initialise the AWS SDK or credential chain.
            import boto3

            self._kms_client = boto3.client("kms", region_name=self.region)
        return self._kms_client

    async def encrypt(self, task_id: str, plaintext: str) -> WebhookSecretEnvelope:
        ref_id = secret_ref_id(task_id)
        try:
            response = await asyncio.to_thread(
                self._client().generate_data_key,
                KeyId=self.cmk_id,
                NumberOfBytes=32,
                EncryptionContext=_encryption_context(ref_id),
            )
            plaintext_dek = bytes(response["Plaintext"])
            encrypted_dek = bytes(response["CiphertextBlob"])
            if len(plaintext_dek) != 32 or not encrypted_dek:
                raise ValueError("KMS returned invalid data-key material")
        except Exception as exc:  # noqa: BLE001 -- SDK errors are provider-specific
            raise WebhookSecretEncryptionError("AWS KMS could not generate a webhook-secret data key") from exc

        iv = os.urandom(12)
        encrypted = AESGCM(plaintext_dek).encrypt(
            iv,
            plaintext.encode("utf-8"),
            ref_id.encode("utf-8"),
        )
        payload = {
            "ciphertext": base64.b64encode(encrypted[:-_TAG_BYTES]).decode("ascii"),
            "iv": base64.b64encode(iv).decode("ascii"),
            "tag": base64.b64encode(encrypted[-_TAG_BYTES:]).decode("ascii"),
        }
        return {
            "secretRefId": ref_id,
            "algorithm": _ALGORITHM,
            "ciphertext": _encode_json(payload),
            "encryptedDek": base64.b64encode(encrypted_dek).decode("ascii"),
            "keyProvider": _KEY_PROVIDER,
            "cmkId": self.cmk_id,
        }

    async def decrypt(self, task_id: str, envelope: dict[str, Any]) -> str:
        ref_id = secret_ref_id(task_id)
        if envelope.get("secretRefId") != ref_id:
            raise WebhookSecretEncryptionError("Webhook secret envelope does not belong to this task")
        if envelope.get("algorithm") != _ALGORITHM:
            raise WebhookSecretEncryptionError("Webhook secret envelope uses an unsupported algorithm")
        if envelope.get("keyProvider") != _KEY_PROVIDER:
            raise WebhookSecretEncryptionError("Webhook secret envelope uses an unsupported key provider")

        encrypted_dek = _decode_base64(envelope.get("encryptedDek"), "encryptedDek")
        try:
            response = await asyncio.to_thread(
                self._client().decrypt,
                CiphertextBlob=encrypted_dek,
                EncryptionContext=_encryption_context(ref_id),
            )
            plaintext_dek = bytes(response["Plaintext"])
            if len(plaintext_dek) != 32:
                raise ValueError("KMS returned an invalid plaintext data key")
        except Exception as exc:  # noqa: BLE001 -- SDK errors are provider-specific
            raise WebhookSecretEncryptionError("AWS KMS could not decrypt the webhook-secret data key") from exc

        try:
            payload_raw = _decode_base64(envelope.get("ciphertext"), "ciphertext")
            payload = json.loads(payload_raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise TypeError("ciphertext envelope is not an object")
            ciphertext = _decode_base64(payload.get("ciphertext"), "ciphertext payload")
            iv = _decode_base64(payload.get("iv"), "iv")
            tag = _decode_base64(payload.get("tag"), "tag")
            if len(iv) != 12 or len(tag) != _TAG_BYTES:
                raise ValueError("invalid AES-GCM nonce or tag length")
            plaintext = AESGCM(plaintext_dek).decrypt(
                iv,
                ciphertext + tag,
                ref_id.encode("utf-8"),
            )
            return plaintext.decode("utf-8")
        except WebhookSecretEncryptionError:
            raise
        except Exception as exc:  # noqa: BLE001 -- collapse parse/auth failures
            raise WebhookSecretEncryptionError("Webhook secret payload authentication failed") from exc


def build_webhook_secret_protector(*, cmk_id: str | None, region: str | None) -> WebhookSecretProtector | None:
    """Build the production protector, or None when per-task KMS is disabled."""
    if not cmk_id or not cmk_id.strip():
        return None
    return AwsKmsWebhookSecretProtector(cmk_id=cmk_id, region=region)
