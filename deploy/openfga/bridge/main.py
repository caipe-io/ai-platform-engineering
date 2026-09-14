"""gRPC ext_authz target for AgentGateway that calls OpenFGA Check.

The server implements the Envoy external authorization service method
`envoy.service.auth.v3.Authorization/Check` with a minimal protobuf schema
that is wire-compatible for the fields this bridge needs.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import signal
import sys
import time
import uuid
from concurrent import futures
from pathlib import Path
from typing import NamedTuple
import importlib.util

import grpc
import httpx
import jwt
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

try:
    from audit import log_authz_decision
except ModuleNotFoundError:
    audit_spec = importlib.util.spec_from_file_location(
        "openfga_bridge_audit",
        Path(__file__).with_name("audit.py"),
    )
    if audit_spec is None or audit_spec.loader is None:
        raise
    audit_module = importlib.util.module_from_spec(audit_spec)
    audit_spec.loader.exec_module(audit_module)
    log_authz_decision = audit_module.log_authz_decision

OPENFGA_HTTP = os.environ.get("OPENFGA_HTTP", "http://openfga:8080").rstrip("/")
OPENFGA_STORE_NAME = os.environ.get("OPENFGA_STORE_NAME", "caipe-openfga").strip()
GRPC_BIND = os.environ.get("EXT_AUTHZ_GRPC_BIND", "0.0.0.0:9100")
JWT_JWKS_URL = os.environ.get("JWT_JWKS_URL", "").strip()
JWT_ISSUER = os.environ.get("JWT_ISSUER", "").strip()
JWT_AUDIENCES = tuple(
    aud.strip() for aud in os.environ.get("JWT_AUDIENCES", "").split(",") if aud.strip()
)
JWT_ALGORITHMS = tuple(
    alg.strip() for alg in os.environ.get("JWT_ALGORITHMS", "RS256").split(",") if alg.strip()
)
# Optional explicit store id (skips discovery)
STORE_ID: str = os.environ.get("OPENFGA_STORE_ID", "").strip()
# Optional: if set, only these subs get 200 without calling OpenFGA (escape hatch)
BYPASS_SUBS = frozenset(
    s.strip() for s in os.environ.get("OPENFGA_BYPASS_SUBS", "").split(",") if s.strip()
)
AGENT_CONTEXT_HMAC_SECRET = os.environ.get("CAIPE_AGENT_CONTEXT_HMAC_SECRET", "").strip()
AGENT_CONTEXT_MAX_AGE_SECONDS = int(os.environ.get("CAIPE_AGENT_CONTEXT_MAX_AGE_SECONDS", "300"))
# "local" contexts (minted by /api/mcp-servers/agent-context for CLI/local
# callers, see ui/src/lib/mcp-http-server-client.ts) get a longer max age than
# Dynamic Agent contexts: they're re-signed per MCP connection, not per
# request (Claude Code/Codex cache MCP headers for a whole session), so a
# short TTL would force a re-auth or a failed-then-retried tool call every
# few minutes. They're safe to allow longer because they carry no delegated
# authority — see the "local" branch in OpenFgaAuthorizationService.Check.
AGENT_CONTEXT_LOCAL_MAX_AGE_SECONDS = int(
    os.environ.get("CAIPE_AGENT_CONTEXT_LOCAL_MAX_AGE_SECONDS", "28800")  # 8h
)
# Caller-keyed tool-authorization rollout flag (FR-012c / SC-011 / T022a).
# When OFF (default), the bridge keeps the legacy agent-only tool check so
# enabling the new subject→tool check in a shared environment never silently
# breaks existing human callers who rely on transitive (agent-granted) tool
# access. Operators turn this ON only after backfilling direct caller tool
# grants (see docs/docs/security/rbac/workflows.md). Set
# CAIPE_CALLER_TOOL_CHECK_ENABLED=true to enable.
CALLER_TOOL_CHECK_ENABLED = os.environ.get(
    "CAIPE_CALLER_TOOL_CHECK_ENABLED", ""
).strip().lower() in ("1", "true", "yes", "on")
# The Knowledge Base target owns caller authorization: organization Search,
# custom-tool grants, and readable datasources. Mirror its feature gate here
# instead of requiring a second generic MCP assignment.
CAIPE_ORG_KEY = os.environ.get("CAIPE_ORG_KEY", "caipe").strip() or "caipe"
SEARCH_CAPABILITY_MCP_SERVERS = frozenset({"knowledge-base"})
# MCP targets in this set require the caller to hold `can_invoke` on the
# corresponding `mcp_server:<target>` object. This supports selectively
# restricted servers without enabling caller-keyed checks for every MCP tool.
RESTRICTED_MCP_SERVERS = frozenset(
    server_id.strip()
    for server_id in os.environ.get("CAIPE_RESTRICTED_MCP_SERVERS", "").split(",")
    if server_id.strip()
)
_JWKS_CLIENT: jwt.PyJWKClient | None = None
OK = 0
PERMISSION_DENIED = 7
UNAUTHENTICATED = 16
UNAVAILABLE = 14


def _build_proto_classes() -> dict[str, type]:
    """Build minimal Envoy ext_authz message classes at runtime."""
    file_proto = descriptor_pb2.FileDescriptorProto()
    file_proto.name = "envoy/service/auth/v3/minimal_external_auth.proto"
    file_proto.package = "envoy.service.auth.v3"
    file_proto.syntax = "proto3"

    check_request = file_proto.message_type.add()
    check_request.name = "CheckRequest"
    field = check_request.field.add()
    field.name = "attributes"
    field.number = 1
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    field.type_name = ".envoy.service.auth.v3.AttributeContext"

    attribute_context = file_proto.message_type.add()
    attribute_context.name = "AttributeContext"

    request_msg = attribute_context.nested_type.add()
    request_msg.name = "Request"
    field = request_msg.field.add()
    field.name = "http"
    field.number = 2
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    field.type_name = ".envoy.service.auth.v3.AttributeContext.HttpRequest"

    http_request = attribute_context.nested_type.add()
    http_request.name = "HttpRequest"
    for name, number in (
        ("id", 1),
        ("method", 2),
        ("path", 4),
        ("host", 5),
        ("scheme", 6),
        ("query", 7),
        ("fragment", 8),
        ("protocol", 10),
        ("body", 11),
    ):
        field = http_request.field.add()
        field.name = name
        field.number = number
        field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
        field.type = descriptor_pb2.FieldDescriptorProto.TYPE_STRING
    field = http_request.field.add()
    field.name = "size"
    field.number = 9
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_INT64
    field = http_request.field.add()
    field.name = "raw_body"
    field.number = 12
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_BYTES
    headers_entry = http_request.nested_type.add()
    headers_entry.name = "HeadersEntry"
    headers_entry.options.map_entry = True
    field = headers_entry.field.add()
    field.name = "key"
    field.number = 1
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_STRING
    field = headers_entry.field.add()
    field.name = "value"
    field.number = 2
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_STRING
    field = http_request.field.add()
    field.name = "headers"
    field.number = 3
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_REPEATED
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    field.type_name = ".envoy.service.auth.v3.AttributeContext.HttpRequest.HeadersEntry"

    field = attribute_context.field.add()
    field.name = "request"
    field.number = 4
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    field.type_name = ".envoy.service.auth.v3.AttributeContext.Request"
    field = attribute_context.field.add()
    field.name = "metadata_context"
    field.number = 11
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    field.type_name = ".envoy.service.auth.v3.Metadata"

    value_msg = file_proto.message_type.add()
    value_msg.name = "Value"
    field = value_msg.field.add()
    field.name = "string_value"
    field.number = 3
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_STRING
    field = value_msg.field.add()
    field.name = "struct_value"
    field.number = 5
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    field.type_name = ".envoy.service.auth.v3.Struct"

    struct_msg = file_proto.message_type.add()
    struct_msg.name = "Struct"
    fields_entry = struct_msg.nested_type.add()
    fields_entry.name = "FieldsEntry"
    fields_entry.options.map_entry = True
    field = fields_entry.field.add()
    field.name = "key"
    field.number = 1
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_STRING
    field = fields_entry.field.add()
    field.name = "value"
    field.number = 2
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    field.type_name = ".envoy.service.auth.v3.Value"
    field = struct_msg.field.add()
    field.name = "fields"
    field.number = 1
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_REPEATED
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    field.type_name = ".envoy.service.auth.v3.Struct.FieldsEntry"

    metadata_msg = file_proto.message_type.add()
    metadata_msg.name = "Metadata"
    filter_entry = metadata_msg.nested_type.add()
    filter_entry.name = "FilterMetadataEntry"
    filter_entry.options.map_entry = True
    field = filter_entry.field.add()
    field.name = "key"
    field.number = 1
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_STRING
    field = filter_entry.field.add()
    field.name = "value"
    field.number = 2
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    field.type_name = ".envoy.service.auth.v3.Struct"
    field = metadata_msg.field.add()
    field.name = "filter_metadata"
    field.number = 1
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_REPEATED
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    field.type_name = ".envoy.service.auth.v3.Metadata.FilterMetadataEntry"

    status_msg = file_proto.message_type.add()
    status_msg.name = "Status"
    field = status_msg.field.add()
    field.name = "code"
    field.number = 1
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_INT32
    field = status_msg.field.add()
    field.name = "message"
    field.number = 2
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_STRING

    file_proto.message_type.add().name = "OkHttpResponse"
    denied = file_proto.message_type.add()
    denied.name = "DeniedHttpResponse"
    field = denied.field.add()
    field.name = "body"
    field.number = 3
    field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    field.type = descriptor_pb2.FieldDescriptorProto.TYPE_STRING

    check_response = file_proto.message_type.add()
    check_response.name = "CheckResponse"
    for name, number, type_name in (
        ("status", 1, ".envoy.service.auth.v3.Status"),
        ("denied_response", 2, ".envoy.service.auth.v3.DeniedHttpResponse"),
        ("ok_response", 3, ".envoy.service.auth.v3.OkHttpResponse"),
    ):
        field = check_response.field.add()
        field.name = name
        field.number = number
        field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
        field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
        field.type_name = type_name

    pool = descriptor_pool.DescriptorPool()
    pool.Add(file_proto)
    names = [
        "CheckRequest",
        "CheckResponse",
        "AttributeContext",
        "Status",
        "OkHttpResponse",
        "DeniedHttpResponse",
        "Metadata",
        "Struct",
        "Value",
    ]
    return {
        name: message_factory.GetMessageClass(
            pool.FindMessageTypeByName(f"envoy.service.auth.v3.{name}")
        )
        for name in names
    }


PROTO = _build_proto_classes()
CheckRequest = PROTO["CheckRequest"]
CheckResponse = PROTO["CheckResponse"]


def discover_store_id() -> str:
    """Return the configured OpenFGA store id, discovering it by name if needed."""
    global STORE_ID
    if STORE_ID:
        return STORE_ID
    with httpx.Client(timeout=15.0) as client:
        r = client.get(f"{OPENFGA_HTTP}/stores")
        r.raise_for_status()
        for s in r.json().get("stores", []):
            if s.get("name") == OPENFGA_STORE_NAME:
                STORE_ID = s["id"]
                print(f"[bridge] discovered store id={STORE_ID}", file=sys.stderr)
                break
    if not STORE_ID:
        print(
            f"[bridge] No store named {OPENFGA_STORE_NAME!r} — all checks will deny",
            file=sys.stderr,
        )
    return STORE_ID


def _check_openfga(user: str, relation: str, obj: str) -> bool:
    store_id = discover_store_id()
    if not store_id:
        return False
    url = f"{OPENFGA_HTTP}/stores/{store_id}/check"
    body: dict = {
        "tuple_key": {"user": user, "relation": relation, "object": obj},
    }
    with httpx.Client(timeout=10.0) as client:
        r = client.post(url, json=body)
        r.raise_for_status()
        return bool(r.json().get("allowed"))


def _get_jwks_client() -> jwt.PyJWKClient:
    """Return a cached JWKS client for token signature verification."""
    global _JWKS_CLIENT
    if _JWKS_CLIENT is None:
        _JWKS_CLIENT = jwt.PyJWKClient(JWT_JWKS_URL)
    return _JWKS_CLIENT


def _decode_verified_bearer_claims(auth_header: str) -> dict | None:
    """Validate a bearer JWT and return its full claim set when the token is trusted."""
    if not auth_header.startswith("Bearer "):
        return None
    if not JWT_JWKS_URL:
        print("[bridge] JWT_JWKS_URL is required for token validation", file=sys.stderr)
        return None

    token = auth_header[7:].strip()
    try:
        signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
        decode_kwargs: dict[str, object] = {"algorithms": list(JWT_ALGORITHMS)}
        if JWT_ISSUER:
            decode_kwargs["issuer"] = JWT_ISSUER
        if JWT_AUDIENCES:
            decode_kwargs["audience"] = list(JWT_AUDIENCES)
        else:
            decode_kwargs["options"] = {"verify_aud": False}
        payload = jwt.decode(token, signing_key.key, **decode_kwargs)
    except Exception as e:
        print(f"[bridge] JWT validation failed: {e}", file=sys.stderr)
        return None

    return payload if isinstance(payload, dict) else None


def _decode_verified_bearer_subject(auth_header: str) -> str | None:
    """Validate a bearer JWT and return its subject when the token is trusted."""
    payload = _decode_verified_bearer_claims(auth_header)
    if not payload:
        return None
    sub = payload.get("sub")
    return sub if isinstance(sub, str) and sub else None


def _is_service_account_claims(payload: dict | None) -> bool:
    """Canonical service-account detection rule (spec 2026-06-05-service-accounts, T002).

    A token is a service account iff its `preferred_username` claim starts with
    `service-account-`. This MUST match the BFF (`jwt-validation.ts`) and the DA
    backend (`authz.py`) so the same token namespaces identically at
    every enforcement layer.
    """
    if not payload:
        return False
    preferred = payload.get("preferred_username")
    return isinstance(preferred, str) and preferred.startswith("service-account-")


def caller_is_service_account(headers: dict[str, str]) -> bool:
    """Whether the request's bearer token is a Keycloak service-account token.

    Metadata-only requests (no verifiable bearer) are treated as non-service
    accounts and keep the `user:` namespace.
    """
    return _is_service_account_claims(
        _decode_verified_bearer_claims(headers.get("authorization", ""))
    )


def _preferred_username_from_metadata(request: CheckRequest) -> str | None:
    """Read `preferred_username` from the ext_authz `caipe.auth` gRPC metadata.

    AgentGateway's jwtAuth listener consumes the Authorization bearer and does
    NOT forward it in the ext_authz CheckRequest, so the bridge cannot re-decode
    the token (#46/#49). Instead the gateway is configured to pass the SA signal
    in the `caipe.auth` metadata expression alongside `sub`
    (`{"sub": jwt.sub, "preferred_username": jwt.preferred_username}`). Mirrors
    `_subject_from_metadata`. assisted-by Claude claude-opus-4-8
    """
    metadata = request.attributes.metadata_context.filter_metadata
    for key in ("caipe.auth", "dev.agentgateway.jwt"):
        if key not in metadata:
            continue
        fields = metadata[key].fields
        if "preferred_username" in fields:
            value = _string_value(fields["preferred_username"])
            if value:
                return value
        if "claims" in fields:
            claim_fields = fields["claims"].struct_value.fields
            if "preferred_username" in claim_fields:
                value = _string_value(claim_fields["preferred_username"])
                if value:
                    return value
    return None


def request_caller_is_service_account(request: CheckRequest, headers: dict[str, str]) -> bool:
    """Whether the caller is a Keycloak service account, T002 rule.

    Prefers the `preferred_username` carried in `caipe.auth` gRPC metadata (the
    only signal available when AgentGateway's jwtAuth has already consumed the
    bearer — the production path). Falls back to decoding the Authorization
    bearer directly (local diagnostics / metadata-less callers).
    """
    preferred = _preferred_username_from_metadata(request)
    if preferred is not None:
        return preferred.startswith("service-account-")
    return caller_is_service_account(headers)


def _headers_from_check_request(request: CheckRequest) -> dict[str, str]:
    headers = request.attributes.request.http.headers
    return {str(k).lower(): str(v) for k, v in headers.items()}


def _string_value(value: object) -> str | None:
    text = getattr(value, "string_value", "")
    return text if isinstance(text, str) and text else None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# "kind" values recognized in the signed agent-context payload. Absent for
# older producers (Dynamic Agents runtime, the diagnostic test-tool route) —
# those are treated as "dynamic", the pre-existing, fully-checked behavior.
# "local" identifies a context minted for a CLI/local caller (see
# ui/src/app/api/mcp-servers/agent-context/route.ts) acting as the signed-in
# user themselves rather than as a delegated agent — see the "local" branch
# in OpenFgaAuthorizationService.Check for what that changes.
AGENT_CONTEXT_KIND_DYNAMIC = "dynamic"
AGENT_CONTEXT_KIND_LOCAL = "local"
_AGENT_CONTEXT_MAX_AGE_BY_KIND = {
    AGENT_CONTEXT_KIND_DYNAMIC: AGENT_CONTEXT_MAX_AGE_SECONDS,
    AGENT_CONTEXT_KIND_LOCAL: AGENT_CONTEXT_LOCAL_MAX_AGE_SECONDS,
}


class AgentContext(NamedTuple):
    agent_id: str
    kind: str


def build_agent_context_header(
    agent_id: str,
    *,
    secret: str,
    now: int | None = None,
    kind: str = AGENT_CONTEXT_KIND_DYNAMIC,
) -> tuple[str, str]:
    """Build a signed agent context header pair for tests and diagnostics."""
    issued_at = int(now if now is not None else time.time())
    max_age = _AGENT_CONTEXT_MAX_AGE_BY_KIND.get(kind, AGENT_CONTEXT_MAX_AGE_SECONDS)
    payload = {
        "agent_id": agent_id,
        "iat": issued_at,
        "exp": issued_at + max_age,
        "kind": kind,
    }
    encoded = _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    signature = hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()
    return encoded, signature


def _agent_context_from_headers(
    headers: dict[str, str], *, now: int | None = None
) -> AgentContext | None:
    if not AGENT_CONTEXT_HMAC_SECRET:
        return None
    encoded = headers.get("x-caipe-agent-context", "")
    signature = headers.get("x-caipe-agent-context-signature", "")
    if not encoded or not signature:
        return None
    expected = hmac.new(
        AGENT_CONTEXT_HMAC_SECRET.encode(),
        encoded.encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        payload = json.loads(_b64url_decode(encoded))
    except Exception:
        return None

    iat = payload.get("iat")
    exp = payload.get("exp")
    agent_id = payload.get("agent_id")
    kind = payload.get("kind", AGENT_CONTEXT_KIND_DYNAMIC)
    if not isinstance(exp, int) or not isinstance(agent_id, str) or not agent_id:
        return None
    if not isinstance(kind, str) or kind not in _AGENT_CONTEXT_MAX_AGE_BY_KIND:
        return None

    current = int(now if now is not None else time.time())
    if exp < current:
        return None
    # Defense in depth: even though the payload is signed by caipe-ui (the
    # only holder of AGENT_CONTEXT_HMAC_SECRET), cap the lifetime a signer
    # could claim to this kind's configured max age rather than trusting an
    # arbitrary exp - iat span from the payload.
    max_age = _AGENT_CONTEXT_MAX_AGE_BY_KIND[kind]
    if isinstance(iat, int) and exp - iat > max_age:
        return None

    return AgentContext(agent_id=agent_id, kind=kind)


def _request_body_text(request: CheckRequest) -> str:
    http_request = request.attributes.request.http
    if http_request.raw_body:
        return http_request.raw_body.decode("utf-8", errors="replace")
    return http_request.body or ""


def _mcp_target_from_path(path: str) -> str | None:
    parts = [part for part in path.split("/") if part]
    if len(parts) >= 2 and parts[0] == "mcp":
        return parts[1]
    return None


def mcp_tool_call_from_request(request: CheckRequest) -> tuple[str, str] | None:
    """Return ``(target, tool_name)`` for MCP tools/call requests, if available."""
    target = _mcp_target_from_path(request.attributes.request.http.path)
    if not target:
        return None
    body = _request_body_text(request)
    if not body:
        return None
    try:
        payload = json.loads(body)
    except Exception:
        return None
    if payload.get("method") != "tools/call":
        return None
    params = payload.get("params")
    if not isinstance(params, dict):
        return None
    name = params.get("name")
    if not isinstance(name, str) or not name:
        return None
    return target, name


def _subject_from_metadata(request: CheckRequest) -> str | None:
    metadata = request.attributes.metadata_context.filter_metadata
    for key in ("caipe.auth", "dev.agentgateway.jwt"):
        if key not in metadata:
            continue
        fields = metadata[key].fields
        if "sub" in fields:
            sub = _string_value(fields["sub"])
            if sub:
                return sub
        if "claims" in fields:
            claim_fields = fields["claims"].struct_value.fields
            if "sub" in claim_fields:
                sub = _string_value(claim_fields["sub"])
                if sub:
                    return sub
    return None


def subject_from_check_request(request: CheckRequest) -> str | None:
    headers = _headers_from_check_request(request)
    subject = _decode_verified_bearer_subject(headers.get("authorization", ""))
    if subject:
        return subject
    return _subject_from_metadata(request)


def build_check_request(
    *,
    headers: dict[str, str],
    path: str = "/",
    method: str = "GET",
    metadata_subject: str | None = None,
    metadata_preferred_username: str | None = None,
    body: str = "",
) -> CheckRequest:
    """Build a CheckRequest for unit tests and local diagnostics."""
    request = CheckRequest()
    request.attributes.request.http.method = method
    request.attributes.request.http.path = path
    request.attributes.request.http.headers.update({k.lower(): v for k, v in headers.items()})
    request.attributes.request.http.body = body
    request.attributes.request.http.raw_body = body.encode()
    if metadata_subject:
        request.attributes.metadata_context.filter_metadata["caipe.auth"].fields[
            "sub"
        ].string_value = metadata_subject
    if metadata_preferred_username:
        request.attributes.metadata_context.filter_metadata["caipe.auth"].fields[
            "preferred_username"
        ].string_value = metadata_preferred_username
    return request


def build_check_response(
    *,
    allowed: bool,
    code: int | None = None,
    message: str | None = None,
) -> CheckResponse:
    response = CheckResponse()
    if allowed:
        response.status.code = OK
        response.ok_response.SetInParent()
        return response

    response.status.code = code if code is not None else PERMISSION_DENIED
    response.status.message = message or "denied by OpenFGA"
    response.denied_response.body = response.status.message
    return response


def _request_correlation_id(request: CheckRequest) -> str:
    request_id = request.attributes.request.http.id
    return request_id if request_id else str(uuid.uuid4())


def _audit_action(relation: str, obj: str) -> str:
    if obj.startswith("mcp_gateway:"):
        return f"mcp#{relation}"
    resource = obj.split(":", 1)[1] if ":" in obj else obj
    return f"{resource}#{relation}"


def _audit_decision(
    *,
    request: CheckRequest,
    subject: str,
    user: str | None,
    relation: str,
    obj: str,
    outcome: str,
    reason_code: str,
    pdp: str = "openfga",
    duration_ms: float | None = None,
    subject_ref: str | None = None,
) -> None:
    resource_ref = f"{user} {relation} {obj}" if user else f"{relation} {obj}"
    log_authz_decision(
        subject=subject,
        subject_ref=subject_ref,
        outcome=outcome,
        reason_code=reason_code,
        correlation_id=_request_correlation_id(request),
        action=_audit_action(relation, obj),
        component="agent_gateway",
        resource_ref=resource_ref,
        pdp=pdp,
        source="openfga_authz_bridge",
        duration_ms=duration_ms,
    )


class OpenFgaAuthorizationService:
    """Envoy Authorization.Check service backed by OpenFGA."""

    def Check(self, request: CheckRequest, context: grpc.ServicerContext) -> CheckResponse:
        relation = os.environ.get("OPENFGA_RELATION", "can_call")
        obj = os.environ.get("OPENFGA_OBJECT", "mcp_gateway:list")
        headers = _headers_from_check_request(request)
        sub = subject_from_check_request(request)
        if not sub:
            header_names = sorted(headers.keys())
            print(
                f"[bridge] missing subject on ext_authz request; headers={header_names}",
                file=sys.stderr,
            )
            _audit_decision(
                request=request,
                subject="anonymous",
                user=None,
                relation=relation,
                obj=obj,
                outcome="deny",
                reason_code="DENY_NO_TOKEN",
                pdp="agent_gateway",
                duration_ms=0,
            )
            return build_check_response(
                allowed=False,
                code=UNAUTHENTICATED,
                message="missing authenticated subject",
            )

        if sub in BYPASS_SUBS:
            _audit_decision(
                request=request,
                subject=sub,
                user=f"user:{sub}",
                relation=relation,
                obj=obj,
                outcome="allow",
                reason_code="OK_BYPASS",
                pdp="agent_gateway",
                duration_ms=0,
                subject_ref=f"user:{sub}",
            )
            return build_check_response(allowed=True)

        # Namespace the caller subject. Service-account tokens (Keycloak
        # client-credentials) are graphed as `service_account:<sub>`; everything
        # else stays `user:<sub>`. The rule (preferred_username startsWith
        # "service-account-") matches the BFF and DA layers (T002). SA-ness is
        # read from `caipe.auth` gRPC metadata (the gateway consumes the bearer
        # and doesn't forward it — #46/#49), falling back to the bearer header.
        if request_caller_is_service_account(request, headers):
            user = f"service_account:{sub}"
        else:
            user = f"user:{sub}"
        # Stable identity ref for audit events (real, resolvable identity —
        # audit logs are no longer anonymized). Kept separate from `user`
        # because some checks below reassign `user` to `agent:<agent_id>` for
        # agent-scoped OpenFGA tuple keys; the audited subject is always the
        # caller, never the agent.
        subject_ref = user
        start = time.perf_counter()
        try:
            allowed = _check_openfga(user, relation, obj)
            mcp_target = _mcp_target_from_path(request.attributes.request.http.path)
            if allowed and mcp_target in RESTRICTED_MCP_SERVERS:
                mcp_server_obj = f"mcp_server:{mcp_target}"
                server_allowed = _check_openfga(user, "can_invoke", mcp_server_obj)
                if not server_allowed:
                    _audit_decision(
                        request=request,
                        subject=sub,
                        user=user,
                        relation="can_invoke",
                        obj=mcp_server_obj,
                        outcome="deny",
                        reason_code="DENY_MCP_SERVER_INVOKE",
                        duration_ms=(time.perf_counter() - start) * 1000,
                        subject_ref=subject_ref,
                    )
                    return build_check_response(
                        allowed=False,
                        code=PERMISSION_DENIED,
                        message="caller lacks MCP server invoke grant",
                    )
                _audit_decision(
                    request=request,
                    subject=sub,
                    user=user,
                    relation="can_invoke",
                    obj=mcp_server_obj,
                    outcome="allow",
                    reason_code="OK_MCP_SERVER_INVOKE",
                    duration_ms=(time.perf_counter() - start) * 1000,
                    subject_ref=subject_ref,
                )
            tool_call = mcp_tool_call_from_request(request)
            if allowed and tool_call and AGENT_CONTEXT_HMAC_SECRET:
                agent_context = _agent_context_from_headers(headers)
                if not agent_context:
                    _audit_decision(
                        request=request,
                        subject=sub,
                        user=user,
                        relation="can_call",
                        obj=f"tool:{tool_call[0]}/{tool_call[1]}",
                        outcome="deny",
                        reason_code="DENY_NO_AGENT_CONTEXT",
                        duration_ms=(time.perf_counter() - start) * 1000,
                        subject_ref=subject_ref,
                    )
                    return build_check_response(
                        allowed=False,
                        code=PERMISSION_DENIED,
                        message="missing or invalid signed agent context",
                    )
                agent_id = agent_context.agent_id

                # "local" contexts identify the caller acting as themselves —
                # there is no separate delegated identity to bound, so we skip
                # the agent:<id> can_use/can_call checks and rely on the
                # caller-keyed tool check below to scope the request.
                #
                # IMPORTANT: that scoping holds ONLY when CALLER_TOOL_CHECK_ENABLED
                # is on. With the flag off (the upstream chart default), the
                # caller-keyed check below is skipped and a "local" context falls
                # back to just the coarse `can_call mcp_gateway:list` gate above —
                # which every onboarded user holds — granting reach to every tool
                # on every MCP server. Unlike a Dynamic Agent (whose tool grants
                # are explicitly enumerated per-agent), a "local" context has no
                # other tool-scoping mechanism, so the no-broadened-grant property
                # is conditional on the flag, not a structural invariant. This
                # repo's dev/prod helm values set callerToolCheck.enabled: true,
                # so the property holds in those deployments. See
                # ui/lib/mcp-http-server-client.ts and deploy/openfga/model.fga's
                # agent/tool relations.
                if agent_context.kind != AGENT_CONTEXT_KIND_LOCAL:
                    agent_allowed = _check_openfga(user, "can_use", f"agent:{agent_id}")
                    exact_tool_allowed = _check_openfga(
                        f"agent:{agent_id}",
                        "can_call",
                        f"tool:{tool_call[0]}/{tool_call[1]}",
                    )
                    wildcard_tool_allowed = False
                    if not exact_tool_allowed:
                        wildcard_tool_allowed = _check_openfga(
                            f"agent:{agent_id}",
                            "can_call",
                            f"tool:{tool_call[0]}/*",
                        )
                    if not agent_allowed:
                        _audit_decision(
                            request=request,
                            subject=sub,
                            user=user,
                            relation="can_use",
                            obj=f"agent:{agent_id}",
                            outcome="deny",
                            reason_code="DENY_AGENT_USE",
                            duration_ms=(time.perf_counter() - start) * 1000,
                            subject_ref=subject_ref,
                        )
                        return build_check_response(
                            allowed=False,
                            code=PERMISSION_DENIED,
                            message="user lacks dynamic agent grant",
                        )
                    if not (exact_tool_allowed or wildcard_tool_allowed):
                        _audit_decision(
                            request=request,
                            subject=sub,
                            user=f"agent:{agent_id}",
                            relation="can_call",
                            obj=f"tool:{tool_call[0]}/{tool_call[1]}",
                            outcome="deny",
                            reason_code="DENY_AGENT_TOOL",
                            duration_ms=(time.perf_counter() - start) * 1000,
                            subject_ref=subject_ref,
                        )
                        return build_check_response(
                            allowed=False,
                            code=PERMISSION_DENIED,
                            message="dynamic agent lacks agent tool grant",
                        )
                else:
                    _audit_decision(
                        request=request,
                        subject=sub,
                        user=user,
                        relation="can_call",
                        obj=f"tool:{tool_call[0]}/{tool_call[1]}",
                        outcome="allow",
                        reason_code="OK_LOCAL_AGENT_CONTEXT",
                        duration_ms=(time.perf_counter() - start) * 1000,
                        subject_ref=subject_ref,
                    )
                # Caller-keyed tool authorization (FR-012/012a/012b). The agent
                # being allowed to call the tool is NOT sufficient — the calling
                # subject (human user OR service account) must ALSO hold the tool
                # grant. This closes the confused-deputy gap where a caller's
                # effective tool reach was the union of every agent they may use.
                # Applies to all subjects; gated behind a config flag for safe
                # rollout (FR-012c, see CALLER_TOOL_CHECK_ENABLED).
                if CALLER_TOOL_CHECK_ENABLED:
                    caller_tool_obj = f"tool:{tool_call[0]}/{tool_call[1]}"
                    if tool_call[0] in SEARCH_CAPABILITY_MCP_SERVERS:
                        caller_relation = "can_search"
                        caller_obj = f"organization:{CAIPE_ORG_KEY}"
                        caller_allowed = _check_openfga(
                            user,
                            caller_relation,
                            caller_obj,
                        )
                        deny_reason = "DENY_CALLER_SEARCH"
                        allow_reason = "OK_CALLER_SEARCH"
                        deny_message = "caller lacks Knowledge Base search access"
                    else:
                        caller_relation = "can_call"
                        caller_obj = caller_tool_obj
                        caller_exact = _check_openfga(
                            user,
                            caller_relation,
                            caller_obj,
                        )
                        caller_wildcard = False
                        if not caller_exact:
                            caller_wildcard = _check_openfga(
                                user,
                                caller_relation,
                                f"tool:{tool_call[0]}/*",
                            )
                        caller_allowed = caller_exact or caller_wildcard
                        deny_reason = "DENY_CALLER_TOOL"
                        allow_reason = "OK_CALLER_TOOL"
                        deny_message = "caller lacks tool grant"
                    if not caller_allowed:
                        _audit_decision(
                            request=request,
                            subject=sub,
                            user=user,
                            relation=caller_relation,
                            obj=caller_obj,
                            outcome="deny",
                            reason_code=deny_reason,
                            duration_ms=(time.perf_counter() - start) * 1000,
                            subject_ref=subject_ref,
                        )
                        return build_check_response(
                            allowed=False,
                            code=PERMISSION_DENIED,
                            message=deny_message,
                        )
                    # Audit the caller-side allow as well as denials.
                    _audit_decision(
                        request=request,
                        subject=sub,
                        user=user,
                        relation=caller_relation,
                        obj=caller_obj,
                        outcome="allow",
                        reason_code=allow_reason,
                        duration_ms=(time.perf_counter() - start) * 1000,
                        subject_ref=subject_ref,
                    )
        except Exception as e:
            duration_ms = (time.perf_counter() - start) * 1000
            print(f"[bridge] OpenFGA check error: {e}", file=sys.stderr)
            _audit_decision(
                request=request,
                subject=sub,
                user=user,
                relation=relation,
                obj=obj,
                outcome="deny",
                reason_code="DENY_PDP_UNAVAILABLE",
                duration_ms=duration_ms,
                subject_ref=subject_ref,
            )
            return build_check_response(
                allowed=False,
                code=UNAVAILABLE,
                message="OpenFGA check error",
            )

        duration_ms = (time.perf_counter() - start) * 1000
        _audit_decision(
            request=request,
            subject=sub,
            user=user,
            relation=relation,
            obj=obj,
            outcome="allow" if allowed else "deny",
            reason_code="OK" if allowed else "DENY_NO_CAPABILITY",
            subject_ref=subject_ref,
            duration_ms=duration_ms,
        )
        return build_check_response(allowed=allowed)


def _add_authorization_service(server: grpc.Server) -> None:
    handler = grpc.unary_unary_rpc_method_handler(
        OpenFgaAuthorizationService().Check,
        request_deserializer=CheckRequest.FromString,
        response_serializer=lambda response: response.SerializeToString(),
    )
    generic_handler = grpc.method_handlers_generic_handler(
        "envoy.service.auth.v3.Authorization",
        {"Check": handler},
    )
    server.add_generic_rpc_handlers((generic_handler,))


def serve() -> None:
    discover_store_id()
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    _add_authorization_service(server)
    server.add_insecure_port(GRPC_BIND)
    server.start()
    print(f"[bridge] gRPC ext_authz listening on {GRPC_BIND}", file=sys.stderr)

    should_stop = futures.Future()

    def stop(signum: int, _frame: object) -> None:
        print(f"[bridge] received signal {signum}; stopping", file=sys.stderr)
        server.stop(grace=5)
        should_stop.set_result(None)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    should_stop.result()


if __name__ == "__main__":
    serve()
