"""Keycloak-authenticated publication using the Identity Node's existing VC API."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import BaseModel, ConfigDict

from dynamic_agents.config import Settings

MAX_BYTES = 512 * 1024
ENVELOPE = "CREDENTIAL_ENVELOPE_TYPE_JOSE"


class BadgePublicationError(Exception):
    """A safe, caller-visible publication failure; never includes upstream bodies."""


class IdentityBinding(BaseModel):
    """Operator-owned binding, separate from user-editable agent configuration."""

    model_config = ConfigDict(extra="forbid")
    subject: str
    token_subject: str
    client_id: str
    client_secret_file: str


class AgentBadgePublisher:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _configuration(self, agent_id: str) -> tuple[IdentityBinding, rsa.RSAPrivateKey]:
        s = self.settings
        if not s.agntcy_identity_enabled:
            raise BadgePublicationError("Agent Badge publication is disabled")
        urls = (
            s.agntcy_identity_node_url,
            s.agntcy_identity_keycloak_issuer,
            s.agntcy_identity_keycloak_token_url,
            s.agntcy_identity_keycloak_jwks_url,
        )
        for value in urls:
            parsed = urlparse(value)
            schemes = {"https", "http"} if s.agntcy_identity_allow_http else {"https"}
            if (
                parsed.scheme not in schemes
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
            ):
                raise BadgePublicationError("Identity endpoints must be configured HTTPS URLs")
        if (
            not s.agntcy_identity_keycloak_audience
            or not s.agntcy_identity_issuer
            or not s.agntcy_identity_signing_key_id
        ):
            raise BadgePublicationError("Identity issuer, audience and signing key ID are required")
        if not 1 <= s.agntcy_identity_badge_ttl_seconds <= 900:
            raise BadgePublicationError("Agent Badge lifetime must be between 1 and 900 seconds")
        bindings = json.loads(Path(s.agntcy_identity_bindings_file).read_text())
        if agent_id not in bindings:
            raise BadgePublicationError("No operator identity binding for this agent")
        binding = IdentityBinding.model_validate(bindings[agent_id])
        if (
            not re.fullmatch(r"[A-Za-z0-9_.~-]{1,512}", binding.subject)
            or binding.subject != f"IDP-{binding.token_subject}"
            or not binding.client_id
        ):
            raise BadgePublicationError("Expected a generic OIDC Identity Node subject binding")
        key = serialization.load_pem_private_key(Path(s.agntcy_identity_signing_key_file).read_bytes(), password=None)
        if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < 2048:
            raise BadgePublicationError("The AGNTCY signing key must be RSA with at least 2048 bits")
        return binding, key

    async def _json(self, client: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> dict:
        async with client.stream(method, url, **kwargs) as response:
            response.raise_for_status()
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise BadgePublicationError("Identity response exceeds the size limit")
        data = json.loads(body)
        if not isinstance(data, dict):
            raise BadgePublicationError("Invalid identity response")
        return data

    async def _token(self, client: httpx.AsyncClient, binding: IdentityBinding) -> str:
        s = self.settings
        secret = Path(binding.client_secret_file).read_text().strip()
        if not secret:
            raise BadgePublicationError("Empty Keycloak client secret")
        result = await self._json(
            client,
            "POST",
            s.agntcy_identity_keycloak_token_url,
            data={
                "grant_type": "client_credentials",
                "client_id": binding.client_id,
                "client_secret": secret,
            },
        )
        token = result["access_token"]
        jwks = await self._json(client, "GET", s.agntcy_identity_keycloak_jwks_url)
        kid = jwt.get_unverified_header(token).get("kid")
        keys = [item for item in jwks["keys"] if kid and item.get("kid") == kid]
        if len(keys) != 1:
            raise BadgePublicationError("No unique Keycloak signing key")
        claims = jwt.decode(
            token,
            jwt.PyJWK.from_dict(keys[0]).key,
            algorithms=["RS256", "ES256"],
            issuer=s.agntcy_identity_keycloak_issuer,
            audience=s.agntcy_identity_keycloak_audience,
            options={"require": ["iss", "sub", "aud", "iat", "exp"]},
        )
        if claims["sub"] != binding.token_subject or claims.get("azp") != binding.client_id:
            raise BadgePublicationError("Keycloak token does not match the configured agent binding")
        return token

    def _check_metadata(self, metadata: dict, binding: IdentityBinding, key: rsa.RSAPrivateKey) -> None:
        if metadata.get("id") != binding.subject or metadata.get("controller") != self.settings.agntcy_identity_issuer:
            raise BadgePublicationError("Identity Node subject or controller does not match")
        assertions = metadata.get("assertionMethod", [])
        for method in metadata.get("verificationMethod", []):
            public = method.get("publicKeyJwk", {})
            if method.get("id") not in assertions or public.get("kid") != self.settings.agntcy_identity_signing_key_id:
                continue
            if (
                public.get("kty") == "RSA"
                and jwt.PyJWK.from_dict({k: public[k] for k in ("kty", "n", "e")}).key.public_numbers()
                == key.public_key().public_numbers()
            ):
                return
        raise BadgePublicationError("The signing key is not an authorized Node assertion key")

    async def publish(self, agent_id: str, agent_name: str, record: dict) -> dict:
        """Sign exactly the approved public definition; never export runtime prompts."""
        try:
            binding, key = await asyncio.to_thread(self._configuration, agent_id)
            definition = json.dumps(record, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)
            if len(definition.encode()) > MAX_BYTES or record.get("name") != agent_name:
                raise BadgePublicationError("Public definition size or agent name does not match")
            if record.get("annotations", {}).get("agntcy.dir/identity") != f"agntcy://{binding.subject}":
                raise BadgePublicationError("Public definition must declare the configured AGNTCY identity")
            if not record.get("schema_version") or not record.get("version"):
                raise BadgePublicationError("Public definition requires schema_version and version")
            s = self.settings
            base = s.agntcy_identity_node_url.rstrip("/")
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
                token = await self._token(client, binding)
                resolved = await self._json(client, "POST", f"{base}/v1alpha1/id/resolve", json={"id": binding.subject})
                self._check_metadata(resolved["resolverMetadata"], binding, key)
                now = datetime.now(timezone.utc).replace(microsecond=0)
                expires = now + timedelta(seconds=s.agntcy_identity_badge_ttl_seconds)
                context = ["https://www.w3.org/2018/credentials/v1"]
                credential = {
                    "@context": context,
                    "context": context,
                    "type": ["VerifiableCredential", "AgentBadge"],
                    "id": f"urn:uuid:{uuid4()}",
                    "issuer": s.agntcy_identity_issuer,
                    "issuanceDate": now.isoformat().replace("+00:00", "Z"),
                    "expirationDate": expires.isoformat().replace("+00:00", "Z"),
                    "credentialSubject": {"id": binding.subject, "badge": record},
                }
                signed = jwt.encode(
                    credential, key, algorithm="RS256", headers={"kid": s.agntcy_identity_signing_key_id, "typ": "JOSE"}
                )
                envelope = {"envelopeType": ENVELOPE, "value": signed}
                # Node status alone does not enforce expiry or Directory CID binding.
                verified = await self._json(client, "POST", f"{base}/v1alpha1/vc/verify", json={"vc": envelope})
                if verified.get("status") is not True:
                    raise BadgePublicationError("Identity Node rejected the signed badge")
                await self._json(
                    client,
                    "POST",
                    f"{base}/v1alpha1/vc/publish",
                    json={
                        "vc": envelope,
                        "proof": {"type": "JWT", "proofValue": token},
                    },
                )
            return {
                "agent_id": agent_id,
                "subject": f"agntcy://{binding.subject}",
                "credential_id": credential["id"],
                "issuer": s.agntcy_identity_issuer,
                "expires_at": credential["expirationDate"],
                "badges_url": f"{base}/v1alpha1/vc/{binding.subject}/.well-known/vcs.json",
                "definition_sha256": hashlib.sha256(definition.encode()).hexdigest(),
            }
        except BadgePublicationError:
            raise
        except (httpx.HTTPError, jwt.PyJWTError, OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
            raise BadgePublicationError(
                "Agent Badge publication failed; check identity configuration and service availability"
            ) from exc
